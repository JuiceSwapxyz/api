import { Request, Response } from "express";
import Logger from "bunyan";
import { prisma } from "../../db/prisma";
import { serializeBridgeSwap } from "../../utils/bridgeSwapSerialize";
import { syncBridgeSwapStatuses } from "../../services/BridgeSwapStatusSyncer";
import {
  LdsSwapStatus,
  swapStatusPending,
  swapStatusSuccess,
} from "../../types/BridgeSwapsStatus";

export function createGetBridgeSwapsByUserHandler(logger: Logger) {
  return async function handleGetBridgeSwapsByUser(
    req: Request,
    res: Response,
  ): Promise<void> {
    const userId = req.user!.address.toLowerCase();
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const status = req.query.status as string | string[] | undefined;

    try {
      await syncBridgeSwapStatuses(userId, logger);

      const statusFilter = Array.isArray(status)
        ? { in: status }
        : status
          ? status
          : undefined;
      const where = {
        userId,
        ...(statusFilter ? { status: statusFilter } : {}),
      };

      const [
        swaps,
        total,
        totalRefundable,
        totalClaimable,
        totalSuccess,
        totalPending,
      ] = await Promise.all([
        prisma.bridgeSwap.findMany({
          where,
          orderBy: { date: "desc" },
          take: limit,
          skip: offset,
        }),
        prisma.bridgeSwap.count({ where }),
        prisma.bridgeSwap.count({
          where: { userId, status: LdsSwapStatus.UserRefundable },
        }),
        prisma.bridgeSwap.count({
          where: { userId, status: LdsSwapStatus.UserClaimable },
        }),
        prisma.bridgeSwap.count({
          where: { userId, status: { in: Object.values(swapStatusSuccess) } },
        }),
        prisma.bridgeSwap.count({
          where: { userId, status: { in: Object.values(swapStatusPending) } },
        }),
      ]);

      res.json({
        summary: {
          total,
          totalRefundable,
          totalClaimable,
          totalSuccess,
          totalPending,
        },
        swaps: swaps.map(serializeBridgeSwap),
        total,
        limit,
        offset,
      });
    } catch (error) {
      logger.error(
        {
          error:
            error instanceof Error
              ? { message: error.message, stack: error.stack }
              : error,
          userId,
        },
        "Failed to get bridge swaps by user",
      );
      res.status(500).json({
        error: "Internal server error",
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };
}
