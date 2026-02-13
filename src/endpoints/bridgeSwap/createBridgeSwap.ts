import { Request, Response } from "express";
import Logger from "bunyan";
import { prisma } from "../../db/prisma";
import {
  serializeBridgeSwap,
  toSwapData,
} from "../../utils/bridgeSwapSerialize";

export function createBridgeSwapHandler(logger: Logger) {
  return async function handleCreateBridgeSwap(
    req: Request,
    res: Response,
  ): Promise<void> {
    const startTime = Date.now();

    try {
      // Ensure userId matches authenticated wallet
      if (req.body.userId.toLowerCase() !== req.user?.address.toLowerCase()) {
        res.status(403).json({
          error: "Forbidden",
          detail: "userId must match authenticated wallet address",
        });
        return;
      }

      const { id, ...updateData } = toSwapData(req.body);

      const existingSwap = await prisma.bridgeSwap.findUnique({
        where: { id },
      });

      if (
        existingSwap &&
        existingSwap.userId.toLowerCase() !== req.user!.address.toLowerCase()
      ) {
        res
          .status(403)
          .json({ error: "Forbidden", detail: "You do not own this swap" });
        return;
      }

      const bridgeSwap = await (existingSwap
        ? prisma.bridgeSwap.update({ where: { id }, data: updateData })
        : prisma.bridgeSwap.create({ data: { id, ...updateData } }));

      logger.info(
        {
          id: bridgeSwap.id,
          userId: bridgeSwap.userId,
          type: bridgeSwap.type,
          responseTime: Date.now() - startTime,
        },
        "Bridge swap upserted",
      );

      res.status(200).json(serializeBridgeSwap(bridgeSwap));
    } catch (error: any) {
      logger.error(
        {
          error:
            error instanceof Error
              ? { message: error.message, stack: error.stack }
              : error,
        },
        "Failed to create bridge swap",
      );
      res.status(500).json({
        error: "Internal server error",
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };
}
