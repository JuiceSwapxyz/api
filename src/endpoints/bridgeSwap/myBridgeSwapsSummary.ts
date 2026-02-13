import { Request, Response } from "express";
import Logger from "bunyan";
import { prisma } from "../../db/prisma";
import {
  LdsSwapStatus,
  swapStatusPending,
  swapStatusSuccess,
} from "../../types/BridgeSwapsStatus";
import { syncBridgeSwapStatuses } from "../../services/BridgeSwapStatusSyncer";

export function createMyBridgeSwapsSummaryHandler(logger: Logger) {
  return async function handleMyBridgeSwapsSummary(
    req: Request,
    res: Response,
  ): Promise<void> {
    const userId = req.user!.address;

    try {
      await syncBridgeSwapStatuses(userId, logger);

      const totalPendingSwaps = await prisma.bridgeSwap.count({
        where: {
          userId,
          status: { in: Object.values(swapStatusPending) },
        },
      });

      const totalExpiredSwaps = await prisma.bridgeSwap.count({
        where: {
          userId,
          status: LdsSwapStatus.SwapExpired,
        },
      });

      const totalSwaps = await prisma.bridgeSwap.count({
        where: {
          userId,
        },
      });

      const totalSuccessSwaps = await prisma.bridgeSwap.count({
        where: {
          userId,
          status: { in: Object.values(swapStatusSuccess) },
        },
      });

      const refundableSwaps = await prisma.bridgeSwap.count({
        where: {
          userId,
          status: LdsSwapStatus.UserRefundable,
        },
      });

      res.json({
        totalSwaps: totalSwaps,
        totalSuccessSwaps: totalSuccessSwaps,
        totalPendingSwaps: totalPendingSwaps,
        totalExpiredSwaps: totalExpiredSwaps,
        refundableSwaps: refundableSwaps,
      });
    } catch (error: any) {
      logger.error(
        {
          error:
            error instanceof Error
              ? { message: error.message, stack: error.stack }
              : error,
          userId,
        },
        "Failed to fetch my bridge swaps summary",
      );
      res.status(500).json({
        error: "Internal server error",
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };
}
