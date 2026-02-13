import { Request, Response } from "express";
import Logger from "bunyan";
import { prisma } from "../../db/prisma";
import { serializeBridgeSwap } from "../../utils/bridgeSwapSerialize";
import { BtcOnchainIndexerService } from "../../services/BtcOnchainIndexerService";
import { buildFixSwapStatuses } from "../../utils/statusFixers";
import { EvmBridgeIndexer } from "../../services/EvmBrigdeIndexer";

export function createGetBridgeSwapByIdHandler(logger: Logger) {
  return async function handleGetBridgeSwapById(
    req: Request,
    res: Response,
  ): Promise<void> {
    const { id } = req.params;

    try {
      const bridgeSwap = await prisma.bridgeSwap.findUnique({ where: { id } });

      if (!bridgeSwap) {
        res
          .status(404)
          .json({ error: "Not found", detail: `Bridge swap ${id} not found` });
        return;
      }

      if (bridgeSwap.userId.toLowerCase() !== req.user!.address.toLowerCase()) {
        res.status(403).json({
          error: "Forbidden",
          detail: "You do not own this swap",
        });
        return;
      }

      const btcOnchainIndexerService = new BtcOnchainIndexerService(logger);
      const evmBridgeIndexerService = new EvmBridgeIndexer(logger);

      const fixSwapStatuses = buildFixSwapStatuses({
        btcOnchainIndexerService,
        evmBridgeIndexerService,
      });

      const [resolvedSwap] = await fixSwapStatuses([bridgeSwap]);

      if (resolvedSwap !== bridgeSwap) {
        await prisma.bridgeSwap.update({
          where: { id: bridgeSwap.id },
          data: { status: resolvedSwap.status },
        });
      }

      res.json(serializeBridgeSwap(resolvedSwap));
    } catch (error) {
      logger.error(
        {
          error:
            error instanceof Error
              ? { message: error.message, stack: error.stack }
              : error,
          id,
        },
        "Failed to get bridge swap",
      );
      res.status(500).json({
        error: "Internal server error",
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };
}
