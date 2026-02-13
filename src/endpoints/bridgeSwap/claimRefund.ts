import { providers } from "ethers";
import { ChainId } from "@juiceswapxyz/sdk-core";
import { Request, Response } from "express";
import Logger from "bunyan";
import { computeClaimableAndRefundableEvmSwaps } from "../../services/EvmBridgeClaimRefund";
import { computeRefundableBtcChainSwaps } from "../../services/BtcChainSwapRefund";
import { syncBridgeSwapStatuses } from "../../services/BridgeSwapStatusSyncer";

export function createClaimRefundHandler(
  providerMap: Map<ChainId, providers.StaticJsonRpcProvider>,
  logger: Logger,
) {
  return async function handleClaimRefund(
    req: Request,
    res: Response,
  ): Promise<void> {
    const userId = req.user!.address;
    // Force fresh responses for this endpoint only.
    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });
    delete req.headers["if-none-match"];
    delete req.headers["if-modified-since"];

    try {
      await syncBridgeSwapStatuses(userId, logger);

      const evm = await computeClaimableAndRefundableEvmSwaps(
        userId,
        logger,
        providerMap,
      );

      const btc = await computeRefundableBtcChainSwaps(userId, logger);

      res.json({
        evm,
        btc,
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
        "Failed to compute claim/refund swaps",
      );
      res.status(500).json({
        error: "Internal server error",
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };
}
