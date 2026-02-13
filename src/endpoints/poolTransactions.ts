import { Request, Response } from "express";
import Logger from "bunyan";
import { getAddress } from "viem";
import { ethers } from "ethers";
import { getPonderClient } from "../services/PonderClient";
import { ExploreStatsService } from "../services/ExploreStatsService";
import { getChainName } from "../config/chains";
import { computeVolumeUsd } from "../utils/volumeUsd";

export function createPoolTransactionsHandler(
  exploreStatsService: ExploreStatsService,
  logger: Logger,
) {
  return async function handlePoolTransactions(
    req: Request,
    res: Response,
  ): Promise<void> {
    const log = logger.child({ endpoint: "poolTransactions" });

    try {
      const poolAddress = getAddress(req.params.address);
      const chainId = req.query.chainId as unknown as number;
      const first = req.query.first as unknown as number;
      const cursor = req.query.cursor as string | undefined;
      const chainName = getChainName(chainId);

      // Build Ponder query params (independent of ExploreStatsService)
      const ponderClient = getPonderClient(logger);
      const whereClause: Record<string, unknown> = {
        poolAddress: poolAddress,
      };
      // Parse compound cursor "timestamp:id" (new) or plain timestamp (legacy).
      // Compound cursors use blockTimestamp_lte so same-timestamp records aren't
      // skipped; the cursor id is used to strip already-seen records after fetch.
      let cursorId: string | undefined;
      if (cursor) {
        const colonIdx = cursor.indexOf(":");
        if (colonIdx > 0) {
          const cursorTimestamp = cursor.substring(0, colonIdx);
          cursorId = cursor.substring(colonIdx + 1);
          whereClause.blockTimestamp_lte = cursorTimestamp;
        } else {
          whereClause.blockTimestamp_lt = cursor;
        }
      }

      // Run ExploreStatsService and Ponder query in parallel
      const [enrichedPool, result] = await Promise.all([
        exploreStatsService.getPoolStats(chainId, poolAddress),
        ponderClient.query(
          `
          query GetPoolTransactions($where: poolActivityFilter = {}, $limit: Int = 25) {
            poolActivitys(where: $where, orderBy: "blockTimestamp", orderDirection: "desc", limit: $limit) {
              items {
                id
                poolAddress
                blockTimestamp
                txHash
                sender
                recipient
                amount0
                amount1
                sqrtPriceX96
                liquidity
                tick
              }
            }
          }
          `,
          {
            where: whereClause,
            // Over-fetch slightly when deduplicating so we still return `first` results
            limit: cursorId ? first + 10 : first,
          },
        ),
      ]);

      const token0Info = enrichedPool?.token0;
      const token1Info = enrichedPool?.token1;
      const token0Price = token0Info?.price?.value ?? 0;
      const token1Price = token1Info?.price?.value ?? 0;
      const token0Decimals = token0Info?.decimals ?? 18;
      const token1Decimals = token1Info?.decimals ?? 18;

      let activities: any[] = result.poolActivitys?.items || [];

      // When using compound cursor, strip the already-seen record(s) and trim to `first`
      if (cursorId && activities.length > 0) {
        const cursorIdx = activities.findIndex(
          (a: { id: string }) => a.id === cursorId,
        );
        if (cursorIdx >= 0) {
          activities = activities.slice(cursorIdx + 1);
        }
        activities = activities.slice(0, first);
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

      // Map each activity to a transaction
      const transactions = activities.map(
        (activity: {
          id: string;
          blockTimestamp: string;
          txHash: string;
          sender: string;
          recipient: string;
          amount0: string;
          amount1: string;
        }) => {
          // Format amounts (amounts from poolActivity are raw bigints)
          const amount0Raw = BigInt(activity.amount0);
          const amount1Raw = BigInt(activity.amount1);

          const amount0Formatted = parseFloat(
            ethers.utils.formatUnits(
              (amount0Raw < 0n ? -amount0Raw : amount0Raw).toString(),
              token0Decimals,
            ),
          );
          const amount1Formatted = parseFloat(
            ethers.utils.formatUnits(
              (amount1Raw < 0n ? -amount1Raw : amount1Raw).toString(),
              token1Decimals,
            ),
          );

          // Calculate USD value from the priced side
          const usdValue = computeVolumeUsd(
            (amount0Raw < 0n ? -amount0Raw : amount0Raw).toString(),
            (amount1Raw < 0n ? -amount1Raw : amount1Raw).toString(),
            token0Decimals,
            token1Decimals,
            token0Price,
            token1Price,
          );

          // Determine quantities with sign:
          // In a swap, one amount is positive (received by pool) and the other is negative (sent out)
          // Frontend expects: positive = amount flowing in that direction
          const token0Quantity = (
            (amount0Raw < 0n ? -1 : 1) * amount0Formatted
          ).toString();
          const token1Quantity = (
            (amount1Raw < 0n ? -1 : 1) * amount1Formatted
          ).toString();

          return {
            timestamp: parseInt(activity.blockTimestamp),
            hash: activity.txHash,
            account: activity.sender,
            token0: {
              address: token0Info?.address ?? "",
              symbol: token0Info?.symbol ?? "",
              chain: chainName,
              decimals: token0Decimals,
            },
            token0Quantity,
            token1: {
              address: token1Info?.address ?? "",
              symbol: token1Info?.symbol ?? "",
              chain: chainName,
              decimals: token1Decimals,
            },
            token1Quantity,
            usdValue: { value: usdValue },
            // Ponder poolActivity table only captures Swap events.
            // Supporting ADD/REMOVE requires Ponder schema changes (Mint/Burn events).
            type: "SWAP",
          };
        },
      );

      // Build cursor from the last activity's blockTimestamp + id for deterministic pagination.
      // Clients should pass this opaque cursor string to get the next page.
      const lastActivity = activities[activities.length - 1];
      const nextCursor = lastActivity
        ? `${lastActivity.blockTimestamp}:${lastActivity.id}`
        : undefined;

      res.json({
        v3Pool: {
          id: poolAddress,
          transactions,
          cursor: nextCursor,
        },
      });
    } catch (error) {
      log.error({ error }, "Failed to get pool transactions");
      res.status(500).json({ error: "Internal server error" });
    }
  };
}
