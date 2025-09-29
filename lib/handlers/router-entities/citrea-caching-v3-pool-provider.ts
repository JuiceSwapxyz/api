import { ChainId, Token } from '@juiceswapxyz/sdk-core'
import { FeeAmount, Pool } from '@juiceswapxyz/v3-sdk'
import { IV3PoolProvider, V3PoolAccessor, V3PoolProvider } from '@juiceswapxyz/smart-order-router'
import { ProviderConfig } from '@juiceswapxyz/smart-order-router/build/main/providers/provider'

interface CachedPoolState {
  pool: Pool
  timestamp: number
}

/**
 * Aggressive caching layer for Citrea V3 pools to minimize RPC calls
 * Caches pool states for extended periods since testnet liquidity is stable
 */
export class CitreaCachingV3PoolProvider implements IV3PoolProvider {
  private poolStateCache = new Map<string, CachedPoolState>()
  private readonly CACHE_TTL = 900_000 // 15 minutes for pool states on testnet
  private readonly baseProvider: V3PoolProvider

  constructor(chainId: ChainId, multicallProvider: any) {
    this.baseProvider = new V3PoolProvider(chainId, multicallProvider)
  }

  async getPools(tokenPairs: [Token, Token, FeeAmount][], providerConfig?: ProviderConfig): Promise<V3PoolAccessor> {
    const uncachedPairs: [Token, Token, FeeAmount][] = []
    const cachedPools = new Map<string, Pool>()
    const now = Date.now()

    // Check cache first
    for (const [tokenA, tokenB, feeAmount] of tokenPairs) {
      const cacheKey = this.getCacheKey(tokenA, tokenB, feeAmount)
      const cached = this.poolStateCache.get(cacheKey)

      if (cached && now - cached.timestamp < this.CACHE_TTL) {
        cachedPools.set(cacheKey, cached.pool)
        console.log(`[CitreaPoolCache] HIT for ${tokenA.symbol}/${tokenB.symbol}/${feeAmount}`)
      } else {
        uncachedPairs.push([tokenA, tokenB, feeAmount])
      }
    }

    // Fetch only uncached pools
    let freshPools: V3PoolAccessor | undefined
    if (uncachedPairs.length > 0) {
      console.log(`[CitreaPoolCache] Fetching ${uncachedPairs.length} pools from RPC`)
      freshPools = await this.baseProvider.getPools(uncachedPairs, providerConfig)

      // Cache the fresh results
      for (const [tokenA, tokenB, feeAmount] of uncachedPairs) {
        const pool = freshPools.getPool(tokenA, tokenB, feeAmount)
        if (pool) {
          const cacheKey = this.getCacheKey(tokenA, tokenB, feeAmount)
          this.poolStateCache.set(cacheKey, { pool, timestamp: now })
        }
      }
    }

    // Return combined accessor
    return {
      getPool: (tokenA: Token, tokenB: Token, feeAmount: FeeAmount): Pool | undefined => {
        const cacheKey = this.getCacheKey(tokenA, tokenB, feeAmount)
        const cached = cachedPools.get(cacheKey)
        if (cached) return cached
        return freshPools?.getPool(tokenA, tokenB, feeAmount)
      },
      getPoolByAddress: (address: string): Pool | undefined => {
        // Search in cached pools first
        for (const cached of cachedPools.values()) {
          if (Pool.getAddress(cached.token0, cached.token1, cached.fee).toLowerCase() === address.toLowerCase()) {
            return cached
          }
        }
        return freshPools?.getPoolByAddress(address)
      },
      getAllPools: (): Pool[] => {
        const allPools = [...cachedPools.values()]
        if (freshPools) {
          allPools.push(...freshPools.getAllPools())
        }
        // Remove duplicates
        const uniquePools = new Map<string, Pool>()
        for (const pool of allPools) {
          const key = Pool.getAddress(pool.token0, pool.token1, pool.fee)
          uniquePools.set(key, pool)
        }
        return Array.from(uniquePools.values())
      },
    }
  }

  private getCacheKey(tokenA: Token, tokenB: Token, feeAmount: FeeAmount): string {
    const [token0, token1] = tokenA.sortsBefore(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA]
    return `${token0.address}-${token1.address}-${feeAmount}`
  }

  getPoolAddress(
    tokenA: Token,
    tokenB: Token,
    feeAmount: FeeAmount
  ): { poolAddress: string; token0: Token; token1: Token } {
    return this.baseProvider.getPoolAddress(tokenA, tokenB, feeAmount)
  }
}
