import { Request, Response } from "express";
import Logger from "bunyan";
import { getAddress } from "viem";
import { ResponseCache } from "../cache/responseCache";
import {
  LaunchpadCandlesRequest,
  LaunchpadChartService,
  LaunchpadTokenNotFoundError,
} from "../services/LaunchpadChartService";

const launchpadCandlesCache = new ResponseCache({
  ttl: 10_000,
  maxSize: 500,
  name: "LaunchpadCandlesCache",
});

/**
 * @swagger
 * /v1/launchpad/token/{address}/candles:
 *   get:
 *     tags: [Launchpad]
 *     summary: Get per-token Launchpad OHLCV candles
 *     description: Builds Pump.fun-style candles from launchpad bonding-curve trades.
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *         description: Launchpad token contract address
 *       - in: query
 *         name: chainId
 *         schema:
 *           type: integer
 *           default: 4114
 *       - in: query
 *         name: interval
 *         schema:
 *           type: string
 *           enum: [1m, 5m, 15m, 1h, 4h, 1d]
 *           default: 5m
 *       - in: query
 *         name: from
 *         schema:
 *           type: integer
 *         description: Optional start timestamp in seconds; response range is bucket-aligned and limit-capped
 *       - in: query
 *         name: to
 *         schema:
 *           type: integer
 *         description: Optional end timestamp in seconds
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 1000
 *           maximum: 1500
 *       - in: query
 *         name: currency
 *         schema:
 *           type: string
 *           enum: [base]
 *           default: base
 *       - in: query
 *         name: fill
 *         schema:
 *           type: string
 *           enum: [none, last]
 *           default: none
 *       - in: query
 *         name: trader
 *         schema:
 *           type: string
 *         description: Optional wallet address to return per-token user trade markers
 *     responses:
 *       200:
 *         description: Launchpad OHLCV candles for the token
 *       404:
 *         description: Launchpad token not found
 */
export function createLaunchpadCandlesHandler(logger: Logger) {
  const service = new LaunchpadChartService(logger);

  return async function handleLaunchpadCandles(
    req: Request,
    res: Response,
  ): Promise<void> {
    const log = logger.child({ endpoint: "launchpad/token/candles" });

    try {
      const tokenAddress = getAddress(req.params.address);
      const query = req.query as unknown as Omit<
        LaunchpadCandlesRequest,
        "address"
      >;

      const cacheKey = JSON.stringify({
        address: tokenAddress.toLowerCase(),
        chainId: query.chainId,
        interval: query.interval,
        from: query.from,
        to: query.to,
        limit: query.limit,
        currency: query.currency,
        fill: query.fill,
        trader: query.trader?.toLowerCase(),
      });

      const cached = launchpadCandlesCache.get(cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }

      const response = await service.getCandles({
        ...query,
        address: tokenAddress,
      });

      launchpadCandlesCache.set(cacheKey, response);
      res.json(response);
    } catch (error) {
      if (error instanceof LaunchpadTokenNotFoundError) {
        res.status(404).json({ error: "Launchpad token not found" });
        return;
      }

      log.error({ error }, "Failed to get launchpad token candles");
      res.status(500).json({ error: "Internal server error" });
    }
  };
}
