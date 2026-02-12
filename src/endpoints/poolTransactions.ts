import { Request, Response } from "express";
import Logger from "bunyan";
import { getAddress } from "viem";
import { ethers } from "ethers";
import { getPonderClient } from "../services/PonderClient";
import { ExploreStatsService } from "../services/ExploreStatsService";

const CHAIN_ID_TO_CHAIN_NAME: Record<number, string> = {
  1: "ETHEREUM",
  11155111: "ETHEREUM_SEPOLIA",
  137: "POLYGON",
  5115: "CITREA_TESTNET",
  4114: "CITREA_MAINNET",
};

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
      const chainId = parseInt(req.query.chainId as string) || 4114;
      const first = Math.min(parseInt(req.query.first as string) || 25, 100);
      const cursor = req.query.cursor as string | undefined;
      const chainName = CHAIN_ID_TO_CHAIN_NAME[chainId] || `CHAIN_${chainId}`;

      // Get token prices and info from ExploreStatsService
      const exploreData = await exploreStatsService.getExploreStats(chainId);
      const enrichedPool = exploreData.stats?.poolStatsV3?.find(
        (p) => p.id.toLowerCase() === poolAddress.toLowerCase(),
      );

      const token0Info = enrichedPool?.token0;
      const token1Info = enrichedPool?.token1;
      const token0Price = token0Info?.price?.value ?? 0;
      const token1Price = token1Info?.price?.value ?? 0;
      const token0Decimals = token0Info?.decimals ?? 18;
      const token1Decimals = token1Info?.decimals ?? 18;

      // Query poolActivity from Ponder
      const ponderClient = getPonderClient(logger);
      const whereClause: Record<string, unknown> = {
        poolAddress: poolAddress,
      };
      if (cursor) {
        whereClause.blockTimestamp_lt = cursor;
      }

      const result = await ponderClient.query(
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
          limit: first,
        },
      );

      const activities = result.poolActivitys?.items || [];

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
              amount0Raw < 0n ? -amount0Raw : amount0Raw,
              token0Decimals,
            ),
          );
          const amount1Formatted = parseFloat(
            ethers.utils.formatUnits(
              amount1Raw < 0n ? -amount1Raw : amount1Raw,
              token1Decimals,
            ),
          );

          // Calculate USD value from the priced side
          let usdValue = 0;
          if (token0Price > 0) {
            usdValue = amount0Formatted * token0Price;
          } else if (token1Price > 0) {
            usdValue = amount1Formatted * token1Price;
          }

          // Determine quantities with sign:
          // In a swap, one amount is positive (received by pool) and the other is negative (sent out)
          // Frontend expects: positive = amount flowing in that direction
          const token0Quantity = parseFloat(
            ethers.utils.formatUnits(activity.amount0, token0Decimals),
          ).toString();
          const token1Quantity = parseFloat(
            ethers.utils.formatUnits(activity.amount1, token1Decimals),
          ).toString();

          return {
            timestamp: parseInt(activity.blockTimestamp),
            hash: activity.txHash,
            account: activity.sender,
            token0: {
              id: token0Info?.address ?? "",
              address: token0Info?.address ?? "",
              symbol: token0Info?.symbol ?? "",
              chain: chainName,
              decimals: token0Decimals,
              project: {
                id: token0Info?.address ?? "",
                name: token0Info?.name ?? "",
                logo: null,
              },
            },
            token0Quantity,
            token1: {
              id: token1Info?.address ?? "",
              address: token1Info?.address ?? "",
              symbol: token1Info?.symbol ?? "",
              chain: chainName,
              decimals: token1Decimals,
              project: {
                id: token1Info?.address ?? "",
                name: token1Info?.name ?? "",
                logo: null,
              },
            },
            token1Quantity,
            usdValue: { value: usdValue },
            type: "SWAP",
          };
        },
      );

      res.json({
        v3Pool: {
          id: poolAddress,
          transactions,
        },
      });
    } catch (error) {
      log.error({ error }, "Failed to get pool transactions");
      res.status(500).json({
        error: "Internal server error",
        detail:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  };
}
