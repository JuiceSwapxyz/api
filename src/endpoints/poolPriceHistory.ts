import { Request, Response } from "express";
import Logger from "bunyan";
import { getAddress } from "viem";
import { getPonderClient } from "../services/PonderClient";
import { ExploreStatsService } from "../services/ExploreStatsService";

type Duration = "DAY" | "WEEK" | "MONTH" | "YEAR";

interface PriceHistoryEntry {
  id: string;
  token0Price: number;
  token1Price: number;
  timestamp: number;
}

/**
 * Returns hoursBack and resample interval (seconds) for each duration.
 */
function getDurationParams(duration: Duration): {
  hoursBack: number;
  resampleSec: number;
} {
  switch (duration) {
    case "DAY":
      return { hoursBack: 24, resampleSec: 3600 }; // hourly
    case "WEEK":
      return { hoursBack: 7 * 24, resampleSec: 6 * 3600 }; // 6h
    case "MONTH":
      return { hoursBack: 30 * 24, resampleSec: 24 * 3600 }; // daily
    case "YEAR":
      return { hoursBack: 365 * 24, resampleSec: 7 * 24 * 3600 }; // weekly
    default:
      return { hoursBack: 24, resampleSec: 3600 };
  }
}

export function createPoolPriceHistoryHandler(
  exploreStatsService: ExploreStatsService,
  logger: Logger,
) {
  return async function handlePoolPriceHistory(
    req: Request,
    res: Response,
  ): Promise<void> {
    const log = logger.child({ endpoint: "poolPriceHistory" });

    try {
      const poolAddress = getAddress(req.params.address);
      const chainId = req.query.chainId as unknown as number;
      const duration = req.query.duration as unknown as Duration;

      const { hoursBack, resampleSec } = getDurationParams(duration);
      const cutoff = (
        Math.floor(Date.now() / 1000) -
        hoursBack * 3600
      ).toString();

      // Get token info and prices from ExploreStatsService
      const exploreData = await exploreStatsService.getExploreStats(chainId);
      const enrichedPool = exploreData.stats?.poolStatsV3?.find(
        (p) => p.id.toLowerCase() === poolAddress.toLowerCase(),
      );

      const token0Decimals = enrichedPool?.token0?.decimals ?? 18;
      const token1Decimals = enrichedPool?.token1?.decimals ?? 18;

      // Query poolActivity for swap history (sqrtPriceX96 snapshots)
      // Use pagination for large time ranges (YEAR can exceed 1000 records)
      const ponderClient = getPonderClient(logger);
      const PAGE_LIMIT = 1000;
      const MAX_PAGES = 10; // Safety cap: 10k records max
      const activities: any[] = [];
      let lastTimestamp = cutoff;

      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await ponderClient.query(
          `
          query GetPoolActivities($where: poolActivityFilter = {}) {
            poolActivitys(where: $where, orderBy: "blockTimestamp", orderDirection: "asc", limit: ${PAGE_LIMIT}) {
              items { poolAddress, sqrtPriceX96, blockTimestamp }
            }
          }
          `,
          {
            where: {
              poolAddress: poolAddress,
              blockTimestamp_gte: lastTimestamp,
            },
          },
        );

        const items = result.poolActivitys?.items || [];
        if (items.length === 0) break;

        activities.push(...items);

        // Stop if this page wasn't full (no more data)
        if (items.length < PAGE_LIMIT) break;

        // Advance cursor past the last timestamp to avoid re-fetching the boundary record.
        // poolActivity records within the same second are rare (same-block swaps);
        // incrementing by 1 may skip them but the resampling smooths over gaps.
        const lastItem = items[items.length - 1];
        lastTimestamp = (parseInt(lastItem.blockTimestamp) + 1).toString();
      }

      if (!enrichedPool && activities.length === 0) {
        res.status(404).json({ error: "Pool not found" });
        return;
      }
      if (!enrichedPool && activities.length > 0) {
        log.warn(
          { poolAddress },
          "Pool exists in Ponder but not in ExploreStatsService cache",
        );
      }

      if (activities.length === 0) {
        res.json([]);
        return;
      }

      // Convert each sqrtPriceX96 to token-pair price ratios (Uniswap subgraph convention)
      // token0Price = token0 per token1, token1Price = token1 per token0
      const Q96 = 2 ** 96;
      const decimalAdjust = 10 ** (token0Decimals - token1Decimals);

      const rawPoints: Array<{
        timestamp: number;
        token0Price: number;
        token1Price: number;
      }> = [];

      for (const activity of activities) {
        const sqrtPrice = parseFloat(activity.sqrtPriceX96);
        if (!sqrtPrice || sqrtPrice <= 0) continue;

        // priceRatio = token1 per token0 (price of token0 denominated in token1)
        const priceRatio = (sqrtPrice / Q96) ** 2 * decimalAdjust;

        rawPoints.push({
          timestamp: parseInt(activity.blockTimestamp),
          token0Price: priceRatio > 0 ? 1 / priceRatio : 0,
          token1Price: priceRatio,
        });
      }

      // Resample: take the last data point in each time bucket
      const resampled = new Map<
        number,
        { token0Price: number; token1Price: number; timestamp: number }
      >();

      for (const point of rawPoints) {
        const bucketStart =
          Math.floor(point.timestamp / resampleSec) * resampleSec;
        // Keep the latest point in each bucket
        const existing = resampled.get(bucketStart);
        if (!existing || point.timestamp >= existing.timestamp) {
          resampled.set(bucketStart, point);
        }
      }

      // Sort by timestamp and build response
      const entries: PriceHistoryEntry[] = Array.from(resampled.entries())
        .sort(([a], [b]) => a - b)
        .map(([bucketTs, point]) => ({
          id: `${poolAddress}-${bucketTs}`,
          token0Price: point.token0Price,
          token1Price: point.token1Price,
          timestamp: point.timestamp,
        }));

      res.json(entries);
    } catch (error) {
      log.error({ error }, "Failed to get pool price history");
      res.status(500).json({
        error: "Internal server error",
        detail:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  };
}
