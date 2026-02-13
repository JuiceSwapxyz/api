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
      // First check the evm side to know if the user:
      // - has locked up any funds
      // - if so, check if it has refunded said lockup
      // - we don't care about the claims made by the bridge operator
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

      // Second check the onchain side to know if the user:
      // - has claimed said lockup via witness spending
      if (
        swap.claimDetails &&
        typeof swap.claimDetails === "object" &&
        "swapTree" in swap.claimDetails
      ) {
        const swapTree = (swap.claimDetails as any).swapTree;
        const claimLeaf = swapTree.claimLeaf.output;
        const lockupAddress = (swap.claimDetails as any).lockupAddress;

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
