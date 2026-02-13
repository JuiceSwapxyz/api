import Logger from "bunyan";
import { BridgeSwap, SwapType } from "../generated/prisma";
import { prisma } from "../db/prisma";
import { LdsSwapStatus, localUserFinalStatuses, swapStatusPending } from "../types/BridgeSwapsStatus";
import { serializeBridgeSwap } from "../utils/bridgeSwapSerialize";
import { BtcOnchainIndexerService } from "./BtcOnchainIndexerService";

export async function computeRefundableBtcChainSwaps(
  userId: string,
  logger: Logger,
): Promise<{
  readyToRefund: BridgeSwap[];
  waitUnlock: BridgeSwap[];
}> {
  const candidates = await prisma.bridgeSwap.findMany({
    where: {
      userId,
      type: SwapType.chain,
      assetSend: "BTC",
      refundTx: null,
      claimTx: null,
      status: {
        notIn: [LdsSwapStatus.SwapCreated, ...Object.values(swapStatusPending), ...localUserFinalStatuses],
      },
    },
  });

  if (candidates.length === 0) {
    return { readyToRefund: [], waitUnlock: [] };
  }

  const btcIndexer = new BtcOnchainIndexerService(logger);
  let blockTipHeight: number;
  try {
    blockTipHeight = await btcIndexer.fetchBlockTipHeight();
  } catch {
    return { readyToRefund: [], waitUnlock: [] };
  }

  if (!Number.isFinite(blockTipHeight)) {
    return { readyToRefund: [], waitUnlock: [] };
  }

  const swapsWithTimeout = candidates.filter((swap) => {
    const timeoutBlockHeight =
      swap.timeoutBlockHeight ??
      (swap.lockupDetails as any)?.timeoutBlockHeight;
    const lockupAddress =
      swap.lockupAddress ?? (swap.lockupDetails as any)?.lockupAddress;
    return (
      typeof timeoutBlockHeight === "number" &&
      Number.isFinite(timeoutBlockHeight) &&
      typeof lockupAddress === "string" &&
      lockupAddress.length > 0
    );
  });

  return {
    readyToRefund: swapsWithTimeout
      .filter((swap) => {
        const timeout =
          swap.timeoutBlockHeight ??
          (swap.lockupDetails as any).timeoutBlockHeight;
        return timeout < blockTipHeight;
      })
      .map(serializeBridgeSwap),
    waitUnlock: swapsWithTimeout
      .filter((swap) => {
        const timeout =
          swap.timeoutBlockHeight ??
          (swap.lockupDetails as any).timeoutBlockHeight;
        return timeout >= blockTipHeight;
      })
      .map(serializeBridgeSwap),
  };
}
