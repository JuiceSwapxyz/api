import rateLimit from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';

// Skip rate limiting in development and test environments
// This matches AWS Lambda behavior (no app-level rate limiting)
const isDevelopment = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

// Pass-through middleware for development
const noOpLimiter = (_req: Request, _res: Response, next: NextFunction) => next();

/**
 * Extract client IP address from request
 * Properly handles X-Forwarded-For header and falls back to socket address
 */
function getClientIp(req: Request): string {
  // Try X-Forwarded-For header (set by proxies/load balancers)
  const forwarded = req.headers['x-forwarded-for'] as string;
  if (forwarded) {
    // X-Forwarded-For can be a comma-separated list; use the first IP
    return forwarded.split(',')[0].trim();
  }

  // Fall back to req.ip or connection remote address
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Rate limiter for quote endpoint
 * IP-based rate limiting: 2000 requests per minute per IP (matches develop's 20000/10min)
 * Disabled in development/test environments for better DX
 */
export const quoteLimiter = isDevelopment ? noOpLimiter : rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: parseInt(process.env.RATE_LIMIT_QUOTE_PER_MINUTE || '2000'),

  // Use custom key generator to properly extract IP
  keyGenerator: getClientIp,

  // Return rate limit info in headers
  standardHeaders: true,
  legacyHeaders: false,

  // Custom error handler with IP logging
  handler: (req: Request, res: Response) => {
    const ip = getClientIp(req);
    console.log(`[Rate Limit] Blocked quote request from IP: ${ip}`);

    res.status(429).json({
      error: 'Too many requests',
      message: 'You have exceeded the quote rate limit. Please try again later.',
      retryAfter: 60,
    });
  },

  // Skip rate limiting for health checks
  skip: (req) => {
    return req.path === '/healthz' || req.path === '/readyz';
  },
});

/**
 * More lenient rate limiter for other endpoints (swap, lp/approve, lp/create)
 * IP-based rate limiting: 10000 requests per minute per IP
 * Disabled in development/test environments for better DX
 */
export const generalLimiter = isDevelopment ? noOpLimiter : rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: parseInt(process.env.RATE_LIMIT_GENERAL_PER_MINUTE || '10000'),

  // Use custom key generator to properly extract IP
  keyGenerator: getClientIp,

  // Return rate limit info in headers
  standardHeaders: true,
  legacyHeaders: false,

  // Custom error handler with IP logging
  handler: (req: Request, res: Response) => {
    const ip = getClientIp(req);
    console.log(`[Rate Limit] Blocked general request from IP: ${ip}`);

    res.status(429).json({
      error: 'Too many requests',
      message: 'You have exceeded the rate limit. Please try again later.',
      retryAfter: 60,
    });
  },

  // Skip rate limiting for health checks
  skip: (req) => {
    return req.path === '/healthz' || req.path === '/readyz';
  },
});
