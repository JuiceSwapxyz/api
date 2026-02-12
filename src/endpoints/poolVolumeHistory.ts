import { Request, Response } from "express";
import Logger from "bunyan";
import { getAddress } from "viem";
import { ethers } from "ethers";
import { getPonderClient } from "../services/PonderClient";
import { ExploreStatsService } from "../services/ExploreStatsService";

type Duration = "DAY" | "WEEK" | "MONTH" | "YEAR";

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

      const { bucketType, hoursBack } = getQueryParams(duration);
      const cutoff = (
        Math.floor(Date.now() / 1000) -
        hoursBack * 3600
      ).toString();

      // Fetch token prices from ExploreStatsService
      const exploreData = await exploreStatsService.getExploreStats(chainId);
      const enrichedPool = exploreData.stats?.poolStatsV3?.find(
        (p) => p.id.toLowerCase() === poolAddress.toLowerCase(),
      );

      const token0Price = enrichedPool?.token0?.price?.value ?? 0;
      const token1Price = enrichedPool?.token1?.price?.value ?? 0;
      const token0Decimals = enrichedPool?.token0?.decimals ?? 18;
      const token1Decimals = enrichedPool?.token1?.decimals ?? 18;

      // Fetch poolStat buckets from Ponder
      const ponderClient = getPonderClient(logger);
      const result = await ponderClient.query(
        `
        query GetPoolStatsForChart($where: poolStatFilter = {}) {
          poolStats(where: $where, orderBy: "timestamp", orderDirection: "asc", limit: 1000) {
            items { poolAddress, volume0, volume1, timestamp, type }
          }
        }
        `,
        {
          where: {
            type: bucketType,
            poolAddress: poolAddress,
            timestamp_gte: cutoff,
          },
        },
      );

      const buckets = result.poolStats?.items || [];

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
