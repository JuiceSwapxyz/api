/**
 * Portfolio Cache Service for JuiceSwap API
 *
 * Caches wallet portfolio balances to reduce RPC calls and improve response times.
 * Balances are cached for 30 seconds as they change less frequently than quotes.
 */

import Logger from 'bunyan';

interface CachedPortfolio {
  data: any;
  timestamp: number;
  hitCount: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  totalRequests: number;
  cacheSize: number;
  avgHitRate: number;
}

export class PortfolioCache {
  private cache: Map<string, CachedPortfolio> = new Map();
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    totalRequests: 0,
    cacheSize: 0,
    avgHitRate: 0,
  };
  private logger?: Logger;

  // Configuration
  private readonly DEFAULT_TTL = 30_000; // 30 seconds (balances don't change as fast as quotes)
  private readonly MAX_CACHE_SIZE = 500;
  private readonly CLEANUP_INTERVAL = 60_000; // Run cleanup every minute

  constructor(logger?: Logger) {
    this.logger = logger;
    // Start periodic cleanup
    setInterval(() => this.cleanup(), this.CLEANUP_INTERVAL);
    if (this.logger) {
      this.logger.debug('[PortfolioCache] Initialized with TTL: 30s');
    }
  }

  /**
   * Set logger after construction (for singleton pattern)
   */
  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  /**
   * Generate cache key from wallet address and chain ID
   */
  private generateKey(chainId: number, address: string): string {
    return `${chainId}_${address.toLowerCase()}`;
  }

  /**
   * Get cached portfolio if available and valid
   */
  get(chainId: number, address: string): any | null {
    const key = this.generateKey(chainId, address);
    const cached = this.cache.get(key);

    this.stats.totalRequests++;

    if (!cached) {
      this.stats.misses++;
      this.updateHitRate();
      this.logger?.debug(`[PortfolioCache] MISS - Address: ${address.substring(0, 10)}...`);
      return null;
    }

    const age = Date.now() - cached.timestamp;

    if (age > this.DEFAULT_TTL) {
      // Expired entry
      this.cache.delete(key);
      this.stats.misses++;
      this.updateHitRate();
      this.logger?.debug(
        `[PortfolioCache] EXPIRED - Address: ${address.substring(0, 10)}... (age: ${age}ms)`
      );
      return null;
    }

    // Cache hit!
    cached.hitCount++;
    this.stats.hits++;
    this.updateHitRate();

    this.logger?.debug(
      `[PortfolioCache] HIT - Address: ${address.substring(0, 10)}... (age: ${age}ms, hits: ${cached.hitCount})`
    );

    return cached.data;
  }

  /**
   * Store portfolio in cache
   */
  set(chainId: number, address: string, data: any): void {
    const key = this.generateKey(chainId, address);

    // Enforce size limit
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      this.evictOldest();
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      hitCount: 0,
    });

    this.stats.cacheSize = this.cache.size;

    this.logger?.debug(
      `[PortfolioCache] STORED - Address: ${address.substring(0, 10)}... (size: ${this.cache.size})`
    );
  }

  /**
   * Remove expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    let removed = 0;

    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.DEFAULT_TTL) {
        this.cache.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger?.debug(`[PortfolioCache] Cleanup removed ${removed} expired entries`);
    }

    this.stats.cacheSize = this.cache.size;
  }

  /**
   * Evict oldest entry (LRU)
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Date.now();

    for (const [key, value] of this.cache.entries()) {
      if (value.timestamp < oldestTime) {
        oldestTime = value.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.logger?.debug(`[PortfolioCache] Evicted oldest entry: ${oldestKey.substring(0, 20)}...`);
    }
  }

  /**
   * Update hit rate statistics
   */
  private updateHitRate(): void {
    if (this.stats.totalRequests > 0) {
      this.stats.avgHitRate = (this.stats.hits / this.stats.totalRequests) * 100;
    }
  }

  /**
   * Get cache statistics for monitoring
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    this.cache.clear();
    this.stats.cacheSize = 0;
    this.logger?.debug('[PortfolioCache] Cache cleared');
  }
}

// Singleton instance
export const portfolioCache = new PortfolioCache();
