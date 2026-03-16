import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { sendAdminNotification } from '@/lib/email';
import { checkRateLimitAsync, getClientIp, RateLimitPresets } from '@/lib/ratelimit';
import { markNotificationPending } from '@/lib/notification-queue';
import { appLogger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    // Apply rate limiting: 10 attempts per hour per IP to prevent token enumeration
    const clientIp = getClientIp(request);
    const rateLimitIpResult = await checkRateLimitAsync(clientIp, RateLimitPresets.verification);

    const searchParams = request.nextUrl.searchParams;
    const token = searchParams.get('token');

    // Add per-token rate limiting: 3 attempts per token per hour
    const rateLimitTokenResult = await checkRateLimitAsync(clientIp, {
      maxRequests: 3,
      windowMs: 60 * 60 * 1000, // 1 hour
      identifier: token || 'no-token',
    });

    if (!rateLimitIpResult.success || !rateLimitTokenResult.success) {
      return NextResponse.json(
        { error: 'Too many verification attempts. Please try again later.' },
        { status: 429 }
      );
    }

    if (!token) {
      return NextResponse.json(
        { error: 'Invalid verification link' },
        { status: 400 }
      );
    }

    const accessRequest = await prisma.accessRequest.findUnique({
      where: {
        verificationToken: token,
      },
    });

    if (!accessRequest) {
      return NextResponse.json(
        { error: 'Invalid or expired verification link' },
        { status: 400 }
      );
    }

    // Check if too many verification attempts have been made
    if (accessRequest.verificationAttempts >= 5) {
      return NextResponse.json(
        { error: 'This verification link has been used too many times' },
        { status: 400 }
      );
    }

    if (accessRequest.isVerified) {
      return NextResponse.json(
        { error: 'This email has already been verified' },
        { status: 400 }
      );
    }

    // Check expiration using the new field if available, otherwise fall back to createdAt (backward compatibility)
    const isExpired = accessRequest.verificationTokenExpiresAt
      ? new Date() > accessRequest.verificationTokenExpiresAt
      : (Date.now() - accessRequest.createdAt.getTime()) > (24 * 60 * 60 * 1000);

    if (isExpired) {
      // Increment attempt counter even for expired tokens
      await prisma.accessRequest.update({
        where: { id: accessRequest.id },
        data: { verificationAttempts: { increment: 1 } },
      }).catch(() => { /* ignore errors */ });
      return NextResponse.json(
        { error: 'This verification link has expired. Please submit a new request.' },
        { status: 400 }
      );
    }

    // Send admin notification FIRST before updating database
    // This ensures we only mark as verified if the notification succeeds
    try {
      await sendAdminNotification(
        accessRequest.id,
        accessRequest.name,
        accessRequest.email,
        accessRequest.isInternal,
        accessRequest.needsDomainAccount,
        accessRequest.eventReason || undefined
      );
    } catch (emailError) {
      console.error('Failed to send admin notification email:', emailError);
      appLogger.error('Admin notification failed, marking as pending', {
        requestId: accessRequest.id,
        email: accessRequest.email,
        error: emailError instanceof Error ? emailError.message : 'Unknown error',
      });

      // Mark notification as pending for manual retry
      await markNotificationPending(accessRequest.id);

      // Increment attempt counter for the failed verification
      await prisma.accessRequest.update({
        where: { id: accessRequest.id },
        data: {
          verificationAttempts: { increment: 1 },
        },
      }).catch(() => { /* ignore errors */ });

      // Return informative message to user
      return NextResponse.json(
        {
          message: 'Email verified successfully! Your request is being processed. Admins will be notified shortly.',
          status: 'notification_pending'
        },
        { status: 200 }
      );
    }

    // Successful verification - update status ONLY after notification succeeds
    await prisma.accessRequest.update({
      where: {
        id: accessRequest.id,
      },
      data: {
        isVerified: true,
        verifiedAt: new Date(),
        verificationAttempts: { increment: 1 }, // Track this attempt
        status: 'pending_student_directors', // Move to next stage after verification
      },
    });

    return NextResponse.json(
      { message: 'Email verified successfully!' },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error verifying request:', error);
    return NextResponse.json(
      { error: 'Failed to process verification. Please try again.' },
      { status: 500 }
    );
  }
}
