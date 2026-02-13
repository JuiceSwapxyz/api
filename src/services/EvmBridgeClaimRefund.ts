import { providers } from "ethers";
import { ChainId } from "@juiceswapxyz/sdk-core";
import Logger from "bunyan";
import { prisma } from "../db/prisma";
import { EvmBridgeIndexer, EvmLockup } from "./EvmBrigdeIndexer";
import { EvmChainHeightService } from "./EvmChainHeightService";
import { prefix0x, unprefix0x } from "../utils/hex";

const computeLockupsReadyToClaim = async (
  userId: string,
  lockups: EvmLockup[],
): Promise<(EvmLockup & { preimage: string })[]> => {
  const unknownPreimages = lockups
    .filter((lockup) => !lockup.knownPreimage?.preimage)
    .map((lockup) => unprefix0x(lockup.preimageHash));

  const swapsWithPreimages = await prisma.bridgeSwap.findMany({
    where: {
      userId,
      preimageHash: { in: unknownPreimages },
    },
    select: {
      preimageHash: true,
      preimage: true,
    },
  });

  const preimageByHash = new Map(
    swapsWithPreimages
      .filter((s) => !!s.preimage)
      .map((s) => [s.preimageHash, s.preimage]),
  );

  const readyToClaim: (EvmLockup & { preimage: string })[] = lockups
    .map((lockup) => {
      const preimage =
        lockup.knownPreimage?.preimage ??
        preimageByHash.get(unprefix0x(lockup.preimageHash));
      return preimage ? { ...lockup, preimage: prefix0x(preimage) } : null;
    })
    .filter((l): l is EvmLockup & { preimage: string } => l !== null);

  return readyToClaim;
};

const computeLockupsReadyToRefund = async (
  lockups: EvmLockup[],
  getBlockHeight: (chainId: ChainId) => Promise<number>,
): Promise<{ readyToRefund: EvmLockup[]; waitUnlock: EvmLockup[] }> => {
  const chainIds = new Set(lockups.map((lockup) => lockup.chainId));
  const blockHeights = await Promise.all(
    Array.from(chainIds).map((chainId) => getBlockHeight(chainId)),
  );
  const blockHeightByChainId = new Map(
    Array.from(chainIds).map((chainId, index) => [
      chainId,
      blockHeights[index],
    ]),
  );

  const supportedLockups = lockups.filter((lockup) =>
    blockHeightByChainId.has(lockup.chainId),
  );

  const readyToRefund = supportedLockups.filter((lockup) => {
    const blockHeight = blockHeightByChainId.get(lockup.chainId);
    return blockHeight && lockup.timelock < blockHeight;
  });

  const waitUnlock = supportedLockups.filter((lockup) => {
    const blockHeight = blockHeightByChainId.get(lockup.chainId);
    return blockHeight && lockup.timelock > blockHeight;
  });

  return { readyToRefund, waitUnlock };
};

export async function computeClaimableAndRefundableEvmSwaps(
  userId: string,
  logger: Logger,
  providers: Map<ChainId, providers.StaticJsonRpcProvider>,
): Promise<{
  readyToClaim: (EvmLockup & { preimage: string })[];
  readyToRefund: EvmLockup[];
  waitUnlock: EvmLockup[];
}> {
  const evmBridgeIndexerService = new EvmBridgeIndexer(logger);

  const { claimable, refundable } =
    await evmBridgeIndexerService.getClaimableAndRefundableLockups(userId);

  const evmChainHeightService = new EvmChainHeightService(logger, providers);

  const readyToClaim = await computeLockupsReadyToClaim(userId, claimable);

  const { readyToRefund, waitUnlock } = await computeLockupsReadyToRefund(
    refundable,
    evmChainHeightService.getBlockHeight,
  );

  return {
    readyToClaim,
    readyToRefund,
    waitUnlock,
  };
}
