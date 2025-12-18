import { ChainId, Token } from '@juiceswapxyz/sdk-core';
import { IV2SubgraphProvider, V2SubgraphPool } from '@juiceswapxyz/smart-order-router';
import Logger from 'bunyan';
import { getPonderClient } from '../services/PonderClient';

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

/**
 * V2SubgraphProvider that returns graduated launchpad pools from Ponder.
 * Used by AlphaRouter to discover V2 pools for routing.
 */
export class GraduatedV2SubgraphProvider implements IV2SubgraphProvider {
  private logger: Logger;
  private poolsCache: V2SubgraphPool[] = [];
  private lastFetch: number = 0;
  private readonly CACHE_TTL = 60_000; // 1 minute

  constructor(_chainId: ChainId, logger: Logger) {
    // chainId is accepted for API compatibility but not currently used
    // Ponder returns all graduated pools regardless of chain
    this.logger = logger.child({ provider: 'GraduatedV2SubgraphProvider' });
  }

  async getPools(
    tokenIn?: Token,
    tokenOut?: Token,
    _providerConfig?: any
  ): Promise<V2SubgraphPool[]> {
    await this.refreshPoolsIfNeeded();

    // Filter by tokens if provided
    if (tokenIn && tokenOut) {
      return this.poolsCache.filter((pool) => {
        const hasTokenIn =
          pool.token0.id.toLowerCase() === tokenIn.address.toLowerCase() ||
          pool.token1.id.toLowerCase() === tokenIn.address.toLowerCase();
        const hasTokenOut =
          pool.token0.id.toLowerCase() === tokenOut.address.toLowerCase() ||
          pool.token1.id.toLowerCase() === tokenOut.address.toLowerCase();
        return hasTokenIn && hasTokenOut;
      });
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
      const response = await ponderClient.get('/graduated-pools');
      const pools: GraduatedPool[] = response.data.pools || [];

      this.poolsCache = pools.map((p) => {
        // Calculate a reasonable reserve value from token reserves
        // This is used for pool ranking - higher reserve = more liquidity
        const reserve0 = BigInt(p.reserve0 || '0');
        const reserve1 = BigInt(p.reserve1 || '0');
        // Use geometric mean as a rough estimate
        const totalReserve = Number(reserve0 + reserve1);

        return {
          id: p.pairAddress.toLowerCase(),
          token0: { id: p.token0.toLowerCase() },
          token1: { id: p.token1.toLowerCase() },
          supply: 1000000, // Placeholder - not used for routing decisions
          reserve: totalReserve,
          reserveUSD: 0, // Would need price oracle for accurate USD value
        };
      });

      this.lastFetch = now;
      this.logger.info(
        { poolCount: pools.length },
        'Refreshed graduated V2 pool cache'
      );
    } catch (error) {
      this.logger.error({ error }, 'Failed to fetch graduated pools from Ponder');
      // Keep existing cache on error, don't throw
    }
  }
}
