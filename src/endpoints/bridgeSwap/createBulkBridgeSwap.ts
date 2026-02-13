import { Request, Response } from "express";
import Logger from "bunyan";
import { prisma } from "../../db/prisma";
import { toSwapData } from "../../utils/bridgeSwapSerialize";

export function createBulkBridgeSwapHandler(logger: Logger) {
  return async function handleBulkCreateBridgeSwap(
    req: Request,
    res: Response,
  ): Promise<void> {
    const startTime = Date.now();

    try {
      const { swaps } = req.body;

      // Ensure all userIds match authenticated wallet
      const invalidSwap = swaps.find(
        (swap: any) =>
          swap.userId.toLowerCase() !== req.user?.address.toLowerCase(),
      );
      if (invalidSwap) {
        res.status(403).json({
          error: "Forbidden",
          detail:
            "All swaps must have userId matching authenticated wallet address",
        });
        return;
      }

      const result = await prisma.bridgeSwap.createMany({
        data: swaps.map(toSwapData),
        skipDuplicates: true,
      });

      logger.info(
        {
          count: result.count,
          requested: swaps.length,
          responseTime: Date.now() - startTime,
        },
        "Bulk bridge swaps created",
      );

      res.status(201).json({
        count: result.count,
        requested: swaps.length,
        skipped: swaps.length - result.count,
      });
    } catch (error: any) {
      logger.error(
        {
          error:
            error instanceof Error
              ? { message: error.message, stack: error.stack }
              : error,
        },
        "Failed to create bulk bridge swaps",
      );
      res.status(500).json({
        error: "Internal server error",
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };
}
