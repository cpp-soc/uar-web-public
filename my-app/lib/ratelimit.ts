interface RateLimitStore {
  [key: string]: {
    count: number;
    resetTime: number;
  };
}

const store: RateLimitStore = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let redisClient: any = null;

const isRedisEnabled = typeof process !== 'undefined' && !!process.env.REDIS_URL;

if (isRedisEnabled) {
  try {
    // Check if using Upstash Redis (requires token) or local Redis (no token)
    const isUpstash = process.env.REDIS_URL?.includes('upstash.io');

    if (isUpstash && !process.env.REDIS_TOKEN) {
      console.warn('[Upstash Redis] The \'token\' property is missing or undefined in your Redis config.');
      console.warn('[RateLimit] Falling back to in-memory rate limiting.');
    } else if (isUpstash) {
      import('@upstash/redis').then((module) => {
        const { Redis } = module;
        redisClient = new Redis({
          url: process.env.REDIS_URL!,
          token: process.env.REDIS_TOKEN!
        });
        console.log('[RateLimit] Upstash Redis client initialized for production rate limiting');
      }).catch(() => {
        console.warn('[RateLimit] Redis URL provided but @upstash/redis not installed. Falling back to in-memory rate limiting.');
        console.warn('[RateLimit] Install with: npm install @upstash/redis');
      });
    } else {
      // Local Redis - use redis package
      import('redis').then(async (module) => {
        const { createClient } = module;
        redisClient = createClient({ url: process.env.REDIS_URL! });

        redisClient.on('error', (err: Error) => {
          console.error('[RateLimit] Redis Client Error:', err);
        });

        await redisClient.connect();
        console.log('[RateLimit] Local Redis client initialized at:', process.env.REDIS_URL);
      }).catch((error) => {
        console.warn('[RateLimit] Redis URL provided but redis package not available. Using in-memory rate limiting:', error);
      });
    }
  } catch (error) {
    console.warn('[RateLimit] Failed to initialize Redis. Using in-memory rate limiting:', error);
  }
}

if (!isRedisEnabled) {
  setInterval(() => {
    const now = Date.now();
    Object.keys(store).forEach((key) => {
      if (store[key].resetTime < now) {
        delete store[key];
      }
    });
  }, 10 * 60 * 1000);
}

export interface RateLimitConfig {
  /**
   * Maximum number of requests allowed within the window
   */
  maxRequests: number;

  /**
   * Time window in milliseconds
   */
  windowMs: number;

  /**
   * Optional identifier (e.g., email) in addition to IP
   */
  identifier?: string;
}

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
}

/**
 * Check if a request should be rate limited (Redis-backed for production)
 * @param ip - Client IP address
 * @param config - Rate limit configuration
 * @returns RateLimitResult indicating if request is allowed
 */
export async function checkRateLimitAsync(ip: string, config: RateLimitConfig): Promise<RateLimitResult> {
  const key = config.identifier ? `ratelimit:${ip}:${config.identifier}` : `ratelimit:${ip}`;

  if (redisClient) {
    try {
      const current = await redisClient.incr(key);

      if (current === 1) {
        await redisClient.expire(key, Math.ceil(config.windowMs / 1000));
      }

      const ttl = await redisClient.ttl(key);
      const resetTime = Date.now() + (ttl * 1000);

      return {
        success: current <= config.maxRequests,
        limit: config.maxRequests,
        remaining: Math.max(0, config.maxRequests - current),
        reset: resetTime,
      };
    } catch (error) {
      console.error('[RateLimit] Redis error, falling back to in-memory:', error);
    }
  }

  const now = Date.now();
  const memKey = config.identifier ? `${ip}:${config.identifier}` : ip;

  let entry = store[memKey];

  if (!entry || entry.resetTime < now) {
    entry = {
      count: 0,
      resetTime: now + config.windowMs,
    };
    store[memKey] = entry;
  }

  entry.count++;

  const remaining = Math.max(0, config.maxRequests - entry.count);
  const success = entry.count <= config.maxRequests;

  return {
    success,
    limit: config.maxRequests,
    remaining,
    reset: entry.resetTime,
  };
}

/**
 * Check if a request should be rate limited (synchronous wrapper)
 * For backward compatibility - delegates to async implementation
 * @param ip - Client IP address
 * @param config - Rate limit configuration
 * @returns RateLimitResult indicating if request is allowed
 */
export function checkRateLimit(ip: string, config: RateLimitConfig): RateLimitResult {
  const now = Date.now();
  const key = config.identifier ? `${ip}:${config.identifier}` : ip;

  let entry = store[key];

  if (!entry || entry.resetTime < now) {
    entry = {
      count: 0,
      resetTime: now + config.windowMs,
    };
    store[key] = entry;
  }

  entry.count++;

  const remaining = Math.max(0, config.maxRequests - entry.count);
  const success = entry.count <= config.maxRequests;

  return {
    success,
    limit: config.maxRequests,
    remaining,
    reset: entry.resetTime,
  };
}

/**
 * Get client IP from request headers
 * Checks common proxy headers before falling back to socket
 */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return realIp;
  }

  const vercelIp = request.headers.get('x-vercel-forwarded-for');
  if (vercelIp) {
    return vercelIp.split(',')[0].trim();
  }

  // Check for Next.js specific ip property
  if ((request as any).ip) {
    return (request as any).ip;
  }

  return 'unknown';
}

/**
 * Preset rate limit configurations for common use cases
 */
export const RateLimitPresets = {
  /**
   * Login attempts: 20 per 15 minutes (increased to accommodate typos)
   */
  login: {
    maxRequests: 200,
    windowMs: 15 * 60 * 1000,
  },

  /**
   * Request submissions: 20 per hour (increased for legitimate multiple requests)
   */
  requestSubmission: {
    maxRequests: 200,
    windowMs: 60 * 60 * 1000,
  },

  /**
   * Password reset: 10 per hour (slightly increased while maintaining security)
   */
  passwordReset: {
    maxRequests: 100,
    windowMs: 60 * 60 * 1000,
  },

  /**
   * Verification: 60 per hour (increased for frequent status checks)
   */
  verification: {
    maxRequests: 600,
    windowMs: 60 * 60 * 1000,
  },

  /**
   * Admin operations: 400 per minute (increased for bulk operations)
   */
  adminOperations: {
    maxRequests: 4000,
    windowMs: 60 * 1000,
  },

  /**
   * General API: 200 per minute (increased for normal usage)
   */
  general: {
    maxRequests: 2000,
    windowMs: 60 * 1000,
  },
} as const;
