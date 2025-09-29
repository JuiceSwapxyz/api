/**
 * Rate Limiting Middleware for JuiceSwap API
 *
 * Protects the API from overload during high-traffic events
 * like the Citrea bApps Campaign.
 */

import { Request, Response, NextFunction } from 'express';

interface RateLimitConfig {
  windowMs: number;       // Time window in milliseconds
  maxRequests: number;    // Max requests per window
  maxRequestsPerIP: number; // Max requests per IP per window
  skipSuccessfulRequests: boolean; // Don't count successful cached requests
  message: string;        // Error message when rate limit exceeded
  headers: boolean;       // Send rate limit headers
  campaignMode: boolean;  // Special mode for campaigns with relaxed limits
}

interface RequestRecord {
  count: number;
  firstRequest: number;
  lastRequest: number;
  cachedHits: number;
}

export class RateLimiter {
  private requests: Map<string, RequestRecord> = new Map();
  private globalCount = 0;
  private windowStart = Date.now();
  private config: RateLimitConfig;
  private cleanupInterval: NodeJS.Timeout;

  constructor(config?: Partial<RateLimitConfig>) {
    this.config = {
      windowMs: 60 * 1000, // 1 minute
      maxRequests: 1000,   // Total requests per minute
      maxRequestsPerIP: 100, // Per IP per minute
      skipSuccessfulRequests: true,
      message: 'Too many requests, please try again later.',
      headers: true,
      campaignMode: true, // Enable campaign mode by default
      ...config
    };

    // Adjust limits for campaign mode
    if (this.config.campaignMode) {
      this.config.maxRequests = 2000;      // Double the normal limit
      this.config.maxRequestsPerIP = 200;  // Double per-IP limit
      console.log('[RateLimit] Campaign mode enabled - relaxed limits');
    }

    // Cleanup old entries periodically
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.config.windowMs);
  }

  /**
   * Express middleware function
   */
  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      this.handleRequest(req, res, next);
    };
  }

  /**
   * Handle incoming request
   */
  private handleRequest(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    const ip = this.getClientIP(req);

    // Reset window if expired
    if (now - this.windowStart > this.config.windowMs) {
      this.resetWindow();
    }

    // Get or create request record for this IP
    let record = this.requests.get(ip);
    if (!record) {
      record = {
        count: 0,
        firstRequest: now,
        lastRequest: now,
        cachedHits: 0
      };
      this.requests.set(ip, record);
    }

    // Check global rate limit
    if (this.globalCount >= this.config.maxRequests) {
      return this.sendRateLimitResponse(req, res, 'Global rate limit exceeded');
    }

    // Check per-IP rate limit
    if (record.count >= this.config.maxRequestsPerIP) {
      return this.sendRateLimitResponse(req, res, 'IP rate limit exceeded');
    }

    // Increment counters
    record.count++;
    record.lastRequest = now;
    this.globalCount++;

    // Add rate limit info to request
    (req as any).rateLimit = {
      limit: this.config.maxRequestsPerIP,
      current: record.count,
      remaining: Math.max(0, this.config.maxRequestsPerIP - record.count),
      resetTime: new Date(this.windowStart + this.config.windowMs)
    };

    // Set headers if enabled
    if (this.config.headers) {
      res.setHeader('X-RateLimit-Limit', this.config.maxRequestsPerIP.toString());
      res.setHeader('X-RateLimit-Remaining', (req as any).rateLimit.remaining.toString());
      res.setHeader('X-RateLimit-Reset', (req as any).rateLimit.resetTime.toISOString());
    }

    // Track response to potentially not count cached hits
    if (this.config.skipSuccessfulRequests) {
      const self = this;
      const originalSend = res.send;
      res.send = function(data: any) {
        // Check if response indicates a cache hit
        if (typeof data === 'string' && data.includes('"hitsCachedRoutes":true')) {
          // Don't count this against rate limit
          record!.count = Math.max(0, record!.count - 1);
          record!.cachedHits++;
          (req as any).rateLimit.current = record!.count;
          (req as any).rateLimit.remaining = Math.max(0, self.config.maxRequestsPerIP - record!.count);
        }
        return originalSend.call(this, data);
      };
    }

    next();
  }

  /**
   * Get client IP address
   */
  private getClientIP(req: Request): string {
    // Check various headers for real IP (when behind proxy)
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = (forwarded as string).split(',');
      return ips[0].trim();
    }

    const realIp = req.headers['x-real-ip'];
    if (realIp) {
      return realIp as string;
    }

    // Fallback to socket address
    return req.socket.remoteAddress || 'unknown';
  }

  /**
   * Send rate limit exceeded response
   */
  private sendRateLimitResponse(req: Request, res: Response, reason: string) {
    console.log(`[RateLimit] Request blocked - IP: ${this.getClientIP(req)} - Reason: ${reason}`);

    if (this.config.headers) {
      res.setHeader('Retry-After', Math.ceil(this.config.windowMs / 1000).toString());
    }

    res.status(429).json({
      error: this.config.message,
      retryAfter: Math.ceil(this.config.windowMs / 1000),
      reason: reason
    });
  }

  /**
   * Reset the rate limit window
   */
  private resetWindow() {
    this.windowStart = Date.now();
    this.globalCount = 0;
    this.requests.clear();
    console.log('[RateLimit] Window reset');
  }

  /**
   * Clean up old entries
   */
  private cleanup() {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;
    let removed = 0;

    const requestEntries = Array.from(this.requests.entries());
    for (const [ip, record] of requestEntries) {
      if (record.lastRequest < cutoff) {
        this.requests.delete(ip);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`[RateLimit] Cleaned ${removed} expired IP records`);
    }
  }

  /**
   * Get current statistics
   */
  getStats() {
    const now = Date.now();
    const windowAge = now - this.windowStart;
    const windowRemaining = Math.max(0, this.config.windowMs - windowAge);

    let totalCachedHits = 0;
    let topIPs: Array<{ ip: string; count: number; cachedHits: number }> = [];

    const requestEntries = Array.from(this.requests.entries());
    for (const [ip, record] of requestEntries) {
      totalCachedHits += record.cachedHits;
      topIPs.push({
        ip,
        count: record.count,
        cachedHits: record.cachedHits
      });
    }

    // Sort by request count and take top 5
    topIPs.sort((a, b) => b.count - a.count);
    topIPs = topIPs.slice(0, 5);

    return {
      windowMs: this.config.windowMs,
      maxRequests: this.config.maxRequests,
      maxRequestsPerIP: this.config.maxRequestsPerIP,
      currentGlobalCount: this.globalCount,
      uniqueIPs: this.requests.size,
      totalCachedHits,
      windowRemaining: `${Math.ceil(windowRemaining / 1000)}s`,
      campaignMode: this.config.campaignMode,
      topIPs
    };
  }

  /**
   * Shutdown rate limiter
   */
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.requests.clear();
    console.log('[RateLimit] Rate limiter shut down');
  }
}

// Export singleton instance
export const rateLimiter = new RateLimiter({
  windowMs: 60 * 1000,      // 1 minute window
  maxRequests: 2000,        // 2000 requests per minute (campaign mode)
  maxRequestsPerIP: 200,    // 200 per IP per minute (campaign mode)
  skipSuccessfulRequests: true, // Don't count cached hits
  campaignMode: true        // Enable campaign optimizations
});

// Export middleware function
export const rateLimitMiddleware = rateLimiter.middleware();