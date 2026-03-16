import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomBytes } from 'crypto';
import { prisma } from '@/lib/prisma';
import { sendPasswordResetEmail } from '@/lib/email';
import { appLogger } from '@/lib/logger';
import { getLDAPUserEmail, searchUserByEmail } from '@/lib/ldap';
import { checkRateLimitAsync, getClientIp, RateLimitPresets } from '@/lib/ratelimit';
import { verifyTurnstileToken } from '@/lib/turnstile';
import { StandardErrors, internalError } from '@/lib/standardErrors';

export async function POST(request: NextRequest) {
  try {
    const { email, username, turnstileToken } = await request.json();

    // Determine if this is a logged-in user request (has username) or non-logged-in (has email)
    let targetEmail: string | null = null;
    const successMessage =
      'If an account exists with this email, you will receive a password reset link.';

    // Apply rate limiting: 3 attempts per hour per email/IP combination
    const clientIp = getClientIp(request);
    const identifier = email || username || '';
    const rateLimitResult = await checkRateLimitAsync(clientIp, {
      ...RateLimitPresets.passwordReset,
      identifier,
    });

    if (!rateLimitResult.success) {
      return NextResponse.json(
        {
          error: StandardErrors.RATE_LIMIT_EXCEEDED,
          retryAfter: Math.ceil((rateLimitResult.reset - Date.now()) / 1000),
        },
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit': rateLimitResult.limit.toString(),
            'X-RateLimit-Remaining': rateLimitResult.remaining.toString(),
            'X-RateLimit-Reset': new Date(rateLimitResult.reset).toISOString(),
            'Retry-After': Math.ceil((rateLimitResult.reset - Date.now()) / 1000).toString(),
          },
        }
      );
    }

    // Verify Turnstile for public requests (email provided, no username)
    if (email && !username) {
      if (!turnstileToken) {
        return NextResponse.json(
          { error: StandardErrors.TURNSTILE_VALIDATION_FAILED },
          { status: 400 }
        );
      }

      const isTurnstileValid = await verifyTurnstileToken(turnstileToken);
      if (!isTurnstileValid) {
        return NextResponse.json(
          { error: StandardErrors.TURNSTILE_VALIDATION_FAILED },
          { status: 400 }
        );
      }
    }

    if (username) {
      // Logged-in user - get their email from LDAP
      const ldapEmail = await getLDAPUserEmail(username);
      if (!ldapEmail) {
        appLogger.warn(
          'LDAP username not found during password reset request',
          { username }
        );
      } else {
        targetEmail = ldapEmail;
      }
    } else if (email) {
      // Non-logged-in user - verify email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return NextResponse.json(
          { error: StandardErrors.INVALID_INPUT },
          { status: 400 }
        );
      }
      targetEmail = email;
    } else {
      return NextResponse.json(
        { error: StandardErrors.INVALID_INPUT },
        { status: 400 }
      );
    }

    if (!targetEmail) {
      // Return uniform success response even when no matching LDAP user is found
      appLogger.info('Password reset: No target email resolved (invalid input or LDAP lookup failure)', { username, providedEmail: email });
      return NextResponse.json({ message: successMessage });
    }

    // Check if the user exists in Active Directory using the email
    // This prevents sending emails to non-existent users (email enumeration/spam prevention)
    const adUser = await searchUserByEmail(targetEmail);
    if (!adUser) {
      // Return uniform success response without logging to avoid notifying the user/logs
      appLogger.info('Password reset: User not found in AD', { email: targetEmail });
      return NextResponse.json({ message: successMessage });
    }

    // Check account status before sending reset email
    const accessRequest = await prisma.accessRequest.findFirst({
      where: { email: targetEmail.toLowerCase() },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        accountExpiresAt: true,
        rejectionReason: true,
      },
    });

    // If account exists, validate its status
    if (accessRequest) {
      // For reconnaissance resistance, never reveal account status to callers.
      // Only approved accounts can receive reset links; all other states return
      // the same generic response to avoid account/user enumeration.
      const status = accessRequest.status;
      const isExpired = accessRequest.accountExpiresAt && accessRequest.accountExpiresAt < new Date();

      if (
        status === 'rejected' ||
        status === 'pending_verification' ||
        status === 'pending_student_directors' ||
        status === 'pending_faculty' ||
        status !== 'approved' ||
        isExpired
      ) {
        appLogger.info('Password reset: Account status invalid or expired', { email: targetEmail, status, isExpired });
        return NextResponse.json({ message: successMessage });
      }
    }

    // Invalidate any existing unused tokens for this email
    // This prevents multiple valid tokens from existing simultaneously
    await prisma.passwordResetToken.updateMany({
      where: {
        email: targetEmail,
        used: false,
        expiresAt: {
          gt: new Date(), // Only invalidate tokens that haven't expired yet
        },
      },
      data: {
        used: true,
        usedAt: new Date(),
      },
    });

    // Generate a secure token
    const resetToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(resetToken).digest('hex');

    // Token expires in 1 hour
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    // Store the token in the database
    await prisma.passwordResetToken.create({
      data: {
        email: targetEmail,
        tokenHash,
        expiresAt,
      },
    });

    // Send the reset email
    await sendPasswordResetEmail(targetEmail, resetToken);

    // Return success without revealing if the email exists
    return NextResponse.json({ message: successMessage });
  } catch (error) {
    return internalError(error, 'Password Reset Request');
  }
}
