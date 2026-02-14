import { BridgeSwap } from "../../generated/prisma";
import { SwapFixerDeps, SwapFixerFn } from "./types";
import { fixCbtcToBtcOnchainClaimPending } from "./fixCbtcToBtcOnchainClaimPending";
import { fixOnchainBtcExpiredSwap } from "./fixOnchainBtcExpiredSwap";
import { fixTransactionLockupFailedSwap } from "./fixTransactionLockupFailedSwap";
import { fixBtcOnchainTransactionLockupExpiredSwap } from "./fixBtcOnchainTransactionLockupExpiredSwap";
import { fixErc20ExpiredSwap } from "./fixErc20ExpiredSwap";
import { fixSubmarineSwapStuckOnClaimPending } from "./fixSubmarineSwapStuckOnClaimPending";

export type { SwapFixerDeps, SwapFixerFn };

export const buildFixSwapStatuses = (deps: SwapFixerDeps) => {
  const fixers: SwapFixerFn[] = [
    // cBTC → BTC | transaction.claim.pending
    fixCbtcToBtcOnchainClaimPending(deps),
    // cBTC → BTC (chain) | swap.expired
    fixOnchainBtcExpiredSwap(deps),
    // BTC → cBTC (chain) | transaction.lockup.failed
    fixTransactionLockupFailedSwap(deps),
    // BTC → cBTC (chain) | swap.expired
    fixBtcOnchainTransactionLockupExpiredSwap(deps),
    // ERC20 → ERC20 (chain) | swap.expired
    fixErc20ExpiredSwap(deps),
    // BTC → cBTC (reverse) | transaction.claim.pending
    fixSubmarineSwapStuckOnClaimPending(),
  ];

  return async (swaps: BridgeSwap[]): Promise<BridgeSwap[]> => {
    return Promise.all(
      swaps.map(async (swap) => {
        for (const fixer of fixers) {
          const result = await fixer(swap);
          if (result !== swap) return result;
        }
        return swap;
      }),
    );
  };
};
