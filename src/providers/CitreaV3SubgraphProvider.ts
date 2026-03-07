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

const EXCLUDED_LOW_LIQUIDITY_POOLS = [
  "0x002afdd9272be61ce8c882839a1c88f8b75287f8",
  "0x26bdf3981424b2097c525f2afeb4e0062a347f0d",
  "0xd7ad0708c62327f4876c3f08ea7067e6c04da828",
];

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
            query AllPoolsWithTokens($tokenIn: String = "", $tokenOut: String = "", $chainId: Int = 0, $excludedPools: [String!] = []) {
                allPools:pools(
                    where: {OR: {token0: $tokenIn, token1: $tokenIn, OR: {token0: $tokenOut, token1: $tokenOut}}, AND: {chainId: $chainId, address_not_in: $excludedPools}}
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
                    AND: {address_not_in: $excludedPools}
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
        excludedPools: EXCLUDED_LOW_LIQUIDITY_POOLS,
      },
    );

    // Keep a defensive filter here in case query-side filtering changes upstream.
    const directPools = ponderPools.direct.items.filter(
      (pool) =>
        !EXCLUDED_LOW_LIQUIDITY_POOLS.includes(pool.address.toLowerCase()),
    );
    const allPools = ponderPools.allPools.items.filter(
      (pool) =>
        !EXCLUDED_LOW_LIQUIDITY_POOLS.includes(pool.address.toLowerCase()),
    );
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
