import { Request, Response } from "express";
import Logger from "bunyan";
import { ChainId } from "@juiceswapxyz/sdk-core";
import { ethers } from "ethers";
import {
  ProtocolStatsService,
  ProtocolStatsResponse,
} from "../services/ProtocolStatsService";
import { ExploreStatsService } from "../services/ExploreStatsService";

export interface ProtocolStatsRequestBody {
  chainId: number;
}

/**
 * @swagger
 * /v1/protocol/stats:
 *   post:
 *     tags: [Protocol]
 *     summary: Get protocol TVL and volume stats
 *     description: Returns aggregated TVL and 24h volume for V2 and V3 protocols
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [chainId]
 *             properties:
 *               chainId:
 *                 type: number
 *                 description: Chain ID to query
 *                 example: 4114
 *     responses:
 *       200:
 *         description: Protocol stats
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 dailyProtocolTvl:
 *                   type: object
 *                   properties:
 *                     v2:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           timestamp:
 *                             type: number
 *                           value:
 *                             type: number
 *                     v3:
 *                       type: array
 *                     bridge:
 *                       type: array
 *                 historicalProtocolVolume:
 *                   type: object
 *                   properties:
 *                     Month:
 *                       type: object
 *                       properties:
 *                         v2:
 *                           type: array
 *                         v3:
 *                           type: array
 *                         bridge:
 *                           type: array
 *       400:
 *         description: Invalid request
 *       500:
 *         description: Internal server error
 */
export function createProtocolStatsHandler(
  providers: Map<ChainId, ethers.providers.StaticJsonRpcProvider>,
  logger: Logger,
  exploreStatsService: ExploreStatsService,
) {
  const protocolStatsService = new ProtocolStatsService(
    providers,
    logger,
    exploreStatsService,
  );

  return async function handleProtocolStats(
    req: Request,
    res: Response,
  ): Promise<void> {
    const startTime = Date.now();
    const requestId =
      (req.headers["x-request-id"] as string) || `protocol-stats-${Date.now()}`;

    const log = logger.child({ requestId, endpoint: "protocolStats" });

    try {
      const body: ProtocolStatsRequestBody = req.body;

      log.debug({ chainId: body.chainId }, "Protocol stats request received");

      const stats: ProtocolStatsResponse =
        await protocolStatsService.getProtocolStats(body.chainId);

      res.setHeader("X-Response-Time", `${Date.now() - startTime}ms`);

      log.debug(
        { responseTime: Date.now() - startTime },
        "Protocol stats retrieved successfully",
      );

      res.json(stats);
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
        },
        "Failed to get protocol stats",
      );

      res.status(500).json({
        error: "Internal server error",
        detail:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  };
}
