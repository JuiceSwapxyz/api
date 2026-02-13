import { Request, Response } from "express";
import Logger from "bunyan";
import { prisma } from "../../db/prisma";
import { serializeBridgeSwap } from "../../utils/bridgeSwapSerialize";
import { BtcOnchainIndexerService } from "../../services/BtcOnchainIndexerService";
import { buildFixSwapStatuses } from "../../utils/statusFixers";
import { EvmBridgeIndexer } from "../../services/EvmBrigdeIndexer";
import { unprefix0x } from "../../utils/hex";

export function createGetBridgeSwapByPreimageHashHandler(logger: Logger) {
  return async function handleGetBridgeSwapByPreimageHash(
    req: Request,
    res: Response,
  ): Promise<void> {
    const { preimageHash } = req.params;
    const userId = req.user!.address;

    try {
      const bridgeSwap = await prisma.bridgeSwap.findFirst({
        where: { preimageHash: unprefix0x(preimageHash), userId },
      });

      if (!bridgeSwap) {
        res.status(404).json({
          error: "Not found",
          detail: `Bridge swap with preimageHash ${preimageHash} not found`,
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
          preimageHash,
          userId,
        },
        "Failed to get bridge swap by preimage hash",
      );
      res.status(500).json({
        error: "Internal server error",
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };
}
