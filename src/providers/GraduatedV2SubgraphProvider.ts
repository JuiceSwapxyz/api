import { ChainId, Token } from "@juiceswapxyz/sdk-core";
import {
  IV2SubgraphProvider,
  V2SubgraphPool,
  UniswapMulticallProvider,
} from "@juiceswapxyz/smart-order-router";
import Logger from "bunyan";
import { ethers } from "ethers";
import { getPonderClient } from "../services/PonderClient";
import { CITREA_V2_POOLS } from "./citreaStaticPools";

interface GraduatedPool {
  pairAddress: string;
  token0: string;
  token1: string;
  reserve0: string;
  reserve1: string;
  tokenName: string;
  tokenSymbol: string;
  launchpadTokenAddress: string;
  createdAt: string;
  totalSwaps: number;
}

// Static V2 pools for gas estimation (not from Ponder)
// Uses centralized config from citreaStaticPools.ts
const STATIC_V2_POOLS = Object.values(CITREA_V2_POOLS).map((pool) => ({
  pairAddress: pool.pairAddress,
  token0: pool.token0.address,
  token1: pool.token1.address,
}));

// V2 Pair ABI for getReserves
const V2_PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
];

/**
 * V2SubgraphProvider that returns graduated launchpad pools from Ponder.
 * Fetches on-chain reserves for accurate liquidity data.
 * Used by AlphaRouter to discover V2 pools for routing.
 */
export class GraduatedV2SubgraphProvider implements IV2SubgraphProvider {
  private chainId: ChainId;
  private logger: Logger;
  private poolsCache: V2SubgraphPool[] = [];
  private lastFetch: number = 0;
  private readonly CACHE_TTL = 60_000; // 1 minute
  private readonly MULTICALL_BATCH_SIZE = 100;
  private multicallProvider: UniswapMulticallProvider | undefined;

  constructor(
    chainId: ChainId,
    logger: Logger,
    multicallProvider?: UniswapMulticallProvider,
  ) {
    this.chainId = chainId;
    this.logger = logger.child({ provider: "GraduatedV2SubgraphProvider", chainId });
    this.multicallProvider = multicallProvider;
  }

  async getPools(
    tokenIn?: Token,
    tokenOut?: Token,
    _providerConfig?: any,
  ): Promise<V2SubgraphPool[]> {
    this.logger.info(
      { tokenIn: tokenIn?.address, tokenOut: tokenOut?.address },
      "GraduatedV2SubgraphProvider.getPools() called",
    );
    await this.refreshPoolsIfNeeded();

    // Filter by tokens if provided, but always include static pools (needed for gas estimation)
    if (tokenIn && tokenOut) {
      const staticPoolIds = new Set(
        STATIC_V2_POOLS.map((p) => p.pairAddress.toLowerCase()),
      );
      const filtered = this.poolsCache.filter((pool) => {
        // Always include static pools for gas estimation
        if (staticPoolIds.has(pool.id)) {
          return true;
        }
        // Filter graduated pools by token pair
        const hasTokenIn =
          pool.token0.id.toLowerCase() === tokenIn.address.toLowerCase() ||
          pool.token1.id.toLowerCase() === tokenIn.address.toLowerCase();
        const hasTokenOut =
          pool.token0.id.toLowerCase() === tokenOut.address.toLowerCase() ||
          pool.token1.id.toLowerCase() === tokenOut.address.toLowerCase();
        return hasTokenIn && hasTokenOut;
      });
      this.logger.info(
        {
          filteredPoolCount: filtered.length,
          pools: filtered.map((p) => ({
            id: p.id,
            token0: p.token0.id,
            token1: p.token1.id,
            reserve: p.reserve,
          })),
        },
        "Filtered pools for routing",
      );
      return filtered;
    }

    return this.poolsCache;
  }

  private async refreshPoolsIfNeeded(): Promise<void> {
    const now = Date.now();
    if (now - this.lastFetch < this.CACHE_TTL) {
      return;
    }

    try {
      const ponderClient = getPonderClient(this.logger);
      const response = await ponderClient.get(`/graduated-pools?chainId=${this.chainId}`);
      const pools: GraduatedPool[] = response.data.pools || [];

      if (pools.length === 0) {
        this.poolsCache = [];
        this.lastFetch = now;
        return;
      }

      // Combine Ponder pools with static pools
      const allPairAddresses = [
        ...pools.map((p) => p.pairAddress),
        ...STATIC_V2_POOLS.map((p) => p.pairAddress),
      ];

      // Fetch on-chain reserves for all pools (including static)
      const reservesMap = await this.fetchOnChainReserves(allPairAddresses);

      // Map Ponder pools
      const ponderPools = pools.map((p) => {
        const pairAddressLower = p.pairAddress.toLowerCase();
        const reserves = reservesMap.get(pairAddressLower);

        // Use on-chain reserves if available, otherwise fall back to Ponder data
        const reserve0 = reserves?.reserve0 ?? BigInt(p.reserve0 || "0");
        const reserve1 = reserves?.reserve1 ?? BigInt(p.reserve1 || "0");
        const totalReserve = Number(reserve0 + reserve1);

        return {
          id: pairAddressLower,
          token0: { id: p.token0.toLowerCase() },
          token1: { id: p.token1.toLowerCase() },
          supply: 1000000, // Placeholder - not used for routing decisions
          reserve: totalReserve,
          reserveUSD: 0, // Would need price oracle for accurate USD value
        };
      });

      // Map static pools (WcBTC/JUSD for gas estimation)
      const staticPools = STATIC_V2_POOLS.map((p) => {
        const pairAddressLower = p.pairAddress.toLowerCase();
        const reserves = reservesMap.get(pairAddressLower);
        const reserve0 = reserves?.reserve0 ?? BigInt(0);
        const reserve1 = reserves?.reserve1 ?? BigInt(0);
        const totalReserve = Number(reserve0 + reserve1);

        return {
          id: pairAddressLower,
          token0: { id: p.token0.toLowerCase() },
          token1: { id: p.token1.toLowerCase() },
          supply: 1000000,
          reserve: totalReserve,
          reserveUSD: 0,
        };
      });

      // Combine Ponder pools with static pools
      this.poolsCache = [...ponderPools, ...staticPools];

      this.lastFetch = now;
      this.logger.info(
        {
          chainId: this.chainId,
          ponderPoolCount: pools.length,
          staticPoolCount: STATIC_V2_POOLS.length,
          totalPoolCount: this.poolsCache.length,
          hasOnChainReserves: reservesMap.size > 0,
        },
        "Refreshed graduated V2 pool cache",
      );
    } catch (error) {
      this.logger.error(
        { error },
        "Failed to fetch graduated pools from Ponder",
      );
      // Keep existing cache on error, don't throw
    }
  }

  /**
   * Fetch on-chain reserves for V2 pairs using multicall
   */
  private async fetchOnChainReserves(
    pairAddresses: string[],
  ): Promise<Map<string, { reserve0: bigint; reserve1: bigint }>> {
    const reservesMap = new Map<
      string,
      { reserve0: bigint; reserve1: bigint }
    >();

    if (!this.multicallProvider || pairAddresses.length === 0) {
      return reservesMap;
    }

    try {
      const v2PairInterface = new ethers.utils.Interface(V2_PAIR_ABI);

      // Process in batches to avoid gas/size limits
      for (
        let i = 0;
        i < pairAddresses.length;
        i += this.MULTICALL_BATCH_SIZE
      ) {
        const batch = pairAddresses.slice(i, i + this.MULTICALL_BATCH_SIZE);

        const { results } =
          await this.multicallProvider.callSameFunctionOnMultipleContracts<
            undefined,
            [bigint, bigint, number]
          >({
            addresses: batch,
            contractInterface: v2PairInterface,
            functionName: "getReserves",
          });

        batch.forEach((addr, j) => {
          const result = results[j];
          if (result?.success && result.result) {
            const [reserve0, reserve1] = result.result;
            reservesMap.set(addr.toLowerCase(), {
              reserve0: BigInt(reserve0.toString()),
              reserve1: BigInt(reserve1.toString()),
            });
          }
        });
      }

      this.logger.debug(
        { fetchedCount: reservesMap.size, totalPools: pairAddresses.length },
        "Fetched on-chain reserves for V2 pools",
      );
    } catch (error) {
      this.logger.warn(
        { error },
        "Failed to fetch on-chain reserves via multicall",
      );
      // Return empty map - will fall back to Ponder data
    }

    return reservesMap;
  }
}
