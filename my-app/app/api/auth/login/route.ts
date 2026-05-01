import { NextRequest, NextResponse } from 'next/server';
import { authenticateLDAP, searchLDAPUser, isUserDomainAdmin } from '@/lib/ldap';
import { checkRateLimitAsync, getClientIp, RateLimitPresets } from '@/lib/ratelimit';
import { establishSessionOnResponse } from '@/lib/session';
import { parseJsonWithLimit, MAX_REQUEST_BODY_SIZE } from '@/lib/validation';
import { prisma } from '@/lib/prisma';
import { verifyTurnstileToken } from '@/lib/turnstile';
import { StandardErrors, authenticationError } from '@/lib/standardErrors';
import { appLogger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    // Check if logins are disabled
    const settings = await prisma.systemSettings.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    if (settings?.loginDisabled) {
      return NextResponse.json(
        { error: StandardErrors.SERVICE_UNAVAILABLE },
        { status: 503 }
      );
    }

    // Apply rate limiting: 5 attempts per 15 minutes per IP
    const clientIp = getClientIp(request);
    const rateLimitResult = await checkRateLimitAsync(clientIp, RateLimitPresets.login);
    
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
    
    const body = await parseJsonWithLimit<{ username?: string; password?: string; turnstileToken?: string }>(request, MAX_REQUEST_BODY_SIZE.SMALL);
    const { username, password, turnstileToken } = body;

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

    if (!username || !password) {
      return NextResponse.json(
        { error: StandardErrors.INVALID_INPUT },
        { status: 400 }
      );
    }

    const authResult = await authenticateLDAP(username, password);

    if (!authResult.success) {
      // Log detailed error server-side only
      appLogger.error('[Login] Authentication failed:', undefined, {
        username, // Safe to log username for audit purposes
        error: authResult.error,
        timestamp: new Date().toISOString(),
        ip: clientIp,
      });
      
      // Return generic error to client - don't reveal if user exists or password is wrong
      return NextResponse.json(
        { error: StandardErrors.INVALID_CREDENTIALS },
        { status: 401 }
      );
    }

    const userInfo = await searchLDAPUser(username);
    const isDomainAdmin = await isUserDomainAdmin(username);

    const response = NextResponse.json(
      {
        message: 'Authentication successful',
        user: {
          username,
          email: userInfo?.attributes?.find(attr => attr.type === 'mail')?.values?.[0] || '',
          name: userInfo?.attributes?.find(attr => attr.type === 'cn')?.values?.[0] || username,
        },
        isAdmin: isDomainAdmin,
      },
      { status: 200 }
    );

    const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || clientIp;
    const userAgent = request.headers.get('user-agent') || undefined;

    // Log successful login
    try {
      // Import these dynamically to avoid circular dependencies if any, or just standard import above if clean
      const { logAuditAction, AuditActions, AuditCategories } = await import('@/lib/audit-log');
      await logAuditAction({
        action: AuditActions.LOGIN_SUCCESS,
        category: AuditCategories.AUTH,
        username: username,
        details: {
          method: 'LDAP',
          isAdmin: isDomainAdmin,
        },
        ipAddress: ipAddress,
        userAgent: userAgent,
      });
    } catch (auditError) {
      // Don't fail login if audit logging fails, but log error
      appLogger.error('Failed to log login success:', auditError);
    }

    await establishSessionOnResponse(response, username, isDomainAdmin, ipAddress, userAgent);

    return response;
  } catch (error) {
    // Log detailed error information server-side
    return authenticationError(error, 'Login');
  }
}
