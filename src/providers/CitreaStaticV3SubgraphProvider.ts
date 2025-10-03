import { ChainId, Token } from '@juiceswapxyz/sdk-core';
import { FeeAmount, Pool } from '@juiceswapxyz/v3-sdk';
import {
  IV3PoolProvider,
  StaticV3SubgraphProvider,
  V3SubgraphPool,
} from '@juiceswapxyz/smart-order-router';
import JSBI from 'jsbi';
import { CITREA_STATIC_POOLS } from './citreaStaticPools';

/**
 * Custom V3 subgraph provider for Citrea that uses static pool configuration
 * enriched with on-chain pool states.
 *
 * Strategy:
 * - Static pools serve as candidates for routing
 * - On-chain discovery fetches real pool states (liquidity, price, tick)
 * - Returns all pools to enable multi-hop routing
 * - The AlphaRouter handles pool selection and optimization
 */
export class CitreaStaticV3SubgraphProvider extends StaticV3SubgraphProvider {
  private v3PoolProvider: IV3PoolProvider;
  private poolCache = new Map<string, V3SubgraphPool[]>();
  private lastCacheTime = 0;
  private readonly CACHE_TTL_MS = 60000; // 1 minute cache

  constructor(chainId: ChainId, poolProvider: IV3PoolProvider) {
    super(chainId, poolProvider);
    this.v3PoolProvider = poolProvider;
  }

  public async getPools(): Promise<V3SubgraphPool[]> {
    // Check cache first
    const now = Date.now();
    if (this.poolCache.size > 0 && now - this.lastCacheTime < this.CACHE_TTL_MS) {
      const allCachedPools: V3SubgraphPool[] = [];
      for (const pools of this.poolCache.values()) {
        allCachedPools.push(...pools);
      }
      return allCachedPools;
    }

    // Get static pools as base
    const staticPools = this.getStaticPools();

    // Enrich with on-chain data
    const enrichedPools = await this.enrichPoolsWithOnChainData(staticPools);

    // Cache the results
    this.poolCache.clear();
    this.poolCache.set('all', enrichedPools);
    this.lastCacheTime = now;

    return enrichedPools;
  }

  /**
   * Enriches static pools with real on-chain data (liquidity, sqrtPrice, tick)
   */
  private async enrichPoolsWithOnChainData(
    staticPools: V3SubgraphPool[]
  ): Promise<V3SubgraphPool[]> {
    const enrichedPools: V3SubgraphPool[] = [];

    // Group pools by token pairs for batch fetching
    const poolRequests: Array<{
      token0: Token;
      token1: Token;
      fee: FeeAmount;
      staticPool: V3SubgraphPool;
    }> = [];

    for (const pool of staticPools) {
      const token0 = new Token(
        ChainId.CITREA_TESTNET,
        pool.token0.id,
        parseInt(pool.token0.decimals),
        pool.token0.symbol,
        pool.token0.name
      );
      const token1 = new Token(
        ChainId.CITREA_TESTNET,
        pool.token1.id,
        parseInt(pool.token1.decimals),
        pool.token1.symbol,
        pool.token1.name
      );

      poolRequests.push({
        token0,
        token1,
        fee: parseInt(pool.feeTier) as FeeAmount,
        staticPool: pool,
      });
    }

    // Fetch real pool states from chain
    const tokenPairs = poolRequests.map((req) => [
      req.token0,
      req.token1,
      req.fee,
    ] as [Token, Token, FeeAmount]);

    try {
      const poolAccessor = await this.v3PoolProvider.getPools(tokenPairs);

      for (const req of poolRequests) {
        const onChainPool = poolAccessor.getPool(req.token0, req.token1, req.fee);

        if (onChainPool && JSBI.greaterThan(onChainPool.liquidity, JSBI.BigInt(0))) {
          // Use real on-chain data
          enrichedPools.push({
            ...req.staticPool,
            liquidity: onChainPool.liquidity.toString(),
            sqrtPrice: onChainPool.sqrtRatioX96.toString(),
            tick: onChainPool.tickCurrent.toString(),
          });
        } else {
          // Pool doesn't exist on-chain or has no liquidity - skip it
          // This prevents ProviderGasError during quote estimation
        }
      }
    } catch (error) {
      // If on-chain fetch fails, fall back to static pools
      // This ensures routing still works even if RPC is slow/unavailable
      return staticPools;
    }

    return enrichedPools;
  }

  private getStaticPools(): V3SubgraphPool[] {
    return CITREA_STATIC_POOLS.map((pool) => {
      const [token0, token1] =
        pool.token0.address.toLowerCase() < pool.token1.address.toLowerCase()
          ? [pool.token0, pool.token1]
          : [pool.token1, pool.token0];

      return {
        id: `${token0.address.toLowerCase()}-${token1.address.toLowerCase()}-${pool.fee}`,
        feeTier: pool.fee.toString(),
        liquidity: pool.liquidity || '1000000000000000000',
        token0: {
          id: token0.address.toLowerCase(),
          symbol: token0.symbol!,
          name: token0.name!,
          decimals: token0.decimals.toString(),
        },
        token1: {
          id: token1.address.toLowerCase(),
          symbol: token1.symbol!,
          name: token1.name!,
          decimals: token1.decimals.toString(),
        },
        sqrtPrice: '0',
        tick: '0',
        tvlETH: 0,
        tvlUSD: 0,
      } as V3SubgraphPool;
    });
  }
}
