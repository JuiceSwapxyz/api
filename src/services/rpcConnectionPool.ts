/**
 * RPC Connection Pool Manager
 *
 * Manages RPC provider connections to prevent memory leaks and improve performance
 * under high load conditions like the Citrea bApps Campaign.
 */

import { providers } from 'ethers';

interface PooledProvider {
  provider: providers.JsonRpcProvider;
  activeRequests: number;
  lastUsed: number;
}

interface PoolConfig {
  maxConnectionsPerProvider: number;
  connectionTTL: number; // milliseconds
  maxRequestsPerConnection: number;
  cleanupInterval: number;
}

export class RpcConnectionPool {
  private pools: Map<string, PooledProvider[]> = new Map();
  private config: PoolConfig;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(config?: Partial<PoolConfig>) {
    this.config = {
      maxConnectionsPerProvider: 5,
      connectionTTL: 5 * 60 * 1000, // 5 minutes
      maxRequestsPerConnection: 100,
      cleanupInterval: 60 * 1000, // 1 minute
      ...config
    };

    // Start cleanup timer
    this.startCleanup();
  }

  /**
   * Get a provider from the pool or create a new one
   */
  async getProvider(rpcUrl: string): Promise<providers.JsonRpcProvider> {
    if (!this.pools.has(rpcUrl)) {
      this.pools.set(rpcUrl, []);
    }

    const pool = this.pools.get(rpcUrl)!;

    // Find an available connection
    let availableProvider = pool.find(p =>
      p.activeRequests < this.config.maxRequestsPerConnection
    );

    if (!availableProvider && pool.length < this.config.maxConnectionsPerProvider) {
      // Create new connection
      const provider = new providers.JsonRpcProvider(rpcUrl);

      // Set max listeners to prevent warnings
      // Note: In ethers v5, we cannot directly set max listeners

      availableProvider = {
        provider,
        activeRequests: 0,
        lastUsed: Date.now()
      };

      pool.push(availableProvider);
      console.log(`[RpcPool] Created new connection for ${this.getDomain(rpcUrl)} (pool size: ${pool.length})`);
    } else if (!availableProvider) {
      // All connections busy, wait for least busy one
      availableProvider = pool.reduce((least, current) =>
        current.activeRequests < least.activeRequests ? current : least
      );
    }

    // Track request
    availableProvider.activeRequests++;
    availableProvider.lastUsed = Date.now();

    // Wrap provider to track when request completes
    const wrappedProvider = this.wrapProvider(availableProvider, rpcUrl);

    return wrappedProvider;
  }

  /**
   * Wrap provider to track request completion
   */
  private wrapProvider(pooledProvider: PooledProvider, _rpcUrl: string): providers.JsonRpcProvider {
    const originalProvider = pooledProvider.provider;

    // Create a proxy to intercept calls
    return new Proxy(originalProvider, {
      get: (target, prop) => {
        const value = target[prop as keyof typeof target];

        // Intercept async methods
        if (typeof value === 'function') {
          return (...args: any[]) => {
            const result = (value as any).apply(target, args);

            // If it's a promise, track completion
            if (result instanceof Promise) {
              result.finally(() => {
                pooledProvider.activeRequests = Math.max(0, pooledProvider.activeRequests - 1);
              });
            }

            return result;
          };
        }

        return value;
      }
    }) as providers.JsonRpcProvider;
  }

  /**
   * Extract domain from RPC URL for logging
   */
  private getDomain(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      return url.substring(0, 30);
    }
  }

  /**
   * Start periodic cleanup of stale connections
   */
  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval);
  }

  /**
   * Remove stale connections
   */
  private cleanup(): void {
    const now = Date.now();
    let totalRemoved = 0;

    const poolEntries = Array.from(this.pools.entries());
    for (const [rpcUrl, pool] of poolEntries) {
      const initialSize = pool.length;

      // Remove stale connections
      const activePool = pool.filter(p => {
        const isStale = (now - p.lastUsed) > this.config.connectionTTL;
        const isIdle = p.activeRequests === 0;

        if (isStale && isIdle) {
          // Note: ethers v5 providers don't have destroy method
          return false;
        }

        return true;
      });

      if (activePool.length < initialSize) {
        this.pools.set(rpcUrl, activePool);
        const removed = initialSize - activePool.length;
        totalRemoved += removed;
        console.log(`[RpcPool] Cleaned ${removed} stale connections for ${this.getDomain(rpcUrl)}`);
      }

      // Remove empty pools
      if (activePool.length === 0) {
        this.pools.delete(rpcUrl);
      }
    }

    if (totalRemoved > 0) {
      console.log(`[RpcPool] Total connections cleaned: ${totalRemoved}`);
    }
  }

  /**
   * Get pool statistics
   */
  getStats(): object {
    const stats: any = {
      pools: {},
      totalConnections: 0,
      totalActiveRequests: 0
    };

    const poolEntries = Array.from(this.pools.entries());
    for (const [rpcUrl, pool] of poolEntries) {
      const poolStats = {
        connections: pool.length,
        activeRequests: pool.reduce((sum, p) => sum + p.activeRequests, 0),
        avgRequestsPerConnection: pool.length > 0
          ? pool.reduce((sum, p) => sum + p.activeRequests, 0) / pool.length
          : 0
      };

      stats.pools[this.getDomain(rpcUrl)] = poolStats;
      stats.totalConnections += poolStats.connections;
      stats.totalActiveRequests += poolStats.activeRequests;
    }

    return stats;
  }

  /**
   * Shutdown pool manager
   */
  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Close all connections
    const poolValues = Array.from(this.pools.values());
    for (const pool of poolValues) {
      // Note: ethers v5 providers don't have destroy method
      // Connections will be cleaned up automatically
      pool.length = 0;
    }

    this.pools.clear();
    console.log('[RpcPool] Connection pool shut down');
  }
}

// Singleton instance
export const rpcPool = new RpcConnectionPool({
  maxConnectionsPerProvider: 10, // Increased for Citrea campaign
  maxRequestsPerConnection: 50,  // Reduced to distribute load better
  connectionTTL: 10 * 60 * 1000, // 10 minutes for campaign duration
});