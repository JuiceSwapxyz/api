import rateLimit from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';

// Skip rate limiting in development and test environments
// This matches AWS Lambda behavior (no app-level rate limiting)
const isDevelopment = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

// Pass-through middleware for development
const noOpLimiter = (_req: Request, _res: Response, next: NextFunction) => next();

// Quote endpoint rate limiter (stricter)
export const quoteLimiter = isDevelopment ? noOpLimiter : rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: parseInt(process.env.RATE_LIMIT_QUOTE_PER_MINUTE || '30'),
  message: {
    error: 'Too many requests',
    detail: 'You have exceeded the quote rate limit. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Rate limit by IP address
    const forwarded = req.headers['x-forwarded-for'] as string;
    const ip = forwarded ? forwarded.split(',')[0] : req.ip;
    return ip || 'unknown';
  },
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
  keyGenerator: (req) => {
    const forwarded = req.headers['x-forwarded-for'] as string;
    const ip = forwarded ? forwarded.split(',')[0] : req.ip;
    return ip || 'unknown';
  },
  skip: (req) => {
    return req.path === '/healthz' || req.path === '/readyz';
  },
});