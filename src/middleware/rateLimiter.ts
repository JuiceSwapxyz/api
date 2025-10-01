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

// Quote endpoint rate limiter (stricter)
export const quoteLimiter = isDevelopment ? noOpLimiter : rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: parseInt(process.env.RATE_LIMIT_QUOTE_PER_MINUTE || '1000'),
  message: {
    error: 'Too many requests',
    detail: 'You have exceeded the quote rate limit. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIp,
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/healthz' || req.path === '/readyz';
  },
});

// General endpoint rate limiter (more lenient)
export const generalLimiter = isDevelopment ? noOpLimiter : rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: parseInt(process.env.RATE_LIMIT_GENERAL_PER_MINUTE || '100'),
  message: {
    error: 'Too many requests',
    detail: 'You have exceeded the rate limit. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIp,
  skip: (req) => {
    return req.path === '/healthz' || req.path === '/readyz';
  },
});
