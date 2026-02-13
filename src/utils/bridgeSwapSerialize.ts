import { SwapType } from "../generated/prisma";

/**
 * Serialize BigInt fields to string for JSON-safe bridge swap responses.
 */
export function serializeBridgeSwap(swap: any) {
  return {
    ...swap,
    sendAmount: swap.sendAmount.toString(),
    receiveAmount: swap.receiveAmount.toString(),
    date: swap.date.toString(),
    expectedAmount: swap.expectedAmount?.toString() ?? null,
    onchainAmount: swap.onchainAmount?.toString() ?? null,
  };
}

/**
 * Convert request body to Prisma create data.
 */
export function toSwapData(data: any) {
  return {
    id: data.id,
    userId: data.userId.toLowerCase(),
    type: data.type as SwapType,
    version: data.version,
    status: data.status,
    assetSend: data.assetSend,
    assetReceive: data.assetReceive,
    sendAmount: BigInt(data.sendAmount),
    receiveAmount: BigInt(data.receiveAmount),
    date: BigInt(data.date),
    preimage: data.preimage,
    preimageHash: data.preimageHash,
    preimageSeed: data.preimageSeed,
    keyIndex: data.keyIndex,
    claimPrivateKeyIndex: data.claimPrivateKeyIndex ?? null,
    refundPrivateKeyIndex: data.refundPrivateKeyIndex ?? null,
    claimAddress: data.claimAddress,
    address: data.address ?? null,
    refundAddress: data.refundAddress ?? null,
    lockupAddress: data.lockupAddress ?? null,
    claimTx: data.claimTx ?? null,
    refundTx: data.refundTx ?? null,
    lockupTx: data.lockupTx ?? null,
    invoice: data.invoice ?? null,
    acceptZeroConf: data.acceptZeroConf ?? null,
    expectedAmount:
      data.expectedAmount != null ? BigInt(data.expectedAmount) : null,
    onchainAmount:
      data.onchainAmount != null ? BigInt(data.onchainAmount) : null,
    timeoutBlockHeight: data.timeoutBlockHeight ?? null,
    claimDetails: data.claimDetails ?? null,
    lockupDetails: data.lockupDetails ?? null,
    referralId: data.referralId ?? null,
    chainId: data.chainId ?? null,
  };
}
