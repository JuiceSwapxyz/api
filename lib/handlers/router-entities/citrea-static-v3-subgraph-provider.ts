import { ChainId, Token } from '@juiceswapxyz/sdk-core'
import { IV3PoolProvider, StaticV3SubgraphProvider, V3SubgraphPool } from '@juiceswapxyz/smart-order-router'
import { CITREA_STATIC_POOLS } from '../../util/citreaStaticPools'

/**
 * Custom Static V3 Subgraph Provider for Citrea
 *
 * Returns hardcoded pool data to avoid expensive on-chain discovery
 * that causes timeouts on Citrea testnet.
 */
export class CitreaStaticV3SubgraphProvider extends StaticV3SubgraphProvider {
  constructor(chainId: ChainId, poolProvider: IV3PoolProvider) {
    super(chainId, poolProvider)
  }

  public async getPools(
    tokenIn?: Token,
    tokenOut?: Token,
  ): Promise<V3SubgraphPool[]> {
    // Convert our static pools to V3SubgraphPool format
    const pools: V3SubgraphPool[] = CITREA_STATIC_POOLS.map(pool => {
      // Ensure token0 address is lower than token1 address (Uniswap convention)
      const [token0, token1] = pool.token0.address.toLowerCase() < pool.token1.address.toLowerCase()
        ? [pool.token0, pool.token1]
        : [pool.token1, pool.token0]

      return {
        id: `${token0.address.toLowerCase()}-${token1.address.toLowerCase()}-${pool.fee}`,
        feeTier: pool.fee.toString(),
        liquidity: pool.liquidity || '1000000000000000000',
        token0: {
          id: token0.address.toLowerCase(),
          symbol: token0.symbol,
          name: token0.name,
          decimals: token0.decimals.toString(),
        },
        token1: {
          id: token1.address.toLowerCase(),
          symbol: token1.symbol,
          name: token1.name,
          decimals: token1.decimals.toString(),
        },
        // These values will be fetched on-chain when needed
        sqrtPrice: '0',
        tick: '0',
        tvlETH: 0,
        tvlUSD: 0,
      } as V3SubgraphPool
    })

    // If specific tokens are requested, filter the pools
    if (tokenIn && tokenOut) {
      const tokenInAddress = tokenIn.address.toLowerCase()
      const tokenOutAddress = tokenOut.address.toLowerCase()

      return pools.filter(pool => {
        const hasTokenIn = pool.token0.id === tokenInAddress || pool.token1.id === tokenInAddress
        const hasTokenOut = pool.token0.id === tokenOutAddress || pool.token1.id === tokenOutAddress
        return hasTokenIn && hasTokenOut
      })
    }

    // Return all pools if no specific tokens requested
    return pools
  }
}