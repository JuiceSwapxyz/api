import Logger from "bunyan";
import { prisma } from "../db/prisma";
import { LdsSwapStatus, swapStatusPending } from "../types/BridgeSwapsStatus";
import { LdsBridgeService } from "./LdsBridgeService";
import { BtcOnchainIndexerService } from "./BtcOnchainIndexerService";
import { buildFixSwapStatuses } from "../utils/statusFixers";
import { EvmBridgeIndexer } from "./EvmBrigdeIndexer";
import { SwapType } from "../generated/prisma";

/**
 * Syncs pending bridge swap statuses for a user:
 * 1. Fetches pending swaps from DB
 * 2. Pulls latest statuses from LDS
 * 3. Applies status fixers (onchain checks, etc.)
 * 4. Persists any changes back to DB
 */
async function syncPendingSwapStatuses(
  userId: string,
  logger: Logger,
): Promise<void> {
  const pendingSwaps = await prisma.bridgeSwap.findMany({
    where: {
      userId,
      status: { in: Object.values(swapStatusPending) },
    },
  });

  if (pendingSwaps.length === 0) return;

  // Pull latest statuses from LDS
  const ldsBridgeService = new LdsBridgeService(logger);
  const currentStatuses = await ldsBridgeService.getCurrentStatus(
    pendingSwaps.map((swap) => swap.id),
  );

  // Apply LDS status updates
  const withLdsUpdates = pendingSwaps.map((swap) => {
    const ldsStatus = currentStatuses[swap.id]?.status;
    return ldsStatus && ldsStatus !== swap.status
      ? { ...swap, status: ldsStatus }
      : swap;
  });

  // Apply status fixers (onchain checks, etc.)
  const btcOnchainIndexerService = new BtcOnchainIndexerService(logger);
  const evmBridgeIndexerService = new EvmBridgeIndexer(logger);
  const fixSwapStatuses = buildFixSwapStatuses({
    btcOnchainIndexerService,
    evmBridgeIndexerService,
  });
  const resolvedSwaps = await fixSwapStatuses(withLdsUpdates);

  // Persist only swaps that actually changed
  const swapsToUpdate = resolvedSwaps.filter(
    (swap, i) => swap !== pendingSwaps[i],
  );

  if (swapsToUpdate.length > 0) {
    await prisma.$transaction(
      swapsToUpdate.map((swap) =>
        prisma.bridgeSwap.update({
          where: { id: swap.id },
          data: {
            status: swap.status,
            claimTx: swap.claimTx,
            refundTx: swap.refundTx,
          },
        }),
      ),
    );
  }
}

async function syncExpiredSwapStatuses(
  userId: string,
  logger: Logger,
): Promise<void> {
  const expiredSwaps = await prisma.bridgeSwap.findMany({
    where: {
      userId,
      status: LdsSwapStatus.SwapExpired,
      type: { notIn: [SwapType.reverse, SwapType.submarine] },
    },
  });

  if (expiredSwaps.length === 0) return;

  const btcOnchainIndexerService = new BtcOnchainIndexerService(logger);
  const evmBridgeIndexerService = new EvmBridgeIndexer(logger);

  const fixSwapStatuses = buildFixSwapStatuses({
    btcOnchainIndexerService,
    evmBridgeIndexerService,
  });

  const resolvedSwaps = await fixSwapStatuses(expiredSwaps);

  const swapsToUpdate = resolvedSwaps.filter(
    (swap, i) => swap !== expiredSwaps[i],
  );

  if (swapsToUpdate.length > 0) {
    await prisma.$transaction(
      swapsToUpdate.map((swap) =>
        prisma.bridgeSwap.update({
          where: { id: swap.id },
          data: {
            status: swap.status,
            claimTx: swap.claimTx,
            refundTx: swap.refundTx,
          },
        }),
      ),
    );
  }
}

async function syncFailedSwapStatuses(
  userId: string,
  logger: Logger,
): Promise<void> {
  const failedSwaps = await prisma.bridgeSwap.findMany({
    where: {
      userId,
      status: { in: [LdsSwapStatus.TransactionLockupFailed] },
    },
  });

  if (failedSwaps.length === 0) return;

  const btcOnchainIndexerService = new BtcOnchainIndexerService(logger);
  const evmBridgeIndexerService = new EvmBridgeIndexer(logger);

  const fixSwapStatuses = buildFixSwapStatuses({
    btcOnchainIndexerService,
    evmBridgeIndexerService,
  });

  const resolvedSwaps = await fixSwapStatuses(failedSwaps);

  const swapsToUpdate = resolvedSwaps.filter(
    (swap, i) => swap !== failedSwaps[i],
  );

  if (swapsToUpdate.length > 0) {
    await prisma.$transaction(
      swapsToUpdate.map((swap) =>
        prisma.bridgeSwap.update({
          where: { id: swap.id },
          data: {
            status: swap.status,
            claimTx: swap.claimTx,
            refundTx: swap.refundTx,
          },
        }),
      ),
    );
  }
}

const inflightSyncs = new Map<string, Promise<void>>();

export async function syncBridgeSwapStatuses(
  userId: string,
  logger: Logger,
): Promise<void> {
  const existing = inflightSyncs.get(userId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      await syncPendingSwapStatuses(userId, logger);
      await syncExpiredSwapStatuses(userId, logger);
      await syncFailedSwapStatuses(userId, logger);
    } catch (error: any) {
      logger.error(
        { error: error.message },
        "Failed to sync bridge swap statuses",
      );
    } finally {
      inflightSyncs.delete(userId);
    }
  })();

  inflightSyncs.set(userId, promise);
  return promise;
}
