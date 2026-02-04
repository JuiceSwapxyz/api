import { Request, Response } from "express";
import Logger from "bunyan";
import { getPonderClient } from "../services/PonderClient";
import { getAddress } from "viem";
import { RouterService } from "../core/RouterService";
import { ChainId, Token } from "@juiceswapxyz/sdk-core";
import {
  fetchV3OnchainPositionInfo,
  fetchV3OnchainPoolInfo,
  V3OnchainPoolInfo,
} from "../utils/v3OnchainPositionInfo";

interface PositionFromPonder {
  tokenId: string;
  owner: string;
  tickLower: number;
  tickUpper: number;
  poolAddress: string;
  chainId: number;
  amount0: string;
  amount1: string;
}

interface PoolFromPonder {
  address: string;
  chainId: number;
  fee: number;
  tickSpacing: number;
  token0: string;
  token1: string;
}

interface TokenFromPonder {
  address: string;
  decimals: number;
  name: string;
  symbol: string;
}

/**
 * @swagger
 * /v1/positions/owner:
 *   post:
 *     tags: [Position]
 *     summary: Get all positions for an owner
 *     description: Fetches all liquidity positions for a specific owner address with live on-chain data
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - address
 *             properties:
 *               address:
 *                 type: string
 *                 description: Owner wallet address
 *                 example: "0x1234567890123456789012345678901234567890"
 *               chainIds:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 description: Optional array of chain IDs to filter by
 *                 example: [4114]
 *     responses:
 *       200:
 *         description: Positions retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 positions:
 *                   type: array
 *                   items:
 *                     type: object
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Internal server error
 */
export function createPositionsOwnerHandler(
  routerService: RouterService,
  logger: Logger,
) {
  return async function handlePositionsOwner(
    req: Request,
    res: Response,
  ): Promise<void> {
    const log = logger.child({ endpoint: "positionsOwner" });
    const startTime = Date.now();

    try {
      const { address, chainIds } = req.body;

      if (!address) {
        log.debug("Validation failed: missing address");
        res.status(400).json({
          error: "Bad request",
          detail: "Missing address parameter",
        });
        return;
      }

      let normalizedAddress: string;
      try {
        normalizedAddress = getAddress(address);
      } catch {
        log.debug({ address }, "Validation failed: invalid address format");
        res.status(400).json({
          error: "Bad request",
          detail: "Invalid Ethereum address",
        });
        return;
      }

      log.debug(
        { address: normalizedAddress, chainIds },
        "Fetching positions for owner",
      );

      const ponderClient = getPonderClient(logger);

      // Build filter for positions query
      const wherePosition: Record<string, unknown> = {
        owner: normalizedAddress,
      };
      if (chainIds && Array.isArray(chainIds) && chainIds.length > 0) {
        wherePosition.chainId_in = chainIds;
      }

      // Fetch positions from Ponder
      const positionsResult = await ponderClient.query(
        `
        query PositionsByOwner($wherePosition: positionFilter = {}) {
          positions(where: $wherePosition, limit: 100) {
            items {
              tokenId
              owner
              tickLower
              tickUpper
              poolAddress
              chainId
              amount0
              amount1
            }
          }
        }
        `,
        { wherePosition },
      );

      const positions: PositionFromPonder[] =
        positionsResult.positions?.items || [];

      if (positions.length === 0) {
        log.debug({ address: normalizedAddress }, "No positions found");
        res.status(200).json({ positions: [] });
        return;
      }

      // Get unique pool addresses and their chain IDs
      const poolKeys = new Set<string>();
      const poolAddressByKey = new Map<
        string,
        { address: string; chainId: number }
      >();
      for (const pos of positions) {
        const key = `${pos.poolAddress.toLowerCase()}-${pos.chainId}`;
        if (!poolKeys.has(key)) {
          poolKeys.add(key);
          poolAddressByKey.set(key, {
            address: pos.poolAddress,
            chainId: pos.chainId,
          });
        }
      }

      // Fetch all pools in parallel
      const poolPromises = Array.from(poolAddressByKey.values()).map(
        async ({ address: poolAddr, chainId }) => {
          const result = await ponderClient.query(
            `
          query PoolInfo($wherePool: poolFilter = {}) {
            pools(where: $wherePool, limit: 1) {
              items {
                address
                chainId
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
                address: getAddress(poolAddr),
                chainId,
              },
            },
          );
          return result.pools?.items?.[0] as PoolFromPonder | undefined;
        },
      );

      const poolsArray = await Promise.all(poolPromises);
      const poolMap = new Map<string, PoolFromPonder>();
      for (const pool of poolsArray) {
        if (pool) {
          poolMap.set(`${pool.address.toLowerCase()}-${pool.chainId}`, pool);
        }
      }

      // Get unique token addresses
      const tokenAddresses = new Set<string>();
      for (const pool of poolMap.values()) {
        tokenAddresses.add(pool.token0.toLowerCase());
        tokenAddresses.add(pool.token1.toLowerCase());
      }

      // Fetch all tokens
      const tokenPromises = Array.from(tokenAddresses).map(
        async (tokenAddr) => {
          const result = await ponderClient.query(
            `
          query TokenInfo($tokenId: String = "") {
            token(id: $tokenId) {
              address
              decimals
              name
              symbol
            }
          }
          `,
            { tokenId: tokenAddr },
          );
          return result.token as TokenFromPonder | undefined;
        },
      );

      const tokensArray = await Promise.all(tokenPromises);
      const tokenMap = new Map<string, TokenFromPonder>();
      for (const token of tokensArray) {
        if (token) {
          tokenMap.set(token.address.toLowerCase(), token);
        }
      }

      // Dedupe pools for on-chain fetching (fetch each pool's state once)
      const poolOnchainInfoMap = new Map<string, V3OnchainPoolInfo>();
      const poolOnchainPromises: Promise<void>[] = [];

      for (const [key, pool] of poolMap.entries()) {
        const provider = routerService.getProvider(pool.chainId as ChainId);
        if (provider) {
          poolOnchainPromises.push(
            fetchV3OnchainPoolInfo({
              provider,
              poolAddress: getAddress(pool.address),
            })
              .then((info) => {
                poolOnchainInfoMap.set(key, info);
              })
              .catch((error) => {
                log.warn(
                  { poolAddress: pool.address, error: error.message },
                  "Failed to fetch pool on-chain info",
                );
              }),
          );
        }
      }

      await Promise.allSettled(poolOnchainPromises);

      // Enrich each position with on-chain data
      const enrichedPositions = await Promise.allSettled(
        positions.map(async (pos) => {
          const poolKey = `${pos.poolAddress.toLowerCase()}-${pos.chainId}`;
          const pool = poolMap.get(poolKey);

          if (!pool) {
            log.warn({ tokenId: pos.tokenId }, "Pool not found for position");
            return null;
          }

          const token0 = tokenMap.get(pool.token0.toLowerCase());
          const token1 = tokenMap.get(pool.token1.toLowerCase());

          if (!token0 || !token1) {
            log.warn(
              { tokenId: pos.tokenId },
              "Token info not found for position",
            );
            return null;
          }

          const provider = routerService.getProvider(pos.chainId as ChainId);

          // Default values from indexed data
          let liquidity = "0";
          let currentTick = pos.tickLower.toString();
          let currentPrice = "0";
          let currentLiquidity = "0";
          let tickLower = pos.tickLower.toString();
          let tickUpper = pos.tickUpper.toString();
          let amount0 = pos.amount0 || "0";
          let amount1 = pos.amount1 || "0";
          let token0UncollectedFees = "0";
          let token1UncollectedFees = "0";

          // Try to get on-chain data
          if (provider) {
            try {
              const onchainInfo = await fetchV3OnchainPositionInfo({
                provider,
                chainId: pos.chainId as ChainId,
                poolAddress: getAddress(pos.poolAddress),
                tokenId: pos.tokenId,
                token0: new Token(
                  pos.chainId as ChainId,
                  token0.address,
                  token0.decimals,
                ),
                token1: new Token(
                  pos.chainId as ChainId,
                  token1.address,
                  token1.decimals,
                ),
                fee: pool.fee,
              });

              liquidity = onchainInfo.liquidity;
              currentTick = onchainInfo.currentTick;
              currentPrice = onchainInfo.currentPrice;
              currentLiquidity = onchainInfo.currentLiquidity;
              tickLower = onchainInfo.tickLower;
              tickUpper = onchainInfo.tickUpper;
              amount0 = onchainInfo.amount0;
              amount1 = onchainInfo.amount1;
              token0UncollectedFees = onchainInfo.token0UncollectedFees;
              token1UncollectedFees = onchainInfo.token1UncollectedFees;
            } catch (error) {
              log.warn(
                {
                  tokenId: pos.tokenId,
                  error: error instanceof Error ? error.message : error,
                },
                "Failed to fetch on-chain position info, using indexed data",
              );

              // Try to at least get pool info from cache
              const cachedPoolInfo = poolOnchainInfoMap.get(poolKey);
              if (cachedPoolInfo) {
                currentTick = cachedPoolInfo.currentTick;
                currentPrice = cachedPoolInfo.currentPrice;
                currentLiquidity = cachedPoolInfo.currentLiquidity;
              }
            }
          }

          // Determine position status based on current tick
          const currentTickNum = Number(currentTick);
          const tickLowerNum = Number(tickLower);
          const tickUpperNum = Number(tickUpper);
          const status =
            currentTickNum >= tickLowerNum && currentTickNum <= tickUpperNum
              ? "POSITION_STATUS_IN_RANGE"
              : "POSITION_STATUS_OUT_OF_RANGE";

          return {
            chainId: pos.chainId,
            protocolVersion: "PROTOCOL_VERSION_V3",
            case: "v3Position",
            v3Position: {
              case: "v3Position",
              tokenId: pos.tokenId,
              poolId: pool.address,
              owner: pos.owner,
              tickLower,
              tickUpper,
              liquidity,
              token0: {
                chainId: pos.chainId,
                address: token0.address,
                symbol: token0.symbol,
                decimals: token0.decimals,
                name: token0.name,
              },
              token1: {
                chainId: pos.chainId,
                address: token1.address,
                symbol: token1.symbol,
                decimals: token1.decimals,
                name: token1.name,
              },
              feeTier: pool.fee.toString(),
              currentTick,
              currentPrice,
              tickSpacing: pool.tickSpacing.toString(),
              token0UncollectedFees,
              token1UncollectedFees,
              amount0,
              amount1,
              currentLiquidity,
              totalLiquidityUsd: "0",
            },
            status,
            timestamp: Math.floor(Date.now() / 1000),
          };
        }),
      );

      // Filter out failed enrichments and null values
      const validPositions: unknown[] = [];
      for (const result of enrichedPositions) {
        if (result.status === "fulfilled" && result.value !== null) {
          validPositions.push(result.value);
        }
      }

      log.debug(
        {
          address: normalizedAddress,
          positionCount: validPositions.length,
          responseTime: Date.now() - startTime,
        },
        "Successfully returned positions for owner",
      );

      res.status(200).json({ positions: validPositions });
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
        "Failed to fetch positions for owner",
      );

      res.status(500).json({
        error: "Internal server error",
        detail:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  };
}
