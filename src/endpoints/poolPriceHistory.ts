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
      const chainId = parseInt(req.query.chainId as string) || 4114;
      const duration = (
        (req.query.duration as string) || "DAY"
      ).toUpperCase() as Duration;

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

      // We need the counterpart USD price to convert pool ratios to USD prices
      // For now, use current prices as a base
      const token0PriceUsd = enrichedPool?.token0?.price?.value ?? 0;
      const token1PriceUsd = enrichedPool?.token1?.price?.value ?? 0;

      // Query poolActivity for swap history (sqrtPriceX96 snapshots)
      const ponderClient = getPonderClient(logger);
      const result = await ponderClient.query(
        `
        query GetPoolActivities($where: poolActivityFilter = {}) {
          poolActivitys(where: $where, orderBy: "blockTimestamp", orderDirection: "asc", limit: 1000) {
            items { poolAddress, sqrtPriceX96, blockTimestamp }
          }
        }
        `,
        {
          where: {
            poolAddress: poolAddress,
            blockTimestamp_gte: cutoff,
          },
        },
      );

      const activities = result.poolActivitys?.items || [];

      if (activities.length === 0) {
        res.json([]);
        return;
      }

      // Convert each sqrtPriceX96 to token0/token1 price ratio
      // price = (sqrtPriceX96 / 2^96)^2 * 10^(decimals0 - decimals1)
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

        const priceRatio = (sqrtPrice / Q96) ** 2 * decimalAdjust;
        // priceRatio = token0_price_in_token1_terms
        // token0Price in USD = priceRatio * token1PriceUsd
        // token1Price in USD = (1/priceRatio) * token0PriceUsd

        let t0Price = 0;
        let t1Price = 0;

        if (token1PriceUsd > 0) {
          t0Price = priceRatio * token1PriceUsd;
        }
        if (token0PriceUsd > 0 && priceRatio > 0) {
          t1Price = token0PriceUsd / priceRatio;
        }

        // Fallback: if we only have one side, derive the other from ratio
        if (t0Price > 0 && t1Price === 0 && priceRatio > 0) {
          t1Price = t0Price / priceRatio;
        } else if (t1Price > 0 && t0Price === 0) {
          t0Price = t1Price * priceRatio;
        }

        rawPoints.push({
          timestamp: parseInt(activity.blockTimestamp),
          token0Price: t0Price,
          token1Price: t1Price,
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
