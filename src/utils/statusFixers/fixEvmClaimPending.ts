import { SwapType } from "../../generated/prisma";
import { LdsSwapStatus } from "../../types/BridgeSwapsStatus";
import { SwapFixerDeps, SwapFixerFn } from "./types";
import { EvmAssets, MapAssetToChain } from "../../config/swap-bridge";

export const fixEvmClaimPending =
  ({ evmBridgeIndexerService }: SwapFixerDeps): SwapFixerFn =>
  async (swap) => {
    if (
      swap.status !== LdsSwapStatus.TransactionClaimPending ||
      swap.type !== SwapType.chain ||
      swap.assetReceive === "BTC" ||
      swap.assetSend === "BTC"
    ) {
      return swap;
    }

    const assetReceive = swap.assetReceive as (typeof EvmAssets)[number];
    if (!EvmAssets.includes(assetReceive)) {
      return swap;
    }

    const destinationChain = MapAssetToChain[assetReceive];
    if (!destinationChain) {
      return swap;
    }

    const [lockup] = await evmBridgeIndexerService.getLockup(
      swap.preimageHash,
      destinationChain,
    );
    
    if (lockup && lockup.claimed) {
      return {
        ...swap,
        status: LdsSwapStatus.UserClaimed,
        claimTx: lockup.claimTxHash,
      };
    }

    return swap;
  };
