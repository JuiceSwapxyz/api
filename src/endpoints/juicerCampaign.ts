import { Request, Response } from "express";
import Logger from "bunyan";
import { ethers } from "ethers";
import { getDiscordOAuthService } from "../services/DiscordOAuthService";
import { getPonderClient } from "../services/PonderClient";
import { prisma } from "../db/prisma";
import {
  getJuicerNftContract,
  JUICER_CAMPAIGN_CHAIN_ID,
  JUICER_JP_COST,
  JUICER_SPEND_REASON,
} from "../lib/constants/campaigns";

/**
 * Juicer NFT Campaign endpoints.
 *
 * Flow (mirrors apps/web/src/services/juicerCampaign in the frontend):
 *   1. POST /spend                 — trade JUICER_JP_COST JP for the claim right
 *   2. POST /twitter/mark-followed — mark the X follow (honor system, like the
 *                                    First Squeezer mark-followed step)
 *   3. GET  /discord/start|callback — Discord OAuth; requires the Juicer role
 *   4. GET  /nft/signature         — backend-signed claim() payload, only once
 *                                    every condition is satisfied
 *   GET /progress                  — composed read model for all of the above
 *
 * JP economics: the EARN side lives in the Ponder indexer (on-chain derived,
 * append-only; `GET /points/:address`). The SPEND side is the JpSpend ledger
 * here. availableJp = ponder total − SUM(JpSpend.amount). Spends are
 * idempotent via the (walletAddress, chainId, reason) unique constraint.
 */

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Build the EIP-191 claim signature consumed by JuicerNFT.claim(signature).
 * Must stay byte-compatible with the contract, which recovers:
 *   keccak256(abi.encodePacked(address(this), block.chainid, msg.sender))
 *     .toEthSignedMessageHash()
 *     .recover(signature) == signer
 * `signMessage(arrayify(hash))` applies the same EIP-191 prefix as
 * toEthSignedMessageHash, so the recovered address equals the signer.
 */
export async function buildJuicerClaimSignature(
  signerPrivateKey: string,
  contractAddress: string,
  chainId: number,
  walletAddress: string,
): Promise<string> {
  const signer = new ethers.Wallet(signerPrivateKey);
  const messageHash = ethers.utils.solidityKeccak256(
    ["address", "uint256", "address"],
    [contractAddress, chainId, walletAddress],
  );
  return signer.signMessage(ethers.utils.arrayify(messageHash));
}

interface PonderPointsBreakdown {
  total: number;
  swaps: { count: number; points: number };
  liquidity: {
    days: number;
    points: number;
    currentUsdValue: number;
    meetsMinimum: boolean;
  };
  bonuses: {
    memeTokenCreated: boolean;
    memeTokenPoints: number;
    memeTokenGraduated: boolean;
    memeTokenGraduatedPoints: number;
    points: number;
  };
}

/**
 * Earned JP for a wallet, straight from the Ponder points engine.
 * Throws on indexer failure — callers decide whether to fail open (progress
 * display) or closed (spend / signature gates MUST fail closed).
 */
async function fetchEarnedPoints(
  log: Logger,
  walletAddress: string,
): Promise<PonderPointsBreakdown> {
  const ponderClient = getPonderClient(log);
  const response = await ponderClient.get(`/points/${walletAddress}`);
  return response.data as PonderPointsBreakdown;
}

/** Sum of all JP this wallet has spent on the campaign chain. */
async function fetchSpentJp(walletAddress: string): Promise<number> {
  const agg = await prisma.jpSpend.aggregate({
    where: {
      walletAddress: walletAddress.toLowerCase(),
      chainId: JUICER_CAMPAIGN_CHAIN_ID,
    },
    _sum: { amount: true },
  });
  return agg._sum.amount ?? 0;
}

/** The wallet's Juicer spend row, if the 5,000 JP trade already happened. */
async function fetchJuicerSpend(walletAddress: string) {
  return prisma.jpSpend.findUnique({
    where: {
      walletAddress_chainId_reason: {
        walletAddress: walletAddress.toLowerCase(),
        chainId: JUICER_CAMPAIGN_CHAIN_ID,
        reason: JUICER_SPEND_REASON,
      },
    },
  });
}

/**
 * On-chain hasClaimed() for the Juicer NFT. Returns null when the contract is
 * not configured/deployed yet or the RPC fails — callers must treat null as
 * "unknown" (progress shows false; the signature path re-checks and the
 * contract itself is the final double-claim guard).
 */
async function fetchNftMinted(
  log: Logger,
  walletAddress: string,
): Promise<boolean | null> {
  const contractAddress = getJuicerNftContract(JUICER_CAMPAIGN_CHAIN_ID);
  const rpcUrl = process.env.CITREA_4114_RPC_URL;
  if (!contractAddress || !rpcUrl) {
    return null;
  }
  try {
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const contract = new ethers.Contract(
      contractAddress,
      ["function hasClaimed(address) view returns (bool)"],
      provider,
    );
    return await contract.hasClaimed(walletAddress);
  } catch (error: any) {
    log.warn(
      { error: error.message, walletAddress },
      "Juicer hasClaimed lookup failed",
    );
    return null;
  }
}

/**
 * @swagger
 * /v1/campaigns/juicer/progress:
 *   get:
 *     tags: [Campaign]
 *     summary: Full Juicer campaign progress for a wallet
 *     description: >
 *       Composes the Ponder-earned JP total, the JpSpend ledger, the social
 *       verification state and the on-chain claim state into the read model
 *       the Juicer page renders.
 *     parameters:
 *       - in: query
 *         name: walletAddress
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: chainId
 *         required: false
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 walletAddress: { type: string }
 *                 chainId: { type: integer }
 *                 availableJp: { type: number }
 *                 totalEarnedJp: { type: number }
 *                 spentJp: { type: number }
 *                 cost: { type: number }
 *                 jpSpent: { type: boolean }
 *                 memeTokenCreated: { type: boolean }
 *                 twitterVerified: { type: boolean }
 *                 discordVerified: { type: boolean }
 *                 isEligibleForNFT: { type: boolean }
 *                 nftMinted: { type: boolean }
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createJuicerProgressHandler(logger: Logger) {
  return async function handleJuicerProgress(
    req: Request,
    res: Response,
  ): Promise<void> {
    const log = logger.child({ endpoint: "juicer-progress" });

    try {
      const walletAddress = req.query.walletAddress as string;
      if (!walletAddress || !ADDRESS_RE.test(walletAddress)) {
        res.status(400).json({ message: "Invalid wallet address" });
        return;
      }
      const normalizedAddress = walletAddress.toLowerCase();

      // Earned side from Ponder. Progress is a read model, so a down indexer
      // degrades to zeros instead of breaking the page.
      let breakdown: PonderPointsBreakdown | null = null;
      try {
        breakdown = await fetchEarnedPoints(log, normalizedAddress);
      } catch (error: any) {
        log.warn(
          { error: error.message, walletAddress: normalizedAddress },
          "Ponder points lookup failed; rendering zero-earned progress",
        );
      }
      const totalEarnedJp = breakdown?.total ?? 0;
      const memeTokenCreated = breakdown?.bonuses?.memeTokenCreated ?? false;

      // Spend side from the ledger.
      const [spentJp, juicerSpend] = await Promise.all([
        fetchSpentJp(normalizedAddress),
        fetchJuicerSpend(normalizedAddress),
      ]);
      const availableJp = Math.max(0, totalEarnedJp - spentJp);
      const jpSpent = !!juicerSpend;

      // Social verification state.
      const user = await prisma.user.findUnique({
        where: { address: normalizedAddress },
        include: { juicerCampaign: true },
      });
      const campaign = user?.juicerCampaign ?? null;
      const twitterVerified = !!campaign?.twitterVerifiedAt;
      const discordVerified = !!campaign?.discordVerifiedAt;

      // On-chain claim state (null = unknown -> render as not minted).
      const nftMinted =
        (await fetchNftMinted(log, normalizedAddress)) ?? false;

      const isEligibleForNFT =
        jpSpent &&
        memeTokenCreated &&
        twitterVerified &&
        discordVerified &&
        !nftMinted;

      res.status(200).json({
        walletAddress: normalizedAddress,
        chainId: JUICER_CAMPAIGN_CHAIN_ID,
        availableJp,
        totalEarnedJp,
        spentJp,
        cost: JUICER_JP_COST,
        jpSpent,
        memeTokenCreated,
        memeTokenCreatedAt: null,
        twitterVerified,
        twitterVerifiedAt: campaign?.twitterVerifiedAt?.toISOString() ?? null,
        discordVerified,
        discordVerifiedAt: campaign?.discordVerifiedAt?.toISOString() ?? null,
        isEligibleForNFT,
        nftMinted,
      });
    } catch (error: any) {
      log.error(
        { error: error.message, stack: error.stack },
        "Error in handleJuicerProgress",
      );
      res.status(500).json({ message: "Failed to load Juicer progress" });
    }
  };
}

/**
 * @swagger
 * /v1/campaigns/juicer/spend:
 *   post:
 *     tags: [Campaign]
 *     summary: Trade 5,000 JP for the right to claim the Juicer NFT
 *     description: >
 *       Atomic and idempotent. The (walletAddress, chainId, reason) unique
 *       constraint guarantees a retried POST returns the original spend record
 *       without deducting twice. Fails closed if the Ponder indexer cannot be
 *       reached (the earned balance can't be verified).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               walletAddress: { type: string }
 *               chainId: { type: integer }
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 spentJp: { type: number }
 *                 remainingJp: { type: number }
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createJuicerSpendHandler(logger: Logger) {
  return async function handleJuicerSpend(
    req: Request,
    res: Response,
  ): Promise<void> {
    const log = logger.child({ endpoint: "juicer-spend" });

    try {
      const walletAddress = req.body?.walletAddress as string;
      if (!walletAddress || !ADDRESS_RE.test(walletAddress)) {
        res.status(400).json({ message: "Invalid wallet address" });
        return;
      }
      const normalizedAddress = walletAddress.toLowerCase();

      // Idempotency fast path: spend already recorded.
      const existing = await fetchJuicerSpend(normalizedAddress);
      if (existing) {
        const spentJp = await fetchSpentJp(normalizedAddress);
        let remainingJp = 0;
        try {
          const breakdown = await fetchEarnedPoints(log, normalizedAddress);
          remainingJp = Math.max(0, breakdown.total - spentJp);
        } catch {
          // earned lookup is non-essential on the idempotent replay
        }
        res.status(200).json({ spentJp, remainingJp });
        return;
      }

      // Balance gate — MUST fail closed when the earn side is unreadable.
      let totalEarnedJp: number;
      try {
        const breakdown = await fetchEarnedPoints(log, normalizedAddress);
        totalEarnedJp = breakdown.total;
      } catch (error: any) {
        log.error(
          { error: error.message, walletAddress: normalizedAddress },
          "Ponder unavailable during spend — failing closed",
        );
        res
          .status(503)
          .json({ message: "Points service unavailable; please retry" });
        return;
      }

      const alreadySpent = await fetchSpentJp(normalizedAddress);
      const availableJp = totalEarnedJp - alreadySpent;
      if (availableJp < JUICER_JP_COST) {
        res.status(403).json({
          message: `Insufficient Juice Points: ${availableJp} available, ${JUICER_JP_COST} required`,
          availableJp,
          required: JUICER_JP_COST,
        });
        return;
      }

      // Record the spend. A concurrent duplicate insert loses on the unique
      // constraint (P2002) and is treated as the idempotent replay.
      try {
        await prisma.jpSpend.create({
          data: {
            walletAddress: normalizedAddress,
            chainId: JUICER_CAMPAIGN_CHAIN_ID,
            amount: JUICER_JP_COST,
            reason: JUICER_SPEND_REASON,
          },
        });
      } catch (error: any) {
        if (error?.code !== "P2002") {
          throw error;
        }
        log.info(
          { walletAddress: normalizedAddress },
          "Concurrent juicer spend deduped by unique constraint",
        );
      }

      const spentJp = await fetchSpentJp(normalizedAddress);
      const remainingJp = Math.max(0, totalEarnedJp - spentJp);

      log.info(
        { walletAddress: normalizedAddress, spentJp, remainingJp },
        "Juicer JP spend recorded",
      );
      res.status(200).json({ spentJp, remainingJp });
    } catch (error: any) {
      log.error(
        { error: error.message, stack: error.stack },
        "Error in handleJuicerSpend",
      );
      res.status(500).json({ message: "Failed to spend Juice Points" });
    }
  };
}

/**
 * @swagger
 * /v1/campaigns/juicer/twitter/mark-followed:
 *   post:
 *     tags: [Campaign]
 *     summary: Mark a wallet as following @JuiceSwap_com (honor system)
 *     description: >
 *       Sets `twitterVerifiedAt` on the Juicer campaign record. Honor-system,
 *       mirroring the First Squeezer mark-followed step.
 *     parameters:
 *       - in: query
 *         name: walletAddress
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 verifiedAt: { type: string, format: date-time }
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createJuicerTwitterMarkFollowedHandler(logger: Logger) {
  return async function handleJuicerTwitterMarkFollowed(
    req: Request,
    res: Response,
  ): Promise<void> {
    const log = logger.child({ endpoint: "juicer-twitter-mark-followed" });

    try {
      const walletAddress = req.query.walletAddress as string;
      if (!walletAddress || !ADDRESS_RE.test(walletAddress)) {
        res.status(400).json({ message: "Invalid wallet address" });
        return;
      }
      const normalizedAddress = walletAddress.toLowerCase();

      let user = await prisma.user.findUnique({
        where: { address: normalizedAddress },
      });
      if (!user) {
        user = await prisma.user.create({
          data: { address: normalizedAddress },
        });
      }

      const verifiedAt = new Date();
      await prisma.juicerCampaignUser.upsert({
        where: { userId: user.id },
        update: { twitterVerifiedAt: verifiedAt },
        create: { userId: user.id, twitterVerifiedAt: verifiedAt },
      });

      log.info(
        { walletAddress: normalizedAddress },
        "Juicer Twitter follow marked (honor system)",
      );
      res
        .status(200)
        .json({ success: true, verifiedAt: verifiedAt.toISOString() });
    } catch (error: any) {
      log.error(
        { error: error.message, stack: error.stack },
        "Error in handleJuicerTwitterMarkFollowed",
      );
      res.status(500).json({ message: "Failed to mark Twitter follow" });
    }
  };
}

/**
 * @swagger
 * /v1/campaigns/juicer/discord/start:
 *   get:
 *     tags: [Campaign]
 *     summary: Start Discord OAuth flow for the Juicer campaign
 *     parameters:
 *       - in: query
 *         name: walletAddress
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 authUrl: { type: string }
 *                 state: { type: string }
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createJuicerDiscordStartHandler(logger: Logger) {
  return async function handleJuicerDiscordStart(
    req: Request,
    res: Response,
  ): Promise<void> {
    const log = logger.child({ endpoint: "juicer-discord-start" });

    try {
      const walletAddress = req.query.walletAddress as string;
      if (!walletAddress || !ADDRESS_RE.test(walletAddress)) {
        res.status(400).json({ message: "Invalid wallet address" });
        return;
      }
      const normalizedAddress = walletAddress.toLowerCase();

      // The shared Discord app defaults to the First Squeezer callback; the
      // Juicer flow uses its own callback (threaded through the OAuth session
      // so the token exchange repeats the same redirect_uri) so the
      // verification lands on the Juicer campaign record.
      const discordService = getDiscordOAuthService();
      const { authUrl, state } = await discordService.generateAuthUrl(
        normalizedAddress,
        process.env.JUICER_DISCORD_CALLBACK_URL,
      );

      res.status(200).json({ authUrl, state });
    } catch (error: any) {
      log.error(
        { error: error.message, stack: error.stack },
        "Error in handleJuicerDiscordStart",
      );
      res.status(500).json({
        message: "Failed to generate OAuth URL",
        detail: error.message,
      });
    }
  };
}

/**
 * @swagger
 * /v1/campaigns/juicer/discord/callback:
 *   get:
 *     tags: [Campaign]
 *     summary: Discord OAuth callback for the Juicer campaign (redirects to frontend)
 *     parameters:
 *       - in: query
 *         name: code
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: state
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       302:
 *         description: Redirects to frontend
 */
export function createJuicerDiscordCallbackHandler(logger: Logger) {
  return async function handleJuicerDiscordCallback(
    req: Request,
    res: Response,
  ): Promise<void> {
    const log = logger.child({ endpoint: "juicer-discord-callback" });
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3001";

    try {
      const code = req.query.code as string;
      const state = req.query.state as string;

      if (!code || !state) {
        log.warn("Missing code or state parameter");
        res.redirect(
          `${frontendUrl}/oauth-callback?discord=error&message=missing_params`,
        );
        return;
      }

      const discordService = getDiscordOAuthService();
      const { walletAddress, discordUser, hasJuicerRole } =
        await discordService.completeOAuthFlow(code, state);

      if (
        !discordUser.id ||
        typeof discordUser.id !== "string" ||
        discordUser.id.trim() === ""
      ) {
        log.error(
          { walletAddress, discordUser },
          "Discord OAuth returned user without valid ID",
        );
        res.redirect(
          `${frontendUrl}/oauth-callback?discord=error&message=${encodeURIComponent("Invalid Discord response - missing user ID")}`,
        );
        return;
      }

      if (!hasJuicerRole) {
        log.warn(
          { walletAddress, discordUsername: discordUser.username },
          "User does not have the Juicer role in JuiceSwap Discord",
        );
        res.redirect(
          `${frontendUrl}/oauth-callback?discord=error&message=${encodeURIComponent("Your Discord account must have the Juicer role in the JuiceSwap server")}`,
        );
        return;
      }

      let user = await prisma.user.findUnique({
        where: { address: walletAddress },
      });
      if (!user) {
        user = await prisma.user.create({ data: { address: walletAddress } });
      }

      // One Discord account, one wallet — same anti-sybil rule as First
      // Squeezer, scoped to the Juicer campaign table.
      const existingDiscordLink = await prisma.juicerCampaignUser.findFirst({
        where: {
          discordUserId: discordUser.id,
          userId: { not: user.id },
        },
      });
      if (existingDiscordLink) {
        log.warn(
          {
            walletAddress,
            discordUserId: discordUser.id,
            existingUserId: existingDiscordLink.userId,
          },
          "Discord account already linked to different wallet (juicer)",
        );
        res.redirect(
          `${frontendUrl}/oauth-callback?discord=error&message=${encodeURIComponent("This Discord account is already linked to another wallet")}`,
        );
        return;
      }

      const username =
        discordUser.discriminator && discordUser.discriminator !== "0"
          ? `${discordUser.username}#${discordUser.discriminator}`
          : discordUser.username;

      await prisma.juicerCampaignUser.upsert({
        where: { userId: user.id },
        update: {
          discordVerifiedAt: new Date(),
          discordUserId: discordUser.id,
          discordUsername: username,
        },
        create: {
          userId: user.id,
          discordVerifiedAt: new Date(),
          discordUserId: discordUser.id,
          discordUsername: username,
        },
      });

      log.info(
        { walletAddress, discordUsername: username },
        "Juicer Discord account linked successfully",
      );
      res.redirect(
        `${frontendUrl}/oauth-callback?discord=success&username=${encodeURIComponent(username)}`,
      );
    } catch (error: any) {
      log.error(
        { error: error.message, stack: error.stack },
        "Error in handleJuicerDiscordCallback",
      );
      res.redirect(
        `${frontendUrl}/oauth-callback?discord=error&message=${encodeURIComponent(error.message || "unknown_error")}`,
      );
    }
  };
}

/**
 * @swagger
 * /v1/campaigns/juicer/nft/signature:
 *   get:
 *     tags: [Campaign]
 *     summary: Get the Juicer NFT claim signature
 *     description: |
 *       Issues the signature for JuicerNFT.claim(). Every gate fails CLOSED:
 *       the JP spend must be on the ledger, the meme token must exist on the
 *       campaign chain (verified against Ponder), Twitter and Discord must be
 *       verified, and the wallet must not have claimed yet.
 *     parameters:
 *       - in: query
 *         name: walletAddress
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 signature: { type: string }
 *                 contractAddress: { type: string }
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createJuicerNftSignatureHandler(logger: Logger) {
  return async function handleJuicerNftSignature(
    req: Request,
    res: Response,
  ): Promise<void> {
    const log = logger.child({ endpoint: "juicer-nft-signature" });

    try {
      const walletAddress = req.query.walletAddress as string;
      if (!walletAddress || !ADDRESS_RE.test(walletAddress)) {
        res.status(400).json({ message: "Invalid wallet address" });
        return;
      }
      const normalizedAddress = walletAddress.toLowerCase();

      const signerPrivateKey =
        process.env.JUICER_SIGNER_PRIVATE_KEY ||
        process.env.CAMPAIGN_SIGNER_PRIVATE_KEY;
      if (!signerPrivateKey) {
        log.error("JUICER_SIGNER_PRIVATE_KEY not configured");
        res.status(500).json({ message: "NFT claiming not configured" });
        return;
      }

      const contractAddress = getJuicerNftContract(JUICER_CAMPAIGN_CHAIN_ID);
      if (!contractAddress) {
        log.error("JUICER_NFT_CONTRACT_MAINNET not configured");
        res.status(500).json({ message: "NFT claiming not configured" });
        return;
      }

      // Gate 1: the 5,000 JP spend must be on the ledger.
      const spend = await fetchJuicerSpend(normalizedAddress);
      if (!spend) {
        res.status(403).json({
          message: `Trade ${JUICER_JP_COST} JP first`,
          jpSpent: false,
        });
        return;
      }

      // Gate 2: social verifications.
      const user = await prisma.user.findUnique({
        where: { address: normalizedAddress },
        include: { juicerCampaign: true },
      });
      const campaign = user?.juicerCampaign ?? null;
      const twitterVerified = !!campaign?.twitterVerifiedAt;
      const discordVerified = !!campaign?.discordVerifiedAt;
      if (!twitterVerified || !discordVerified) {
        res.status(403).json({
          message: "Complete all verification steps first",
          twitterVerified,
          discordVerified,
        });
        return;
      }

      // Gate 3: meme token created on the campaign chain. Verified against
      // Ponder; fail closed when the indexer is unreachable.
      try {
        const breakdown = await fetchEarnedPoints(log, normalizedAddress);
        if (!breakdown.bonuses?.memeTokenCreated) {
          res.status(403).json({
            message: "Create a meme token on Citrea Mainnet first",
            memeTokenCreated: false,
          });
          return;
        }
      } catch (error: any) {
        log.error(
          { error: error.message, context: "meme-token gate" },
          "Failed to verify meme token — failing closed",
        );
        res
          .status(503)
          .json({ message: "Could not verify eligibility; please retry" });
        return;
      }

      // Gate 4: not already claimed. Best-effort — the contract's hasClaimed
      // mapping is the authoritative double-claim guard.
      const alreadyClaimed = await fetchNftMinted(log, normalizedAddress);
      if (alreadyClaimed === true) {
        res
          .status(403)
          .json({ message: "NFT already claimed", alreadyClaimed: true });
        return;
      }

      // Signature matches JuicerNFT.sol:
      //   keccak256(abi.encodePacked(address(this), block.chainid, msg.sender))
      const signature = await buildJuicerClaimSignature(
        signerPrivateKey,
        contractAddress,
        JUICER_CAMPAIGN_CHAIN_ID,
        normalizedAddress,
      );

      log.info(
        {
          walletAddress: normalizedAddress,
          contractAddress,
          signerAddress: new ethers.Wallet(signerPrivateKey).address,
        },
        "Juicer NFT claim signature generated",
      );
      res.status(200).json({ signature, contractAddress });
    } catch (error: any) {
      log.error(
        { error: error.message, stack: error.stack },
        "Error in handleJuicerNftSignature",
      );
      res.status(500).json({ message: "Failed to generate signature" });
    }
  };
}
