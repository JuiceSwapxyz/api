/**
 * Azure Table Storage Cache Service
 *
 * Alternative to DynamoDB for Azure deployments
 * Provides distributed route caching across multiple App Service instances
 */

import { TableClient, TableEntity } from '@azure/data-tables';

interface RouteEntity extends TableEntity {
  partitionKey: string; // Chain combination (e.g., "1_137")
  rowKey: string;       // Route hash
  routeData: string;    // JSON serialized route
  hitCount: number;
  lastAccessed: Date;
  ttl: number;
}

interface CacheEntry {
  data: any;
  hitCount: number;
  lastAccessed: Date;
  ttl: number;
}

export class AzureTableCache {
  private client: TableClient | null = null;
  private tableName = 'juiceswapRoutes';
  private fallbackCache = new Map<string, CacheEntry>();

  // Configuration
  private readonly DEFAULT_TTL = 24 * 60 * 60; // 24 hours in seconds
  private readonly CITREA_TTL = 12 * 60 * 60;  // 12 hours for Citrea
  private readonly MAX_FALLBACK_SIZE = 500;

  constructor() {
    this.initializeClient();
  }

  /**
   * Initialize Azure Table Storage client
   */
  private async initializeClient() {
    try {
      const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;

      if (!connectionString) {
        console.warn('[AzureCache] No Azure Storage connection string found, using fallback cache');
        return;
      }

      this.client = new TableClient(connectionString, this.tableName);

      // Create table if it doesn't exist
      await this.client.createTable();

      console.log('[AzureCache] Connected to Azure Table Storage');
    } catch (error) {
      console.error('[AzureCache] Failed to initialize Azure client:', error);
      console.log('[AzureCache] Falling back to in-memory cache');
    }
  }

  /**
   * Generate cache key for route
   */
  private generateKey(params: any): { partitionKey: string; rowKey: string } {
    const {
      tokenInChainId,
      tokenOutChainId,
      tokenIn,
      tokenOut,
      amount,
      type = 'EXACT_INPUT'
    } = params;

    // Partition by chain combination for better distribution
    const partitionKey = `${tokenInChainId}_${tokenOutChainId}`;

    // Create deterministic row key
    const routeParams = [
      (tokenIn || '').toLowerCase(),
      (tokenOut || '').toLowerCase(),
      amount,
      type
    ].join('_');

    // Hash for shorter key (Azure has 1KB limit)
    const rowKey = this.hashString(routeParams);

    return { partitionKey, rowKey };
  }

  /**
   * Simple hash function for generating row keys
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Check if this is a Citrea route for different TTL
   */
  private isCitreaRoute(params: any): boolean {
    const CITREA_CHAIN_ID = 5115;
    return params.tokenInChainId === CITREA_CHAIN_ID ||
           params.tokenOutChainId === CITREA_CHAIN_ID;
  }

  /**
   * Get TTL based on route type
   */
  private getTTL(params: any): number {
    return this.isCitreaRoute(params) ? this.CITREA_TTL : this.DEFAULT_TTL;
  }

  /**
   * Get cached route from Azure Table Storage
   */
  async get(params: any): Promise<any | null> {
    const { partitionKey, rowKey } = this.generateKey(params);
    const cacheKey = `${partitionKey}_${rowKey}`;

    try {
      // Try Azure Table Storage first
      if (this.client) {
        const entity = await this.client.getEntity<RouteEntity>(partitionKey, rowKey);

        if (entity) {
          const now = Math.floor(Date.now() / 1000);
          const age = now - Math.floor(entity.lastAccessed.getTime() / 1000);

          if (age < entity.ttl) {
            // Update hit count and last accessed
            await this.client.updateEntity({
              partitionKey,
              rowKey,
              hitCount: entity.hitCount + 1,
              lastAccessed: new Date()
            }, 'Merge');

            console.log(`[AzureCache] HIT - ${cacheKey} (age: ${age}s, hits: ${entity.hitCount + 1})`);
            return JSON.parse(entity.routeData);
          } else {
            // Expired, delete entity
            await this.client.deleteEntity(partitionKey, rowKey);
            console.log(`[AzureCache] EXPIRED - ${cacheKey} (age: ${age}s)`);
          }
        }
      }

      // Fallback to in-memory cache
      const fallbackEntry = this.fallbackCache.get(cacheKey);
      if (fallbackEntry) {
        const now = Date.now();
        const age = Math.floor((now - fallbackEntry.lastAccessed.getTime()) / 1000);

        if (age < fallbackEntry.ttl) {
          fallbackEntry.hitCount++;
          fallbackEntry.lastAccessed = new Date();
          console.log(`[AzureCache] FALLBACK HIT - ${cacheKey} (age: ${age}s)`);
          return fallbackEntry.data;
        } else {
          this.fallbackCache.delete(cacheKey);
        }
      }

      console.log(`[AzureCache] MISS - ${cacheKey}`);
      return null;

    } catch (error) {
      console.error(`[AzureCache] Error getting ${cacheKey}:`, error);
      return null;
    }
  }

  /**
   * Store route in Azure Table Storage
   */
  async set(params: any, data: any): Promise<void> {
    const { partitionKey, rowKey } = this.generateKey(params);
    const cacheKey = `${partitionKey}_${rowKey}`;
    const ttl = this.getTTL(params);

    try {
      // Store in Azure Table Storage
      if (this.client) {
        const entity: RouteEntity = {
          partitionKey,
          rowKey,
          routeData: JSON.stringify(data),
          hitCount: 0,
          lastAccessed: new Date(),
          ttl
        };

        await this.client.upsertEntity(entity, 'Replace');
        console.log(`[AzureCache] STORED - ${cacheKey} (TTL: ${ttl}s)`);
      } else {
        // Store in fallback cache
        if (this.fallbackCache.size >= this.MAX_FALLBACK_SIZE) {
          // Remove oldest entry
          const oldestKey = Array.from(this.fallbackCache.keys())[0];
          this.fallbackCache.delete(oldestKey);
        }

        this.fallbackCache.set(cacheKey, {
          data,
          hitCount: 0,
          lastAccessed: new Date(),
          ttl
        });

        console.log(`[AzureCache] FALLBACK STORED - ${cacheKey}`);
      }

    } catch (error) {
      console.error(`[AzureCache] Error storing ${cacheKey}:`, error);
    }
  }

  /**
   * Check if route should be cached
   */
  shouldCache(params: any, response: any): boolean {
    // Don't cache failed routes
    if (!response || response.error || response.state === 'NOT_FOUND') {
      return false;
    }

    // Always cache Citrea routes (campaign optimization)
    if (this.isCitreaRoute(params)) {
      return true;
    }

    // Don't cache very large trades
    const amount = parseFloat(params.amount || '0');
    if (amount > 100e18) {
      return false;
    }

    return true;
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<any> {
    const stats: any = {
      provider: this.client ? 'Azure Table Storage' : 'Fallback Cache',
      fallbackSize: this.fallbackCache.size,
      azureConnected: !!this.client
    };

    if (this.client) {
      try {
        // Get sample of entities to calculate stats
        const entities = this.client.listEntities<RouteEntity>({
          select: ['hitCount', 'lastAccessed', 'ttl']
        });

        let totalHits = 0;
        let entityCount = 0;
        let oldestAccess = Date.now();

        for await (const entity of entities) {
          totalHits += entity.hitCount || 0;
          entityCount++;

          const accessTime = entity.lastAccessed.getTime();
          if (accessTime < oldestAccess) {
            oldestAccess = accessTime;
          }

          // Limit sample size for performance
          if (entityCount >= 100) break;
        }

        stats.azureStats = {
          estimatedEntities: entityCount,
          totalHits,
          avgHitsPerEntity: entityCount > 0 ? Math.round(totalHits / entityCount) : 0,
          oldestEntry: entityCount > 0 ? new Date(oldestAccess).toISOString() : null
        };

      } catch (error) {
        stats.azureError = error.message;
      }
    }

    return stats;
  }

  /**
   * Clear cache (for testing/maintenance)
   */
  async clear(): Promise<void> {
    try {
      if (this.client) {
        // Delete all entities (expensive operation, use carefully)
        const entities = this.client.listEntities();

        for await (const entity of entities) {
          await this.client.deleteEntity(entity.partitionKey!, entity.rowKey!);
        }

        console.log('[AzureCache] Azure Table Storage cleared');
      }

      this.fallbackCache.clear();
      console.log('[AzureCache] Fallback cache cleared');

    } catch (error) {
      console.error('[AzureCache] Error clearing cache:', error);
    }
  }

  /**
   * Cleanup expired entries (for maintenance)
   */
  async cleanup(): Promise<void> {
    try {
      if (!this.client) return;

      const now = Math.floor(Date.now() / 1000);
      const entities = this.client.listEntities<RouteEntity>();
      let deletedCount = 0;

      for await (const entity of entities) {
        const age = now - Math.floor(entity.lastAccessed.getTime() / 1000);

        if (age > entity.ttl) {
          await this.client.deleteEntity(entity.partitionKey!, entity.rowKey!);
          deletedCount++;
        }
      }

      if (deletedCount > 0) {
        console.log(`[AzureCache] Cleanup removed ${deletedCount} expired entries`);
      }

    } catch (error) {
      console.error('[AzureCache] Error during cleanup:', error);
    }
  }
}

// Singleton instance
export const azureCache = new AzureTableCache();