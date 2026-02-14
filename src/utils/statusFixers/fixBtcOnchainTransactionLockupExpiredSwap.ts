import { ChainId } from "@juiceswapxyz/sdk-core";
import { SwapType } from "../../generated/prisma";
import { LdsSwapStatus } from "../../types/BridgeSwapsStatus";
import { SwapFixerDeps, SwapFixerFn } from "./types";

export const fixBtcOnchainTransactionLockupExpiredSwap =
  ({
    btcOnchainIndexerService,
    evmBridgeIndexerService,
  }: SwapFixerDeps): SwapFixerFn =>
  async (swap) => {
    if (
      swap.status === LdsSwapStatus.SwapExpired &&
      swap.type === SwapType.chain &&
      swap.assetSend === "BTC" &&
      swap.assetReceive === "cBTC" &&
      swap.lockupDetails &&
      typeof swap.lockupDetails === "object" &&
      "swapTree" in swap.lockupDetails
    ) {
      const swapTree = (swap.lockupDetails as any).swapTree;
      const refundLeaf = swapTree.refundLeaf.output;
      const lockupAddress = (swap.lockupDetails as any).lockupAddress;

      const txs =
        await btcOnchainIndexerService.getTransactionsByAddress(lockupAddress);

      if (txs.length === 0) {
        return {
          ...swap,
          status: LdsSwapStatus.UserAbandoned,
        };
      }

      const spendRefundTx = txs.find((tx) =>
        tx.vin.some((input) => input.witness?.some((w) => w === refundLeaf)),
      );

      if (spendRefundTx) {
        return {
          ...swap,
          status: LdsSwapStatus.UserRefunded,
          refundTx: spendRefundTx.txid,
        };
      }

      if (swap.preimageHash) {
        const [lockup] = await evmBridgeIndexerService.getLockup(
          swap.preimageHash,
          ChainId.CITREA_MAINNET,
        );

        if (lockup && lockup.claimed) {
          return {
            ...swap,
            status: LdsSwapStatus.UserClaimed,
            claimTx: lockup.claimTxHash,
          };
        }
      }

      return swap;
    }
    return swap;
  };
