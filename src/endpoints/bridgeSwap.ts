import { Request, Response } from "express";
import Logger from "bunyan";
import { prisma } from "../db/prisma";
import { SwapType } from "../generated/prisma";

// Helper: convert request body to Prisma create data
function toSwapData(data: any) {
  return {
    id: data.id,
    userId: data.userId,
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
    expectedAmount: data.expectedAmount != null ? BigInt(data.expectedAmount) : null,
    onchainAmount: data.onchainAmount != null ? BigInt(data.onchainAmount) : null,
    timeoutBlockHeight: data.timeoutBlockHeight ?? null,
    claimDetails: data.claimDetails ?? null,
    lockupDetails: data.lockupDetails ?? null,
    referralId: data.referralId ?? null,
    chainId: data.chainId ?? null,
  };
}

// Helper: serialize BigInt fields to string for JSON response
function serializeSwap(swap: any) {
  return {
    ...swap,
    sendAmount: swap.sendAmount.toString(),
    receiveAmount: swap.receiveAmount.toString(),
    date: swap.date.toString(),
    expectedAmount: swap.expectedAmount?.toString() ?? null,
    onchainAmount: swap.onchainAmount?.toString() ?? null,
  };
}

export function createBridgeSwapHandler(logger: Logger) {
  return async function handleCreateBridgeSwap(
    req: Request,
    res: Response,
  ): Promise<void> {
    const startTime = Date.now();

    try {
      // Ensure userId matches authenticated wallet
      if (req.body.userId.toLowerCase() !== req.user?.address.toLowerCase()) {
        res.status(403).json({
          error: "Forbidden",
          detail: "userId must match authenticated wallet address",
        });
        return;
      }

      const bridgeSwap = await prisma.bridgeSwap.create({
        data: toSwapData(req.body),
      });

      logger.info(
        { id: bridgeSwap.id, userId: bridgeSwap.userId, type: bridgeSwap.type, responseTime: Date.now() - startTime },
        "Bridge swap created",
      );

      res.status(201).json(serializeSwap(bridgeSwap));
    } catch (error: any) {
      if (error.code === "P2002") {
        res.status(409).json({ error: "Conflict", detail: "A swap with this ID already exists" });
        return;
      }

      logger.error({ error: error instanceof Error ? { message: error.message, stack: error.stack } : error }, "Failed to create bridge swap");
      res.status(500).json({ error: "Internal server error", detail: error instanceof Error ? error.message : "Unknown error" });
    }
  };
}

export function createBulkBridgeSwapHandler(logger: Logger) {
  return async function handleBulkCreateBridgeSwap(
    req: Request,
    res: Response,
  ): Promise<void> {
    const startTime = Date.now();

    try {
      const { swaps } = req.body;

      // Ensure all userIds match authenticated wallet
      const invalidSwap = swaps.find((swap: any) => swap.userId.toLowerCase() !== req.user?.address.toLowerCase());
      if (invalidSwap) {
        res.status(403).json({
          error: "Forbidden",
          detail: "All swaps must have userId matching authenticated wallet address",
        });
        return;
      }

      const result = await prisma.bridgeSwap.createMany({
        data: swaps.map(toSwapData),
        skipDuplicates: true,
      });

      logger.info(
        { count: result.count, requested: swaps.length, responseTime: Date.now() - startTime },
        "Bulk bridge swaps created",
      );

      res.status(201).json({
        count: result.count,
        requested: swaps.length,
        skipped: swaps.length - result.count,
      });
    } catch (error: any) {
      logger.error({ error: error instanceof Error ? { message: error.message, stack: error.stack } : error }, "Failed to create bulk bridge swaps");
      res.status(500).json({ error: "Internal server error", detail: error instanceof Error ? error.message : "Unknown error" });
    }
  };
}

export function createGetBridgeSwapByIdHandler(logger: Logger) {
  return async function handleGetBridgeSwapById(
    req: Request,
    res: Response,
  ): Promise<void> {
    const { id } = req.params;

    try {
      const bridgeSwap = await prisma.bridgeSwap.findUnique({ where: { id } });

      if (!bridgeSwap) {
        res.status(404).json({ error: "Not found", detail: `Bridge swap ${id} not found` });
        return;
      }

      res.json(serializeSwap(bridgeSwap));
    } catch (error) {
      logger.error({ error: error instanceof Error ? { message: error.message, stack: error.stack } : error, id }, "Failed to get bridge swap");
      res.status(500).json({ error: "Internal server error", detail: error instanceof Error ? error.message : "Unknown error" });
    }
  };
}

export function createGetBridgeSwapsByUserHandler(logger: Logger) {
  return async function handleGetBridgeSwapsByUser(
    req: Request,
    res: Response,
  ): Promise<void> {
    const { userId } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const status = req.query.status as string | undefined;

    try {
      const where = { userId, ...(status ? { status } : {}) };

      const [swaps, total] = await Promise.all([
        prisma.bridgeSwap.findMany({
          where,
          orderBy: { date: "desc" },
          take: limit,
          skip: offset,
        }),
        prisma.bridgeSwap.count({ where }),
      ]);

      res.json({
        swaps: swaps.map(serializeSwap),
        total,
        limit,
        offset,
      });
    } catch (error) {
      logger.error({ error: error instanceof Error ? { message: error.message, stack: error.stack } : error, userId }, "Failed to get bridge swaps by user");
      res.status(500).json({ error: "Internal server error", detail: error instanceof Error ? error.message : "Unknown error" });
    }
  };
}
