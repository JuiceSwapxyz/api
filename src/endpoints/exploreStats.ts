import { Request, Response } from "express";
import Logger from "bunyan";
import { ChainId } from "@juiceswapxyz/sdk-core";
import { ExploreStatsService } from "../services/ExploreStatsService";

/**
 * @swagger
 * /v1/explore/stats:
 *   get:
 *     tags: [Explore]
 *     summary: Get enriched explore stats with USD prices
 *     description: Returns token stats, pool stats, and transaction stats with USD-denominated prices, TVL, and volumes
 *     parameters:
 *       - in: query
 *         name: chainId
 *         schema:
 *           type: number
 *         description: Chain ID to query (defaults to 4114 for Citrea Mainnet)
 *         example: 4114
 *     responses:
 *       200:
 *         description: Enriched explore stats
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 stats:
 *                   type: object
 *                   properties:
 *                     tokenStats:
 *                       type: array
 *                     poolStatsV2:
 *                       type: array
 *                     poolStatsV3:
 *                       type: array
 *                     poolStatsV4:
 *                       type: array
 *                     transactionStats:
 *                       type: array
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Internal server error
 */
export function createExploreStatsHandler(
  exploreStatsService: ExploreStatsService,
  logger: Logger,
) {

  return async function handleExploreStats(
    req: Request,
    res: Response,
  ): Promise<void> {
    const startTime = Date.now();
    const requestId =
      (req.headers["x-request-id"] as string) || `explore-stats-${Date.now()}`;

    const log = logger.child({ requestId, endpoint: "exploreStats" });

    try {
      const chainId = req.query.chainId
        ? parseInt(req.query.chainId as string, 10)
        : ChainId.CITREA_MAINNET;

      if (isNaN(chainId)) {
        res.status(400).json({
          error: "Invalid chainId: must be a number",
        });
        return;
      }

      log.debug({ chainId }, "Explore stats request received");

      const stats = await exploreStatsService.getExploreStats(chainId);

      res.setHeader("X-Response-Time", `${Date.now() - startTime}ms`);

      log.debug(
        { responseTime: Date.now() - startTime },
        "Explore stats retrieved successfully",
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
        "Failed to get explore stats",
      );

      res.status(500).json({
        error: "Internal server error",
        detail:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  };
}
