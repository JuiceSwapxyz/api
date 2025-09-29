import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';

/**
 * Extract IP address from request, considering proxy headers
 */
function getClientIp(req: Request): string {
  // Try x-forwarded-for header first (for proxies/load balancers)
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    return ips.split(',')[0].trim();
  }

  // Try x-real-ip header
  const realIp = req.headers['x-real-ip'];
  if (realIp) {
    return Array.isArray(realIp) ? realIp[0] : realIp;
  }

  // Fall back to req.ip or connection remote address
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Check if request has a valid connected wallet
 * Requests without wallet or with placeholder address get stricter limits
 */
function hasConnectedWallet(req: Request): boolean {
  const swapper = req.body?.swapper;
  const UNCONNECTED_ADDRESS = '0xAAAA44272dc658575Ba38f43C438447dDED45358';

  return swapper &&
         typeof swapper === 'string' &&
         swapper !== UNCONNECTED_ADDRESS &&
         swapper.match(/^0x[a-fA-F0-9]{40}$/); // Valid Ethereum address
}

/**
 * Rate limiter for quote endpoint
 * - 60 requests/minute for requests with connected wallet
 * - 10 requests/minute for requests without wallet (likely bots)
 */
export const quoteLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window

  // Dynamic limit based on whether wallet is connected
  max: (req) => {
    return hasConnectedWallet(req) ? 60 : 10;
  },

  // Use custom key generator to properly extract IP
  keyGenerator: getClientIp,

  // Return rate limit info in headers
  standardHeaders: true,
  legacyHeaders: false,

  // Custom error handler
  handler: (req: Request, res: Response) => {
    const ip = getClientIp(req);
    const hasWallet = hasConnectedWallet(req);

    console.log(`[Rate Limit] Blocked request from IP: ${ip}, hasWallet: ${hasWallet}`);

    res.status(429).json({
      error: 'Too many requests',
      message: 'You have exceeded the rate limit. Please try again later.',
      retryAfter: 60,
      hint: hasWallet ? 'Rate limit: 60 requests/minute' : 'Rate limit: 10 requests/minute (connect wallet for higher limit)'
    });
  },

  // Skip rate limiting for successful responses (optional - can be removed if too lenient)
  skipSuccessfulRequests: false,

  // Skip failed requests from counting (optional)
  skipFailedRequests: false,
});

/**
 * More lenient rate limiter for other endpoints (swap, etc.)
 * 100 requests per minute
 */
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  keyGenerator: getClientIp,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    const ip = getClientIp(req);
    console.log(`[Rate Limit] Blocked general request from IP: ${ip}`);

    res.status(429).json({
      error: 'Too many requests',
      message: 'You have exceeded the rate limit. Please try again later.',
      retryAfter: 60
    });
  },
});