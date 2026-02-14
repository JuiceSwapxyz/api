import Logger from "bunyan";
import { ChainId } from "@juiceswapxyz/sdk-core";
import { UniswapMulticallProvider } from "@juiceswapxyz/smart-order-router";
import { ethers } from "ethers";
import { PriceService, BtcPriceData, BtcPriceHistory } from "./PriceService";
import { getPonderClient } from "./PonderClient";
import { getChainContracts } from "../config/contracts";
import { getChainName } from "../config/chains";

// Minimal ERC20 ABI — balanceOf for TVL, totalSupply for FDV
const ERC20_BALANCE_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
];

const ERC20_TOTAL_SUPPLY_ABI = [
  "function totalSupply() view returns (uint256)",
];

// V2 Pair ABI for getReserves
const V2_PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
];

// Equity contract ABI — price() returns JUICE price in JUSD (18 decimals)
const EQUITY_PRICE_ABI = ["function price() view returns (uint256)"];

// V3 Pool ABI for slot0
const V3_POOL_SLOT0_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
];

// ---------- Ponder raw data types ----------

interface PonderToken {
  address: string;
  decimals: number;
  symbol: string;
  name: string;
}

interface PonderPool {
  address: string;
  token0: string;
  token1: string;
  fee: number;
}

interface PonderPoolStat {
  poolAddress: string;
  volume0: string;
  volume1: string;
  txCount: string;
  timestamp: string;
  type: string;
}

interface PonderTokenStat {
  address: string;
  volume: string;
  txCount: string;
  timestamp: string;
  type: string;
}

interface PonderV2Pool {
  pairAddress: string;
  token0: string;
  token1: string;
  launchpadTokenAddress: string;
}

interface PonderV2PoolStat {
  poolAddress: string;
  volume0: string;
  volume1: string;
  txCount: string;
  timestamp: string;
}

interface PonderPoolActivity {
  poolAddress: string;
  sqrtPriceX96: string;
  blockTimestamp: string;
}

interface PonderSwap {
  txHash: string;
  blockTimestamp: string;
  swapperAddress: string;
  from: string;
  to: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  chainId: number;
}

// ---------- Response types (protobuf-compatible JSON) ----------

interface PriceHistoryResponse {
  start: number;
  end: number;
  step: number;
  values: number[];
}

interface Amount {
  currency?: string;
  value: number;
}

interface TokenProject {
  name?: string;
}

interface TokenStatsResponse {
  chain: string;
  address: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  price?: Amount;
  fullyDilutedValuation?: Amount;
  pricePercentChange1Hour?: Amount;
  pricePercentChange1Day?: Amount;
  volume1Hour?: Amount;
  volume1Day?: Amount;
  volume1Week?: Amount;
  volume1Month?: Amount;
  volume1Year?: Amount;
  priceHistoryDay?: PriceHistoryResponse;
  project?: TokenProject;
}

interface PoolStatsResponse {
  id: string;
  chain: string;
  totalLiquidity?: Amount;
  txCount?: number;
  volume1Day?: Amount;
  volume1Week?: Amount;
  volume30Day?: Amount;
  feeTier?: number;
  token0?: TokenStatsResponse;
  token1?: TokenStatsResponse;
  protocolVersion?: string;
}

interface TransactionStatsResponse {
  hash: string;
  chain: string;
  timestamp: number;
  account: string;
  usdValue?: Amount;
  token0?: TokenStatsResponse;
  token0Quantity: string;
  token1?: TokenStatsResponse;
  token1Quantity: string;
  type: string;
  protocolVersion: string;
}

interface ExploreStatsResponseData {
  stats: {
    tokenStats: TokenStatsResponse[];
    poolStatsV2: PoolStatsResponse[];
    poolStatsV3: PoolStatsResponse[];
    transactionStats: TransactionStatsResponse[];
  };
}

interface StatsCache {
  response: ExploreStatsResponseData;
  timestamp: number;
}

/**
 * ExploreStatsService - Enriches Ponder raw data with USD prices, TVL, and volumes
 *
 * Reuses existing infrastructure:
 * - PriceService for BTC + stablecoin prices
 * - PonderClient for GraphQL queries
 * - UniswapMulticallProvider for on-chain balances (TVL)
 */
export class ExploreStatsService {
  private logger: Logger;
  private priceService: PriceService;
  private providers: Map<ChainId, ethers.providers.StaticJsonRpcProvider>;
  private cache: Map<number, StatsCache> = new Map();
  private inflightRequests: Map<number, Promise<ExploreStatsResponseData>> =
    new Map();
  private readonly CACHE_TTL = 60_000; // 60 seconds
  private readonly REFRESH_INTERVAL = this.CACHE_TTL - 5_000; // refresh 5s before TTL
  private backgroundRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private yearlyVolumeCache: Map<
    number,
    {
      v3Stats: PonderPoolStat[];
      v2Stats: PonderV2PoolStat[];
      timestamp: number;
    }
  > = new Map();
  private readonly YEARLY_CACHE_TTL = 15 * 60_000; // 15 minutes

  constructor(
    providers: Map<ChainId, ethers.providers.StaticJsonRpcProvider>,
    logger: Logger,
  ) {
    this.logger = logger.child({ service: "ExploreStatsService" });
    this.priceService = new PriceService(logger);
    this.providers = providers;
  }

  /**
   * Pre-warm the cache for the given chain IDs and keep it warm
   * by refreshing just before the TTL expires.
   * Safe to call only once; subsequent calls are ignored.
   */
  startBackgroundRefresh(chainIds: number[]): void {
    if (this.backgroundRefreshTimer) {
      return;
    }

    const refresh = () => {
      for (const chainId of chainIds) {
        this.getExploreStats(chainId).catch((err) => {
          this.logger.warn(
            { chainId, error: err },
            "Background cache refresh failed",
          );
        });
      }
    };

    // Immediately pre-warm
    refresh();
    this.logger.info(
      { chainIds },
      "ExploreStatsService background refresh started",
    );

    // Refresh just before TTL expires to keep cache perpetually warm
    this.backgroundRefreshTimer = setInterval(refresh, this.REFRESH_INTERVAL);
  }

  /**
   * Stop the background refresh timer. Call during graceful shutdown
   * to allow the process to exit cleanly without waiting for the timer.
   */
  stopBackgroundRefresh(): void {
    if (this.backgroundRefreshTimer) {
      clearInterval(this.backgroundRefreshTimer);
      this.backgroundRefreshTimer = null;
      this.logger.info("ExploreStatsService background refresh stopped");
    }
  }

  /**
   * Look up a single V3 pool's stats from the cached explore data.
   * Returns undefined if the pool is not found.
   */
  async getPoolStats(
    chainId: number,
    poolAddress: string,
  ): Promise<PoolStatsResponse | undefined> {
    const exploreData = await this.getExploreStats(chainId);
    return exploreData.stats?.poolStatsV3?.find(
      (p) => p.id.toLowerCase() === poolAddress.toLowerCase(),
    );
  }

  async getExploreStats(chainId: number): Promise<ExploreStatsResponseData> {
    const cached = this.cache.get(chainId);
    const now = Date.now();
    if (cached && now - cached.timestamp < this.CACHE_TTL) {
      return cached.response;
    }

    // Deduplicate concurrent requests: piggyback on inflight promise
    const inflight = this.inflightRequests.get(chainId);
    if (inflight) {
      return inflight;
    }

    const promise = this.fetchExploreStats(chainId);
    this.inflightRequests.set(chainId, promise);
    try {
      return await promise;
    } finally {
      this.inflightRequests.delete(chainId);
    }
  }

  private async fetchExploreStats(
    chainId: number,
  ): Promise<ExploreStatsResponseData> {
    const now = Date.now();
    const chainName = getChainName(chainId);
    const ponderClient = getPonderClient(this.logger);

    // 1. Fetch all raw data from Ponder in parallel
    //    365d volume stats use a 15-min tiered cache (heaviest queries, rarely change)
    const [
      tokens,
      v3Pools,
      v3PoolStats24h,
      v3PoolStats30d,
      v2Pools,
      v2PoolStats24h,
      v2PoolStats30d,
      tokenStats1h,
      recentSwaps,
      poolActivities,
      btcPriceData,
      btcPriceHistory,
      yearlyStats,
    ] = await Promise.all([
      this.fetchTokens(ponderClient, chainId),
      this.fetchV3Pools(ponderClient, chainId),
      this.fetchPoolStats(ponderClient, chainId, "1h", 24),
      this.fetchPoolStats(ponderClient, chainId, "24h", 30 * 24),
      this.fetchV2Pools(ponderClient, chainId),
      this.fetchV2PoolStats(ponderClient, chainId, "1h", 24),
      this.fetchV2PoolStats(ponderClient, chainId, "24h", 30 * 24),
      this.fetchTokenStats(ponderClient, chainId, "1h", 24),
      this.fetchRecentSwaps(ponderClient, chainId),
      this.fetchPoolActivities(ponderClient, chainId),
      this.priceService.getBtcPriceData().catch((err) => {
        this.logger.warn({ error: err }, "Failed to fetch BTC price data");
        return { price: 0, change1h: 0, change24h: 0 } as BtcPriceData;
      }),
      this.priceService.getBtcPriceHistory().catch((err) => {
        this.logger.warn({ error: err }, "Failed to fetch BTC price history");
        return null;
      }),
      this.getYearlyVolumeStats(ponderClient, chainId),
    ]);
    const v3PoolStats365d = yearlyStats.v3;
    const v2PoolStats365d = yearlyStats.v2;

    // 2. Build token map (from Ponder + known contract tokens as fallback)
    const tokenMap = new Map<string, PonderToken>();
    for (const t of tokens) {
      tokenMap.set(t.address.toLowerCase(), t);
    }

    // Add known tokens from contracts config as fallback for V2 pools
    const contracts = getChainContracts(chainId);
    if (contracts) {
      const knownTokenFallbacks: Array<{
        addr: string;
        symbol: string;
        name: string;
        decimals: number;
      }> = [
        {
          addr: contracts.JUSD,
          symbol: "JUSD",
          name: "JuiceDollar",
          decimals: 18,
        },
        {
          addr: contracts.JUICE,
          symbol: "JUICE",
          name: "Juice Protocol",
          decimals: 18,
        },
      ];
      for (const kt of knownTokenFallbacks) {
        if (kt.addr && !tokenMap.has(kt.addr.toLowerCase())) {
          tokenMap.set(kt.addr.toLowerCase(), {
            address: kt.addr,
            symbol: kt.symbol,
            name: kt.name,
            decimals: kt.decimals,
          });
        }
      }
    }

    // 3. Collect all unique token addresses
    const allTokenAddrs = new Set<string>();
    for (const t of tokens) {
      allTokenAddrs.add(t.address.toLowerCase());
    }
    for (const p of v3Pools) {
      allTokenAddrs.add(p.token0.toLowerCase());
      allTokenAddrs.add(p.token1.toLowerCase());
    }
    for (const p of v2Pools) {
      allTokenAddrs.add(p.token0.toLowerCase());
      allTokenAddrs.add(p.token1.toLowerCase());
    }

    // 4. Get token prices (BTC, stablecoins, JUICE on-chain, then derive unknown from pools)
    const prices = await this.resolveAllTokenPrices(
      chainId,
      allTokenAddrs,
      v3Pools,
      tokenMap,
    );

    // Group pool activities by pool address (shared by price changes + sparklines)
    const activitiesByPool = this.groupActivitiesByPool(poolActivities);

    // 4d. Compute token price changes (1h, 24h) and FDV
    const { pctChange1h, pctChange24h } = this.computeTokenPriceChanges(
      v3Pools,
      tokenMap,
      prices,
      btcPriceData,
      activitiesByPool,
      chainId,
    );
    const priceHistories = this.buildTokenPriceHistories(
      tokens,
      v3Pools,
      tokenMap,
      prices,
      btcPriceHistory,
      activitiesByPool,
      chainId,
    );

    // Create a single multicall provider for all on-chain reads
    const provider = this.providers.get(chainId as ChainId);
    const multicallProvider = provider
      ? new UniswapMulticallProvider(chainId as ChainId, provider, 375000)
      : null;

    // 5. Compute FDV + TVL via parallel multicalls (all read-only against `prices`)
    const [fdvMap, v3PoolTvl, v2PoolTvl] = await Promise.all([
      this.computeTokenFdv(tokens, prices, multicallProvider),
      this.computeV3PoolTvl(v3Pools, tokenMap, prices, multicallProvider),
      this.computeV2PoolTvl(
        chainId,
        v2Pools,
        tokenMap,
        prices,
        multicallProvider,
      ),
    ]);

    // 7. Compute pool volumes
    const v3PoolMap = new Map(v3Pools.map((p) => [p.address.toLowerCase(), p]));
    const v2PoolMap = new Map(
      v2Pools.map((p) => [p.pairAddress.toLowerCase(), p]),
    );

    const v3Vol1d = this.aggregatePoolVolumes(
      v3PoolStats24h,
      v3PoolMap,
      tokenMap,
      prices,
    );
    const v3Vol30d = this.aggregatePoolVolumes(
      v3PoolStats30d,
      v3PoolMap,
      tokenMap,
      prices,
    );
    const v2Vol1d = this.aggregateV2PoolVolumes(
      v2PoolStats24h,
      v2PoolMap,
      tokenMap,
      chainId,
    );
    const v2Vol30d = this.aggregateV2PoolVolumes(
      v2PoolStats30d,
      v2PoolMap,
      tokenMap,
      chainId,
    );

    // 7b. Compute 7-day pool volumes (filter 30d data to last 7 days)
    const sevenDayCutoff = (
      Math.floor(Date.now() / 1000) -
      7 * 24 * 3600
    ).toString();
    const v3Vol7d = this.aggregatePoolVolumes(
      v3PoolStats30d.filter((ps) => ps.timestamp >= sevenDayCutoff),
      v3PoolMap,
      tokenMap,
      prices,
    );
    const v2Vol7d = this.aggregateV2PoolVolumes(
      v2PoolStats30d.filter((ps) => ps.timestamp >= sevenDayCutoff),
      v2PoolMap,
      tokenMap,
      chainId,
    );

    // 7c. Compute 365-day pool volumes
    const v3Vol365d = this.aggregatePoolVolumes(
      v3PoolStats365d,
      v3PoolMap,
      tokenMap,
      prices,
    );
    const v2Vol365d = this.aggregateV2PoolVolumes(
      v2PoolStats365d,
      v2PoolMap,
      tokenMap,
      chainId,
    );

    // 8. Compute token 1-day volumes (V3 tokenStat)
    const tokenVol1d = this.aggregateTokenVolumes(
      tokenStats1h,
      tokenMap,
      prices,
    );

    // 9. Compute token 1-hour volumes (from 1h bucket)
    const tokenVol1h = this.aggregateTokenVolumes(
      tokenStats1h.filter((ts) => {
        const cutoff = Math.floor(Date.now() / 1000) - 3600;
        return parseInt(ts.timestamp) >= cutoff;
      }),
      tokenMap,
      prices,
    );

    // 9b. Attribute V2 pool volumes to their non-JUSD tokens
    this.attributeV2TokenVolumes(
      v2PoolStats24h,
      v2PoolMap,
      tokenMap,
      chainId,
      tokenVol1d,
    );

    // 9c. Also attribute V2 volumes to 1-hour token volumes
    const v2PoolStats1h = v2PoolStats24h.filter((ps) => {
      const cutoff = Math.floor(Date.now() / 1000) - 3600;
      return parseInt(ps.timestamp) >= cutoff;
    });
    this.attributeV2TokenVolumes(
      v2PoolStats1h,
      v2PoolMap,
      tokenMap,
      chainId,
      tokenVol1h,
    );

    // 10. Derive token volumes for longer timeframes from pool volumes
    const tokenVol1w = this.deriveTokenVolumesFromPoolVolumes(
      v3Vol7d,
      v2Vol7d,
      v3Pools,
      v2Pools,
    );
    const tokenVol1m = this.deriveTokenVolumesFromPoolVolumes(
      v3Vol30d,
      v2Vol30d,
      v3Pools,
      v2Pools,
    );
    const tokenVol1y = this.deriveTokenVolumesFromPoolVolumes(
      v3Vol365d,
      v2Vol365d,
      v3Pools,
      v2Pools,
    );

    // 11. Build response

    // Token stats
    const tokenStatsResponse: TokenStatsResponse[] = tokens.map((t) => {
      const addr = t.address.toLowerCase();
      const priceUsd = prices.get(addr) || 0;
      return {
        chain: chainName,
        address: t.address,
        name: t.name,
        symbol: t.symbol,
        decimals: t.decimals,
        price: priceUsd > 0 ? { currency: "USD", value: priceUsd } : undefined,
        pricePercentChange1Hour: pctChange1h.has(addr)
          ? { currency: "USD", value: pctChange1h.get(addr)! }
          : undefined,
        pricePercentChange1Day: pctChange24h.has(addr)
          ? { currency: "USD", value: pctChange24h.get(addr)! }
          : undefined,
        fullyDilutedValuation:
          fdvMap.get(addr) != null && fdvMap.get(addr)! > 0
            ? { currency: "USD", value: fdvMap.get(addr)! }
            : undefined,
        volume1Day: { currency: "USD", value: tokenVol1d.get(addr) ?? 0 },
        volume1Hour: { currency: "USD", value: tokenVol1h.get(addr) ?? 0 },
        volume1Week: { currency: "USD", value: tokenVol1w.get(addr) ?? 0 },
        volume1Month: { currency: "USD", value: tokenVol1m.get(addr) ?? 0 },
        volume1Year: { currency: "USD", value: tokenVol1y.get(addr) ?? 0 },
        priceHistoryDay: priceHistories.get(addr),
        project: { name: t.name },
      };
    });

    // V3 Pool stats
    const poolStatsV3Response: PoolStatsResponse[] = v3Pools.map((pool) => {
      const addr = pool.address.toLowerCase();
      const t0 = tokenMap.get(pool.token0.toLowerCase());
      const t1 = tokenMap.get(pool.token1.toLowerCase());
      const tvl = v3PoolTvl.get(addr) || 0;
      const vol1d = v3Vol1d.get(addr) || 0;
      const vol30d = v3Vol30d.get(addr) || 0;

      // Count transactions from 24h stats for this pool
      const txCount = v3PoolStats24h
        .filter((ps) => ps.poolAddress.toLowerCase() === addr)
        .reduce((sum, ps) => sum + parseInt(ps.txCount || "0"), 0);

      return {
        id: pool.address,
        chain: chainName,
        totalLiquidity: { currency: "USD", value: tvl },
        txCount: txCount || undefined,
        volume1Day: { currency: "USD", value: vol1d },
        volume30Day: { currency: "USD", value: vol30d },
        feeTier: pool.fee,
        token0: t0
          ? {
              chain: chainName,
              address: t0.address,
              name: t0.name,
              symbol: t0.symbol,
              decimals: t0.decimals,
              price:
                (prices.get(t0.address.toLowerCase()) || 0) > 0
                  ? {
                      currency: "USD",
                      value: prices.get(t0.address.toLowerCase())!,
                    }
                  : undefined,
              project: { name: t0.name },
            }
          : undefined,
        token1: t1
          ? {
              chain: chainName,
              address: t1.address,
              name: t1.name,
              symbol: t1.symbol,
              decimals: t1.decimals,
              price:
                (prices.get(t1.address.toLowerCase()) || 0) > 0
                  ? {
                      currency: "USD",
                      value: prices.get(t1.address.toLowerCase())!,
                    }
                  : undefined,
              project: { name: t1.name },
            }
          : undefined,
        protocolVersion: "V3",
      };
    });

    // V2 Pool stats
    const poolStatsV2Response: PoolStatsResponse[] = v2Pools.map((pool) => {
      const addr = pool.pairAddress.toLowerCase();
      const t0 = tokenMap.get(pool.token0.toLowerCase());
      const t1 = tokenMap.get(pool.token1.toLowerCase());
      const tvl = v2PoolTvl.get(addr) || 0;
      const vol1d = v2Vol1d.get(addr) || 0;
      const vol30d = v2Vol30d.get(addr) || 0;

      const txCount = v2PoolStats24h
        .filter((ps) => ps.poolAddress.toLowerCase() === addr)
        .reduce((sum, ps) => sum + parseInt(ps.txCount || "0"), 0);

      return {
        id: pool.pairAddress,
        chain: chainName,
        totalLiquidity: { currency: "USD", value: tvl },
        txCount: txCount || undefined,
        volume1Day: { currency: "USD", value: vol1d },
        volume30Day: { currency: "USD", value: vol30d },
        feeTier: 3000, // V2 default fee tier (0.3%)
        token0: t0
          ? {
              chain: chainName,
              address: t0.address,
              name: t0.name,
              symbol: t0.symbol,
              decimals: t0.decimals,
              price:
                (prices.get(t0.address.toLowerCase()) || 0) > 0
                  ? {
                      currency: "USD",
                      value: prices.get(t0.address.toLowerCase())!,
                    }
                  : undefined,
              project: { name: t0.name },
            }
          : undefined,
        token1: t1
          ? {
              chain: chainName,
              address: t1.address,
              name: t1.name,
              symbol: t1.symbol,
              decimals: t1.decimals,
              price:
                (prices.get(t1.address.toLowerCase()) || 0) > 0
                  ? {
                      currency: "USD",
                      value: prices.get(t1.address.toLowerCase())!,
                    }
                  : undefined,
              project: { name: t1.name },
            }
          : undefined,
        protocolVersion: "V2",
      };
    });

    // Transaction stats
    const transactionStatsResponse: TransactionStatsResponse[] =
      recentSwaps.map((swap) => {
        // tokenIn/tokenOut map directly to token0/token1
        const tokenInAddr = swap.tokenIn?.toLowerCase();
        const tokenOutAddr = swap.tokenOut?.toLowerCase();

        const tIn = tokenInAddr ? tokenMap.get(tokenInAddr) : undefined;
        const tOut = tokenOutAddr ? tokenMap.get(tokenOutAddr) : undefined;

        // Calculate USD value from known-price side
        let usdValue = 0;
        if (tIn && tokenInAddr) {
          const priceIn = prices.get(tokenInAddr) || 0;
          if (priceIn > 0) {
            const amount = Math.abs(
              parseFloat(
                ethers.utils.formatUnits(swap.amountIn || "0", tIn.decimals),
              ),
            );
            usdValue = amount * priceIn;
          }
        }
        if (usdValue === 0 && tOut && tokenOutAddr) {
          const priceOut = prices.get(tokenOutAddr) || 0;
          if (priceOut > 0) {
            const amount = Math.abs(
              parseFloat(
                ethers.utils.formatUnits(swap.amountOut || "0", tOut.decimals),
              ),
            );
            usdValue = amount * priceOut;
          }
        }

        const amountInFormatted = tIn
          ? Math.abs(
              parseFloat(
                ethers.utils.formatUnits(swap.amountIn || "0", tIn.decimals),
              ),
            ).toString()
          : "0";
        const amountOutFormatted = tOut
          ? Math.abs(
              parseFloat(
                ethers.utils.formatUnits(swap.amountOut || "0", tOut.decimals),
              ),
            ).toString()
          : "0";

        return {
          hash: swap.txHash,
          chain: chainName,
          timestamp: parseInt(swap.blockTimestamp),
          account: swap.swapperAddress,
          usdValue:
            usdValue > 0 ? { currency: "USD", value: usdValue } : undefined,
          token0: tIn
            ? {
                chain: chainName,
                address: tIn.address,
                name: tIn.name,
                symbol: tIn.symbol,
                decimals: tIn.decimals,
                project: { name: tIn.name },
              }
            : undefined,
          token0Quantity: amountInFormatted,
          token1: tOut
            ? {
                chain: chainName,
                address: tOut.address,
                name: tOut.name,
                symbol: tOut.symbol,
                decimals: tOut.decimals,
                project: { name: tOut.name },
              }
            : undefined,
          token1Quantity: amountOutFormatted,
          type: "SWAP",
          protocolVersion: "V3",
        };
      });

    const response: ExploreStatsResponseData = {
      stats: {
        tokenStats: tokenStatsResponse,
        poolStatsV2: poolStatsV2Response,
        poolStatsV3: poolStatsV3Response,
        transactionStats: transactionStatsResponse,
      },
    };

    this.cache.set(chainId, { response, timestamp: now });

    this.logger.info(
      {
        chainId,
        tokenCount: tokenStatsResponse.length,
        v3PoolCount: poolStatsV3Response.length,
        v2PoolCount: poolStatsV2Response.length,
        txCount: transactionStatsResponse.length,
      },
      "Explore stats computed",
    );

    return response;
  }

  // ---------- Ponder data fetching ----------

  private async fetchTokens(
    ponderClient: ReturnType<typeof getPonderClient>,
    chainId: number,
  ): Promise<PonderToken[]> {
    try {
      const query = `
        query GetTokens($where: tokenFilter = {}) {
          tokens(where: $where, limit: 200) {
            items { address, decimals, symbol, name }
          }
        }
      `;
      const result = await ponderClient.query(query, {
        where: { chainId },
      });
      return result.tokens?.items || [];
    } catch {
      this.logger.warn("Failed to fetch tokens from Ponder");
      return [];
    }
  }

  private async fetchV3Pools(
    ponderClient: ReturnType<typeof getPonderClient>,
    chainId: number,
  ): Promise<PonderPool[]> {
    try {
      const query = `
        query GetPools($where: poolFilter = {}) {
          pools(where: $where, limit: 200) {
            items { address, token0, token1, fee }
          }
        }
      `;
      const result = await ponderClient.query(query, {
        where: { chainId },
      });
      return result.pools?.items || [];
    } catch {
      this.logger.warn("Failed to fetch V3 pools from Ponder");
      return [];
    }
  }

  private async fetchPoolStats(
    ponderClient: ReturnType<typeof getPonderClient>,
    chainId: number,
    bucketType: string,
    hoursBack: number,
  ): Promise<PonderPoolStat[]> {
    try {
      const cutoff = (
        Math.floor(Date.now() / 1000) -
        hoursBack * 3600
      ).toString();
      const query = `
        query GetPoolStats($where: poolStatFilter = {}) {
          poolStats(where: $where, orderBy: "timestamp", orderDirection: "desc", limit: 1000) {
            items { poolAddress, volume0, volume1, txCount, timestamp, type }
          }
        }
      `;
      const result = await ponderClient.query(query, {
        where: { type: bucketType, chainId, timestamp_gte: cutoff },
      });
      return result.poolStats?.items || [];
    } catch {
      this.logger.warn(
        { bucketType, hoursBack },
        "Failed to fetch pool stats from Ponder",
      );
      return [];
    }
  }

  private async fetchV2Pools(
    ponderClient: ReturnType<typeof getPonderClient>,
    chainId: number,
  ): Promise<PonderV2Pool[]> {
    try {
      const response = await ponderClient.get(
        `/graduated-pools?chainId=${chainId}`,
      );
      return response.data?.pools || [];
    } catch {
      this.logger.warn("Failed to fetch V2 pools from Ponder");
      return [];
    }
  }

  private async fetchV2PoolStats(
    ponderClient: ReturnType<typeof getPonderClient>,
    chainId: number,
    bucketType: string,
    hoursBack: number,
  ): Promise<PonderV2PoolStat[]> {
    try {
      const cutoff = (
        Math.floor(Date.now() / 1000) -
        hoursBack * 3600
      ).toString();
      const query = `
        query GetV2PoolStats($where: v2PoolStatFilter = {}) {
          v2PoolStats(where: $where, orderBy: "timestamp", orderDirection: "desc", limit: 1000) {
            items { poolAddress, volume0, volume1, txCount, timestamp }
          }
        }
      `;
      const result = await ponderClient.query(query, {
        where: { type: bucketType, chainId, timestamp_gte: cutoff },
      });
      return result.v2PoolStats?.items || [];
    } catch {
      this.logger.warn("Failed to fetch V2 pool stats from Ponder");
      return [];
    }
  }

  /**
   * Get yearly (365d) volume stats with a 15-minute cache.
   * These are the heaviest Ponder queries (~7000 records each) but the data
   * barely changes minute-to-minute, so we avoid re-fetching every 55s.
   */
  private async getYearlyVolumeStats(
    ponderClient: ReturnType<typeof getPonderClient>,
    chainId: number,
  ): Promise<{ v3: PonderPoolStat[]; v2: PonderV2PoolStat[] }> {
    const cached = this.yearlyVolumeCache.get(chainId);
    if (cached && Date.now() - cached.timestamp < this.YEARLY_CACHE_TTL) {
      return { v3: cached.v3Stats, v2: cached.v2Stats };
    }
    const [v3Stats, v2Stats] = await Promise.all([
      this.fetchPoolStats(ponderClient, chainId, "24h", 365 * 24),
      this.fetchV2PoolStats(ponderClient, chainId, "24h", 365 * 24),
    ]);
    this.yearlyVolumeCache.set(chainId, {
      v3Stats,
      v2Stats,
      timestamp: Date.now(),
    });
    return { v3: v3Stats, v2: v2Stats };
  }

  private async fetchTokenStats(
    ponderClient: ReturnType<typeof getPonderClient>,
    chainId: number,
    bucketType: string,
    hoursBack: number,
  ): Promise<PonderTokenStat[]> {
    try {
      const cutoff = (
        Math.floor(Date.now() / 1000) -
        hoursBack * 3600
      ).toString();
      const query = `
        query GetTokenStats($where: tokenStatFilter = {}) {
          tokenStats(where: $where, orderBy: "timestamp", orderDirection: "desc", limit: 1000) {
            items { address, volume, txCount, timestamp, type }
          }
        }
      `;
      const result = await ponderClient.query(query, {
        where: { type: bucketType, chainId, timestamp_gte: cutoff },
      });
      return result.tokenStats?.items || [];
    } catch {
      this.logger.warn("Failed to fetch token stats from Ponder");
      return [];
    }
  }

  private async fetchRecentSwaps(
    ponderClient: ReturnType<typeof getPonderClient>,
    chainId: number,
  ): Promise<PonderSwap[]> {
    try {
      const query = `
        query GetRecentSwaps($where: transactionSwapFilter = {}) {
          transactionSwaps(where: $where, orderBy: "blockTimestamp", orderDirection: "desc", limit: 50) {
            items { txHash, blockTimestamp, swapperAddress, from, to, tokenIn, tokenOut, amountIn, amountOut, chainId }
          }
        }
      `;
      const result = await ponderClient.query(query, {
        where: { chainId },
      });
      return result.transactionSwaps?.items || [];
    } catch {
      this.logger.warn("Failed to fetch recent swaps from Ponder");
      return [];
    }
  }

  // ---------- Price derivation ----------

  /**
   * Resolve all token prices in the correct sequential order:
   * 1. getTokenPrices — BTC-pegged + stablecoins from PriceService
   * 2. fetchJuicePrice — on-chain Equity.price() for JUICE
   * 3. deriveUnknownPrices — derive remaining tokens from V3 pool slot0()
   *
   * This chain MUST remain sequential: deriveUnknownPrices needs JUICE priced
   * first, since tokens paired with JUICE in V3 pools would fail to derive otherwise.
   */
  private async resolveAllTokenPrices(
    chainId: number,
    allTokenAddrs: Set<string>,
    v3Pools: PonderPool[],
    tokenMap: Map<string, PonderToken>,
  ): Promise<Map<string, number>> {
    const prices = await this.priceService.getTokenPrices(
      chainId,
      Array.from(allTokenAddrs),
    );
    await this.fetchJuicePrice(chainId, prices);
    await this.deriveUnknownPrices(chainId, v3Pools, tokenMap, prices);
    return prices;
  }

  /**
   * Fetch JUICE price from the on-chain Equity.price() method.
   * Returns price in JUSD (18 decimals). Since JUSD ≈ $1, this is the USD price.
   */
  private async fetchJuicePrice(
    chainId: number,
    prices: Map<string, number>,
  ): Promise<void> {
    const contracts = getChainContracts(chainId);
    const provider = this.providers.get(chainId as ChainId);
    if (!contracts?.JUICE || !provider) return;

    const juiceAddr = contracts.JUICE.toLowerCase();
    // Skip if already priced
    if ((prices.get(juiceAddr) || 0) > 0) return;

    try {
      const equityContract = new ethers.Contract(
        contracts.JUICE,
        EQUITY_PRICE_ABI,
        provider,
      );
      const priceRaw: ethers.BigNumber = await equityContract.price();
      const priceUsd = parseFloat(ethers.utils.formatUnits(priceRaw, 18));

      if (priceUsd > 0 && isFinite(priceUsd)) {
        prices.set(juiceAddr, priceUsd);
        this.logger.debug(
          { priceUsd },
          "Fetched JUICE price from Equity contract",
        );
      }
    } catch (error) {
      this.logger.warn(
        { error },
        "Failed to fetch JUICE price from Equity contract",
      );
    }
  }

  /**
   * Derive prices for unknown tokens from V3 pool sqrtPriceX96.
   * For each unpriced token, find a pool where the counterpart has a known price.
   * Uses on-chain slot0() calls instead of Ponder poolActivity for reliability.
   */
  private async deriveUnknownPrices(
    chainId: number,
    pools: PonderPool[],
    tokenMap: Map<string, PonderToken>,
    prices: Map<string, number>,
  ): Promise<void> {
    const provider = this.providers.get(chainId as ChainId);
    if (!provider) return;

    // Collect all (unpricedToken, pool, knownPriceToken, unknownIsToken0) triples
    const derivationTargets: Array<{
      unpricedAddr: string;
      pool: PonderPool;
      knownPriceAddr: string;
      unknownIsToken0: boolean;
    }> = [];

    const unpricedTokens: string[] = [];
    prices.forEach((price, addr) => {
      if (price === 0) unpricedTokens.push(addr);
    });

    if (unpricedTokens.length === 0) return;

    // For each unpriced token, find the first pool with a priced counterpart
    for (const unpricedAddr of unpricedTokens) {
      for (const pool of pools) {
        const t0 = pool.token0.toLowerCase();
        const t1 = pool.token1.toLowerCase();

        if (t0 === unpricedAddr && (prices.get(t1) || 0) > 0) {
          derivationTargets.push({
            unpricedAddr,
            pool,
            knownPriceAddr: t1,
            unknownIsToken0: true,
          });
          break;
        } else if (t1 === unpricedAddr && (prices.get(t0) || 0) > 0) {
          derivationTargets.push({
            unpricedAddr,
            pool,
            knownPriceAddr: t0,
            unknownIsToken0: false,
          });
          break;
        }
      }
    }

    if (derivationTargets.length === 0) return;

    // Batch all slot0() calls in parallel
    const slot0Results = await Promise.all(
      derivationTargets.map(async ({ pool }) => {
        try {
          const poolContract = new ethers.Contract(
            pool.address,
            V3_POOL_SLOT0_ABI,
            provider,
          );
          const slot0 = await poolContract.slot0();
          return slot0.sqrtPriceX96 as ethers.BigNumber;
        } catch {
          return null;
        }
      }),
    );

    // Derive prices from slot0 results
    for (let i = 0; i < derivationTargets.length; i++) {
      const sqrtPriceX96 = slot0Results[i];
      if (!sqrtPriceX96) continue;

      const { unpricedAddr, pool, knownPriceAddr, unknownIsToken0 } =
        derivationTargets[i];
      const t0 = pool.token0.toLowerCase();
      const t1 = pool.token1.toLowerCase();
      const token0Info = tokenMap.get(t0);
      const token1Info = tokenMap.get(t1);
      if (!token0Info || !token1Info) continue;

      // sqrtPriceX96 gives price of token0 in terms of token1
      // price = (sqrtPriceX96 / 2^96)^2 * 10^(decimals0 - decimals1)
      const sqrtPrice = parseFloat(sqrtPriceX96.toString());
      const Q96 = 2 ** 96;
      const priceRatio =
        (sqrtPrice / Q96) ** 2 *
        10 ** (token0Info.decimals - token1Info.decimals);

      const knownPrice = prices.get(knownPriceAddr)!;
      let derivedPrice: number;

      if (unknownIsToken0) {
        // priceRatio = price_token0 / price_token1
        derivedPrice = priceRatio * knownPrice;
      } else {
        derivedPrice = priceRatio > 0 ? knownPrice / priceRatio : 0;
      }

      if (derivedPrice > 0 && isFinite(derivedPrice)) {
        prices.set(unpricedAddr, derivedPrice);
        this.logger.debug(
          {
            token: unpricedAddr,
            symbol: tokenMap.get(unpricedAddr)?.symbol,
            derivedPrice,
            fromPool: pool.address,
          },
          "Derived token price from pool slot0",
        );
      }
    }
  }

  // ---------- TVL computation ----------

  private async computeV3PoolTvl(
    pools: PonderPool[],
    tokenMap: Map<string, PonderToken>,
    prices: Map<string, number>,
    multicallProvider: UniswapMulticallProvider | null,
  ): Promise<Map<string, number>> {
    const tvlMap = new Map<string, number>();

    if (!multicallProvider || pools.length === 0) return tvlMap;

    try {
      const erc20Interface = new ethers.utils.Interface(ERC20_BALANCE_ABI);

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
          } catch {
            return null;
          }
        }),
      );

      for (const entry of poolBalanceResults) {
        if (!entry) continue;
        const { pool, results } = entry;

        const t0 = tokenMap.get(pool.token0.toLowerCase());
        const t1 = tokenMap.get(pool.token1.toLowerCase());
        const price0 = prices.get(pool.token0.toLowerCase()) || 0;
        const price1 = prices.get(pool.token1.toLowerCase()) || 0;

        let poolTvl = 0;

        if (results[0]?.success && price0 > 0 && t0) {
          const balance0 = parseFloat(
            ethers.utils.formatUnits(results[0].result[0], t0.decimals),
          );
          poolTvl += balance0 * price0;
        }

        if (results[1]?.success && price1 > 0 && t1) {
          const balance1 = parseFloat(
            ethers.utils.formatUnits(results[1].result[0], t1.decimals),
          );
          poolTvl += balance1 * price1;
        }

        if (poolTvl > 0) {
          tvlMap.set(pool.address.toLowerCase(), poolTvl);
        }
      }
    } catch (error) {
      this.logger.warn({ error }, "Failed to compute V3 pool TVL");
    }

    return tvlMap;
  }

  private async computeV2PoolTvl(
    chainId: number,
    pools: PonderV2Pool[],
    tokenMap: Map<string, PonderToken>,
    prices: Map<string, number>,
    multicallProvider: UniswapMulticallProvider | null,
  ): Promise<Map<string, number>> {
    const tvlMap = new Map<string, number>();
    const contracts = getChainContracts(chainId);

    if (!multicallProvider || !contracts || pools.length === 0) return tvlMap;

    try {
      const v2PairInterface = new ethers.utils.Interface(V2_PAIR_ABI);
      const pairAddresses = pools.map((p) =>
        ethers.utils.getAddress(p.pairAddress),
      );

      const { results } =
        await multicallProvider.callSameFunctionOnMultipleContracts({
          addresses: pairAddresses,
          contractInterface: v2PairInterface,
          functionName: "getReserves",
        });

      for (let i = 0; i < pools.length; i++) {
        const pool = pools[i];
        const result = results[i];
        if (!result?.success) continue;

        const [reserve0Raw, reserve1Raw] = result.result as [
          ethers.BigNumber,
          ethers.BigNumber,
          number,
        ];

        const jusdAddress = contracts.JUSD?.toLowerCase();
        const isToken0Jusd = pool.token0.toLowerCase() === jusdAddress;
        const isToken1Jusd = pool.token1.toLowerCase() === jusdAddress;

        const decimals0 =
          tokenMap.get(pool.token0.toLowerCase())?.decimals ?? 18;
        const decimals1 =
          tokenMap.get(pool.token1.toLowerCase())?.decimals ?? 18;

        if (isToken0Jusd || isToken1Jusd) {
          const jusdDecimals = isToken0Jusd ? decimals0 : decimals1;
          const jusdReserve = isToken0Jusd ? reserve0Raw : reserve1Raw;
          const jusdReserveFormatted = parseFloat(
            ethers.utils.formatUnits(jusdReserve, jusdDecimals),
          );
          const jusdPrice =
            (jusdAddress ? prices.get(jusdAddress) : undefined) ?? 1.0;
          tvlMap.set(
            pool.pairAddress.toLowerCase(),
            2 * jusdReserveFormatted * jusdPrice,
          );
        }
      }
    } catch (error) {
      this.logger.warn({ error }, "Failed to compute V2 pool TVL");
    }

    return tvlMap;
  }

  // ---------- Volume aggregation ----------

  private aggregatePoolVolumes(
    poolStats: PonderPoolStat[],
    poolMap: Map<string, PonderPool>,
    tokenMap: Map<string, PonderToken>,
    prices: Map<string, number>,
  ): Map<string, number> {
    const volMap = new Map<string, number>();

    for (const ps of poolStats) {
      const poolAddr = ps.poolAddress?.toLowerCase();
      const pool = poolMap.get(poolAddr);
      if (!pool) continue;

      const t0 = tokenMap.get(pool.token0.toLowerCase());
      const t1 = tokenMap.get(pool.token1.toLowerCase());
      const price0 = prices.get(pool.token0.toLowerCase()) || 0;
      const price1 = prices.get(pool.token1.toLowerCase()) || 0;

      let vol = 0;
      if (price0 > 0 && t0) {
        vol =
          parseFloat(ethers.utils.formatUnits(ps.volume0 || "0", t0.decimals)) *
          price0;
      } else if (price1 > 0 && t1) {
        vol =
          parseFloat(ethers.utils.formatUnits(ps.volume1 || "0", t1.decimals)) *
          price1;
      }

      if (vol > 0) {
        volMap.set(poolAddr, (volMap.get(poolAddr) || 0) + vol);
      }
    }

    return volMap;
  }

  private aggregateV2PoolVolumes(
    poolStats: PonderV2PoolStat[],
    v2PoolMap: Map<string, PonderV2Pool>,
    tokenMap: Map<string, PonderToken>,
    chainId: number,
  ): Map<string, number> {
    const volMap = new Map<string, number>();
    const contracts = getChainContracts(chainId);
    if (!contracts) return volMap;

    const jusdAddress = contracts.JUSD?.toLowerCase();

    for (const stats of poolStats) {
      const pool = v2PoolMap.get(stats.poolAddress.toLowerCase());
      if (!pool) continue;

      const isToken0Jusd = pool.token0.toLowerCase() === jusdAddress;
      const isToken1Jusd = pool.token1.toLowerCase() === jusdAddress;

      let vol = 0;
      if (isToken0Jusd) {
        const decimals =
          tokenMap.get(pool.token0.toLowerCase())?.decimals ?? 18;
        vol = parseFloat(
          ethers.utils.formatUnits(stats.volume0 || "0", decimals),
        );
      } else if (isToken1Jusd) {
        const decimals =
          tokenMap.get(pool.token1.toLowerCase())?.decimals ?? 18;
        vol = parseFloat(
          ethers.utils.formatUnits(stats.volume1 || "0", decimals),
        );
      }

      if (vol > 0) {
        const addr = stats.poolAddress.toLowerCase();
        volMap.set(addr, (volMap.get(addr) || 0) + vol);
      }
    }

    return volMap;
  }

  private aggregateTokenVolumes(
    tokenStats: PonderTokenStat[],
    tokenMap: Map<string, PonderToken>,
    prices: Map<string, number>,
  ): Map<string, number> {
    const volMap = new Map<string, number>();

    for (const ts of tokenStats) {
      const addr = ts.address?.toLowerCase();
      if (!addr) continue;

      const token = tokenMap.get(addr);
      const price = prices.get(addr) || 0;
      if (!token || price === 0) continue;

      const vol =
        parseFloat(ethers.utils.formatUnits(ts.volume || "0", token.decimals)) *
        price;

      if (vol > 0) {
        volMap.set(addr, (volMap.get(addr) || 0) + vol);
      }
    }

    return volMap;
  }

  /**
   * Attribute V2 pool volumes to their non-JUSD tokens.
   * V2 pools are JUSD-paired, so the JUSD-side volume in USD ≈ JUSD volume (since JUSD ≈ $1).
   * This gives volume data for tokens traded exclusively in V2 pools.
   */
  private attributeV2TokenVolumes(
    v2PoolStats: PonderV2PoolStat[],
    v2PoolMap: Map<string, PonderV2Pool>,
    tokenMap: Map<string, PonderToken>,
    chainId: number,
    tokenVolMap: Map<string, number>,
  ): void {
    const contracts = getChainContracts(chainId);
    if (!contracts) return;

    const jusdAddress = contracts.JUSD?.toLowerCase();
    if (!jusdAddress) return;

    for (const stats of v2PoolStats) {
      const pool = v2PoolMap.get(stats.poolAddress.toLowerCase());
      if (!pool) continue;

      const t0 = pool.token0.toLowerCase();
      const t1 = pool.token1.toLowerCase();
      const isToken0Jusd = t0 === jusdAddress;
      const isToken1Jusd = t1 === jusdAddress;
      if (!isToken0Jusd && !isToken1Jusd) continue;

      // JUSD-side volume ≈ USD volume
      let jusdVol = 0;
      if (isToken0Jusd) {
        const decimals = tokenMap.get(t0)?.decimals ?? 18;
        jusdVol = parseFloat(
          ethers.utils.formatUnits(stats.volume0 || "0", decimals),
        );
      } else {
        const decimals = tokenMap.get(t1)?.decimals ?? 18;
        jusdVol = parseFloat(
          ethers.utils.formatUnits(stats.volume1 || "0", decimals),
        );
      }

      if (jusdVol > 0) {
        // Attribute to the non-JUSD token
        const counterpartAddr = isToken0Jusd ? t1 : t0;
        tokenVolMap.set(
          counterpartAddr,
          (tokenVolMap.get(counterpartAddr) || 0) + jusdVol,
        );
      }
    }
  }

  /**
   * Derive per-token USD volumes by attributing each pool's USD volume
   * to both of its constituent tokens and summing per token.
   */
  private deriveTokenVolumesFromPoolVolumes(
    v3PoolVolumes: Map<string, number>,
    v2PoolVolumes: Map<string, number>,
    v3Pools: PonderPool[],
    v2Pools: PonderV2Pool[],
  ): Map<string, number> {
    const tokenVolMap = new Map<string, number>();

    for (const pool of v3Pools) {
      const vol = v3PoolVolumes.get(pool.address.toLowerCase());
      if (!vol || vol <= 0) continue;
      const t0 = pool.token0.toLowerCase();
      const t1 = pool.token1.toLowerCase();
      tokenVolMap.set(t0, (tokenVolMap.get(t0) || 0) + vol);
      tokenVolMap.set(t1, (tokenVolMap.get(t1) || 0) + vol);
    }

    for (const pool of v2Pools) {
      const vol = v2PoolVolumes.get(pool.pairAddress.toLowerCase());
      if (!vol || vol <= 0) continue;
      const t0 = pool.token0.toLowerCase();
      const t1 = pool.token1.toLowerCase();
      tokenVolMap.set(t0, (tokenVolMap.get(t0) || 0) + vol);
      tokenVolMap.set(t1, (tokenVolMap.get(t1) || 0) + vol);
    }

    return tokenVolMap;
  }

  // ---------- Pool activity helpers ----------

  private groupActivitiesByPool(
    activities: PonderPoolActivity[],
  ): Map<string, PonderPoolActivity[]> {
    const map = new Map<string, PonderPoolActivity[]>();
    for (const activity of activities) {
      const key = activity.poolAddress.toLowerCase();
      let list = map.get(key);
      if (!list) {
        list = [];
        map.set(key, list);
      }
      list.push(activity);
    }
    return map;
  }

  private async fetchPoolActivities(
    ponderClient: ReturnType<typeof getPonderClient>,
    chainId: number,
  ): Promise<PonderPoolActivity[]> {
    try {
      const cutoff = (Math.floor(Date.now() / 1000) - 25 * 3600).toString();
      const query = `
        query GetPoolActivities($where: poolActivityFilter = {}) {
          poolActivitys(where: $where, orderBy: "blockTimestamp", orderDirection: "asc", limit: 1000) {
            items { poolAddress, sqrtPriceX96, blockTimestamp }
          }
        }
      `;
      const result = await ponderClient.query(query, {
        where: { chainId, blockTimestamp_gte: cutoff },
      });
      return result.poolActivitys?.items || [];
    } catch {
      this.logger.warn("Failed to fetch pool activities from Ponder");
      return [];
    }
  }

  // ---------- Price change computation ----------

  private computeTokenPriceChanges(
    pools: PonderPool[],
    tokenMap: Map<string, PonderToken>,
    prices: Map<string, number>,
    btcPriceData: BtcPriceData,
    activitiesByPool: Map<string, PonderPoolActivity[]>,
    chainId: number,
  ): { pctChange1h: Map<string, number>; pctChange24h: Map<string, number> } {
    const pctChange1h = new Map<string, number>();
    const pctChange24h = new Map<string, number>();

    const now = Math.floor(Date.now() / 1000);
    const target1h = now - 3600;
    const target24h = now - 24 * 3600;

    // Assign BTC-pegged and stablecoin tokens directly
    for (const [addr] of prices) {
      const category = this.priceService.getTokenCategory(chainId, addr);
      if (category === "BTC") {
        pctChange1h.set(addr, btcPriceData.change1h);
        pctChange24h.set(addr, btcPriceData.change24h);
      } else if (category === "STABLECOIN") {
        pctChange1h.set(addr, 0);
        pctChange24h.set(addr, 0);
      }
    }

    // For each unpriced-change token, find its reference pool and compute historical price
    for (const [addr, currentPrice] of prices) {
      if (currentPrice <= 0) continue;
      if (pctChange1h.has(addr)) continue; // Already handled (BTC/stable)

      // Find a reference pool for this token (same logic as deriveUnknownPrices)
      let refPool: PonderPool | undefined;
      let unknownIsToken0 = false;
      let knownPriceAddr = "";

      for (const pool of pools) {
        const t0 = pool.token0.toLowerCase();
        const t1 = pool.token1.toLowerCase();
        if (t0 === addr && (prices.get(t1) || 0) > 0) {
          refPool = pool;
          unknownIsToken0 = true;
          knownPriceAddr = t1;
          break;
        } else if (t1 === addr && (prices.get(t0) || 0) > 0) {
          refPool = pool;
          unknownIsToken0 = false;
          knownPriceAddr = t0;
          break;
        }
      }

      if (!refPool) continue;

      const poolAddr = refPool.address.toLowerCase();
      const activities = activitiesByPool.get(poolAddr);

      const knownCategory = this.priceService.getTokenCategory(
        chainId,
        knownPriceAddr,
      );

      // Fallback: if no pool activity, the pool ratio hasn't changed, so the
      // token's USD price change equals the counterpart's USD price change.
      if (!activities || activities.length === 0) {
        if (knownCategory === "STABLECOIN") {
          // Paired with stablecoin, no trades → price is constant → 0%
          pctChange1h.set(addr, 0);
          pctChange24h.set(addr, 0);
        } else if (knownCategory === "BTC") {
          // Paired with BTC, no trades → ratio unchanged → tracks BTC
          pctChange1h.set(addr, btcPriceData.change1h);
          pctChange24h.set(addr, btcPriceData.change24h);
        }
        continue;
      }

      const token0Info = tokenMap.get(refPool.token0.toLowerCase());
      const token1Info = tokenMap.get(refPool.token1.toLowerCase());
      if (!token0Info || !token1Info) continue;

      // Derive historical BTC prices from CoinGecko % change data
      const btcPrice1hAgo =
        btcPriceData.change1h !== 0
          ? btcPriceData.price / (1 + btcPriceData.change1h / 100)
          : btcPriceData.price;
      const btcPrice24hAgo =
        btcPriceData.change24h !== 0
          ? btcPriceData.price / (1 + btcPriceData.change24h / 100)
          : btcPriceData.price;

      // Helper: compute a historical price from a poolActivity record
      const computeHistoricalPrice = (
        activity: PonderPoolActivity,
        historicalBtcPrice: number,
      ): number | null => {
        const sqrtPrice = parseFloat(activity.sqrtPriceX96);
        if (!sqrtPrice || sqrtPrice <= 0) return null;

        const Q96 = 2 ** 96;
        const priceRatio =
          (sqrtPrice / Q96) ** 2 *
          10 ** (token0Info.decimals - token1Info.decimals);

        // Determine historical counterpart price
        let historicalCounterpartPrice: number;
        if (knownCategory === "STABLECOIN") {
          historicalCounterpartPrice = 1.0;
        } else if (knownCategory === "BTC") {
          historicalCounterpartPrice = historicalBtcPrice;
        } else {
          // Counterpart is also pool-derived — use current price as approximation
          historicalCounterpartPrice = prices.get(knownPriceAddr) || 0;
        }

        if (historicalCounterpartPrice <= 0) return null;

        if (unknownIsToken0) {
          return priceRatio * historicalCounterpartPrice;
        } else {
          return priceRatio > 0
            ? historicalCounterpartPrice / priceRatio
            : null;
        }
      };

      // Find the activity closest to 1h ago and 24h ago
      const closest1h = this.findClosestActivity(activities, target1h, 1800); // ±30 min tolerance
      const closest24h = this.findClosestActivity(activities, target24h, 3600); // ±60 min tolerance

      if (closest1h) {
        const historicalPrice = computeHistoricalPrice(
          closest1h,
          btcPrice1hAgo,
        );
        if (historicalPrice && historicalPrice > 0) {
          const pctChange =
            ((currentPrice - historicalPrice) / historicalPrice) * 100;
          if (isFinite(pctChange)) {
            pctChange1h.set(addr, pctChange);
          }
        }
      }

      if (closest24h) {
        const historicalPrice = computeHistoricalPrice(
          closest24h,
          btcPrice24hAgo,
        );
        if (historicalPrice && historicalPrice > 0) {
          const pctChange =
            ((currentPrice - historicalPrice) / historicalPrice) * 100;
          if (isFinite(pctChange)) {
            pctChange24h.set(addr, pctChange);
          }
        }
      }

      // Fallback for partially missing data: if we computed one but not the other
      // from pool activity, infer from counterpart category for the missing one
      if (!pctChange1h.has(addr) || !pctChange24h.has(addr)) {
        if (knownCategory === "STABLECOIN") {
          if (!pctChange1h.has(addr)) pctChange1h.set(addr, 0);
          if (!pctChange24h.has(addr)) pctChange24h.set(addr, 0);
        } else if (knownCategory === "BTC") {
          if (!pctChange1h.has(addr))
            pctChange1h.set(addr, btcPriceData.change1h);
          if (!pctChange24h.has(addr))
            pctChange24h.set(addr, btcPriceData.change24h);
        }
      }
    }

    return { pctChange1h, pctChange24h };
  }

  /**
   * Find the poolActivity record closest to the target timestamp,
   * within the given tolerance (in seconds).
   * Uses binary search since activities are sorted by blockTimestamp asc.
   */
  private findClosestActivity(
    activities: PonderPoolActivity[],
    targetTimestamp: number,
    toleranceSec: number,
  ): PonderPoolActivity | null {
    if (activities.length === 0) return null;

    let lo = 0;
    let hi = activities.length - 1;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (parseInt(activities[mid].blockTimestamp, 10) < targetTimestamp) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    // lo is the first index >= targetTimestamp; check lo and lo-1 for closest
    let best = activities[lo];
    let bestDiff = Math.abs(
      parseInt(best.blockTimestamp, 10) - targetTimestamp,
    );

    if (lo > 0) {
      const prev = activities[lo - 1];
      const prevDiff = Math.abs(
        parseInt(prev.blockTimestamp, 10) - targetTimestamp,
      );
      if (prevDiff < bestDiff) {
        best = prev;
        bestDiff = prevDiff;
      }
    }

    return bestDiff <= toleranceSec ? best : null;
  }

  // ---------- Price history (sparkline) computation ----------

  /**
   * Build 24-point hourly price histories for sparkline charts.
   * Strategy per token category:
   *   - Stablecoins: flat $1 line
   *   - BTC-pegged: map CoinGecko BTC hourly prices
   *   - Pool-derived: reconstruct from poolActivity sqrtPriceX96 + counterpart price
   */
  private buildTokenPriceHistories(
    tokens: PonderToken[],
    pools: PonderPool[],
    tokenMap: Map<string, PonderToken>,
    prices: Map<string, number>,
    btcPriceHistory: BtcPriceHistory | null,
    activitiesByPool: Map<string, PonderPoolActivity[]>,
    chainId: number,
  ): Map<string, PriceHistoryResponse> {
    const result = new Map<string, PriceHistoryResponse>();
    const now = Math.floor(Date.now() / 1000);
    const bucketCount = 24;
    const step = 3600; // 1 hour
    const start = now - bucketCount * step;
    const end = now;

    for (const token of tokens) {
      const addr = token.address.toLowerCase();
      const category = this.priceService.getTokenCategory(chainId, addr);

      if (category === "STABLECOIN") {
        result.set(addr, {
          start,
          end,
          step,
          values: Array(bucketCount).fill(1.0),
        });
        continue;
      }

      if (category === "BTC") {
        if (!btcPriceHistory || btcPriceHistory.prices.length < 2) continue;

        const values: number[] = [];
        for (let i = 0; i < bucketCount; i++) {
          const targetTs = start + i * step;
          const interpolated = this.interpolateBtcPrice(
            btcPriceHistory,
            targetTs,
          );
          values.push(interpolated);
        }
        result.set(addr, { start, end, step, values });
        continue;
      }

      // Pool-derived token: find reference pool
      let refPool: PonderPool | undefined;
      let unknownIsToken0 = false;
      let knownPriceAddr = "";

      for (const pool of pools) {
        const t0 = pool.token0.toLowerCase();
        const t1 = pool.token1.toLowerCase();
        if (t0 === addr && (prices.get(t1) || 0) > 0) {
          refPool = pool;
          unknownIsToken0 = true;
          knownPriceAddr = t1;
          break;
        } else if (t1 === addr && (prices.get(t0) || 0) > 0) {
          refPool = pool;
          unknownIsToken0 = false;
          knownPriceAddr = t0;
          break;
        }
      }

      if (!refPool) continue;

      const currentPrice = prices.get(addr) || 0;
      const poolAddr = refPool.address.toLowerCase();
      const activities = activitiesByPool.get(poolAddr);

      const token0Info = tokenMap.get(refPool.token0.toLowerCase());
      const token1Info = tokenMap.get(refPool.token1.toLowerCase());

      const knownCategory = this.priceService.getTokenCategory(
        chainId,
        knownPriceAddr,
      );

      // Try activity-based sparkline first (requires token decimals for sqrtPriceX96 conversion)
      let validCount = 0;
      const values: (number | null)[] = [];

      if (activities && activities.length > 0 && token0Info && token1Info) {
        for (let i = 0; i < bucketCount; i++) {
          const targetTs = start + i * step;
          const closest = this.findClosestActivity(activities, targetTs, 1800); // ±30min
          if (!closest) {
            values.push(null);
            continue;
          }

          const sqrtPrice = parseFloat(closest.sqrtPriceX96);
          if (!sqrtPrice || sqrtPrice <= 0) {
            values.push(null);
            continue;
          }

          const Q96 = 2 ** 96;
          const priceRatio =
            (sqrtPrice / Q96) ** 2 *
            10 ** (token0Info.decimals - token1Info.decimals);

          // Determine counterpart price at this time
          let counterpartPrice: number;
          if (knownCategory === "STABLECOIN") {
            counterpartPrice = 1.0;
          } else if (knownCategory === "BTC" && btcPriceHistory) {
            counterpartPrice = this.interpolateBtcPrice(
              btcPriceHistory,
              targetTs,
            );
          } else {
            counterpartPrice = prices.get(knownPriceAddr) || 0;
          }

          if (counterpartPrice <= 0) {
            values.push(null);
            continue;
          }

          let tokenPrice: number;
          if (unknownIsToken0) {
            tokenPrice = priceRatio * counterpartPrice;
          } else {
            tokenPrice = priceRatio > 0 ? counterpartPrice / priceRatio : 0;
          }

          if (tokenPrice > 0 && isFinite(tokenPrice)) {
            values.push(tokenPrice);
            validCount++;
          } else {
            values.push(null);
          }
        }
      }

      if (validCount >= 2) {
        // Fill gaps: LOCF (last observation carried forward), backfill leading gaps
        const filled = this.fillGaps(values);
        result.set(addr, { start, end, step, values: filled });
        continue;
      }

      // Fallback: no/insufficient pool activity — ratio hasn't changed,
      // so derive sparkline from counterpart's price history
      if (currentPrice <= 0) continue;

      if (knownCategory === "STABLECOIN") {
        // Paired with stablecoin, no trades → price is constant
        result.set(addr, {
          start,
          end,
          step,
          values: Array(bucketCount).fill(currentPrice),
        });
      } else if (
        knownCategory === "BTC" &&
        btcPriceHistory &&
        btcPriceHistory.prices.length >= 2
      ) {
        // Paired with BTC, no trades → ratio unchanged → scale BTC curve
        const latestBtcPrice =
          btcPriceHistory.prices[btcPriceHistory.prices.length - 1].price;
        if (latestBtcPrice > 0) {
          const scale = currentPrice / latestBtcPrice;
          const btcValues: number[] = [];
          for (let i = 0; i < bucketCount; i++) {
            const targetTs = start + i * step;
            btcValues.push(
              this.interpolateBtcPrice(btcPriceHistory, targetTs) * scale,
            );
          }
          result.set(addr, { start, end, step, values: btcValues });
        }
      }
    }

    return result;
  }

  /**
   * Interpolate BTC price at a target timestamp from CoinGecko hourly data.
   * Uses linear interpolation between the two surrounding data points.
   */
  private interpolateBtcPrice(
    btcPriceHistory: BtcPriceHistory,
    targetTimestamp: number,
  ): number {
    const pts = btcPriceHistory.prices;
    if (pts.length === 0) return 0;

    // Clamp to range
    if (targetTimestamp <= pts[0].timestamp) return pts[0].price;
    if (targetTimestamp >= pts[pts.length - 1].timestamp)
      return pts[pts.length - 1].price;

    // Binary search for surrounding points
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi - 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (pts[mid].timestamp <= targetTimestamp) {
        lo = mid;
      } else {
        hi = mid;
      }
    }

    const p0 = pts[lo];
    const p1 = pts[hi];
    const t = (targetTimestamp - p0.timestamp) / (p1.timestamp - p0.timestamp);
    return p0.price + t * (p1.price - p0.price);
  }

  /**
   * Fill null gaps in a values array using LOCF (last observation carried forward).
   * Leading nulls are backfilled with the first known value.
   */
  private fillGaps(values: (number | null)[]): number[] {
    const filled: number[] = new Array(values.length);

    // Forward pass: LOCF
    let lastKnown: number | null = null;
    for (let i = 0; i < values.length; i++) {
      if (values[i] !== null) {
        lastKnown = values[i];
      }
      filled[i] = lastKnown ?? 0;
    }

    // Backfill leading zeros if we have a first known value
    const firstKnownIdx = values.findIndex((v) => v !== null);
    if (firstKnownIdx > 0) {
      const firstVal = values[firstKnownIdx] as number;
      for (let i = 0; i < firstKnownIdx; i++) {
        filled[i] = firstVal;
      }
    }

    return filled;
  }

  // ---------- FDV computation ----------

  private async computeTokenFdv(
    tokens: PonderToken[],
    prices: Map<string, number>,
    multicallProvider: UniswapMulticallProvider | null,
  ): Promise<Map<string, number>> {
    const fdvMap = new Map<string, number>();
    if (!multicallProvider || tokens.length === 0) return fdvMap;

    // Only compute FDV for tokens with known prices
    const pricedTokens = tokens.filter(
      (t) => (prices.get(t.address.toLowerCase()) || 0) > 0,
    );
    if (pricedTokens.length === 0) return fdvMap;

    try {
      const totalSupplyInterface = new ethers.utils.Interface(
        ERC20_TOTAL_SUPPLY_ABI,
      );

      const addresses = pricedTokens.map((t) =>
        ethers.utils.getAddress(t.address),
      );

      const { results } =
        await multicallProvider.callSameFunctionOnMultipleContracts({
          addresses,
          contractInterface: totalSupplyInterface,
          functionName: "totalSupply",
        });

      for (let i = 0; i < pricedTokens.length; i++) {
        const token = pricedTokens[i];
        const result = results[i];
        if (!result?.success) continue;

        const totalSupply = parseFloat(
          ethers.utils.formatUnits(result.result[0], token.decimals),
        );
        const priceUsd = prices.get(token.address.toLowerCase()) || 0;

        if (totalSupply > 0 && priceUsd > 0) {
          const fdv = totalSupply * priceUsd;
          if (isFinite(fdv)) {
            fdvMap.set(token.address.toLowerCase(), fdv);
          }
        }
      }
    } catch (error) {
      this.logger.warn({ error }, "Failed to compute token FDV via multicall");
    }

    return fdvMap;
  }
}
