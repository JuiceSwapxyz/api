import axios from "axios";
import Logger from "bunyan";
import { ChainId, WETH9 } from "@juiceswapxyz/sdk-core";
import { getChainContracts } from "../config/contracts";

interface PriceCache {
  price: number;
  timestamp: number;
}

/**
 * Known token categories for price resolution
 */
type TokenCategory = "BTC" | "STABLECOIN";

/**
 * PriceService - Fetches and caches token prices for TVL/volume calculations
 *
 * Pricing strategy:
 * - Tier 1: Direct prices from known token mappings (BTC-pegged, stablecoins)
 * - Tier 2: Derived prices from pool reserves (V2 launchpad tokens paired with JUSD)
 */
export class PriceService {
  private logger: Logger;
  private btcPriceCache: PriceCache | null = null;
  private btcPriceInflight: Promise<number> | null = null;
  private readonly CACHE_TTL = 60_000; // 60 seconds

  // Known BTC-pegged tokens by chain (lowercased addresses)
  private btcTokens: Map<number, Set<string>> = new Map();

  // Known stablecoin tokens by chain (lowercased addresses)
  private stablecoinTokens: Map<number, Set<string>> = new Map();

  constructor(logger: Logger) {
    this.logger = logger.child({ service: "PriceService" });
    this.initializeKnownTokens();
  }

  private initializeKnownTokens(): void {
    for (const chainId of [ChainId.CITREA_MAINNET, ChainId.CITREA_TESTNET]) {
      const contracts = getChainContracts(chainId);
      const wcbtc = WETH9[chainId];

      const btcSet = new Set<string>();
      const stableSet = new Set<string>();

      // BTC-pegged tokens
      if (wcbtc) {
        btcSet.add(wcbtc.address.toLowerCase());
      }

      // syBTC (yield-bearing BTC, sourced from ChainContracts config)
      if (contracts?.SY_BTC) {
        btcSet.add(contracts.SY_BTC.toLowerCase());
      }

      // Stablecoin tokens
      if (contracts) {
        if (contracts.JUSD) stableSet.add(contracts.JUSD.toLowerCase());
        if (contracts.SV_JUSD) stableSet.add(contracts.SV_JUSD.toLowerCase());
        if (contracts.USDC) stableSet.add(contracts.USDC.toLowerCase());
        if (contracts.USDT) stableSet.add(contracts.USDT.toLowerCase());
        if (contracts.CTUSD) stableSet.add(contracts.CTUSD.toLowerCase());
        if (contracts.SUSD) stableSet.add(contracts.SUSD.toLowerCase());
      }

      this.btcTokens.set(chainId, btcSet);
      this.stablecoinTokens.set(chainId, stableSet);
    }
  }

  /**
   * Get BTC price in USD from CoinGecko (primary) or Binance (fallback)
   */
  async getBtcPriceUsd(): Promise<number> {
    const now = Date.now();
    if (
      this.btcPriceCache &&
      now - this.btcPriceCache.timestamp < this.CACHE_TTL
    ) {
      return this.btcPriceCache.price;
    }

    // Deduplicate concurrent requests: if a fetch is already in progress, await the same promise
    if (this.btcPriceInflight) {
      return this.btcPriceInflight;
    }

    this.btcPriceInflight = this.fetchBtcPriceWithFallback();
    try {
      return await this.btcPriceInflight;
    } finally {
      this.btcPriceInflight = null;
    }
  }

  private async fetchBtcPriceWithFallback(): Promise<number> {
    const now = Date.now();
    try {
      const price = await this.fetchBtcPriceCoinGecko();
      this.btcPriceCache = { price, timestamp: now };
      return price;
    } catch (error) {
      this.logger.warn(
        { error },
        "CoinGecko BTC price fetch failed, trying Binance",
      );
      try {
        const price = await this.fetchBtcPriceBinance();
        this.btcPriceCache = { price, timestamp: now };
        return price;
      } catch (fallbackError) {
        this.logger.error(
          { error: fallbackError },
          "Both BTC price sources failed",
        );
        // Return stale cache if available
        if (this.btcPriceCache) {
          return this.btcPriceCache.price;
        }
        throw new Error("Unable to fetch BTC price");
      }
    }
  }

  /**
   * Get the price category of a token (BTC-pegged, stablecoin, or unknown)
   */
  getTokenCategory(chainId: number, address: string): TokenCategory | null {
    const addr = address.toLowerCase();
    if (this.btcTokens.get(chainId)?.has(addr)) return "BTC";
    if (this.stablecoinTokens.get(chainId)?.has(addr)) return "STABLECOIN";
    return null;
  }

  /**
   * Get USD price for a single token
   */
  async getTokenPriceUsd(chainId: number, address: string): Promise<number> {
    const category = this.getTokenCategory(chainId, address);

    switch (category) {
      case "BTC":
        return this.getBtcPriceUsd();
      case "STABLECOIN":
        return 1.0;
      default:
        // Unknown token - return 0 (caller can derive from pool ratios)
        return 0;
    }
  }

  /**
   * Batch fetch prices for multiple tokens
   * Returns a map of lowercased address -> USD price
   */
  async getTokenPrices(
    chainId: number,
    tokenAddresses: string[],
  ): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    let btcPrice: number | null = null;

    for (const addr of tokenAddresses) {
      const lowerAddr = addr.toLowerCase();
      const category = this.getTokenCategory(chainId, lowerAddr);

      switch (category) {
        case "BTC":
          if (btcPrice === null) {
            btcPrice = await this.getBtcPriceUsd();
          }
          prices.set(lowerAddr, btcPrice);
          break;
        case "STABLECOIN":
          prices.set(lowerAddr, 1.0);
          break;
        default:
          prices.set(lowerAddr, 0);
          break;
      }
    }

    return prices;
  }

  private async fetchBtcPriceCoinGecko(): Promise<number> {
    const response = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price",
      {
        params: { ids: "bitcoin", vs_currencies: "usd" },
        timeout: 5000,
      },
    );
    const price = response.data?.bitcoin?.usd;
    if (typeof price !== "number" || price <= 0) {
      throw new Error("Invalid CoinGecko response");
    }
    this.logger.debug({ price }, "Fetched BTC price from CoinGecko");
    return price;
  }

  private async fetchBtcPriceBinance(): Promise<number> {
    const response = await axios.get(
      "https://api.binance.com/api/v3/ticker/price",
      {
        params: { symbol: "BTCUSDT" },
        timeout: 5000,
      },
    );
    const price = parseFloat(response.data?.price);
    if (isNaN(price) || price <= 0) {
      throw new Error("Invalid Binance response");
    }
    this.logger.debug({ price }, "Fetched BTC price from Binance");
    return price;
  }
}
