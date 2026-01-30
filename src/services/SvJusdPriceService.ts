import { ethers } from "ethers";
import { ChainId } from "@juiceswapxyz/sdk-core";
import Logger from "bunyan";
import {
  getChainContracts,
  hasJuiceDollarIntegration,
} from "../config/contracts";

/**
 * ABI for ERC4626 vault (svJUSD)
 */
const ERC4626_ABI = [
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
];

interface PriceCacheEntry {
  sharePrice: ethers.BigNumber;
  timestamp: number;
}

export interface SvJusdSharePriceInfo {
  chainId: number;
  sharePrice: string;
  sharePriceDecimals: number;
  svJusdAddress: string;
  jusdAddress: string;
  timestamp: number;
}

/**
 * SvJusdPriceService - Handles svJUSD share price with caching
 *
 * The svJUSD token is an ERC4626 vault that accumulates interest over time.
 * Its share price (assets per share) increases as interest accrues.
 *
 * This service provides:
 * 1. Cached share price retrieval (30s TTL)
 * 2. JUSD ↔ svJUSD conversion utilities
 * 3. Price adjustment calculations for LP operations
 *
 * The share price is critical for accurate dependent amount calculations
 * when creating or modifying liquidity positions involving JUSD.
 */
export class SvJusdPriceService {
  private logger: Logger;
  private priceCache: Map<ChainId, PriceCacheEntry> = new Map();
  private svJusdContracts: Map<ChainId, ethers.Contract> = new Map();

  /** Cache TTL in milliseconds (30 seconds - roughly 2 blocks) */
  private readonly CACHE_TTL_MS = 30_000;

  /** Default share price (1:1) used as fallback */
  private readonly DEFAULT_SHARE_PRICE = ethers.utils.parseEther("1");

  constructor(
    providers: Map<ChainId, ethers.providers.StaticJsonRpcProvider>,
    logger: Logger,
  ) {
    this.logger = logger.child({ service: "SvJusdPriceService" });

    // Initialize contracts for chains with JuiceDollar integration
    for (const [chainId, provider] of providers) {
      const contracts = getChainContracts(chainId);
      if (contracts && hasJuiceDollarIntegration(chainId)) {
        this.svJusdContracts.set(
          chainId,
          new ethers.Contract(contracts.SV_JUSD, ERC4626_ABI, provider),
        );
        this.logger.info({ chainId }, "svJUSD contract initialized");
      }
    }
  }

  /**
   * Get the current svJUSD share price (JUSD per svJUSD)
   *
   * Uses cached value if available and not stale.
   * Falls back to default (1.0) on error.
   *
   * @param chainId - The chain to query
   * @returns Share price as BigNumber (18 decimals, e.g., 1.02e18 = 1.02 JUSD per svJUSD)
   */
  async getSharePrice(chainId: ChainId): Promise<ethers.BigNumber> {
    // Check cache first
    const cached = this.priceCache.get(chainId);
    const now = Date.now();

    if (cached && now - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.sharePrice;
    }

    // Fetch fresh price
    try {
      const freshPrice = await this.fetchOnChainSharePrice(chainId);
      this.priceCache.set(chainId, {
        sharePrice: freshPrice,
        timestamp: now,
      });
      return freshPrice;
    } catch (error) {
      this.logger.error(
        { chainId, error },
        "Failed to fetch svJUSD share price",
      );

      // Fallback 1: Use stale cached value
      if (cached) {
        this.logger.warn(
          { chainId, cacheAge: now - cached.timestamp },
          "Using stale svJUSD share price due to error",
        );
        return cached.sharePrice;
      }

      // Fallback 2: Use default (1:1)
      this.logger.warn(
        { chainId },
        "No cached price available, using default 1:1",
      );
      return this.DEFAULT_SHARE_PRICE;
    }
  }

  /**
   * Get share price info for API response
   */
  async getSharePriceInfo(
    chainId: ChainId,
  ): Promise<SvJusdSharePriceInfo | null> {
    if (!hasJuiceDollarIntegration(chainId)) {
      return null;
    }

    const contracts = getChainContracts(chainId);
    if (!contracts) {
      return null;
    }

    const sharePrice = await this.getSharePrice(chainId);
    const cached = this.priceCache.get(chainId);

    return {
      chainId,
      sharePrice: sharePrice.toString(),
      sharePriceDecimals: 18,
      svJusdAddress: contracts.SV_JUSD,
      jusdAddress: contracts.JUSD,
      timestamp: cached?.timestamp || Date.now(),
    };
  }

  /**
   * Convert JUSD amount to svJUSD shares using current share price
   *
   * @param chainId - The chain
   * @param jusdAmount - JUSD amount as string (in wei)
   * @returns svJUSD shares as string (in wei)
   */
  async jusdToSvJusd(chainId: ChainId, jusdAmount: string): Promise<string> {
    const sharePrice = await this.getSharePrice(chainId);

    // svJUSD = JUSD * 1e18 / sharePrice
    const jusdBN = ethers.BigNumber.from(jusdAmount);
    const svJusdShares = jusdBN
      .mul(ethers.utils.parseEther("1"))
      .div(sharePrice);

    return svJusdShares.toString();
  }

  /**
   * Convert svJUSD shares to JUSD amount using current share price
   *
   * @param chainId - The chain
   * @param svJusdAmount - svJUSD shares as string (in wei)
   * @returns JUSD amount as string (in wei)
   */
  async svJusdToJusd(chainId: ChainId, svJusdAmount: string): Promise<string> {
    const sharePrice = await this.getSharePrice(chainId);

    // JUSD = svJUSD * sharePrice / 1e18
    const svJusdBN = ethers.BigNumber.from(svJusdAmount);
    const jusdAmount = svJusdBN
      .mul(sharePrice)
      .div(ethers.utils.parseEther("1"));

    return jusdAmount.toString();
  }

  /**
   * Adjust a sqrtPriceX96 value for svJUSD share price
   *
   * When a user specifies a price in JUSD terms, we need to adjust it
   * for the actual svJUSD pool. The adjustment depends on which token
   * in the pair is JUSD.
   *
   * For token0 = JUSD (→ svJUSD): sqrtPrice decreases (less svJUSD per token1)
   * For token1 = JUSD (→ svJUSD): sqrtPrice increases (more token0 per svJUSD)
   *
   * @param sqrtPriceX96 - Original sqrt price in X96 format
   * @param sharePrice - svJUSD share price (18 decimals)
   * @param isJusdToken0 - Whether JUSD is token0 in the pair
   * @returns Adjusted sqrtPriceX96
   */
  adjustSqrtPriceForSvJusd(
    sqrtPriceX96: ethers.BigNumber,
    sharePrice: ethers.BigNumber,
    isJusdToken0: boolean,
  ): ethers.BigNumber {
    // sqrtSharePrice = sqrt(sharePrice)
    // Using Newton-Raphson or integer sqrt approximation
    const sqrtSharePrice = this.sqrt(
      sharePrice.mul(ethers.utils.parseEther("1")),
    );
    const one = ethers.utils.parseEther("1");

    if (isJusdToken0) {
      // token0 is JUSD → becomes svJUSD
      // Price = token1/token0 → increases when token0 becomes more valuable
      // sqrtPrice = sqrtPrice * sqrt(sharePrice)
      return sqrtPriceX96.mul(sqrtSharePrice).div(one);
    } else {
      // token1 is JUSD → becomes svJUSD
      // Price = token1/token0 → decreases when token1 becomes more valuable
      // sqrtPrice = sqrtPrice / sqrt(sharePrice)
      return sqrtPriceX96.mul(one).div(sqrtSharePrice);
    }
  }

  /**
   * Check if share price is considered stale
   */
  isSharePriceStale(chainId: ChainId): boolean {
    const cached = this.priceCache.get(chainId);
    if (!cached) return true;
    return Date.now() - cached.timestamp >= this.CACHE_TTL_MS;
  }

  /**
   * Force refresh the share price cache
   */
  async refreshSharePrice(chainId: ChainId): Promise<ethers.BigNumber> {
    const freshPrice = await this.fetchOnChainSharePrice(chainId);
    this.priceCache.set(chainId, {
      sharePrice: freshPrice,
      timestamp: Date.now(),
    });
    return freshPrice;
  }

  /**
   * Clear the cache (useful for testing)
   */
  clearCache(): void {
    this.priceCache.clear();
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * Fetch share price directly from the svJUSD contract
   */
  private async fetchOnChainSharePrice(
    chainId: ChainId,
  ): Promise<ethers.BigNumber> {
    const contract = this.svJusdContracts.get(chainId);
    if (!contract) {
      throw new Error(`No svJUSD contract for chain ${chainId}`);
    }

    // convertToAssets(1e18) returns JUSD equivalent of 1 svJUSD
    const oneShare = ethers.utils.parseEther("1");
    const assets = await contract.convertToAssets(oneShare);

    this.logger.debug(
      { chainId, sharePrice: ethers.utils.formatEther(assets) },
      "Fetched svJUSD share price",
    );

    return assets;
  }

  /**
   * Integer square root using Newton-Raphson method
   * Used for sqrtPriceX96 adjustments
   */
  private sqrt(value: ethers.BigNumber): ethers.BigNumber {
    if (value.isZero()) return ethers.BigNumber.from(0);

    let z = value;
    let x = value.div(2).add(1);

    while (x.lt(z)) {
      z = x;
      x = value.div(x).add(x).div(2);
    }

    return z;
  }
}
