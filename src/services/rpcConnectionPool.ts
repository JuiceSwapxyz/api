/**
 * RPC Connection Pool Manager
 *
 * Manages RPC provider connections to prevent memory leaks and improve performance
 * under high load conditions like the Citrea bApps Campaign.
 */

import { ethers } from 'ethers';

interface PooledProvider {
  provider: ethers.JsonRpcProvider;
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
  async getProvider(rpcUrl: string): Promise<ethers.JsonRpcProvider> {
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
      const provider = new ethers.JsonRpcProvider(rpcUrl);

      // Set max listeners to prevent warnings
      provider._events.setMaxListeners(50);

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
  private wrapProvider(pooledProvider: PooledProvider, rpcUrl: string): ethers.JsonRpcProvider {
    const originalProvider = pooledProvider.provider;

    // Create a proxy to intercept calls
    return new Proxy(originalProvider, {
      get: (target, prop) => {
        const value = target[prop as keyof typeof target];

        // Intercept async methods
        if (typeof value === 'function') {
          return (...args: any[]) => {
            const result = value.apply(target, args);

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
    }) as ethers.JsonRpcProvider;
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

    for (const [rpcUrl, pool] of this.pools.entries()) {
      const initialSize = pool.length;

      // Remove stale connections
      const activePool = pool.filter(p => {
        const isStale = (now - p.lastUsed) > this.config.connectionTTL;
        const isIdle = p.activeRequests === 0;

        if (isStale && isIdle) {
          // Clean up provider
          p.provider.destroy();
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

    for (const [rpcUrl, pool] of this.pools.entries()) {
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
    for (const pool of this.pools.values()) {
      for (const p of pool) {
        p.provider.destroy();
      }
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