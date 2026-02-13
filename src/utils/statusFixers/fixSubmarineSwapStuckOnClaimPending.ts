
import { BridgeSwap, SwapType } from "../../generated/prisma";
import { LdsSwapStatus } from "../../types/BridgeSwapsStatus";
import { SwapFixerFn } from "./types";

export const fixSubmarineSwapStuckOnClaimPending = (): SwapFixerFn => {
  return async (swap: BridgeSwap) => {
    if (
      swap.status === LdsSwapStatus.TransactionClaimPending &&
      swap.type === SwapType.submarine &&
      swap.assetSend === "cBTC" &&
      swap.assetReceive === "BTC"
    ) {
      return {
        ...swap,
        status: LdsSwapStatus.UserClaimed,
      };
    }
    return swap;
  };
};
