import { LdsSwapStatus } from "../../types/BridgeSwapsStatus";
import { SwapFixerDeps, SwapFixerFn } from "./types";

export const fixCbtcToBtcOnchainClaimPending =
  ({ btcOnchainIndexerService }: SwapFixerDeps): SwapFixerFn =>
  async (swap) => {
    if (
      swap.assetSend !== "cBTC" ||
      swap.assetReceive !== "BTC" ||
      swap.status !== "transaction.claim.pending" ||
      !(swap.claimDetails as any)?.lockupAddress ||
      !(swap.claimDetails as any)?.swapTree
    ) {
      return swap;
    }

    const lockupAddress = (swap.claimDetails as any).lockupAddress as string;
    const txs =
      await btcOnchainIndexerService.getTransactionsByAddress(lockupAddress);

    if (txs.length === 0) {
      return { ...swap, status: LdsSwapStatus.UserAbandoned };
    }

    const claimLeaf = (swap.claimDetails as any).swapTree.claimLeaf.output;
    const spendClaimTx = txs.find((tx) =>
      tx.vin.some((input) => input.witness?.some((w) => w === claimLeaf)),
    );

    if (spendClaimTx) {
      return {
        ...swap,
        status: LdsSwapStatus.UserClaimed,
        claimTx: spendClaimTx.txid,
      };
    }

    return swap;
  };
