import Logger from "bunyan";
import { ChainId } from "@juiceswapxyz/sdk-core";
import { getPonderClient } from "./PonderClient";

interface GraduatedPool {
  pairAddress: string;
  token0: string;
  token1: string;
  launchpadTokenAddress: string;
  chainId: number;
}

/**
 * LaunchpadTokenService - Detects graduated launchpad tokens for V2 routing
 *
 * Caches the set of graduated launchpad token addresses from Ponder.
 * Used by quote/swap endpoints to automatically enable V2 protocol
 * when a graduated launchpad token is involved in the trade.
 */
class LaunchpadTokenService {
  // Per-chain cache of graduated token addresses
  private graduatedTokensByChain: Map<number, Set<string>> = new Map();
  private lastFetchByChain: Map<number, number> = new Map();
  private readonly CACHE_TTL = 60_000; // 1 minute (same as GraduatedV2SubgraphProvider)
  private logger: Logger | null = null;
  private fetchingChains: Set<number> = new Set();
  private fetchPromiseByChain: Map<number, Promise<void>> = new Map();

  private getLogger(): Logger {
    if (!this.logger) {
      // Create a basic logger if none provided
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const bunyan = require("bunyan");
      this.logger = bunyan.createLogger({
        name: "LaunchpadTokenService",
        level: "info",
      });
    }
    return this.logger!;
  }

  setLogger(logger: Logger): void {
    this.logger = logger.child({ service: "LaunchpadTokenService" });
  }

  /**
   * Check if a token address is a graduated launchpad token
   */
  async isGraduatedLaunchpadToken(
    chainId: number,
    address: string,
  ): Promise<boolean> {
    // Only check for Citrea chains (where launchpad tokens exist)
    if (chainId !== ChainId.CITREA_TESTNET && chainId !== ChainId.CITREA_MAINNET) {
      return false;
    }

    await this.refreshCacheIfNeeded(chainId);
    const chainTokens = this.graduatedTokensByChain.get(chainId);
    return chainTokens?.has(address.toLowerCase()) ?? false;
  }

  /**
   * Get all graduated token addresses for a specific chain (for debugging/logging)
   */
  async getGraduatedTokenAddresses(chainId: number): Promise<Set<string>> {
    await this.refreshCacheIfNeeded(chainId);
    return new Set(this.graduatedTokensByChain.get(chainId) ?? []);
  }

  /**
   * Refresh cache if TTL expired for a specific chain
   */
  private async refreshCacheIfNeeded(chainId: number): Promise<void> {
    const now = Date.now();
    const lastFetch = this.lastFetchByChain.get(chainId) ?? 0;
    if (now - lastFetch < this.CACHE_TTL) {
      return;
    }

    // Avoid concurrent fetches for the same chain
    if (this.fetchingChains.has(chainId)) {
      const existingPromise = this.fetchPromiseByChain.get(chainId);
      if (existingPromise) {
        return existingPromise;
      }
    }

    this.fetchingChains.add(chainId);
    const fetchPromise = this.fetchGraduatedTokens(chainId);
    this.fetchPromiseByChain.set(chainId, fetchPromise);

    try {
      await fetchPromise;
    } finally {
      this.fetchingChains.delete(chainId);
      this.fetchPromiseByChain.delete(chainId);
    }
  }

  /**
   * Fetch graduated tokens from Ponder for a specific chain
   */
  private async fetchGraduatedTokens(chainId: number): Promise<void> {
    const logger = this.getLogger();

    try {
      const ponderClient = getPonderClient(logger);
      const response = await ponderClient.get(`/graduated-pools?chainId=${chainId}`);
      const pools: GraduatedPool[] = response.data.pools || [];

      // Build set of graduated token addresses for this chain
      const tokenAddresses = new Set<string>();
      for (const pool of pools) {
        // Add the launchpad token address
        if (pool.launchpadTokenAddress) {
          tokenAddresses.add(pool.launchpadTokenAddress.toLowerCase());
        }
      }

      this.graduatedTokensByChain.set(chainId, tokenAddresses);
      this.lastFetchByChain.set(chainId, Date.now());

      logger.info(
        { chainId, graduatedTokenCount: tokenAddresses.size },
        "Refreshed graduated launchpad token cache",
      );
    } catch (error) {
      logger.error({ error, chainId }, "Failed to fetch graduated tokens from Ponder");
      // Keep existing cache on error
    }
  }

  /**
   * Clear cache (useful for testing)
   */
  clearCache(): void {
    this.graduatedTokensByChain.clear();
    this.lastFetchByChain.clear();
    this.fetchingChains.clear();
    this.fetchPromiseByChain.clear();
  }
}

// Singleton instance
const launchpadTokenService = new LaunchpadTokenService();

/**
 * Check if a token is a graduated launchpad token
 */
export async function isGraduatedLaunchpadToken(
  chainId: number,
  address: string,
): Promise<boolean> {
  return launchpadTokenService.isGraduatedLaunchpadToken(chainId, address);
}

/**
 * Get all graduated token addresses for a specific chain
 */
export async function getGraduatedTokenAddresses(chainId: number): Promise<Set<string>> {
  return launchpadTokenService.getGraduatedTokenAddresses(chainId);
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
