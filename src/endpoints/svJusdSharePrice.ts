import { Request, Response } from "express";
import Logger from "bunyan";
import {
  SvJusdPriceService,
  SvJusdSharePriceInfo,
} from "../services/SvJusdPriceService";
import { hasJuiceDollarIntegration } from "../config/contracts";
import { ChainId } from "@juiceswapxyz/sdk-core";

export interface SvJusdSharePriceRequestQuery {
  chainId: string;
}

export interface SvJusdSharePriceResponse extends SvJusdSharePriceInfo {
  cached: boolean;
}

export interface SvJusdSharePriceErrorResponse {
  error: string;
  detail?: string;
}

/**
 * @swagger
 * /v1/svjusd/sharePrice:
 *   get:
 *     tags: [svJUSD]
 *     summary: Get current svJUSD share price
 *     description: |
 *       Returns the current svJUSD share price (JUSD per svJUSD).
 *       The share price increases over time as interest accrues in the vault.
 *
 *       This value is essential for accurate dependent amount calculations
 *       when creating or modifying liquidity positions involving JUSD.
 *     parameters:
 *       - in: query
 *         name: chainId
 *         required: true
 *         schema:
 *           type: integer
 *         description: The chain ID to query (e.g., 5115 for Citrea Testnet)
 *     responses:
 *       200:
 *         description: Share price retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 chainId:
 *                   type: number
 *                   description: The queried chain ID
 *                 sharePrice:
 *                   type: string
 *                   description: Share price as string (18 decimals, e.g., "1020000000000000000" = 1.02)
 *                 sharePriceDecimals:
 *                   type: number
 *                   description: Decimals for share price (always 18)
 *                 svJusdAddress:
 *                   type: string
 *                   description: svJUSD contract address
 *                 jusdAddress:
 *                   type: string
 *                   description: JUSD contract address
 *                 timestamp:
 *                   type: number
 *                   description: Unix timestamp when price was fetched
 *                 cached:
 *                   type: boolean
 *                   description: Whether the response came from cache
 *             example:
 *               chainId: 5115
 *               sharePrice: "1020000000000000000"
 *               sharePriceDecimals: 18
 *               svJusdAddress: "0x..."
 *               jusdAddress: "0x..."
 *               timestamp: 1706184000000
 *               cached: true
 *       400:
 *         description: Invalid request parameters
 *       404:
 *         description: Chain does not support JuiceDollar integration
 *       500:
 *         description: Internal server error
 */
export function createSvJusdSharePriceHandler(
  svJusdPriceService: SvJusdPriceService,
  logger: Logger,
) {
  return async function handleSvJusdSharePrice(
    req: Request,
    res: Response,
  ): Promise<void> {
    const startTime = Date.now();
    const requestId =
      (req.headers["x-request-id"] as string) || `svjusd-price-${Date.now()}`;

    const log = logger.child({ requestId, endpoint: "svJusdSharePrice" });

    try {
      const { chainId: chainIdStr } =
        req.query as unknown as SvJusdSharePriceRequestQuery;

      // Validate chainId
      if (!chainIdStr) {
        res.status(400).json({
          error: "Missing required parameter: chainId",
        } as SvJusdSharePriceErrorResponse);
        return;
      }

      const chainId = parseInt(chainIdStr, 10) as ChainId;

      if (isNaN(chainId)) {
        res.status(400).json({
          error: "Invalid chainId: must be a number",
        } as SvJusdSharePriceErrorResponse);
        return;
      }

      log.debug({ chainId }, "svJUSD share price request received");

      // Check if chain supports JuiceDollar
      if (!hasJuiceDollarIntegration(chainId)) {
        res.status(404).json({
          error: `Chain ${chainId} does not support JuiceDollar integration`,
        } as SvJusdSharePriceErrorResponse);
        return;
      }

      // Check if price is cached (before fetching)
      const wasCached = !svJusdPriceService.isSharePriceStale(chainId);

      // Get share price info
      const priceInfo = await svJusdPriceService.getSharePriceInfo(chainId);

      if (!priceInfo) {
        res.status(500).json({
          error: "Failed to retrieve svJUSD share price",
          detail: "Contract configuration missing",
        } as SvJusdSharePriceErrorResponse);
        return;
      }

      const response: SvJusdSharePriceResponse = {
        ...priceInfo,
        cached: wasCached,
      };

      res.setHeader("X-Response-Time", `${Date.now() - startTime}ms`);
      res.setHeader("Cache-Control", "public, max-age=30"); // 30 seconds

      log.debug(
        {
          responseTime: Date.now() - startTime,
          sharePrice: priceInfo.sharePrice,
          cached: wasCached,
        },
        "svJUSD share price retrieved successfully",
      );

      res.json(response);
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
        "Failed to get svJUSD share price",
      );

      res.status(500).json({
        error: "Internal server error",
        detail:
          error instanceof Error ? error.message : "Unknown error occurred",
      } as SvJusdSharePriceErrorResponse);
    }
  };
}
