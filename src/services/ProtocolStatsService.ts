import Logger from "bunyan";
import { ChainId } from "@juiceswapxyz/sdk-core";
import { UniswapMulticallProvider } from "@juiceswapxyz/smart-order-router";
import { ethers } from "ethers";
import axios from "axios";
import { PriceService } from "./PriceService";
import { getPonderClient } from "./PonderClient";
import { getChainContracts } from "../config/contracts";

// Minimal ERC20 ABI — only balanceOf is needed for TVL calculations
const ERC20_BALANCE_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
];

// V2 Pair ABI for getReserves
const V2_PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
];

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

interface V3PoolStat {
  poolAddress: string;
  volume0: string;
  volume1: string;
  txCount: string;
  timestamp: string;
  type: string;
}

interface V3Pool {
  address: string;
  token0: string;
  token1: string;
  fee: number;
}

interface V3Token {
  address: string;
  decimals: number;
  symbol: string;
}

interface V2GraduatedPool {
  pairAddress: string;
  token0: string;
  token1: string;
  launchpadTokenAddress: string;
}

interface V2PoolStatEntry {
  poolAddress: string;
  volume0: string;
  volume1: string;
  txCount: string;
  timestamp: string;
}

interface StatsCache {
  response: ProtocolStatsResponse;
  timestamp: number;
}

/**
 * ProtocolStatsService - Aggregates TVL and volume across V2 and V3 protocols
 *
 * V3 stats: Fetches pool stats from Ponder, balances via RPC multicall
 * V2 stats: Fetches graduated pool list from Ponder, reserves via RPC
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
      const ponderClient = getPonderClient(this.logger);

      // Fetch pool discovery (all-time, for TVL) and 24h volume stats in parallel
      const [exploreResponse, poolStats24h] = await Promise.all([
        ponderClient.get(`/exploreStats?chainId=${chainId}`),
        this.queryV3PoolStats24h(ponderClient, chainId),
      ]);
      const exploreData = exploreResponse.data;

      const poolStatsV3: V3PoolStat[] = exploreData?.stats?.poolStatsV3 || [];

      if (poolStatsV3.length === 0 && poolStats24h.length === 0) {
        return { tvlUsd: 0, volume24hUsd: 0 };
      }

      // Merge pool addresses from both sources for info queries
      const poolAddressSet = new Set<string>();
      for (const ps of poolStatsV3) {
        poolAddressSet.add(ethers.utils.getAddress(ps.poolAddress));
      }
      for (const ps of poolStats24h) {
        poolAddressSet.add(ethers.utils.getAddress(ps.poolAddress));
      }
      const poolAddresses = Array.from(poolAddressSet);

      // Query pool info for token addresses and decimals
      const poolInfoQuery = `
        query GetPools($wherePool: poolFilter = {}) {
          pools(where: $wherePool, limit: 100) {
            items {
              address
              token0
              token1
              fee
            }
          }
        }
      `;

      let pools: V3Pool[] = [];
      try {
        const poolInfoResult = await ponderClient.query(poolInfoQuery, {
          wherePool: { address_in: poolAddresses },
        });
        pools = poolInfoResult.pools?.items || [];
      } catch {
        this.logger.warn("Failed to query V3 pool info via GraphQL");
      }

      // Get unique token addresses from pools
      const allTokenAddrs = new Set<string>();
      for (const pool of pools) {
        allTokenAddrs.add(pool.token0.toLowerCase());
        allTokenAddrs.add(pool.token1.toLowerCase());
      }

      // Fetch token details (decimals)
      const tokenDetailsQuery = `
        query GetTokens($whereToken: tokenFilter = {}) {
          tokens(where: $whereToken, limit: 100) {
            items {
              address
              decimals
              symbol
            }
          }
        }
      `;

      let tokens: V3Token[] = [];
      try {
        const tokenResult = await ponderClient.query(tokenDetailsQuery, {
          whereToken: { address_in: Array.from(allTokenAddrs) },
        });
        tokens = tokenResult.tokens?.items || [];
      } catch {
        this.logger.warn("Failed to query token details via GraphQL");
      }

      const tokenMap = new Map<string, V3Token>();
      for (const t of tokens) {
        tokenMap.set(t.address.toLowerCase(), t);
      }

      // Get token prices
      const prices = await this.priceService.getTokenPrices(
        chainId,
        Array.from(allTokenAddrs),
      );

      // Calculate rolling 24h volume from hourly pool stats
      let totalVolume24hUsd = 0;

      for (const ps of poolStats24h) {
        const poolAddr = ps.poolAddress?.toLowerCase();
        const pool = pools.find(
          (p: V3Pool) => p.address.toLowerCase() === poolAddr,
        );
        if (!pool) continue;

        const token0Info = tokenMap.get(pool.token0.toLowerCase());
        const token1Info = tokenMap.get(pool.token1.toLowerCase());
        const price0 = prices.get(pool.token0.toLowerCase()) || 0;
        const price1 = prices.get(pool.token1.toLowerCase()) || 0;

        const decimals0 = token0Info?.decimals || 18;
        const decimals1 = token1Info?.decimals || 18;

        const volume0 = parseFloat(
          ethers.utils.formatUnits(ps.volume0 || "0", decimals0),
        );
        const volume1 = parseFloat(
          ethers.utils.formatUnits(ps.volume1 || "0", decimals1),
        );

        // Use whichever side has a known price, avoid double counting
        if (price0 > 0) {
          totalVolume24hUsd += volume0 * price0;
        } else if (price1 > 0) {
          totalVolume24hUsd += volume1 * price1;
        }
      }

      // Calculate TVL from on-chain balances
      let totalTvlUsd = 0;
      const provider = this.providers.get(chainId as ChainId);
      if (provider && pools.length > 0) {
        try {
          const multicallProvider = new UniswapMulticallProvider(
            chainId as ChainId,
            provider,
            375000,
          );
          const erc20Interface = new ethers.utils.Interface(ERC20_BALANCE_ABI);

          // Fetch all pool token balances concurrently (one multicall per pool, all in parallel)
          const poolBalanceResults = await Promise.all(
            pools.map(async (pool) => {
              try {
                const { results } =
                  await multicallProvider.callSameFunctionOnMultipleContracts({
                    addresses: [
                      ethers.utils.getAddress(pool.token0),
                      ethers.utils.getAddress(pool.token1),
                    ],
                    contractInterface: erc20Interface,
                    functionName: "balanceOf",
                    functionParams: [ethers.utils.getAddress(pool.address)],
                  });
                return { pool, results };
              } catch (poolError) {
                this.logger.debug(
                  { pool: pool.address, error: poolError },
                  "Failed to fetch balance for V3 pool",
                );
                return null;
              }
            }),
          );

          for (const entry of poolBalanceResults) {
            if (!entry) continue;
            const { pool, results } = entry;

            const token0Info = tokenMap.get(pool.token0.toLowerCase());
            const token1Info = tokenMap.get(pool.token1.toLowerCase());
            const price0 = prices.get(pool.token0.toLowerCase()) || 0;
            const price1 = prices.get(pool.token1.toLowerCase()) || 0;

            if (results[0]?.success && price0 > 0) {
              const balance0 = parseFloat(
                ethers.utils.formatUnits(
                  results[0].result[0],
                  token0Info?.decimals || 18,
                ),
              );
              totalTvlUsd += balance0 * price0;
            }

            if (results[1]?.success && price1 > 0) {
              const balance1 = parseFloat(
                ethers.utils.formatUnits(
                  results[1].result[0],
                  token1Info?.decimals || 18,
                ),
              );
              totalTvlUsd += balance1 * price1;
            }
          }
        } catch (error) {
          this.logger.warn(
            { error },
            "Failed to calculate V3 TVL via multicall",
          );
        }
      }

      this.logger.info(
        { chainId, v3TvlUsd: totalTvlUsd, v3Volume24hUsd: totalVolume24hUsd },
        "Calculated V3 stats",
      );

      return { tvlUsd: totalTvlUsd, volume24hUsd: totalVolume24hUsd };
    } catch (error) {
      this.logger.error({ chainId, error }, "Failed to get V3 stats");
      return { tvlUsd: 0, volume24hUsd: 0 };
    }
  }

  /** Returns a Unix timestamp (seconds) string for 24 hours ago. */
  private get24hAgoCutoff(): string {
    return (Math.floor(Date.now() / 1000) - 86400).toString();
  }

  /**
   * Query rolling 24h V3 pool stats from Ponder GraphQL.
   * Uses hourly buckets (type: "1h") with a 24h-ago cutoff for a true rolling window.
   */
  private async queryV3PoolStats24h(
    ponderClient: ReturnType<typeof getPonderClient>,
    chainId: number,
  ): Promise<V3PoolStat[]> {
    try {
      const cutoff = this.get24hAgoCutoff();
      const query = `
        query GetRolling24hPoolStats($where: poolStatFilter = {}) {
          poolStats(where: $where, orderBy: "timestamp", orderDirection: "desc", limit: 1000) {
            items { poolAddress, volume0, volume1, txCount, timestamp, type }
          }
        }
      `;
      const result = await ponderClient.query(query, {
        where: { type: "1h", chainId, timestamp_gte: cutoff },
      });
      return result.poolStats?.items || [];
    } catch {
      this.logger.warn("Failed to query rolling 24h V3 pool stats via GraphQL");
      return [];
    }
  }

  /**
   * Query rolling 24h V2 pool stats from Ponder GraphQL.
   * Uses hourly buckets (type: "1h") with a 24h-ago cutoff for a true rolling window.
   */
  private async queryV2PoolStats24h(
    ponderClient: ReturnType<typeof getPonderClient>,
    chainId: number,
  ): Promise<V2PoolStatEntry[]> {
    try {
      const cutoff = this.get24hAgoCutoff();
      const query = `
        query GetRolling24hV2PoolStats($where: v2PoolStatFilter = {}) {
          v2PoolStats(where: $where, orderBy: "timestamp", orderDirection: "desc", limit: 1000) {
            items { poolAddress, volume0, volume1, txCount, timestamp, type }
          }
        }
      `;
      const result = await ponderClient.query(query, {
        where: { type: "1h", chainId, timestamp_gte: cutoff },
      });
      return result.v2PoolStats?.items || [];
    } catch {
      this.logger.warn("Failed to query rolling 24h V2 pool stats via GraphQL");
      return [];
    }
  }

  private async getV2Stats(chainId: number): Promise<ProtocolStats> {
    try {
      const ponderClient = getPonderClient(this.logger);
      const contracts = getChainContracts(chainId);

      // Fetch graduated V2 pools from Ponder
      const poolsResponse = await ponderClient.get(
        `/graduated-pools?chainId=${chainId}`,
      );
      const v2Pools: V2GraduatedPool[] = poolsResponse.data?.pools || [];

      if (v2Pools.length === 0) {
        return { tvlUsd: 0, volume24hUsd: 0 };
      }

      // Fetch V2 24h volume stats from Ponder GraphQL
      const v2PoolStats24h = await this.queryV2PoolStats24h(
        ponderClient,
        chainId,
      );

      // Fetch token decimals from Ponder (avoids hardcoding 18 for all tokens)
      const v2TokenAddrs = new Set<string>();
      for (const pool of v2Pools) {
        v2TokenAddrs.add(pool.token0.toLowerCase());
        v2TokenAddrs.add(pool.token1.toLowerCase());
      }

      const v2TokenMap = new Map<string, number>(); // address -> decimals
      try {
        const tokenDetailsQuery = `
          query GetTokens($whereToken: tokenFilter = {}) {
            tokens(where: $whereToken, limit: 100) {
              items { address, decimals }
            }
          }
        `;
        const tokenResult = await ponderClient.query(tokenDetailsQuery, {
          whereToken: { address_in: Array.from(v2TokenAddrs) },
        });
        for (const t of tokenResult.tokens?.items || []) {
          v2TokenMap.set(t.address.toLowerCase(), t.decimals);
        }
      } catch {
        this.logger.warn(
          "Failed to query V2 token decimals via GraphQL, falling back to 18",
        );
      }

      // Fetch reserves via RPC
      const provider = this.providers.get(chainId as ChainId);
      let totalTvlUsd = 0;
      let totalVolume24hUsd = 0;

      if (provider) {
        const multicallProvider = new UniswapMulticallProvider(
          chainId as ChainId,
          provider,
          375000,
        );
        const v2PairInterface = new ethers.utils.Interface(V2_PAIR_ABI);

        // Fetch reserves for all V2 pools
        const pairAddresses = v2Pools.map((p) =>
          ethers.utils.getAddress(p.pairAddress),
        );

        try {
          const { results } =
            await multicallProvider.callSameFunctionOnMultipleContracts({
              addresses: pairAddresses,
              contractInterface: v2PairInterface,
              functionName: "getReserves",
            });

          for (let i = 0; i < v2Pools.length; i++) {
            const pool = v2Pools[i];
            const result = results[i];

            if (!result?.success) continue;

            const [reserve0Raw, reserve1Raw] = result.result as [
              ethers.BigNumber,
              ethers.BigNumber,
              number,
            ];

            // All V2 launchpad pools pair with JUSD ($1)
            // Determine which token is JUSD (the base asset)
            const jusdAddress = contracts?.JUSD?.toLowerCase();
            const isToken0Jusd = pool.token0.toLowerCase() === jusdAddress;
            const isToken1Jusd = pool.token1.toLowerCase() === jusdAddress;

            const decimals0 = v2TokenMap.get(pool.token0.toLowerCase()) ?? 18;
            const decimals1 = v2TokenMap.get(pool.token1.toLowerCase()) ?? 18;

            if (isToken0Jusd || isToken1Jusd) {
              // JUSD reserve gives us the USD value of one side
              const jusdDecimals = isToken0Jusd ? decimals0 : decimals1;
              const jusdReserve = isToken0Jusd ? reserve0Raw : reserve1Raw;
              // TVL = 2 * JUSD reserve (both sides are equal value in AMM)
              const jusdReserveFormatted = parseFloat(
                ethers.utils.formatUnits(jusdReserve, jusdDecimals),
              );
              totalTvlUsd += 2 * jusdReserveFormatted;
            } else {
              // Non-JUSD pool - try to price via known tokens
              const price0 = await this.priceService.getTokenPriceUsd(
                chainId,
                pool.token0,
              );
              const price1 = await this.priceService.getTokenPriceUsd(
                chainId,
                pool.token1,
              );

              if (price0 > 0) {
                const reserve0Formatted = parseFloat(
                  ethers.utils.formatUnits(reserve0Raw, decimals0),
                );
                totalTvlUsd += 2 * reserve0Formatted * price0;
              } else if (price1 > 0) {
                const reserve1Formatted = parseFloat(
                  ethers.utils.formatUnits(reserve1Raw, decimals1),
                );
                totalTvlUsd += 2 * reserve1Formatted * price1;
              }
            }
          }
        } catch (error) {
          this.logger.warn(
            { error },
            "Failed to fetch V2 reserves via multicall",
          );
        }
      }

      // Calculate rolling 24h V2 volume from hourly stats
      if (v2PoolStats24h.length > 0) {
        const jusdAddress = contracts?.JUSD?.toLowerCase();

        // Build a map from pool address to token info for graduated pools
        const v2PoolMap = new Map<string, { token0: string; token1: string }>();
        for (const pool of v2Pools) {
          v2PoolMap.set(pool.pairAddress.toLowerCase(), {
            token0: pool.token0,
            token1: pool.token1,
          });
        }

        for (const stats of v2PoolStats24h) {
          const pool = v2PoolMap.get(stats.poolAddress.toLowerCase());
          if (!pool) continue;

          const isToken0Jusd = pool.token0.toLowerCase() === jusdAddress;
          const isToken1Jusd = pool.token1.toLowerCase() === jusdAddress;

          if (isToken0Jusd) {
            const jusdDecimals =
              v2TokenMap.get(pool.token0.toLowerCase()) ?? 18;
            totalVolume24hUsd += parseFloat(
              ethers.utils.formatUnits(stats.volume0 || "0", jusdDecimals),
            );
          } else if (isToken1Jusd) {
            const jusdDecimals =
              v2TokenMap.get(pool.token1.toLowerCase()) ?? 18;
            totalVolume24hUsd += parseFloat(
              ethers.utils.formatUnits(stats.volume1 || "0", jusdDecimals),
            );
          }
        }
      }

      this.logger.info(
        { chainId, v2TvlUsd: totalTvlUsd, v2Volume24hUsd: totalVolume24hUsd },
        "Calculated V2 stats",
      );

      return { tvlUsd: totalTvlUsd, volume24hUsd: totalVolume24hUsd };
    } catch (error) {
      this.logger.error({ chainId, error }, "Failed to get V2 stats");
      return { tvlUsd: 0, volume24hUsd: 0 };
    }
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
