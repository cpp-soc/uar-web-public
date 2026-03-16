import { NextRequest, NextResponse } from 'next/server';
import { isCsrfExempt, requiresCsrfValidation } from './lib/csrf-config';
import { timingSafeCompare } from './lib/timing-safe';

// Winston is not compatible with Edge Runtime, so we define a lightweight 
// console-based logger for middleware that mimics the JSON structure.
const edgeLogger = {
  info: (message: string, meta?: Record<string, unknown>) => {
    const logEntry = {
      level: 'info',
      message,
      service: 'uar-web',
      timestamp: new Date().toISOString(),
      type: 'access_log',
      ...meta
    };
    console.log(JSON.stringify(logEntry));
  }
};

function validateCsrfToken(token: string | null | undefined, cookieToken: string | null | undefined): boolean {
  if (!token || !cookieToken) {
    return false;
  }

  try {
    return timingSafeCompare(token, cookieToken);
  } catch {
    return false;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Log all incoming requests
  edgeLogger.info('Incoming Request', {
    method: request.method,
    url: request.url,
    pathname: pathname,
    ip: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown',
    userAgent: request.headers.get('user-agent'),
    referer: request.headers.get('referer'),
  });

  let response = NextResponse.next();

  // Protect admin pages - require session cookie to be present
  // Full session validation happens in API routes, but this prevents
  // unauthenticated users from even loading admin pages
  if (pathname.startsWith('/admin') && !pathname.startsWith('/api/')) {
    const sessionCookie = request.cookies.get('session_token');
    if (!sessionCookie?.value) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('redirect', pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  // Skip CSRF validation for exempt paths (defined in csrf-config.ts)
  if (isCsrfExempt(pathname)) {
    // Continue to headers
  } else if (pathname.startsWith('/api/admin/') && request.method === 'GET') {
    // Skip CSRF for admin GET requests - read-only operations
    // These are already protected by session authentication in checkAdminAuthWithRateLimit()
    // CSRF protection is unnecessary for operations that don't modify state
  } else if (requiresCsrfValidation(request.method)) {
    const csrfTokenFromHeader = request.headers.get('x-csrf-token');
    const csrfTokenFromCookie = request.cookies.get('csrf-token')?.value;

    if (!validateCsrfToken(csrfTokenFromHeader, csrfTokenFromCookie)) {
      console.error('CSRF validation failed for:', pathname);

      if (process.env.NODE_ENV !== 'production') {
        console.debug(
          'Header token snippet:',
          csrfTokenFromHeader ? `${csrfTokenFromHeader.substring(0, 20)}...` : 'missing'
        );
        console.debug(
          'Cookie token snippet:',
          csrfTokenFromCookie ? `${csrfTokenFromCookie.substring(0, 20)}...` : 'missing'
        );
      }
      return NextResponse.json(
        { error: 'Invalid CSRF token' },
        { status: 403 }
      );
    }
  }

  // Handle CSRF cookie rotation for GET requests
  // Skip for /api/csrf-token as it sets its own fresh cookie
  if (request.method === 'GET' && pathname !== '/api/csrf-token') {
    const csrfCookie = request.cookies.get('csrf-token');
    if (csrfCookie?.value) {
      response.cookies.set({
        name: 'csrf-token',
        value: csrfCookie.value,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: 60 * 60 * 8
      });
    }
  }

  // Add Security Headers to all responses (API and Pages)
  // These provide defense-in-depth even if next.config.ts misses some
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // HSTS is usually handled by the host/next.config.ts but good to enforce
  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }

  return response;
}

export const config = {
  matcher: ['/api/:path*', '/admin/:path*']
};
