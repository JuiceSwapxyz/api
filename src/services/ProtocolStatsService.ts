import Logger from "bunyan";
import { ChainId } from "@juiceswapxyz/sdk-core";
import { UniswapMulticallProvider } from "@juiceswapxyz/smart-order-router";
import { ethers } from "ethers";
import axios from "axios";
import { PriceService } from "./PriceService";
import { getChainContracts } from "../config/contracts";
import { ExploreStatsService } from "./ExploreStatsService";

// StablecoinBridge ABI — minted() returns total JUSD minted through the bridge
const STABLECOIN_BRIDGE_ABI = ["function minted() view returns (uint256)"];

interface ProtocolStats {
  tvlUsd: number;
  volume24hUsd: number;
}

interface TimestampedAmount {
  timestamp: number;
  value: number;
}

export interface ProtocolStatsResponse {
  dailyProtocolTvl: {
    v2: TimestampedAmount[];
    v3: TimestampedAmount[];
    bridge: TimestampedAmount[];
  };
  historicalProtocolVolume: {
    Month: {
      v2: TimestampedAmount[];
      v3: TimestampedAmount[];
      bridge: TimestampedAmount[];
    };
  };
}

interface StatsCache {
  response: ProtocolStatsResponse;
  timestamp: number;
}

/**
 * ProtocolStatsService - Aggregates TVL and volume across V2, V3, and bridge
 *
 * V2/V3 stats: Derived by summing per-pool data from ExploreStatsService
 * Bridge stats: Fetched directly via RPC multicall and external Ponder instances
 */
export class ProtocolStatsService {
  private logger: Logger;
  private priceService: PriceService;
  private providers: Map<ChainId, ethers.providers.StaticJsonRpcProvider>;
  private cache: Map<number, StatsCache> = new Map();
  private readonly CACHE_TTL = 60_000; // 60 seconds

  constructor(
    providers: Map<ChainId, ethers.providers.StaticJsonRpcProvider>,
    logger: Logger,
    private exploreStatsService: ExploreStatsService,
  ) {
    this.logger = logger.child({ service: "ProtocolStatsService" });
    this.priceService = new PriceService(logger);
    this.providers = providers;
  }

  async getProtocolStats(chainId: number): Promise<ProtocolStatsResponse> {
    // Check cache
    const cached = this.cache.get(chainId);
    const now = Date.now();
    if (cached && now - cached.timestamp < this.CACHE_TTL) {
      return cached.response;
    }

    const [v3Stats, v2Stats, bridgeStats] = await Promise.all([
      this.getV3Stats(chainId),
      this.getV2Stats(chainId),
      this.getBridgeStats(chainId),
    ]);

    const currentTimestamp = Math.floor(now / 1000);

    const response: ProtocolStatsResponse = {
      dailyProtocolTvl: {
        v2: [{ timestamp: currentTimestamp, value: v2Stats.tvlUsd }],
        v3: [{ timestamp: currentTimestamp, value: v3Stats.tvlUsd }],
        bridge: [{ timestamp: currentTimestamp, value: bridgeStats.tvlUsd }],
      },
      historicalProtocolVolume: {
        Month: {
          v2: [{ timestamp: currentTimestamp, value: v2Stats.volume24hUsd }],
          v3: [{ timestamp: currentTimestamp, value: v3Stats.volume24hUsd }],
          bridge: [
            {
              timestamp: currentTimestamp,
              value: bridgeStats.volume24hUsd,
            },
          ],
        },
      },
    };

    this.cache.set(chainId, { response, timestamp: now });
    return response;
  }

  private async getV3Stats(chainId: number): Promise<ProtocolStats> {
    try {
      const exploreData = await this.exploreStatsService.getExploreStats(chainId);
      const poolStatsV3 = exploreData.stats?.poolStatsV3 || [];

      let totalTvlUsd = 0;
      let totalVolume24hUsd = 0;

      for (const pool of poolStatsV3) {
        totalTvlUsd += pool.totalLiquidity?.value ?? 0;
        totalVolume24hUsd += pool.volume1Day?.value ?? 0;
      }

      this.logger.info(
        { chainId, v3TvlUsd: totalTvlUsd, v3Volume24hUsd: totalVolume24hUsd },
        "Calculated V3 stats from ExploreStatsService",
      );

      return { tvlUsd: totalTvlUsd, volume24hUsd: totalVolume24hUsd };
    } catch (error) {
      this.logger.error({ chainId, error }, "Failed to get V3 stats");
      return { tvlUsd: 0, volume24hUsd: 0 };
    }
  }

  private async getV2Stats(chainId: number): Promise<ProtocolStats> {
    try {
      const exploreData = await this.exploreStatsService.getExploreStats(chainId);
      const poolStatsV2 = exploreData.stats?.poolStatsV2 || [];

      let totalTvlUsd = 0;
      let totalVolume24hUsd = 0;

      for (const pool of poolStatsV2) {
        totalTvlUsd += pool.totalLiquidity?.value ?? 0;
        totalVolume24hUsd += pool.volume1Day?.value ?? 0;
      }

      this.logger.info(
        { chainId, v2TvlUsd: totalTvlUsd, v2Volume24hUsd: totalVolume24hUsd },
        "Calculated V2 stats from ExploreStatsService",
      );

      return { tvlUsd: totalTvlUsd, volume24hUsd: totalVolume24hUsd };
    } catch (error) {
      this.logger.error({ chainId, error }, "Failed to get V2 stats");
      return { tvlUsd: 0, volume24hUsd: 0 };
    }
  }

  /** Returns a Unix timestamp (seconds) string for 24 hours ago. */
  private get24hAgoCutoff(): string {
    return (Math.floor(Date.now() / 1000) - 86400).toString();
  }

  /**
   * Bridge stats: TVL from StablecoinBridge minted() totals,
   * volume from JuiceDollar Ponder + LDS Ponder GraphQL queries
   */
  private async getBridgeStats(chainId: number): Promise<ProtocolStats> {
    try {
      const [tvlUsd, volume24hUsd] = await Promise.all([
        this.getBridgeTvl(chainId),
        this.getBridgeVolume(chainId),
      ]);

      this.logger.info(
        { chainId, bridgeTvlUsd: tvlUsd, bridgeVolume24hUsd: volume24hUsd },
        "Calculated bridge stats",
      );

      return { tvlUsd, volume24hUsd };
    } catch (error) {
      this.logger.error({ chainId, error }, "Failed to get bridge stats");
      return { tvlUsd: 0, volume24hUsd: 0 };
    }
  }

  /**
   * Bridge TVL = sum of minted() across all 4 StablecoinBridge contracts.
   * Each bridge mints JUSD (18 decimals) at $1.
   */
  private async getBridgeTvl(chainId: number): Promise<number> {
    const contracts = getChainContracts(chainId);
    const provider = this.providers.get(chainId as ChainId);
    if (!contracts || !provider) return 0;

    const bridgeAddresses = [
      contracts.BRIDGE_SUSD,
      contracts.BRIDGE_USDC,
      contracts.BRIDGE_USDT,
      contracts.BRIDGE_CTUSD,
    ].filter((addr) => addr && addr !== "");

    if (bridgeAddresses.length === 0) return 0;

    try {
      const multicallProvider = new UniswapMulticallProvider(
        chainId as ChainId,
        provider,
        375000,
      );
      const bridgeInterface = new ethers.utils.Interface(STABLECOIN_BRIDGE_ABI);

      const { results } =
        await multicallProvider.callSameFunctionOnMultipleContracts({
          addresses: bridgeAddresses.map((a) => ethers.utils.getAddress(a)),
          contractInterface: bridgeInterface,
          functionName: "minted",
        });

      let totalMinted = 0;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r?.success) {
          totalMinted += parseFloat(ethers.utils.formatUnits(r.result[0], 18));
        }
      }

      return totalMinted;
    } catch (error) {
      this.logger.warn({ error }, "Failed to fetch bridge TVL via multicall");
      return 0;
    }
  }

  /**
   * Bridge volume = stablecoin bridge volume + LDS bridge volume (24h).
   */
  private async getBridgeVolume(chainId: number): Promise<number> {
    const [stablecoinVolume, ldsVolume] = await Promise.all([
      this.getStablecoinBridgeVolume(),
      this.getLdsBridgeVolume(chainId),
    ]);
    return stablecoinVolume + ldsVolume;
  }

  /**
   * Query JuiceDollar Ponder for rolling 24h stablecoin bridge volume.
   * Uses hourly buckets with a 24h-ago cutoff. All values are JUSD (18 decimals, $1).
   */
  private async getStablecoinBridgeVolume(): Promise<number> {
    try {
      const baseUrl =
        process.env.JUICEDOLLAR_PONDER_URL || "https://ponder.juicedollar.com";
      const cutoff = this.get24hAgoCutoff();
      const query = `
        query {
          bridgeVolumeStats(where: { type: "1h", timestamp_gte: "${cutoff}" }, orderBy: "timestamp", orderDirection: "desc", limit: 200) {
            items { stablecoinAddress, timestamp, volume, type }
          }
        }
      `;

      const response = await axios.post(
        `${baseUrl}/graphql`,
        { query },
        { timeout: 10000 },
      );

      const items = response.data?.data?.bridgeVolumeStats?.items || [];
      let totalVolume = 0;
      for (const item of items) {
        totalVolume += parseFloat(
          ethers.utils.formatUnits(item.volume || "0", 18),
        );
      }
      return totalVolume;
    } catch (error) {
      this.logger.warn(
        { error },
        "Failed to fetch stablecoin bridge volume from JuiceDollar Ponder",
      );
      return 0;
    }
  }

  /**
   * Query LDS Ponder for rolling 24h bridge volume (BTC/Lightning/ERC20 atomic swaps).
   * Uses hourly buckets with a 24h-ago cutoff.
   * tokenAddress="native" → cBTC volume (needs BTC price)
   * tokenAddress=JUSD address → already USD at $1
   */
  private async getLdsBridgeVolume(chainId: number): Promise<number> {
    try {
      const baseUrl =
        process.env.LDS_PONDER_URL || "https://lightning.space/v1/claim";
      const cutoff = this.get24hAgoCutoff();
      const query = `
        query {
          volumeStats(where: { chainId: ${chainId}, type: "1h", timestamp_gte: "${cutoff}" }, orderBy: "timestamp", orderDirection: "desc", limit: 200) {
            items { tokenAddress, timestamp, volume, type }
          }
        }
      `;

      const response = await axios.post(
        `${baseUrl}/graphql`,
        { query },
        { timeout: 10000 },
      );

      const items = response.data?.data?.volumeStats?.items || [];
      if (items.length === 0) return 0;

      // Get BTC price for native token volume conversion
      const btcPrice = await this.priceService.getBtcPriceUsd();

      let totalVolume = 0;
      for (const item of items) {
        const volume = parseFloat(
          ethers.utils.formatUnits(item.volume || "0", 18),
        );
        if (item.tokenAddress === "native") {
          // cBTC volume — convert to USD using BTC price
          totalVolume += volume * btcPrice;
        } else {
          // ERC20 volume (JUSD) — already USD at $1
          totalVolume += volume;
        }
      }
      return totalVolume;
    } catch (error) {
      this.logger.warn(
        { error },
        "Failed to fetch LDS bridge volume from LDS Ponder",
      );
      return 0;
    }
  }
}
