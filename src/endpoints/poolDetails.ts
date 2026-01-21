import { Request, Response } from 'express';
import Logger from 'bunyan';
import { getPonderClient } from '../services/PonderClient';
import { erc20Abi, formatUnits, getAddress } from 'viem';
import { ChainId } from '@juiceswapxyz/sdk-core';
import { providers, utils } from 'ethers';
import { UniswapMulticallProvider } from '@juiceswapxyz/smart-order-router';

export interface PoolDetailsRequestBody {
  address: string;
  chainId: number;
}

interface TokenInfo {
  id: string;
  address: string;
  chain: string;
  decimals: number;
  name: string;
  standard: string;
  symbol: string;
  isBridged: null | any;
  bridgedWithdrawalInfo: null | any;
  project: {
    id: string;
    isSpam: boolean;
    logoUrl: string | null;
    name: string;
    safetyLevel: string;
    markets: any[];
    logo: {
      id: string;
      url: string;
    } | null;
  };
  feeData: null | any;
  protectionInfo: null | any;
  market: {
    id: string;
    price: {
      id: string;
      value: number;
    };
  };
}

export interface PoolDetailsResponse {
  data: {
    v3Pool: {
      id: string;
      protocolVersion: string;
      address: string;
      feeTier: number;
      token0: TokenInfo;
      token0Supply: number;
      token1: TokenInfo;
      token1Supply: number;
      txCount: number;
      volume24h: {
        value: number;
      };
      historicalVolume: Array<{
        value: number;
        timestamp: number;
      }>;
      totalLiquidity: {
        value: number;
      };
      totalLiquidityPercentChange24h: {
        value: number;
      };
    };
  };
}

const CHAIN_ID_TO_CHAIN_NAME: Record<number, string> = {
  1: 'ETHEREUM',
  11155111: 'ETHEREUM_SEPOLIA',
  137: 'POLYGON',
  5115: 'CITREA_TESTNET',
};

/**
 * @swagger
 * /v1/pools/v3/details:
 *   post:
 *     tags: [Pools]
 *     summary: Get V3 pool details
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PoolDetailsRequest'
 *           example:
 *             address: "0xDb2d6eb17997F45BD32904798774b7ea654F3223"
 *             chain: 11155111
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PoolDetailsResponse'
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createPoolDetailsHandler(providers: Map<ChainId, providers.StaticJsonRpcProvider>, logger: Logger) {
  return async function handlePoolDetails(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = req.headers['x-request-id'] as string || `pool-details-${Date.now()}`;

    const log = logger.child({ requestId, endpoint: 'poolDetails' });

    try {
      const body: PoolDetailsRequestBody = req.body;
      const chainId = body.chainId as ChainId;

      log.debug({
        address: body.address,
        chainId: body.chainId,
      }, 'Pool details request received');

      const ponderClient = getPonderClient(logger);

      const poolGeneralInfo = await ponderClient.query(
        `
        query PoolGeneralDetails($id: String = "") {
            pool(id: $id) {
                address
                chainId
                createdAt
                fee
                id
                tickSpacing
                token0
                token1
            }
            poolStat(id: $id) {
                txCount
            }
            poolStats(where: {type: "24h", poolAddress: $id}) {
                items {
                    timestamp
                    volume0
                    volume1
                }
            }
        }
        `,
        {
          id: getAddress(body.address),
        }
      );

      const tokenInfo = await ponderClient.query(
        `
        query TokensInfo($token0Id: String = "", $token1Id: String = "") {
            token0: token(id: $token0Id) {
                address
                decimals
                id
                name
                symbol
            }
            token1: token(id: $token1Id) {
                address
                decimals
                id
                name
                symbol
            }
        }
      `,
        {
          token0Id: getAddress(poolGeneralInfo.pool.token0).toLowerCase(),
          token1Id: getAddress(poolGeneralInfo.pool.token1).toLowerCase(),
        }
      );

      const provider = providers.get(chainId);
      if (!provider) {
        throw new Error(`Provider not found for chain ${body.chainId}`);
      }

      const multicallProvider = new UniswapMulticallProvider(
        chainId,
        provider,
        375000
      );

      const erc20Interface = new utils.Interface(erc20Abi);
      
      const { results } = await multicallProvider.callSameFunctionOnMultipleContracts({
        addresses: [getAddress(poolGeneralInfo.pool.token0), getAddress(poolGeneralInfo.pool.token1)],
        contractInterface: erc20Interface,
        functionName: 'balanceOf',
        functionParams: [getAddress(body.address)],
      })

      const [token0Balance, token1Balance] = results.map((result) => {
        if (result.success) {
          return result.result;
        }
        return 0;
      });

      const todaysTimestamp = Math.floor(Date.now() / 1000 / 86400) * 86400;
      const volumen24h = todaysTimestamp < poolGeneralInfo.poolStats.items[0].timestamp ? poolGeneralInfo.poolStats.items[0].volume0 : 0;

      const response: PoolDetailsResponse = {
        data: {
          v3Pool: {
            id: poolGeneralInfo.pool.id,
            protocolVersion: "V3",
            address: poolGeneralInfo.pool.address,
            feeTier: poolGeneralInfo.pool.fee,
            token0: {
              id: tokenInfo.token0.id,
              address: tokenInfo.token0.address,
              chain: CHAIN_ID_TO_CHAIN_NAME[body.chainId],
              decimals: tokenInfo.token0.decimals,
              name: tokenInfo.token0.name,
              standard: "ERC20",
              symbol: tokenInfo.token0.symbol,
              isBridged: null,
              bridgedWithdrawalInfo: null,
              project: {
                id: tokenInfo.token0.id,
                isSpam: false,
                logoUrl: null,
                name: tokenInfo.token0.name,
                safetyLevel: "VERIFIED",
                markets: [],
                logo: null
              },
              feeData: null,
              protectionInfo: null,
              market: {
                id: tokenInfo.token0.id,
                price: {
                  id: tokenInfo.token0.id,
                  value: 0,
                }
              }
            },
            token0Supply: parseFloat(formatUnits(token0Balance, tokenInfo.token0.decimals)),
            token1: {
              id: tokenInfo.token1.id,
              address: tokenInfo.token1.address,
              chain: CHAIN_ID_TO_CHAIN_NAME[body.chainId],
              decimals: tokenInfo.token1.decimals,
              name: tokenInfo.token1.name,
              standard: "ERC20",
              symbol: tokenInfo.token1.symbol,
              isBridged: null,
              bridgedWithdrawalInfo: null,
              project: {
                id: tokenInfo.token1.id,
                isSpam: false,
                logoUrl: null,
                name: tokenInfo.token1.name,
                safetyLevel: "VERIFIED",
                markets: [],
                logo: null
              },
              feeData: null,
              protectionInfo: null,
              market: {
                id: tokenInfo.token1.id,
                price: {
                  id: tokenInfo.token1.id,
                  value: 0,
                }
              }
            },
            token1Supply: parseFloat(formatUnits(token1Balance, tokenInfo.token1.decimals)),
            txCount: poolGeneralInfo.poolStat.txCount,
            volume24h: {
              value: volumen24h,
            },
            historicalVolume: [],
            totalLiquidity: {
              value: 0,
            },
            totalLiquidityPercentChange24h: {
              value: 0,
            }
          }
        }
      };

      res.setHeader('X-Response-Time', `${Date.now() - startTime}ms`);

      log.debug({
        responseTime: Date.now() - startTime,
      }, 'Pool details retrieved successfully');

      res.json(response);

    } catch (error) {
      log.error({
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name
        } : error
      }, 'Failed to get pool details');

      res.status(500).json({
        error: 'Internal server error',
        detail: error instanceof Error ? error.message : 'Unknown error occurred',
      });
    }
  };
}
