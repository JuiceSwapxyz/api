import Logger from "bunyan";
import { ChainId } from "@juiceswapxyz/sdk-core";
import { UniswapMulticallProvider } from "@juiceswapxyz/smart-order-router";
import { ethers } from "ethers";
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

// Equity contract ABI — price() returns JUICE price in JUSD (18 decimals)
const EQUITY_PRICE_ABI = ["function price() view returns (uint256)"];

// V3 Pool ABI for slot0
const V3_POOL_SLOT0_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
];

// Chain name mapping for the frontend protobuf format
const CHAIN_NAMES: Record<number, string> = {
  [ChainId.CITREA_MAINNET]: "CITREA_MAINNET",
  [ChainId.CITREA_TESTNET]: "CITREA_TESTNET",
};

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
    poolStats: PoolStatsResponse[];
    poolStatsV2: PoolStatsResponse[];
    poolStatsV3: PoolStatsResponse[];
    poolStatsV4: PoolStatsResponse[];
    transactionStats: TransactionStatsResponse[];
    dailyProtocolTvl?: { v2: never[]; v3: never[]; v4: never[] };
    historicalProtocolVolume?: null;
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
  private readonly CACHE_TTL = 60_000; // 60 seconds

  constructor(
    providers: Map<ChainId, ethers.providers.StaticJsonRpcProvider>,
    logger: Logger,
  ) {
    this.logger = logger.child({ service: "ExploreStatsService" });
    this.priceService = new PriceService(logger);
    this.providers = providers;
  }

  async getExploreStats(chainId: number): Promise<ExploreStatsResponseData> {
    const cached = this.cache.get(chainId);
    const now = Date.now();
    if (cached && now - cached.timestamp < this.CACHE_TTL) {
      return cached.response;
    }

    const chainName = CHAIN_NAMES[chainId] || `CHAIN_${chainId}`;
    const ponderClient = getPonderClient(this.logger);

    // 1. Fetch all raw data from Ponder in parallel
    const [
      tokens,
      v3Pools,
      v3PoolStats24h,
      v3PoolStats30d,
      v3PoolStats365d,
      v2Pools,
      v2PoolStats24h,
      v2PoolStats30d,
      v2PoolStats365d,
      tokenStats1h,
      recentSwaps,
    ] = await Promise.all([
      this.fetchTokens(ponderClient, chainId),
      this.fetchV3Pools(ponderClient, chainId),
      this.fetchPoolStats(ponderClient, chainId, "1h", 24),
      this.fetchPoolStats(ponderClient, chainId, "24h", 30 * 24),
      this.fetchPoolStats(ponderClient, chainId, "24h", 365 * 24),
      this.fetchV2Pools(ponderClient, chainId),
      this.fetchV2PoolStats(ponderClient, chainId, "1h", 24),
      this.fetchV2PoolStats(ponderClient, chainId, "24h", 30 * 24),
      this.fetchV2PoolStats(ponderClient, chainId, "24h", 365 * 24),
      this.fetchTokenStats(ponderClient, chainId, "1h", 24),
      this.fetchRecentSwaps(ponderClient, chainId),
    ]);

    // 2. Build token map (from Ponder + known contract tokens as fallback)
    const tokenMap = new Map<string, PonderToken>();
    for (const t of tokens) {
      tokenMap.set(t.address.toLowerCase(), t);
    }

    // Add known tokens from contracts config as fallback for V2 pools
    const contracts = getChainContracts(chainId);
    if (contracts) {
      const knownTokenFallbacks: Array<{ addr: string; symbol: string; name: string; decimals: number }> = [
        { addr: contracts.JUSD, symbol: "JUSD", name: "JuiceDollar", decimals: 18 },
        { addr: contracts.JUICE, symbol: "JUICE", name: "Juice Protocol", decimals: 18 },
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

    // 4. Get token prices (BTC, stablecoins, then derive unknown from pools)
    const prices = await this.priceService.getTokenPrices(
      chainId,
      Array.from(allTokenAddrs),
    );

    // 4b. Fetch JUICE price from on-chain Equity.price()
    await this.fetchJuicePrice(chainId, prices);

    // 4c. Derive unknown token prices from V3 pool slot0()
    await this.deriveUnknownPrices(
      chainId,
      v3Pools,
      tokenMap,
      prices,
    );

    // 5. Compute V3 pool TVL via multicall
    const v3PoolTvl = await this.computeV3PoolTvl(
      chainId,
      v3Pools,
      tokenMap,
      prices,
    );

    // 6. Compute V2 pool TVL via multicall
    const v2PoolTvl = await this.computeV2PoolTvl(chainId, v2Pools, tokenMap);

    // 7. Compute pool volumes
    const v3Vol1d = this.aggregatePoolVolumes(
      v3PoolStats24h,
      v3Pools,
      tokenMap,
      prices,
    );
    const v3Vol30d = this.aggregatePoolVolumes(
      v3PoolStats30d,
      v3Pools,
      tokenMap,
      prices,
    );
    const v2Vol1d = this.aggregateV2PoolVolumes(
      v2PoolStats24h,
      v2Pools,
      tokenMap,
      chainId,
    );
    const v2Vol30d = this.aggregateV2PoolVolumes(
      v2PoolStats30d,
      v2Pools,
      tokenMap,
      chainId,
    );

    // 7b. Compute 7-day pool volumes (filter 30d data to last 7 days)
    const sevenDayCutoff = (Math.floor(Date.now() / 1000) - 7 * 24 * 3600).toString();
    const v3Vol7d = this.aggregatePoolVolumes(
      v3PoolStats30d.filter((ps) => ps.timestamp >= sevenDayCutoff),
      v3Pools,
      tokenMap,
      prices,
    );
    const v2Vol7d = this.aggregateV2PoolVolumes(
      v2PoolStats30d.filter((ps) => ps.timestamp >= sevenDayCutoff),
      v2Pools,
      tokenMap,
      chainId,
    );

    // 7c. Compute 365-day pool volumes
    const v3Vol365d = this.aggregatePoolVolumes(v3PoolStats365d, v3Pools, tokenMap, prices);
    const v2Vol365d = this.aggregateV2PoolVolumes(v2PoolStats365d, v2Pools, tokenMap, chainId);

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
      v2Pools,
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
      v2Pools,
      tokenMap,
      chainId,
      tokenVol1h,
    );

    // 10. Derive token volumes for longer timeframes from pool volumes
    const tokenVol1w = this.deriveTokenVolumesFromPoolVolumes(v3Vol7d, v2Vol7d, v3Pools, v2Pools);
    const tokenVol1m = this.deriveTokenVolumesFromPoolVolumes(v3Vol30d, v2Vol30d, v3Pools, v2Pools);
    const tokenVol1y = this.deriveTokenVolumesFromPoolVolumes(v3Vol365d, v2Vol365d, v3Pools, v2Pools);

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
        price:
          priceUsd > 0
            ? { currency: "USD", value: priceUsd }
            : undefined,
        volume1Day: { currency: "USD", value: tokenVol1d.get(addr) ?? 0 },
        volume1Hour: { currency: "USD", value: tokenVol1h.get(addr) ?? 0 },
        volume1Week: { currency: "USD", value: tokenVol1w.get(addr) ?? 0 },
        volume1Month: { currency: "USD", value: tokenVol1m.get(addr) ?? 0 },
        volume1Year: { currency: "USD", value: tokenVol1y.get(addr) ?? 0 },
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
              price: (prices.get(t0.address.toLowerCase()) || 0) > 0
                ? { currency: "USD", value: prices.get(t0.address.toLowerCase())! }
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
              price: (prices.get(t1.address.toLowerCase()) || 0) > 0
                ? { currency: "USD", value: prices.get(t1.address.toLowerCase())! }
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
              price: (prices.get(t0.address.toLowerCase()) || 0) > 0
                ? { currency: "USD", value: prices.get(t0.address.toLowerCase())! }
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
              price: (prices.get(t1.address.toLowerCase()) || 0) > 0
                ? { currency: "USD", value: prices.get(t1.address.toLowerCase())! }
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
            usdValue > 0
              ? { currency: "USD", value: usdValue }
              : undefined,
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
        poolStats: [],
        poolStatsV2: poolStatsV2Response,
        poolStatsV3: poolStatsV3Response,
        poolStatsV4: [],
        transactionStats: transactionStatsResponse,
        dailyProtocolTvl: { v2: [], v3: [], v4: [] },
        historicalProtocolVolume: null,
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
        this.logger.debug({ priceUsd }, "Fetched JUICE price from Equity contract");
      }
    } catch (error) {
      this.logger.warn({ error }, "Failed to fetch JUICE price from Equity contract");
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
    chainId: number,
    pools: PonderPool[],
    tokenMap: Map<string, PonderToken>,
    prices: Map<string, number>,
  ): Promise<Map<string, number>> {
    const tvlMap = new Map<string, number>();
    const provider = this.providers.get(chainId as ChainId);

    if (!provider || pools.length === 0) return tvlMap;

    try {
      const multicallProvider = new UniswapMulticallProvider(
        chainId as ChainId,
        provider,
        375000,
      );
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
  ): Promise<Map<string, number>> {
    const tvlMap = new Map<string, number>();
    const provider = this.providers.get(chainId as ChainId);
    const contracts = getChainContracts(chainId);

    if (!provider || !contracts || pools.length === 0) return tvlMap;

    try {
      const multicallProvider = new UniswapMulticallProvider(
        chainId as ChainId,
        provider,
        375000,
      );
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
          tvlMap.set(pool.pairAddress.toLowerCase(), 2 * jusdReserveFormatted);
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
    pools: PonderPool[],
    tokenMap: Map<string, PonderToken>,
    prices: Map<string, number>,
  ): Map<string, number> {
    const volMap = new Map<string, number>();

    for (const ps of poolStats) {
      const poolAddr = ps.poolAddress?.toLowerCase();
      const pool = pools.find(
        (p) => p.address.toLowerCase() === poolAddr,
      );
      if (!pool) continue;

      const t0 = tokenMap.get(pool.token0.toLowerCase());
      const t1 = tokenMap.get(pool.token1.toLowerCase());
      const price0 = prices.get(pool.token0.toLowerCase()) || 0;
      const price1 = prices.get(pool.token1.toLowerCase()) || 0;

      let vol = 0;
      if (price0 > 0 && t0) {
        vol = parseFloat(
          ethers.utils.formatUnits(ps.volume0 || "0", t0.decimals),
        ) * price0;
      } else if (price1 > 0 && t1) {
        vol = parseFloat(
          ethers.utils.formatUnits(ps.volume1 || "0", t1.decimals),
        ) * price1;
      }

      if (vol > 0) {
        volMap.set(poolAddr, (volMap.get(poolAddr) || 0) + vol);
      }
    }

    return volMap;
  }

  private aggregateV2PoolVolumes(
    poolStats: PonderV2PoolStat[],
    pools: PonderV2Pool[],
    tokenMap: Map<string, PonderToken>,
    chainId: number,
  ): Map<string, number> {
    const volMap = new Map<string, number>();
    const contracts = getChainContracts(chainId);
    if (!contracts) return volMap;

    const jusdAddress = contracts.JUSD?.toLowerCase();
    const v2PoolMap = new Map<string, PonderV2Pool>();
    for (const pool of pools) {
      v2PoolMap.set(pool.pairAddress.toLowerCase(), pool);
    }

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
        parseFloat(
          ethers.utils.formatUnits(ts.volume || "0", token.decimals),
        ) * price;

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
    v2Pools: PonderV2Pool[],
    tokenMap: Map<string, PonderToken>,
    chainId: number,
    tokenVolMap: Map<string, number>,
  ): void {
    const contracts = getChainContracts(chainId);
    if (!contracts) return;

    const jusdAddress = contracts.JUSD?.toLowerCase();
    if (!jusdAddress) return;

    const v2PoolMap = new Map<string, PonderV2Pool>();
    for (const pool of v2Pools) {
      v2PoolMap.set(pool.pairAddress.toLowerCase(), pool);
    }

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
}
