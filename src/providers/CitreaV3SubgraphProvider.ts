import { ChainId, Token } from "@juiceswapxyz/sdk-core";
import {
  IV3SubgraphProvider,
  V3SubgraphPool,
} from "@juiceswapxyz/smart-order-router";
import Logger from "bunyan";
import { getAddress } from "viem";
import { getPonderClient, PonderClient } from "../services/PonderClient";

interface PonderPool {
  address: string;
  token0: string;
  token1: string;
  fee: number;
  tickSpacing: number;
}

export class CitreaV3SubgraphProvider implements IV3SubgraphProvider {
  private ponderClient: PonderClient;
  private chainId: ChainId;

  constructor(logger: Logger, chainId: ChainId) {
    this.chainId = chainId;
    this.ponderClient = getPonderClient(logger);
  }

  public async getPools(
    tokenIn: Token,
    tokenOut: Token,
  ): Promise<V3SubgraphPool[]> {
    const tokenInAddress = getAddress(tokenIn.address);
    const tokenOutAddress = getAddress(tokenOut.address);

    const ponderPools = await this.ponderClient.query<{
      allPools: { items: PonderPool[] };
      direct: { items: PonderPool[] };
    }>(
      `
            query AllPoolsWithTokens($tokenIn: String = "", $tokenOut: String = "", $chainId: Int = 0) {
                allPools:pools(
                    where: {OR: {token0: $tokenIn, token1: $tokenIn, OR: {token0: $tokenOut, token1: $tokenOut}}, AND: {chainId: $chainId}}
                    limit: 1000
                ) {
                    items {
                    address
                    token0
                    token1
                    fee
                    tickSpacing
                    }
                }
                direct:pools(
                  where: {
                    OR:[
                      {AND: {token0: $tokenIn, token1: $tokenOut, chainId: $chainId}}
                      {AND: {token1: $tokenIn, token0: $tokenOut, chainId: $chainId}}
                    ]
                  }) {
                  items{
                    address
                    token0
                    token1
                    fee
                    tickSpacing
                  }
                }
            }
            `,
      {
        tokenIn: tokenInAddress,
        tokenOut: tokenOutAddress,
        chainId: this.chainId,
      },
    );

    const directPools = ponderPools.direct.items;
    const allPools = ponderPools.allPools.items;
    const resultPools = directPools.length > 0 ? directPools : allPools;

    const pools: V3SubgraphPool[] = resultPools.map((pool) => {
      return {
        id: pool.address,
        token0: { id: pool.token0 },
        token1: { id: pool.token1 },
        feeTier: pool.fee.toString(),
        liquidity: "1000000",
        tvlETH: 1000,
        tvlUSD: 1000,
      };
    });

    return pools;
  }
}
