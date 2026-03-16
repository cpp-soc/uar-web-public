import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { prisma } from '@/lib/prisma';
import { setLDAPUserPassword } from '@/lib/ldap';
import { validatePasswordStrength } from '@/lib/password';
import { checkRateLimitAsync, getClientIp, RateLimitPresets } from '@/lib/ratelimit';
import { sendAccountActivationSuccessEmail } from '@/lib/email';
import { appLogger } from '@/lib/logger';
import { parseJsonWithLimit, MAX_REQUEST_BODY_SIZE } from '@/lib/validation';

const MAX_TOKEN_ATTEMPTS = 5;

export async function POST(request: NextRequest) {
  try {
    const { token, username, newPassword } = await parseJsonWithLimit<{
      token?: string;
      username?: string;
      newPassword?: string
    }>(request, MAX_REQUEST_BODY_SIZE.SMALL);

    // Apply rate limiting: 5 attempts per hour per IP/User to prevent token brute forcing
    // We use the username as identifier so shared IPs (NAT) don't block each other
    const clientIp = getClientIp(request);
    const rateLimitResult = await checkRateLimitAsync(clientIp, {
      maxRequests: 5,
      windowMs: RateLimitPresets.passwordReset.windowMs,
      identifier: username // Add username to unique key
    });

    if (!rateLimitResult.success) {
      return NextResponse.json(
        {
          error: 'Too many activation attempts. Please try again later.',
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

    if (!token || !username || !newPassword) {
      return NextResponse.json(
        { error: 'Token, username, and password are required' },
        { status: 400 }
      );
    }

    // Validate password strength
    const passwordValidation = validatePasswordStrength(newPassword);
    if (!passwordValidation.isValid) {
      return NextResponse.json(
        { error: 'Password does not meet requirements', issues: passwordValidation.issues },
        { status: 400 }
      );
    }

    const tokenHash = createHash('sha256').update(token).digest('hex');

    // ATOMIC: Use transaction to fetch and validate token, then mark as used
    let accessRequest;

    try {
      const now = new Date();

      const result = await prisma.$transaction(async (tx: any) => {
        // Fetch the token first within transaction
        const tokenData = await tx.accountActivationToken.findUnique({
          where: { tokenHash },
          include: {
            accessRequest: {
              select: {
                id: true,
                email: true,
                name: true,
                ldapUsername: true,
                isInternal: true,
                status: true,
              },
            },
          },
        });

        // Validate token exists
        if (!tokenData) {
          throw new Error('INVALID_TOKEN');
        }

        // Validate token state
        if (tokenData.used) {
          throw new Error('TOKEN_ALREADY_USED');
        }

        if (tokenData.attempts >= MAX_TOKEN_ATTEMPTS) {
          throw new Error('TOO_MANY_ATTEMPTS');
        }

        if (tokenData.expiresAt <= now) {
          throw new Error('TOKEN_EXPIRED');
        }

        // Validate username matches the access request
        if (tokenData.accessRequest.ldapUsername !== username) {
          // Increment attempts but don't mark as used - wrong username
          await tx.accountActivationToken.update({
            where: { tokenHash },
            data: {
              attempts: { increment: 1 },
            },
          });
          throw new Error('USERNAME_MISMATCH');
        }

        // Validate request is for internal user (security check)
        if (!tokenData.accessRequest.isInternal) {
          throw new Error('INVALID_USER_TYPE');
        }

        // Validate request status is approved
        if (tokenData.accessRequest.status !== 'approved') {
          throw new Error('REQUEST_NOT_APPROVED');
        }

        // Mark token as used atomically in same transaction
        await tx.accountActivationToken.update({
          where: { tokenHash },
          data: {
            attempts: { increment: 1 },
            used: true,
            usedAt: now,
            ipAddress: clientIp,
            userAgent: request.headers.get('user-agent') || undefined,
          },
        });

        // Clear any legacy encrypted password from the access request
        await tx.accessRequest.update({
          where: { id: tokenData.accessRequestId },
          data: {
            accountPassword: null,
          },
        });

        return {
          token: tokenData,
          request: tokenData.accessRequest,
        };
      }, {
        isolationLevel: 'Serializable', // Prevent race conditions
        timeout: 10000,
      });

      accessRequest = result.request;
    } catch (error) {
      // Log specific error for debugging (not exposed to user)
      if (error instanceof Error) {
        appLogger.warn('Account activation failed', {
          errorType: error.message,
          timestamp: new Date().toISOString(),
          ip: clientIp,
          username: username
        });
        console.error('[Account Activation] Error processing token:', error.message);

        // Return specific error messages for certain cases
        // Return generic error message for all validation failures to prevent enumeration
        // Specific errors are already logged above
        return NextResponse.json(
          {
            error: 'Invalid or expired activation link. Please contact IT support if you continue to have issues.',
          },
          { status: 400 }
        );
      }

      // Return uniform error for other cases to prevent token enumeration
      return NextResponse.json(
        {
          error: 'Invalid or expired activation link. Please contact IT support if you continue to have issues.',
        },
        { status: 400 }
      );
    }

    // Set password in Active Directory
    try {
      await setLDAPUserPassword(username, newPassword);
      // Password operation completed - details logged by ldapLogger
    } catch (ldapError) {
      console.error('[Account Activation] ❌ Failed to set password in AD:', ldapError);

      const errorMessage = ldapError instanceof Error ? ldapError.message : 'Unknown error';

      appLogger.error('Failed to set password in AD during activation', {
        username,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      });

      // Mark token as unused so user can retry
      await prisma.accountActivationToken.update({
        where: { tokenHash },
        data: {
          used: false,
          usedAt: null,
          attempts: { decrement: 1 },
        },
      });

      // Provide more specific error messages for known LDAP issues
      let clientErrorMessage = 'Failed to set password in Active Directory. Please try again.';

      if (errorMessage.includes('WILL_NOT_PERFORM') || errorMessage.includes('constraint violation')) {
        clientErrorMessage = 'Password was rejected by Active Directory. It may not meet complexity requirements or matches previous passwords.';
      } else if (errorMessage.includes('data 532') || errorMessage.includes('data 533')) {
        // 532 = password expired, 533 = account disabled - shouldn't happen here usually but good to handle
        clientErrorMessage = 'Account status prevents password change. Please contact support.';
      }

      return NextResponse.json(
        { error: clientErrorMessage, details: process.env.NODE_ENV === 'development' ? errorMessage : undefined },
        { status: 400 } // Use 400 for validation-like errors from AD
      );
    }

    // Send confirmation email
    try {
      await sendAccountActivationSuccessEmail(
        accessRequest.email,
        accessRequest.name,
        username
      );
      console.log('[Account Activation] ✅ Confirmation email sent to:', accessRequest.email);
    } catch (emailError) {
      console.error('[Account Activation] ⚠️ Failed to send confirmation email:', emailError);
      // Don't fail the request if email fails - password was set successfully
    }

    // Log success
    appLogger.info('Account password set via activation link', {
      username,
      email: accessRequest.email,
      ip: clientIp,
      timestamp: new Date().toISOString(),
    });

    return NextResponse.json({
      success: true,
      message: 'Password set successfully. You can now log in with your credentials.',
    });
  } catch (error) {
    console.error('[Account Activation] Unexpected error:', error);

    appLogger.error('Account activation unexpected error', {
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });

    return NextResponse.json(
      { error: 'An unexpected error occurred. Please try again or contact IT support.' },
      { status: 500 }
    );
  }
}
