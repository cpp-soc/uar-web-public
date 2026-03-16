import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getSessionFromRequest } from '@/lib/session';
import { checkRateLimitAsync, getClientIp } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

const CSRF_COOKIE_NAME = 'csrf-token';
const CSRF_MAX_AGE_SECONDS = 60 * 60 * 8;

function generateCsrfToken(sessionId: string): string {
  const secret = process.env.NEXTAUTH_SECRET || process.env.ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error('NEXTAUTH_SECRET or ENCRYPTION_SECRET must be set for CSRF token generation');
  }

  const hmac = crypto.createHmac('sha256', secret);
  // Remove timestamp to make the token stable for the session duration
  // This prevents issues with multiple tabs or token refreshes invalidating previous tokens
  hmac.update(sessionId);
  const signature = hmac.digest('hex');

  return signature;
}

export async function GET(request: NextRequest) {
  // Apply rate limiting: 100 requests per minute per IP
  const clientIp = getClientIp(request);
  const rateLimitResult = await checkRateLimitAsync(clientIp, {
    maxRequests: 100,
    windowMs: 60 * 1000,
  });

  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429 }
    );
  }

  const session = await getSessionFromRequest(request);

  if (!session) {
    const genericToken = crypto.randomBytes(32).toString('hex');
    const response = NextResponse.json({ csrfToken: genericToken });

    response.cookies.set({
      name: CSRF_COOKIE_NAME,
      value: genericToken,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: CSRF_MAX_AGE_SECONDS,
    });

    response.headers.set('x-csrf-token', genericToken);
    return response;
  }

  const csrfToken = generateCsrfToken(session.id);

  const response = NextResponse.json({ csrfToken });

  response.cookies.set({
    name: CSRF_COOKIE_NAME,
    value: csrfToken,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: CSRF_MAX_AGE_SECONDS,
  });

  response.headers.set('x-csrf-token', csrfToken);

  return response;
}
