import Logger from 'bunyan';
import { ChainId } from '@juiceswapxyz/sdk-core';
import { getPonderClient } from './PonderClient';

interface GraduatedPool {
  pairAddress: string;
  token0: string;
  token1: string;
  launchpadTokenAddress: string;
}

/**
 * LaunchpadTokenService - Detects graduated launchpad tokens for V2 routing
 *
 * Caches the set of graduated launchpad token addresses from Ponder.
 * Used by quote/swap endpoints to automatically enable V2 protocol
 * when a graduated launchpad token is involved in the trade.
 */
class LaunchpadTokenService {
  private graduatedTokens: Set<string> = new Set();
  private lastFetch: number = 0;
  private readonly CACHE_TTL = 60_000; // 1 minute (same as GraduatedV2SubgraphProvider)
  private logger: Logger | null = null;
  private isFetching: boolean = false;
  private fetchPromise: Promise<void> | null = null;

  private getLogger(): Logger {
    if (!this.logger) {
      // Create a basic logger if none provided
      const bunyan = require('bunyan');
      this.logger = bunyan.createLogger({
        name: 'LaunchpadTokenService',
        level: 'info',
      });
    }
    return this.logger!;
  }

  setLogger(logger: Logger): void {
    this.logger = logger.child({ service: 'LaunchpadTokenService' });
  }

  /**
   * Check if a token address is a graduated launchpad token
   */
  async isGraduatedLaunchpadToken(chainId: number, address: string): Promise<boolean> {
    // Only check for Citrea Testnet (where launchpad tokens exist)
    if (chainId !== ChainId.CITREA_TESTNET) {
      return false;
    }

    await this.refreshCacheIfNeeded();
    return this.graduatedTokens.has(address.toLowerCase());
  }

  /**
   * Get all graduated token addresses (for debugging/logging)
   */
  async getGraduatedTokenAddresses(): Promise<Set<string>> {
    await this.refreshCacheIfNeeded();
    return new Set(this.graduatedTokens);
  }

  /**
   * Refresh cache if TTL expired
   */
  private async refreshCacheIfNeeded(): Promise<void> {
    const now = Date.now();
    if (now - this.lastFetch < this.CACHE_TTL) {
      return;
    }

    // Avoid concurrent fetches
    if (this.isFetching && this.fetchPromise) {
      return this.fetchPromise;
    }

    this.isFetching = true;
    this.fetchPromise = this.fetchGraduatedTokens();

    try {
      await this.fetchPromise;
    } finally {
      this.isFetching = false;
      this.fetchPromise = null;
    }
  }

  /**
   * Fetch graduated tokens from Ponder
   */
  private async fetchGraduatedTokens(): Promise<void> {
    const logger = this.getLogger();

    try {
      const ponderClient = getPonderClient(logger);
      const response = await ponderClient.get('/graduated-pools');
      const pools: GraduatedPool[] = response.data.pools || [];

      // Build set of graduated token addresses
      const tokenAddresses = new Set<string>();
      for (const pool of pools) {
        // Add the launchpad token address
        if (pool.launchpadTokenAddress) {
          tokenAddresses.add(pool.launchpadTokenAddress.toLowerCase());
        }
      }

      this.graduatedTokens = tokenAddresses;
      this.lastFetch = Date.now();

      logger.info(
        { graduatedTokenCount: tokenAddresses.size },
        'Refreshed graduated launchpad token cache'
      );
    } catch (error) {
      logger.error({ error }, 'Failed to fetch graduated tokens from Ponder');
      // Keep existing cache on error
    }
  }

  /**
   * Clear cache (useful for testing)
   */
  clearCache(): void {
    this.graduatedTokens.clear();
    this.lastFetch = 0;
  }
}

// Singleton instance
const launchpadTokenService = new LaunchpadTokenService();

/**
 * Check if a token is a graduated launchpad token
 */
export async function isGraduatedLaunchpadToken(
  chainId: number,
  address: string
): Promise<boolean> {
  return launchpadTokenService.isGraduatedLaunchpadToken(chainId, address);
}

/**
 * Get all graduated token addresses
 */
export async function getGraduatedTokenAddresses(): Promise<Set<string>> {
  return launchpadTokenService.getGraduatedTokenAddresses();
}

/**
 * Set logger for the service
 */
export function setLaunchpadTokenServiceLogger(logger: Logger): void {
  launchpadTokenService.setLogger(logger);
}

/**
 * Clear the cache (for testing)
 */
export function clearLaunchpadTokenCache(): void {
  launchpadTokenService.clearCache();
}

export { launchpadTokenService };
