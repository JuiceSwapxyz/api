import { ChainId } from "@juiceswapxyz/sdk-core";
import { SwapType } from "../../generated/prisma";
import { LdsSwapStatus } from "../../types/BridgeSwapsStatus";
import { SwapFixerDeps, SwapFixerFn } from "./types";

export const fixOnchainBtcExpiredSwap =
  ({
    btcOnchainIndexerService,
    evmBridgeIndexerService,
  }: SwapFixerDeps): SwapFixerFn =>
  async (swap) => {
    if (
      swap.type === SwapType.chain &&
      swap.assetSend === "cBTC" &&
      swap.assetReceive === "BTC" &&
      swap.status === LdsSwapStatus.SwapExpired
    ) {
      const [lockups] = await evmBridgeIndexerService.getLockup(
        swap.preimageHash,
        ChainId.CITREA_MAINNET,
      );

      if (!lockups) {
        return { ...swap, status: LdsSwapStatus.UserAbandoned };
      }

      if (lockups.refunded) {
        return {
          ...swap,
          status: LdsSwapStatus.UserRefunded,
          refundTx: lockups.refundTxHash,
        };
      }

      if (
        swap.claimDetails &&
        typeof swap.claimDetails === "object" &&
        "swapTree" in swap.claimDetails
      ) {
        const swapTree = (swap.claimDetails as any).swapTree;
        const claimLeaf = swapTree.claimLeaf.output;
        const lockupAddress = lockups.claimDetails.lockupAddress;

        const txs =
          await btcOnchainIndexerService.getTransactionsByAddress(
            lockupAddress,
          );
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
      }

      return swap;
    }

    return swap;
  };
