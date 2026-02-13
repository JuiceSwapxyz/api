import { SwapFixerDeps, SwapFixerFn } from "./types";
import { LdsSwapStatus } from "../../types/BridgeSwapsStatus";
import { SwapType } from "../../generated/prisma";
import {
  Erc20Asset,
  EvmAssets,
  MapAssetToChain,
} from "../../config/swap-bridge";

export const fixErc20ExpiredSwap =
  ({ evmBridgeIndexerService }: SwapFixerDeps): SwapFixerFn =>
  async (swap) => {
    if (
      swap.status === LdsSwapStatus.SwapExpired &&
      swap.type === SwapType.chain &&
      EvmAssets.includes(swap.assetSend as (typeof EvmAssets)[number]) &&
      EvmAssets.includes(swap.assetReceive as (typeof EvmAssets)[number]) &&
      swap.lockupDetails &&
      swap.claimDetails
    ) {
      const assetSend =
        swap.assetSend as (typeof EvmAssets)[number] as (typeof Erc20Asset)[number];
      const assetReceive =
        swap.assetReceive as (typeof EvmAssets)[number] as (typeof Erc20Asset)[number];
      const originChain = MapAssetToChain[assetSend];
      const destinationChain = MapAssetToChain[assetReceive];

      const { originLockup, destinationLockup } =
        await evmBridgeIndexerService.getEvmBrigeLockups(
          swap.preimageHash,
          originChain,
          destinationChain,
        );

      // Happy paths
      if (!originLockup) {
        return { ...swap, status: LdsSwapStatus.UserAbandoned };
      }

      if (originLockup.refunded) {
        return {
          ...swap,
          status: LdsSwapStatus.UserRefunded,
          refundTx: originLockup.refundTxHash,
        };
      }

      if (destinationLockup && destinationLockup.claimed) {
        return {
          ...swap,
          status: LdsSwapStatus.UserClaimed,
          claimTx: destinationLockup.claimTxHash,
        };
      }

      // Complex cases
      // 1. Swap expired and Lds never locked up the funds or refunded
      if (
        !originLockup.claimed &&
        (!destinationLockup || destinationLockup.refunded)
      ) {
        return {
          ...swap,
          status: LdsSwapStatus.UserRefundable,
        };
      }

      // Nothing to do
      return swap;
    }
    return swap;
  };
