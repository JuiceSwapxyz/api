import Logger from "bunyan";
import { ChainId } from "@juiceswapxyz/sdk-core";
import { UniswapMulticallProvider } from "@juiceswapxyz/smart-order-router";
import { ethers } from "ethers";
import { formatUnits, getAddress, erc20Abi } from "viem";
import { PriceService } from "./PriceService";
import { getPonderClient } from "./PonderClient";
import { getChainContracts } from "../config/contracts";

// V2 Pair ABI for getReserves
const V2_PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
];

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
    v4: TimestampedAmount[];
  };
  historicalProtocolVolume: {
    Month: {
      v2: TimestampedAmount[];
      v3: TimestampedAmount[];
      v4: TimestampedAmount[];
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

    const [v3Stats, v2Stats] = await Promise.all([
      this.getV3Stats(chainId),
      this.getV2Stats(chainId),
    ]);

    const currentTimestamp = Math.floor(now / 1000);

    const response: ProtocolStatsResponse = {
      dailyProtocolTvl: {
        v2: [{ timestamp: currentTimestamp, value: v2Stats.tvlUsd }],
        v3: [{ timestamp: currentTimestamp, value: v3Stats.tvlUsd }],
        v4: [],
      },
      historicalProtocolVolume: {
        Month: {
          v2: [{ timestamp: currentTimestamp, value: v2Stats.volume24hUsd }],
          v3: [{ timestamp: currentTimestamp, value: v3Stats.volume24hUsd }],
          v4: [],
        },
      },
    };

    this.cache.set(chainId, { response, timestamp: now });
    return response;
  }

  private async getV3Stats(chainId: number): Promise<ProtocolStats> {
    try {
      const ponderClient = getPonderClient(this.logger);

      // Fetch V3 pool stats and pool info from Ponder
      const exploreResponse = await ponderClient.get(
        `/exploreStats?chainId=${chainId}`,
      );
      const exploreData = exploreResponse.data;

      const poolStatsV3: V3PoolStat[] = exploreData?.stats?.poolStatsV3 || [];

      if (poolStatsV3.length === 0) {
        return { tvlUsd: 0, volume24hUsd: 0 };
      }

      // Get pool addresses and their token info from the Ponder GraphQL
      const poolAddresses = poolStatsV3.map((ps) => getAddress(ps.poolAddress));

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

      // Calculate 24h volume
      let totalVolume24hUsd = 0;

      for (const ps of poolStatsV3) {
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

        const volume0 = Number(
          formatUnits(BigInt(ps.volume0 || "0"), decimals0),
        );
        const volume1 = Number(
          formatUnits(BigInt(ps.volume1 || "0"), decimals1),
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
          const erc20Interface = new ethers.utils.Interface(erc20Abi);

          // For each pool, fetch token0 and token1 balances
          for (const pool of pools) {
            try {
              const { results } =
                await multicallProvider.callSameFunctionOnMultipleContracts({
                  addresses: [getAddress(pool.token0), getAddress(pool.token1)],
                  contractInterface: erc20Interface,
                  functionName: "balanceOf",
                  functionParams: [getAddress(pool.address)],
                });

              const token0Info = tokenMap.get(pool.token0.toLowerCase());
              const token1Info = tokenMap.get(pool.token1.toLowerCase());
              const price0 = prices.get(pool.token0.toLowerCase()) || 0;
              const price1 = prices.get(pool.token1.toLowerCase()) || 0;

              if (results[0]?.success && price0 > 0) {
                const balance0 = Number(
                  formatUnits(
                    BigInt(results[0].result.toString()),
                    token0Info?.decimals || 18,
                  ),
                );
                totalTvlUsd += balance0 * price0;
              }

              if (results[1]?.success && price1 > 0) {
                const balance1 = Number(
                  formatUnits(
                    BigInt(results[1].result.toString()),
                    token1Info?.decimals || 18,
                  ),
                );
                totalTvlUsd += balance1 * price1;
              }
            } catch (poolError) {
              this.logger.debug(
                { pool: pool.address, error: poolError },
                "Failed to fetch balance for V3 pool",
              );
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

      // Fetch V2 volume stats from Ponder
      let v2PoolStats: V2PoolStatEntry[] = [];
      try {
        const statsResponse = await ponderClient.get(
          `/v2-pool-stats?chainId=${chainId}&type=24h`,
        );
        v2PoolStats = statsResponse.data?.stats || [];
      } catch {
        this.logger.warn(
          "V2 pool stats not available yet (indexing may not be complete)",
        );
      }

      // Create lookup map for V2 stats by pool address
      const v2StatsMap = new Map<string, V2PoolStatEntry>();
      for (const stat of v2PoolStats) {
        v2StatsMap.set(stat.poolAddress.toLowerCase(), stat);
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
        const pairAddresses = v2Pools.map((p) => getAddress(p.pairAddress));

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

            if (isToken0Jusd || isToken1Jusd) {
              // JUSD reserve gives us the USD value of one side
              const jusdReserve = isToken0Jusd ? reserve0Raw : reserve1Raw;
              // TVL = 2 * JUSD reserve (both sides are equal value in AMM)
              const jusdReserveFormatted = Number(
                formatUnits(BigInt(jusdReserve.toString()), 18),
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
                const reserve0Formatted = Number(
                  formatUnits(BigInt(reserve0Raw.toString()), 18),
                );
                totalTvlUsd += 2 * reserve0Formatted * price0;
              } else if (price1 > 0) {
                const reserve1Formatted = Number(
                  formatUnits(BigInt(reserve1Raw.toString()), 18),
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

      // Calculate V2 volume from indexed stats
      for (const pool of v2Pools) {
        const stats = v2StatsMap.get(pool.pairAddress.toLowerCase());
        if (!stats) continue;

        // For V2 launchpad pools paired with JUSD, the JUSD-side volume gives USD volume
        const jusdAddress = contracts?.JUSD?.toLowerCase();
        const isToken0Jusd = pool.token0.toLowerCase() === jusdAddress;

        if (isToken0Jusd) {
          // volume0 is JUSD volume
          totalVolume24hUsd += Number(
            formatUnits(BigInt(stats.volume0 || "0"), 18),
          );
        } else if (pool.token1.toLowerCase() === jusdAddress) {
          // volume1 is JUSD volume
          totalVolume24hUsd += Number(
            formatUnits(BigInt(stats.volume1 || "0"), 18),
          );
        }
        // Non-JUSD pairs: skip (no USD volume attribution without price data)
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
}
