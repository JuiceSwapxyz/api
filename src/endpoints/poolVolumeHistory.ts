import { Request, Response } from "express";
import Logger from "bunyan";
import { getAddress } from "viem";
import { ethers } from "ethers";
import { getPonderClient } from "../services/PonderClient";
import { ExploreStatsService } from "../services/ExploreStatsService";
import { ResponseCache } from "../cache/responseCache";

type Duration = "DAY" | "WEEK" | "MONTH" | "YEAR";

const volumeHistoryCache = new ResponseCache({ ttl: 30_000, maxSize: 500, name: "VolumeHistoryCache" });

interface VolumeHistoryEntry {
  id: string;
  value: number;
  timestamp: number;
}

/**
 * Resolution mapping:
 *  DAY  → poolStat type="1h", last 24h
 *  WEEK → poolStat type="1h", last 7d
 *  MONTH→ poolStat type="24h", last 30d
 *  YEAR → poolStat type="24h", last 365d
 */
function getQueryParams(duration: Duration): {
  bucketType: string;
  hoursBack: number;
} {
  switch (duration) {
    case "DAY":
      return { bucketType: "1h", hoursBack: 24 };
    case "WEEK":
      return { bucketType: "1h", hoursBack: 7 * 24 };
    case "MONTH":
      return { bucketType: "24h", hoursBack: 30 * 24 };
    case "YEAR":
      return { bucketType: "24h", hoursBack: 365 * 24 };
    default:
      return { bucketType: "1h", hoursBack: 24 };
  }
}

export function createPoolVolumeHistoryHandler(
  exploreStatsService: ExploreStatsService,
  logger: Logger,
) {
  return async function handlePoolVolumeHistory(
    req: Request,
    res: Response,
  ): Promise<void> {
    const log = logger.child({ endpoint: "poolVolumeHistory" });

    try {
      const poolAddress = getAddress(req.params.address);
      const chainId = req.query.chainId as unknown as number;
      const duration = req.query.duration as unknown as Duration;

      // Check cache first
      const cacheKey = `${chainId}:${poolAddress}:${duration}`;
      const cached = volumeHistoryCache.get(cacheKey);
      if (cached) {
        log.debug({ poolAddress, chainId, duration }, "Serving volume history from cache");
        res.json(cached);
        return;
      }

      const { bucketType, hoursBack } = getQueryParams(duration);
      const cutoff = (
        Math.floor(Date.now() / 1000) -
        hoursBack * 3600
      ).toString();

      // Fetch token prices from ExploreStatsService
      const enrichedPool = await exploreStatsService.getPoolStats(chainId, poolAddress);

      const token0Price = enrichedPool?.token0?.price?.value ?? 0;
      const token1Price = enrichedPool?.token1?.price?.value ?? 0;
      const token0Decimals = enrichedPool?.token0?.decimals ?? 18;
      const token1Decimals = enrichedPool?.token1?.decimals ?? 18;

      // Fetch poolStat buckets from Ponder
      // Use pagination for large time ranges (YEAR can exceed 1000 records)
      const ponderClient = getPonderClient(logger);
      const PAGE_LIMIT = 1000;
      const MAX_PAGES = 10; // Safety cap: 10k records max
      const buckets: any[] = [];
      let lastTimestamp = cutoff;

      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await ponderClient.query(
          `
          query GetPoolStatsForChart($where: poolStatFilter = {}) {
            poolStats(where: $where, orderBy: "timestamp", orderDirection: "asc", limit: ${PAGE_LIMIT}) {
              items { poolAddress, volume0, volume1, timestamp, type }
            }
          }
          `,
          {
            where: {
              type: bucketType,
              poolAddress: poolAddress,
              timestamp_gte: lastTimestamp,
            },
          },
        );

        const items = result.poolStats?.items || [];
        if (items.length === 0) break;

        buckets.push(...items);

        // Stop if this page wasn't full (no more data)
        if (items.length < PAGE_LIMIT) break;

        // Advance cursor past the last timestamp to avoid re-fetching the boundary record.
        // poolStat buckets have unique timestamps per (pool, type), so +1 is safe.
        const lastItem = items[items.length - 1];
        lastTimestamp = (parseInt(lastItem.timestamp) + 1).toString();
      }

      if (!enrichedPool && buckets.length === 0) {
        res.status(404).json({ error: "Pool not found" });
        return;
      }
      if (!enrichedPool && buckets.length > 0) {
        log.warn(
          { poolAddress },
          "Pool exists in Ponder but not in ExploreStatsService cache",
        );
      }

      const entries: VolumeHistoryEntry[] = buckets.map(
        (bucket: { volume0: string; volume1: string; timestamp: string }) => {
          let vol = 0;
          if (token0Price > 0) {
            vol =
              parseFloat(
                ethers.utils.formatUnits(bucket.volume0 || "0", token0Decimals),
              ) * token0Price;
          } else if (token1Price > 0) {
            vol =
              parseFloat(
                ethers.utils.formatUnits(bucket.volume1 || "0", token1Decimals),
              ) * token1Price;
          }

          const ts = parseInt(bucket.timestamp);
          return {
            id: `${poolAddress}-${ts}`,
            value: vol,
            timestamp: ts,
          };
        },
      );

      volumeHistoryCache.set(cacheKey, entries);
      res.json(entries);
    } catch (error) {
      log.error({ error }, "Failed to get pool volume history");
      res.status(500).json({
        error: "Internal server error",
        detail:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  };
}
