import { Request, Response } from "express";
import Logger from "bunyan";
import { getPonderClient } from "../services/PonderClient";
import { getAddress } from "viem";
import { RouterService } from "../core/RouterService";
import { ChainId, Token } from "@juiceswapxyz/sdk-core";
import { fetchV3OnchainPositionInfo } from "../utils/v3OnchainPositionInfo";

/**
 * @swagger
 * /v1/position/{tokenId}:
 *   get:
 *     tags: [Position]
 *     summary: Get liquidity position information
 *     description: Fetches detailed information about a specific liquidity position
 *     parameters:
 *       - in: path
 *         name: tokenId
 *         required: true
 *         schema:
 *           type: string
 *         example: "12345"
 *         description: Position NFT token ID
 *       - in: query
 *         name: chainId
 *         schema:
 *           type: integer
 *         example: 5115
 *         description: Chain ID (defaults to 5115 for Citrea Testnet)
 *       - in: query
 *         name: protocol
 *         schema:
 *           type: string
 *           enum: [V2, V3]
 *         example: V3
 *         description: Protocol version (defaults to V3)
 *     responses:
 *       200:
 *         description: Position information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tokenId:
 *                   type: string
 *                   description: Position NFT token ID
 *                 owner:
 *                   type: string
 *                   description: Position owner address
 *                 liquidity:
 *                   type: string
 *                   description: Position liquidity
 *                 token0:
 *                   type: object
 *                   properties:
 *                     address:
 *                       type: string
 *                     symbol:
 *                       type: string
 *                     name:
 *                       type: string
 *                     decimals:
 *                       type: integer
 *                 token1:
 *                   type: object
 *                   properties:
 *                     address:
 *                       type: string
 *                     symbol:
 *                       type: string
 *                     name:
 *                       type: string
 *                     decimals:
 *                       type: integer
 *                 fee:
 *                   type: number
 *                   description: Pool fee tier
 *                 tickLower:
 *                   type: number
 *                   description: Lower tick of position range
 *                 tickUpper:
 *                   type: number
 *                   description: Upper tick of position range
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Internal server error
 */
export function createPositionInfoHandler(routerService: RouterService, logger: Logger) {
  return async function handlePositionInfo(
    req: Request,
    res: Response
  ): Promise<void> {
    const log = logger.child({ endpoint: "positionInfo" });
    const startTime = Date.now();

    try {
      const { tokenId } = req.params;
      // Query params are validated and transformed by PositionInfoQuerySchema middleware
      const chainId = (req.query.chainId as unknown as number) || 5115;
      const protocol = (req.query.protocol as string) || "V3";

      // Validate tokenId parameter
      if (!tokenId) {
        log.debug("Validation failed: missing tokenId parameter");
        res.status(400).json({
          error: "Bad request",
          detail: "Missing tokenId parameter",
        });
        return;
      }

      // Validate tokenId is a valid number
      if (!/^\d+$/.test(tokenId)) {
        log.debug({ tokenId }, "Validation failed: invalid tokenId format");
        res.status(400).json({
          error: "Bad request",
          detail: "TokenId must be a valid number",
        });
        return;
      }

      log.debug(
        { tokenId, chainId, protocol },
        "Fetching position info"
      );

      const ponderClient = getPonderClient(logger);
      const positionInfo = await ponderClient.query(
        `
        query PositionInfo($wherePosition: positionFilter = {}) {
            positions(where: $wherePosition) {
                items {
                    amount0
                    amount1
                    owner
                    tickLower
                    tickUpper
                    tokenId
                    poolAddress
                }
            }
            }
      `,
        {
          wherePosition: {
            tokenId: tokenId,
            chainId: chainId,
          },
        }
      );
      const positionData = positionInfo.positions.items[0];
      if (!positionData) {
        res.status(404).json({ message: "Position not found", error: "PositionNotFound" });
        return;
      }

      const poolInfo = await ponderClient.query(
        `
        query PoolInfo($wherePool: poolFilter = {}) {
            pools(where: $wherePool) {
                items {
                    address
                    chainId
                    createdAt
                    fee
                    tickSpacing
                    token0
                    token1
                }
            }
            }
      `,
        {
          wherePool: {
            address: getAddress(positionData.poolAddress),
            chainId: chainId,
          }
        }
      );
      const poolData = poolInfo.pools.items[0];
      if (!poolData) {
        res.status(404).json({ message: "Pool not found", error: "PoolNotFound" });
        return;
      }

      const tokenInfo = await ponderClient.query(
        `
        query TokenInfo($token0Id: String = "", $token1Id: String = "") {
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
          token0Id: poolData.token0.toLowerCase(),
          token1Id: poolData.token1.toLowerCase(),
        }
      );

      const token0 = tokenInfo.token0;
      const token1 = tokenInfo.token1;

      const provider = routerService.getProvider(chainId as ChainId);
      if (!provider) {
        res.status(400).json({ message: "Unsupported chainId", error: "InvalidChainId" });
        return;
      }

      const onchain = await fetchV3OnchainPositionInfo({
        provider,
        chainId: chainId as ChainId,
        poolAddress: getAddress(positionData.poolAddress),
        tokenId,
        token0: new Token(chainId as ChainId, token0.address, token0.decimals),
        token1: new Token(chainId as ChainId, token1.address, token1.decimals),
        fee: poolData.fee,
      });

      const position = {
        chainId: chainId,
        protocolVersion: "PROTOCOL_VERSION_V3",
        case: "v3Position",
        v3Position: {
          case: "v3Position",
          tokenId: tokenId,
          poolId: poolData.address,
          owner: positionData.owner,
          tickLower: positionData.tickLower.toString(),
          tickUpper: positionData.tickUpper.toString(),
          token0: {
            chainId: chainId,
            address: token0.address,
            symbol: token0.symbol,
            decimals: token0.decimals,
            name: token0.name,
          },
          token1: {
            chainId: chainId,
            address: token1.address,
            symbol: token1.symbol,
            decimals: token1.decimals,
            name: token1.name,
          },
          liquidity: onchain.liquidity,
          currentTick: onchain.currentTick,
          currentPrice: onchain.currentPrice,
          currentLiquidity: onchain.currentLiquidity,
          feeTier: poolData.fee.toString(),
          tickSpacing: poolData.tickSpacing.toString(),
          amount0: onchain.amount0,
          amount1: onchain.amount1,
          token0UncollectedFees: onchain.token0UncollectedFees,
          token1UncollectedFees: onchain.token1UncollectedFees,
          totalLiquidityUsd: "0",
        },
        status: "POSITION_STATUS_IN_RANGE",
        timestamp: Math.floor(Date.now() / 1000),
      };

      log.debug(
        {
          address: getAddress(positionData.owner),
          tokenId,
          chainId,
          protocol,
          responseTime: Date.now() - startTime,
        },
        "Successfully returned position info"
      );

      res.status(200).json({position});
    } catch (error) {
      log.error(
        {
          error:
            error instanceof Error
              ? {
                  message: error.message,
                  stack: error.stack,
                  name: error.name,
                }
              : error,
          responseTime: Date.now() - startTime,
        },
        "Failed to fetch position info"
      );

      res.status(500).json({
        error: "Internal server error",
        detail:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  };
}
