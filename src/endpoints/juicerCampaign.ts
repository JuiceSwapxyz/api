/**
 * Juicer NFT campaign — eligibility + JP-trade endpoints.
 *
 *   GET  /v1/campaigns/juicer/progress?walletAddress=&chainId=
 *   POST /v1/campaigns/juicer/spend       { walletAddress, chainId }
 *
 * Eligibility model
 * -----------------
 * The Juicer NFT is paid for in Juice Points: a wallet trades
 * `JUICER_JP_COST` JP for a backend signature, then mints with that
 * signature. Spend records live in `juicer_spend` (one row per
 * (wallet, chain)) and act as the source of truth for "available JP".
 *
 *   availableJp = totalEarnedJp - JUICER_JP_COST × (spendRecord ? 1 : 0)
 *
 * The endpoint is idempotent: a retried POST /spend returns the same
 * signature as the first call (signatures are deterministic from
 * `(contract, chainId, wallet)`), so a wallet whose first claim tx
 * failed can retry without losing JP twice or being locked out.
 *
 * Hard dependency on the Juice Points system:
 *   - Ponder must serve `/points/{address}` (PR JuiceSwapxyz/ponder#138).
 *   - Frontend must hit the real API (PR JuiceSwapxyz/bapp#740).
 *   - JuicerNFT contract must be deployed and `JUICER_NFT_CONTRACT`
 *     env var populated (PR JuiceSwapxyz/smart-contracts#56).
 *
 * If any of those preconditions are unmet the relevant handler fails
 * closed with a 503 instead of returning fake data.
 */

import { Request, Response } from "express";
import Logger from "bunyan";
import { ethers } from "ethers";
import { ChainId } from "@juiceswapxyz/sdk-core";
import { prisma } from "../db/prisma";
import { getPonderClient } from "../services/PonderClient";
import {
  JUICER_NFT_CONTRACT,
  JUICER_JP_COST,
} from "../lib/constants/campaigns";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SUPPORTED_CHAIN_IDS = new Set<number>([
  ChainId.CITREA_MAINNET,
  ChainId.CITREA_TESTNET,
]);

interface PonderPointsResponse {
  total: number;
  swaps: { count: number; points: number };
  liquidity: {
    days: number;
    points: number;
    currentUsdValue: number;
    meetsMinimum: boolean;
  };
}

/**
 * Reads total earned JP for a wallet from the ponder /points endpoint.
 * Throws if ponder is unreachable so callers can fail closed.
 */
async function fetchTotalEarnedJp(
  logger: Logger,
  walletAddress: string,
): Promise<number> {
  const ponder = getPonderClient(logger);
  const res = await ponder.get<PonderPointsResponse>(
    `/points/${walletAddress.toLowerCase()}`,
  );
  if (res.status !== 200 || typeof res.data?.total !== "number") {
    throw new Error(`Unexpected ponder response: HTTP ${res.status}`);
  }
  return res.data.total;
}

/**
 * Best-effort on-chain `hasClaimed` check. Returns `false` (with a warning
 * logged) if the RPC is unreachable — the contract itself enforces
 * one-mint-per-address as the second line of defence.
 */
async function hasClaimedOnChain(
  logger: Logger,
  walletAddress: string,
  chainId: number,
): Promise<boolean> {
  const rpcEnvVar =
    chainId === ChainId.CITREA_MAINNET
      ? "CITREA_4114_RPC_URL"
      : "CITREA_5115_RPC_URL";
  const rpcUrl = process.env[rpcEnvVar];
  if (!rpcUrl) {
    logger.warn(
      { rpcEnvVar },
      "RPC URL env var not set — skipping on-chain hasClaimed check",
    );
    return false;
  }
  if (!JUICER_NFT_CONTRACT) {
    return false;
  }
  try {
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const contract = new ethers.Contract(
      JUICER_NFT_CONTRACT,
      ["function hasClaimed(address) view returns (bool)"],
      provider,
    );
    return await contract.hasClaimed(walletAddress);
  } catch (err: any) {
    logger.warn(
      { error: err.message },
      "On-chain hasClaimed check failed — defaulting to false",
    );
    return false;
  }
}

interface ValidatedInput {
  walletAddress: string; // lowercased
  chainId: number;
}

function validateRequest(
  req: Request,
  res: Response,
): ValidatedInput | null {
  const walletAddressRaw =
    (req.method === "GET" ? req.query.walletAddress : req.body?.walletAddress) ??
    "";
  const chainIdRaw =
    (req.method === "GET" ? req.query.chainId : req.body?.chainId) ?? "";

  const walletAddress = String(walletAddressRaw);
  if (!ADDRESS_RE.test(walletAddress)) {
    res.status(400).json({ message: "Invalid walletAddress" });
    return null;
  }

  const chainId = Number(chainIdRaw);
  if (!Number.isFinite(chainId) || !SUPPORTED_CHAIN_IDS.has(chainId)) {
    res
      .status(400)
      .json({ message: "Unsupported chainId (must be Citrea mainnet or testnet)" });
    return null;
  }

  return { walletAddress: walletAddress.toLowerCase(), chainId };
}

/**
 * GET /v1/campaigns/juicer/progress
 */
export function createJuicerProgressHandler(logger: Logger) {
  return async function handle(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: "juicer-progress" });
    const input = validateRequest(req, res);
    if (!input) {
      return;
    }
    const { walletAddress, chainId } = input;

    let totalEarnedJp: number;
    try {
      totalEarnedJp = await fetchTotalEarnedJp(log, walletAddress);
    } catch (err: any) {
      log.error(
        { error: err.message, walletAddress },
        "Failed to read JP from ponder — failing closed",
      );
      res.status(503).json({ message: "Indexer not ready; try again shortly" });
      return;
    }

    const spend = await prisma.juicerSpend.findUnique({
      where: {
        walletAddress_chainId: { walletAddress, chainId },
      },
    });

    const spentJp = spend?.amount ?? 0;
    const availableJp = Math.max(0, totalEarnedJp - spentJp);

    const nftMinted =
      !!spend?.txConfirmedAt ||
      (await hasClaimedOnChain(log, walletAddress, chainId));

    res.status(200).json({
      walletAddress,
      chainId,
      availableJp,
      totalEarnedJp,
      spentJp,
      cost: JUICER_JP_COST,
      isEligibleForNFT: !nftMinted && availableJp >= JUICER_JP_COST,
      nftMinted,
      nftTxHash: spend?.txHash ?? undefined,
      nftMintedAt: spend?.txConfirmedAt?.toISOString() ?? undefined,
    });
  };
}

/**
 * POST /v1/campaigns/juicer/spend
 *
 * Idempotent: if a spend row already exists for (wallet, chain) the
 * stored signature is returned instead of regenerating one or
 * deducting JP twice.
 */
export function createJuicerSpendHandler(logger: Logger) {
  return async function handle(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: "juicer-spend" });
    const input = validateRequest(req, res);
    if (!input) {
      return;
    }
    const { walletAddress, chainId } = input;

    if (!JUICER_NFT_CONTRACT) {
      log.warn("JUICER_NFT_CONTRACT not configured — rejecting spend");
      res
        .status(503)
        .json({ message: "Juicer NFT not deployed yet; try again later" });
      return;
    }
    const signerPrivateKey = process.env.CAMPAIGN_SIGNER_PRIVATE_KEY;
    if (!signerPrivateKey) {
      log.error("CAMPAIGN_SIGNER_PRIVATE_KEY not configured");
      res.status(500).json({ message: "Signing not configured" });
      return;
    }

    // Short-circuit: if a row already exists, just return the stored signature.
    const existing = await prisma.juicerSpend.findUnique({
      where: { walletAddress_chainId: { walletAddress, chainId } },
    });
    if (existing) {
      log.debug(
        { walletAddress, chainId, spentAt: existing.spentAt },
        "Re-issuing existing signature (idempotent)",
      );
      res.status(200).json({
        signature: existing.signature,
        spentJp: existing.amount,
        remainingJp: undefined, // computed by /progress; avoid extra ponder hop here
      });
      return;
    }

    // Fresh spend: validate balance, generate signature, insert row.
    let totalEarnedJp: number;
    try {
      totalEarnedJp = await fetchTotalEarnedJp(log, walletAddress);
    } catch (err: any) {
      log.error(
        { error: err.message, walletAddress },
        "Failed to read JP from ponder — refusing to spend",
      );
      res.status(503).json({ message: "Indexer not ready; try again shortly" });
      return;
    }
    if (totalEarnedJp < JUICER_JP_COST) {
      res.status(403).json({
        message: `Not enough Juice Points (need ${JUICER_JP_COST}, have ${totalEarnedJp})`,
      });
      return;
    }

    // Generate signature: keccak256(abi.encodePacked(contract, chainid, wallet))
    const signer = new ethers.Wallet(signerPrivateKey);
    const messageHash = ethers.utils.solidityKeccak256(
      ["address", "uint256", "address"],
      [JUICER_NFT_CONTRACT, chainId, walletAddress],
    );
    const signature = await signer.signMessage(
      ethers.utils.arrayify(messageHash),
    );

    // Insert spend row. The unique (walletAddress, chainId) constraint
    // means a concurrent request that wins the race short-circuits at
    // the findUnique above on retry; if both miss, one INSERT will lose
    // and we fall back to returning the stored row.
    try {
      const created = await prisma.juicerSpend.create({
        data: {
          walletAddress,
          chainId,
          amount: JUICER_JP_COST,
          signature,
          contractAddress: JUICER_NFT_CONTRACT,
        },
      });
      res.status(201).json({
        signature: created.signature,
        spentJp: created.amount,
        remainingJp: totalEarnedJp - created.amount,
      });
    } catch (err: any) {
      // Race-loser: the unique constraint just fired. Re-read and return.
      const persisted = await prisma.juicerSpend.findUnique({
        where: { walletAddress_chainId: { walletAddress, chainId } },
      });
      if (persisted) {
        res.status(200).json({
          signature: persisted.signature,
          spentJp: persisted.amount,
          remainingJp: totalEarnedJp - persisted.amount,
        });
        return;
      }
      log.error({ error: err.message }, "Failed to record JP spend");
      res.status(500).json({ message: "Failed to record JP spend" });
    }
  };
}
