import crypto from 'crypto';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './prisma';

const SESSION_COOKIE_NAME = 'session_token';

const SESSION_TIMEOUTS = {
  admin: 30 * 60,
  user: 60 * 60,
  maxIdle: 15 * 60
};

const SESSION_COOKIE_SAMESITE = 'strict' as const;

let insecureCookieOverrideWarningLogged = false;

function shouldUseSecureCookies(): boolean {
  const allowInsecure =
    process.env.SESSION_COOKIE_ALLOW_INSECURE === 'true';

  if (process.env.NODE_ENV === 'production') {
    if (allowInsecure && !insecureCookieOverrideWarningLogged) {
      console.warn(
        '[Session] SESSION_COOKIE_ALLOW_INSECURE is ignored outside development environments.'
      );
      insecureCookieOverrideWarningLogged = true;
    }
    return true;
  }

  if (allowInsecure) {
    return false;
  }

  return true;
}

export interface SessionInfo {
  id: string;
  username: string;
  isAdmin: boolean;
  expiresAt: Date;
  lastActivity: Date;
}

function getSessionMaxAgeSeconds(isAdmin: boolean = false): number {
  const defaultTimeout = isAdmin ? SESSION_TIMEOUTS.admin : SESSION_TIMEOUTS.user;
  
  const fromEnv = process.env.AUTH_SESSION_MAX_AGE;

  if (!fromEnv) {
    return defaultTimeout;
  }

  const parsed = Number(fromEnv);

  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }

  return defaultTimeout;
}

function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function calculateExpiryDate(isAdmin: boolean = false): Date {
  return new Date(Date.now() + getSessionMaxAgeSeconds(isAdmin) * 1000);
}

async function loadSessionByToken(
  token: string | undefined | null
): Promise<SessionInfo | null> {
  if (!token) {
    return null;
  }

  const tokenHash = hashSessionToken(token);
  const record = await prisma.session.findUnique({
    where: { tokenHash },
  });

  if (!record) {
    return null;
  }

  const now = new Date();

  if (record.revokedAt || record.expiresAt <= now) {
    await prisma.session
      .delete({
        where: { id: record.id },
      })
      .catch(() => {});
    return null;
  }

  const idleTimeMs = now.getTime() - record.lastActivity.getTime();
  const maxIdleMs = SESSION_TIMEOUTS.maxIdle * 1000;
  
  if (idleTimeMs > maxIdleMs) {
    await prisma.session
      .delete({
        where: { id: record.id },
      })
      .catch(() => {});
    return null;
  }

  await prisma.session
    .update({
      where: { id: record.id },
      data: { lastActivity: now },
    })
    .catch(() => {});

  return {
    id: record.id,
    username: record.username,
    isAdmin: record.isAdmin,
    expiresAt: record.expiresAt,
    lastActivity: now,
  };
}

function attachSessionCookie(
  response: NextResponse,
  token: string,
  expiresAt: Date
) {
  const maxAgeSeconds = Math.max(
    0,
    Math.floor((expiresAt.getTime() - Date.now()) / 1000)
  );
  const secure = shouldUseSecureCookies();

  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: SESSION_COOKIE_SAMESITE,
    maxAge: maxAgeSeconds,
    path: '/',
  });

  response.cookies.set('admin_session', '', {
    httpOnly: true,
    secure,
    sameSite: SESSION_COOKIE_SAMESITE,
    maxAge: 0,
    path: '/',
  });
  response.cookies.set('user_session', '', {
    httpOnly: true,
    secure,
    sameSite: SESSION_COOKIE_SAMESITE,
    maxAge: 0,
    path: '/',
  });
}

function clearSessionCookie(response: NextResponse) {
  const secure = shouldUseSecureCookies();

  response.cookies.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure,
    sameSite: SESSION_COOKIE_SAMESITE,
    maxAge: 0,
    path: '/',
  });

  response.cookies.set('admin_session', '', {
    httpOnly: true,
    secure,
    sameSite: SESSION_COOKIE_SAMESITE,
    maxAge: 0,
    path: '/',
  });
  response.cookies.set('user_session', '', {
    httpOnly: true,
    secure,
    sameSite: SESSION_COOKIE_SAMESITE,
    maxAge: 0,
    path: '/',
  });
}

export async function createUserSession(
  username: string,
  isAdmin: boolean,
  ipAddress?: string,
  userAgent?: string
): Promise<{ token: string; session: SessionInfo }> {
  const token = generateSessionToken();
  const now = new Date();
  const expiresAt = calculateExpiryDate(isAdmin);

  const record = await prisma.$transaction(async (tx: any) => {
    await tx.session.deleteMany({
      where: { username },
    });

    return await tx.session.create({
      data: {
        tokenHash: hashSessionToken(token),
        username,
        isAdmin,
        expiresAt,
        lastActivity: now,
        ipAddress,
        userAgent,
      },
    });
  });

  return {
    token,
    session: {
      id: record.id,
      username: record.username,
      isAdmin: record.isAdmin,
      expiresAt: record.expiresAt,
      lastActivity: record.lastActivity,
    },
  };
}

export async function establishSessionOnResponse(
  response: NextResponse,
  username: string,
  isAdmin: boolean,
  ipAddress?: string,
  userAgent?: string
): Promise<SessionInfo> {
  const { token, session } = await createUserSession(username, isAdmin, ipAddress, userAgent);
  attachSessionCookie(response, token, session.expiresAt);
  return session;
}

export async function getSessionFromRequest(
  request: NextRequest
): Promise<SessionInfo | null> {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  return loadSessionByToken(token);
}

export async function getSessionFromCookies(): Promise<SessionInfo | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  return loadSessionByToken(token);
}

export async function revokeSessionByToken(
  token: string | undefined | null
): Promise<void> {
  if (!token) {
    return;
  }

  const tokenHash = hashSessionToken(token);
  await prisma.session
    .delete({
      where: { tokenHash },
    })
    .catch(() => {
      /* already removed */
    });
}

export async function revokeSessionById(sessionId: string): Promise<void> {
  await prisma.session
    .delete({
      where: { id: sessionId },
    })
    .catch(() => {
      /* already removed */
    });
}

export function clearSession(response: NextResponse) {
  clearSessionCookie(response);
}

export function setSessionCookie(
  response: NextResponse,
  token: string,
  expiresAt: Date
) {
  attachSessionCookie(response, token, expiresAt);
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE_NAME;
}
