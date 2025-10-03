import { ChainId } from '@juiceswapxyz/sdk-core';
import {
  IV3PoolProvider,
  StaticV3SubgraphProvider,
  V3SubgraphPool,
} from '@juiceswapxyz/smart-order-router';
import { CITREA_STATIC_POOLS } from './citreaStaticPools';

/**
 * Custom V3 subgraph provider for Citrea that uses static pool configuration.
 *
 * Returns all static pools to enable multi-hop routing.
 * The AlphaRouter handles pool selection and optimization.
 */
export class CitreaStaticV3SubgraphProvider extends StaticV3SubgraphProvider {
  constructor(chainId: ChainId, poolProvider: IV3PoolProvider) {
    super(chainId, poolProvider);
  }

  public async getPools(): Promise<V3SubgraphPool[]> {
    // Always return all static pools to enable multi-hop routing
    // The AlphaRouter handles pool selection and optimization
    return this.getStaticPools();
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
