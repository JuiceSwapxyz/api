import axios from "axios";
import Logger from "bunyan";
import { ChainId, WETH9 } from "@juiceswapxyz/sdk-core";
import { getChainContracts } from "../config/contracts";

interface PriceCache {
  price: number;
  timestamp: number;
}

export interface BtcPriceData {
  price: number;
  change1h: number; // percent, e.g. -0.12 means -0.12%
  change24h: number; // percent, e.g. 1.45 means +1.45%
}

export interface BtcPriceHistory {
  prices: Array<{ timestamp: number; price: number }>; // ~24 entries, hourly
}

interface BtcPriceDataCache {
  data: BtcPriceData;
  timestamp: number;
}

interface BtcPriceHistoryCache {
  data: BtcPriceHistory;
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
  private btcPriceDataCache: BtcPriceDataCache | null = null;
  private btcPriceDataInflight: Promise<BtcPriceData> | null = null;
  private btcPriceHistoryCache: BtcPriceHistoryCache | null = null;
  private btcPriceHistoryInflight: Promise<BtcPriceHistory | null> | null = null;
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
   * Get BTC price in USD from CoinGecko (primary) or Binance (fallback).
   * Prefers the richer getBtcPriceData() cache when available to avoid
   * redundant CoinGecko requests.
   */
  async getBtcPriceUsd(): Promise<number> {
    const now = Date.now();
    if (
      this.btcPriceCache &&
      now - this.btcPriceCache.timestamp < this.CACHE_TTL
    ) {
      return this.btcPriceCache.price;
    }

    // If a getBtcPriceData() fetch is already inflight, piggyback on it
    // instead of making a separate /simple/price request
    if (this.btcPriceDataInflight) {
      const data = await this.btcPriceDataInflight;
      return data.price;
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

  /**
   * Get BTC price data including 1h/24h percent changes from CoinGecko
   */
  async getBtcPriceData(): Promise<BtcPriceData> {
    const now = Date.now();
    if (
      this.btcPriceDataCache &&
      now - this.btcPriceDataCache.timestamp < this.CACHE_TTL
    ) {
      return this.btcPriceDataCache.data;
    }

    if (this.btcPriceDataInflight) {
      return this.btcPriceDataInflight;
    }

    this.btcPriceDataInflight = this.fetchBtcPriceDataWithFallback();
    try {
      return await this.btcPriceDataInflight;
    } finally {
      this.btcPriceDataInflight = null;
    }
  }

  /**
   * Get BTC price history (24h, hourly) from CoinGecko market_chart endpoint.
   * Returns null on failure — sparklines are non-critical.
   */
  async getBtcPriceHistory(): Promise<BtcPriceHistory | null> {
    const now = Date.now();
    if (
      this.btcPriceHistoryCache &&
      now - this.btcPriceHistoryCache.timestamp < this.CACHE_TTL
    ) {
      return this.btcPriceHistoryCache.data;
    }

    if (this.btcPriceHistoryInflight) {
      return this.btcPriceHistoryInflight;
    }

    this.btcPriceHistoryInflight = this.fetchBtcPriceHistory();
    try {
      return await this.btcPriceHistoryInflight;
    } finally {
      this.btcPriceHistoryInflight = null;
    }
  }

  private async fetchBtcPriceHistory(): Promise<BtcPriceHistory | null> {
    try {
      const response = await axios.get(
        "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart",
        {
          params: { vs_currency: "usd", days: 1 },
          timeout: 5000,
        },
      );
      const rawPrices = response.data?.prices;
      if (!Array.isArray(rawPrices) || rawPrices.length === 0) {
        this.logger.warn("Invalid CoinGecko market_chart response");
        return null;
      }

      const prices = rawPrices
        .filter(
          (entry: unknown) =>
            Array.isArray(entry) &&
            typeof entry[0] === "number" &&
            typeof entry[1] === "number" &&
            entry[1] > 0,
        )
        .map(([msTimestamp, price]: [number, number]) => ({
          timestamp: Math.floor(msTimestamp / 1000),
          price,
        }));

      const data: BtcPriceHistory = { prices };
      this.btcPriceHistoryCache = { data, timestamp: Date.now() };
      this.logger.debug(
        { count: prices.length },
        "Fetched BTC price history from CoinGecko",
      );
      return data;
    } catch (error) {
      this.logger.warn(
        { error },
        "Failed to fetch BTC price history from CoinGecko",
      );
      if (this.btcPriceHistoryCache) {
        return this.btcPriceHistoryCache.data;
      }
      return null;
    }
  }

  private async fetchBtcPriceDataWithFallback(): Promise<BtcPriceData> {
    const now = Date.now();
    try {
      const data = await this.fetchBtcPriceDataCoinGecko();
      this.btcPriceDataCache = { data, timestamp: now };
      // Also update the simple price cache
      this.btcPriceCache = { price: data.price, timestamp: now };
      return data;
    } catch (error) {
      this.logger.warn(
        { error },
        "CoinGecko BTC price data fetch failed, falling back to Binance (no % changes)",
      );
      try {
        const price = await this.fetchBtcPriceBinance();
        const data: BtcPriceData = { price, change1h: 0, change24h: 0 };
        this.btcPriceDataCache = { data, timestamp: now };
        this.btcPriceCache = { price, timestamp: now };
        return data;
      } catch (fallbackError) {
        this.logger.error(
          { error: fallbackError },
          "Both BTC price data sources failed",
        );
        if (this.btcPriceDataCache) {
          return this.btcPriceDataCache.data;
        }
        throw new Error("Unable to fetch BTC price data");
      }
    }
  }

  private async fetchBtcPriceDataCoinGecko(): Promise<BtcPriceData> {
    const response = await axios.get(
      "https://api.coingecko.com/api/v3/coins/bitcoin",
      {
        params: {
          localization: false,
          tickers: false,
          market_data: true,
          community_data: false,
          developer_data: false,
          sparkline: false,
        },
        timeout: 5000,
      },
    );
    const marketData = response.data?.market_data;
    const price = marketData?.current_price?.usd;
    if (typeof price !== "number" || price <= 0) {
      throw new Error("Invalid CoinGecko /coins/bitcoin response");
    }

    const change1h =
      marketData?.price_change_percentage_1h_in_currency?.usd ?? 0;
    const change24h =
      marketData?.price_change_percentage_24h_in_currency?.usd ?? 0;

    this.logger.debug(
      { price, change1h, change24h },
      "Fetched BTC price data from CoinGecko /coins/bitcoin",
    );
    return { price, change1h, change24h };
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
