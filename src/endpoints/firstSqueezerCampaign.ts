import { Request, Response } from 'express';
import Logger from 'bunyan';
import { ethers } from 'ethers';
import { ChainId } from '@juiceswapxyz/sdk-core';
import { getTwitterOAuthService } from '../services/TwitterOAuthService';
import { getDiscordOAuthService } from '../services/DiscordOAuthService';
import { getPonderClient } from '../services/PonderClient';
import { prisma } from '../db/prisma';
import { FIRST_SQUEEZER_NFT_CONTRACT } from '../lib/constants/campaigns';

/**
 * First Squeezer Campaign - Social OAuth Endpoints (Twitter & Discord)
 */

/**
 * @swagger
 * /v1/campaigns/first-squeezer/twitter/start:
 *   get:
 *     tags: [Campaign]
 *     summary: Start Twitter OAuth flow (OAuth 1.0a)
 *     parameters:
 *       - in: query
 *         name: walletAddress
 *         required: true
 *         schema:
 *           type: string
 *         example: "0x2F0cC51C02E5D4EC68bC155728798969D5c0F714"
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 authUrl:
 *                   type: string
 *                 requestToken:
 *                   type: string
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createTwitterStartHandler(logger: Logger) {
  return async function handleTwitterStart(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'twitter-start' });

    try {
      const walletAddress = req.query.walletAddress as string;

      // Validate wallet address
      if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
        log.debug({ walletAddress }, 'Validation failed: invalid wallet address');
        res.status(400).json({ message: 'Invalid wallet address' });
        return;
      }

      // Normalize address to lowercase
      const normalizedAddress = walletAddress.toLowerCase();

      log.debug({ walletAddress: normalizedAddress }, 'Generating Twitter OAuth URL');

      // Get Twitter OAuth service
      const twitterService = getTwitterOAuthService(logger);

      // Generate authorization URL (OAuth 1.0a)
      const { authUrl, requestToken } = await twitterService.generateAuthUrl(normalizedAddress);

      log.debug({ walletAddress: normalizedAddress, requestToken }, 'OAuth URL generated');

      res.status(200).json({
        authUrl,
        requestToken,
      });
    } catch (error: any) {
      log.error({ error: error.message, stack: error.stack }, 'Error in handleTwitterStart');
      res.status(500).json({ message: 'Failed to generate OAuth URL', detail: error.message });
    }
  };
}

/**
 * @swagger
 * /v1/campaigns/first-squeezer/twitter/callback:
 *   get:
 *     tags: [Campaign]
 *     summary: Twitter OAuth callback (OAuth 1.0a - redirects to frontend)
 *     parameters:
 *       - in: query
 *         name: oauth_token
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: oauth_verifier
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       302:
 *         description: Redirects to frontend
 */
export function createTwitterCallbackHandler(logger: Logger) {
  return async function handleTwitterCallback(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'twitter-callback' });

    try {
      const oauthToken = req.query.oauth_token as string;
      const oauthVerifier = req.query.oauth_verifier as string;

      // Validate parameters
      if (!oauthToken || !oauthVerifier) {
        log.warn('Missing oauth_token or oauth_verifier parameter');
        res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3001'}/oauth-callback?twitter=error&message=missing_params`);
        return;
      }

      log.debug({ oauthToken }, 'Processing Twitter OAuth callback');

      // Get Twitter OAuth service
      const twitterService = getTwitterOAuthService(logger);

      // Complete OAuth flow (OAuth 1.0a)
      log.debug({ oauthToken }, 'Starting OAuth flow completion');
      const { walletAddress, twitterUser, isFollowingJuiceSwap } = await twitterService.completeOAuthFlow(oauthToken, oauthVerifier);
      log.debug({ walletAddress, username: twitterUser.username, isFollowingJuiceSwap }, 'OAuth flow completed successfully');

      // Check if user follows JuiceSwap
      if (!isFollowingJuiceSwap) {
        const juiceSwapUsername = process.env.JUICESWAP_TWITTER_USERNAME || 'JuiceSwap';
        log.warn({ walletAddress, twitterUsername: twitterUser.username }, 'User does not follow JuiceSwap on Twitter');
        res.redirect(
          `${process.env.FRONTEND_URL || 'http://localhost:3001'}/oauth-callback?twitter=error&message=${encodeURIComponent(`You must follow @${juiceSwapUsername} on Twitter to qualify`)}`
        );
        return;
      }

      log.info(
        {
          walletAddress,
          twitterUserId: twitterUser.id,
          twitterUsername: twitterUser.username,
        },
        'Twitter OAuth completed successfully'
      );

      // Find or create user
      let user = await prisma.user.findUnique({
        where: { address: walletAddress },
      });

      if (!user) {
        user = await prisma.user.create({
          data: { address: walletAddress },
        });
      }

      // Update or create OG campaign user record
      await prisma.ogCampaignUser.upsert({
        where: { userId: user.id },
        update: {
          twitterVerifiedAt: new Date(),
          twitterUserId: twitterUser.id,
          twitterUsername: twitterUser.username,
        },
        create: {
          userId: user.id,
          twitterVerifiedAt: new Date(),
          twitterUserId: twitterUser.id,
          twitterUsername: twitterUser.username,
        },
      });

      log.info(
        {
          walletAddress,
          twitterUsername: twitterUser.username,
        },
        'Twitter account linked successfully'
      );

      // Redirect to OAuth callback page (popup window)
      res.redirect(
        `${process.env.FRONTEND_URL || 'http://localhost:3001'}/oauth-callback?twitter=success&username=${encodeURIComponent(twitterUser.username)}`
      );
    } catch (error: any) {
      log.error({
        error: error.message,
        stack: error.stack,
        fullError: error
      }, 'Error in handleTwitterCallback');

      // Redirect to OAuth callback page (popup window)
      res.redirect(
        `${process.env.FRONTEND_URL || 'http://localhost:3001'}/oauth-callback?twitter=error&message=${encodeURIComponent(error.message || 'unknown_error')}`
      );
    }
  };
}

/**
 * @swagger
 * /v1/campaigns/first-squeezer/twitter/status:
 *   get:
 *     tags: [Campaign]
 *     summary: Check Twitter verification status
 *     parameters:
 *       - in: query
 *         name: walletAddress
 *         required: true
 *         schema:
 *           type: string
 *         example: "0x2F0cC51C02E5D4EC68bC155728798969D5c0F714"
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 verified:
 *                   type: boolean
 *                 username:
 *                   type: string
 *                 verifiedAt:
 *                   type: string
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createTwitterStatusHandler(logger: Logger) {
  return async function handleTwitterStatus(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'twitter-status' });

    try {
      const walletAddress = req.query.walletAddress as string;

      // Validate wallet address
      if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
        log.debug({ walletAddress }, 'Validation failed: invalid wallet address');
        res.status(400).json({ message: 'Invalid wallet address' });
        return;
      }

      // Normalize address to lowercase
      const normalizedAddress = walletAddress.toLowerCase();

      log.debug({ walletAddress: normalizedAddress }, 'Checking Twitter verification status');

      // Find user
      const user = await prisma.user.findUnique({
        where: { address: normalizedAddress },
        include: { ogCampaign: true },
      });

      if (!user || !user.ogCampaign) {
        res.status(200).json({
          verified: false,
          username: null,
          verifiedAt: null,
        });
        return;
      }

      const campaign = user.ogCampaign;

      res.status(200).json({
        verified: !!campaign.twitterVerifiedAt,
        username: campaign.twitterUsername,
        verifiedAt: campaign.twitterVerifiedAt?.toISOString() || null,
      });
    } catch (error: any) {
      log.error({ error }, 'Error in handleTwitterStatus');
      res.status(500).json({ message: 'Failed to check status' });
    }
  };
}

/**
 * Discord OAuth Endpoints
 */

/**
 * @swagger
 * /v1/campaigns/first-squeezer/discord/start:
 *   get:
 *     tags: [Campaign]
 *     summary: Start Discord OAuth flow
 *     parameters:
 *       - in: query
 *         name: walletAddress
 *         required: true
 *         schema:
 *           type: string
 *         example: "0x2F0cC51C02E5D4EC68bC155728798969D5c0F714"
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 authUrl:
 *                   type: string
 *                 state:
 *                   type: string
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createDiscordStartHandler(logger: Logger) {
  return async function handleDiscordStart(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'discord-start' });

    try {
      const walletAddress = req.query.walletAddress as string;

      // Validate wallet address
      if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
        log.debug({ walletAddress }, 'Validation failed: invalid wallet address');
        res.status(400).json({ message: 'Invalid wallet address' });
        return;
      }

      // Normalize address to lowercase
      const normalizedAddress = walletAddress.toLowerCase();

      log.debug({ walletAddress: normalizedAddress }, 'Generating Discord OAuth URL');

      // Get Discord OAuth service
      const discordService = getDiscordOAuthService();

      // Generate authorization URL (async with database storage)
      const { authUrl, state } = await discordService.generateAuthUrl(normalizedAddress);

      log.debug({ walletAddress: normalizedAddress, state }, 'Discord OAuth URL generated');

      res.status(200).json({
        authUrl,
        state,
      });
    } catch (error: any) {
      log.error({ error: error.message, stack: error.stack }, 'Error in handleDiscordStart');
      res.status(500).json({ message: 'Failed to generate OAuth URL', detail: error.message });
    }
  };
}

/**
 * @swagger
 * /v1/campaigns/first-squeezer/discord/callback:
 *   get:
 *     tags: [Campaign]
 *     summary: Discord OAuth callback (redirects to frontend)
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
export function createDiscordCallbackHandler(logger: Logger) {
  return async function handleDiscordCallback(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'discord-callback' });

    try {
      const code = req.query.code as string;
      const state = req.query.state as string;

      // Validate parameters
      if (!code || !state) {
        log.warn('Missing code or state parameter');
        res.redirect(
          `${process.env.FRONTEND_URL || 'http://localhost:3001'}/oauth-callback?discord=error&message=missing_params`
        );
        return;
      }

      log.debug({ state }, 'Processing Discord OAuth callback');

      // Get Discord OAuth service
      const discordService = getDiscordOAuthService();

      // Complete OAuth flow (includes guild membership check)
      log.debug({ state }, 'Starting Discord OAuth flow completion');
      const { walletAddress, discordUser, isInGuild } = await discordService.completeOAuthFlow(code, state);
      log.debug(
        { walletAddress, username: discordUser.username, isInGuild },
        'Discord OAuth flow completed successfully'
      );

      // Check if user is in the JuiceSwap Discord guild
      if (!isInGuild) {
        log.warn({ walletAddress, discordUsername: discordUser.username }, 'User is not in JuiceSwap Discord guild');
        res.redirect(
          `${process.env.FRONTEND_URL || 'http://localhost:3001'}/oauth-callback?discord=error&message=${encodeURIComponent('You must join the JuiceSwap Discord server first')}`
        );
        return;
      }

      log.info(
        {
          walletAddress,
          discordUserId: discordUser.id,
          discordUsername: discordUser.username,
        },
        'Discord OAuth completed successfully'
      );

      // Find or create user
      let user = await prisma.user.findUnique({
        where: { address: walletAddress },
      });

      if (!user) {
        user = await prisma.user.create({
          data: { address: walletAddress },
        });
      }

      // Format Discord username (handle discriminator)
      const username =
        discordUser.discriminator && discordUser.discriminator !== '0'
          ? `${discordUser.username}#${discordUser.discriminator}`
          : discordUser.username;

      // Update or create OG campaign user record
      await prisma.ogCampaignUser.upsert({
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
        {
          walletAddress,
          discordUsername: username,
        },
        'Discord account linked successfully'
      );

      // Redirect to OAuth callback page
      res.redirect(
        `${process.env.FRONTEND_URL || 'http://localhost:3001'}/oauth-callback?discord=success&username=${encodeURIComponent(username)}`
      );
    } catch (error: any) {
      log.error(
        {
          error: error.message,
          stack: error.stack,
          fullError: error,
        },
        'Error in handleDiscordCallback'
      );

      // Redirect to OAuth callback page
      res.redirect(
        `${process.env.FRONTEND_URL || 'http://localhost:3001'}/oauth-callback?discord=error&message=${encodeURIComponent(error.message || 'unknown_error')}`
      );
    }
  };
}

/**
 * @swagger
 * /v1/campaigns/first-squeezer/discord/status:
 *   get:
 *     tags: [Campaign]
 *     summary: Check Discord verification status
 *     parameters:
 *       - in: query
 *         name: walletAddress
 *         required: true
 *         schema:
 *           type: string
 *         example: "0x2F0cC51C02E5D4EC68bC155728798969D5c0F714"
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 verified:
 *                   type: boolean
 *                 username:
 *                   type: string
 *                 verifiedAt:
 *                   type: string
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createDiscordStatusHandler(logger: Logger) {
  return async function handleDiscordStatus(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'discord-status' });

    try {
      const walletAddress = req.query.walletAddress as string;

      // Validate wallet address
      if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
        log.debug({ walletAddress }, 'Validation failed: invalid wallet address');
        res.status(400).json({ message: 'Invalid wallet address' });
        return;
      }

      // Normalize address to lowercase
      const normalizedAddress = walletAddress.toLowerCase();

      log.debug({ walletAddress: normalizedAddress }, 'Checking Discord verification status');

      // Find user
      const user = await prisma.user.findUnique({
        where: { address: normalizedAddress },
        include: { ogCampaign: true },
      });

      if (!user || !user.ogCampaign) {
        res.status(200).json({
          verified: false,
          username: null,
          verifiedAt: null,
        });
        return;
      }

      const campaign = user.ogCampaign;

      res.status(200).json({
        verified: !!campaign.discordVerifiedAt,
        username: campaign.discordUsername,
        verifiedAt: campaign.discordVerifiedAt?.toISOString() || null,
      });
    } catch (error: any) {
      log.error({ error }, 'Error in handleDiscordStatus');
      res.status(500).json({ message: 'Failed to check status' });
    }
  };
}

/**
 * bApps Campaign Verification Endpoint
 */

/**
 * @swagger
 * /v1/campaigns/first-squeezer/bapps/status:
 *   get:
 *     tags: [Campaign]
 *     summary: Get bApps campaign progress (proxies Ponder)
 *     parameters:
 *       - in: query
 *         name: walletAddress
 *         required: true
 *         schema:
 *           type: string
 *         example: "0x2F0cC51C02E5D4EC68bC155728798969D5c0F714"
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 walletAddress:
 *                   type: string
 *                 chainId:
 *                   type: integer
 *                 tasks:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       name:
 *                         type: string
 *                       description:
 *                         type: string
 *                       completed:
 *                         type: boolean
 *                       completedAt:
 *                         type: string
 *                       txHash:
 *                         type: string
 *                 totalTasks:
 *                   type: integer
 *                 completedTasks:
 *                   type: integer
 *                 progress:
 *                   type: number
 *                 nftClaimed:
 *                   type: boolean
 *                 claimTxHash:
 *                   type: string
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createBAppsStatusHandler(logger: Logger) {
  return async function handleBAppsStatus(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'bapps-status' });

    try {
      const walletAddress = req.query.walletAddress as string;

      // Validate wallet address
      if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
        log.debug({ walletAddress }, 'Validation failed: invalid wallet address');
        res.status(400).json({ message: 'Invalid wallet address' });
        return;
      }

      // Normalize address to lowercase
      const normalizedAddress = walletAddress.toLowerCase();

      log.debug({ walletAddress: normalizedAddress }, 'Proxying request to Ponder API');

      // Query Ponder API (pure proxy - no transformation)
      try {
        const ponderClient = getPonderClient(log);
        const response = await ponderClient.post('/campaign/progress', {
          walletAddress: normalizedAddress,
          chainId: ChainId.CITREA_TESTNET,
        });

        log.debug(
          { walletAddress: normalizedAddress, completedTasks: response.data?.completedTasks },
          'Ponder API response received'
        );

        // Forward Ponder's response directly (pure proxy)
        res.status(200).json(response.data);
      } catch (error: any) {
        log.error({ error: error.message, context: 'bApps status query' }, 'Failed to query Ponder API');
        res.status(500).json({ message: 'Failed to check bApps status' });
      }
    } catch (error: any) {
      log.error({ error }, 'Error in handleBAppsStatus');
      res.status(500).json({ message: 'Failed to check bApps status' });
    }
  };
}

/**
 * NFT Signature Endpoint
 */

/**
 * @swagger
 * /v1/campaigns/first-squeezer/nft/signature:
 *   get:
 *     tags: [Campaign]
 *     summary: Get NFT claim signature
 *     description: Requires Twitter, Discord, and 3 swaps completed
 *     parameters:
 *       - in: query
 *         name: walletAddress
 *         required: true
 *         schema:
 *           type: string
 *         example: "0x2F0cC51C02E5D4EC68bC155728798969D5c0F714"
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 signature:
 *                   type: string
 *                 contractAddress:
 *                   type: string
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createNFTSignatureHandler(logger: Logger) {
  return async function handleNFTSignature(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'nft-signature' });

    try {
      const walletAddress = req.query.walletAddress as string;

      // Validate wallet address
      if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
        log.debug({ walletAddress }, 'Validation failed: invalid wallet address');
        res.status(400).json({ message: 'Invalid wallet address' });
        return;
      }

      // Normalize address to lowercase
      const normalizedAddress = walletAddress.toLowerCase();

      log.debug({ walletAddress: normalizedAddress }, 'Generating NFT claim signature');

      // Validate environment variables
      const signerPrivateKey = process.env.CAMPAIGN_SIGNER_PRIVATE_KEY;

      if (!signerPrivateKey) {
        log.error('CAMPAIGN_SIGNER_PRIVATE_KEY not configured');
        res.status(500).json({ message: 'NFT claiming not configured' });
        return;
      }

      // Use hardcoded contract address (public, immutable blockchain data)
      const contractAddress = FIRST_SQUEEZER_NFT_CONTRACT;

      // Find user with campaign data
      const user = await prisma.user.findUnique({
        where: { address: normalizedAddress },
        include: { ogCampaign: true },
      });

      if (!user) {
        log.debug({ walletAddress: normalizedAddress }, 'User not found');
        res.status(404).json({ message: 'User not found' });
        return;
      }

      if (!user.ogCampaign) {
        log.debug({ walletAddress: normalizedAddress }, 'User has not started campaign');
        res.status(403).json({ message: 'Complete all verification steps first' });
        return;
      }

      // Check Twitter and Discord verification
      const campaign = user.ogCampaign;
      const twitterVerified = !!campaign.twitterVerifiedAt;
      const discordVerified = !!campaign.discordVerifiedAt;

      // Check bApps completion (3 swaps) via Ponder API
      let bappsCompleted = false;

      try {
        const ponderClient = getPonderClient(log);
        const response = await ponderClient.post('/campaign/progress', {
          walletAddress: normalizedAddress,
          chainId: ChainId.CITREA_TESTNET,
        });

        const completedTasks = response.data?.completedTasks || 0;
        bappsCompleted = completedTasks === 3;

        log.debug({ walletAddress: normalizedAddress, completedTasks, bappsCompleted }, 'Ponder API verification');
      } catch (error: any) {
        log.error({ error: error.message, context: 'NFT signature - bApps verification' }, 'Failed to verify bApps completion via Ponder');
        res.status(500).json({ message: 'Failed to verify campaign completion' });
        return;
      }

      // Verify ALL steps completed
      if (!twitterVerified || !discordVerified || !bappsCompleted) {
        log.debug(
          { walletAddress: normalizedAddress, twitterVerified, discordVerified, bappsCompleted },
          'User has not completed all verifications'
        );
        res.status(403).json({
          message: 'Complete all verification steps first',
          twitterVerified,
          discordVerified,
          bappsCompleted,
        });
        return;
      }

      // Check if NFT already claimed (query contract)
      try {
        if (!process.env.CITREA_RPC_URL) {
          throw new Error('CITREA_RPC_URL environment variable is required');
        }
        const provider = new ethers.providers.JsonRpcProvider(process.env.CITREA_RPC_URL);
        const nftContract = new ethers.Contract(
          contractAddress,
          ['function hasClaimed(address) view returns (bool)'],
          provider
        );

        const alreadyClaimed = await nftContract.hasClaimed(normalizedAddress);

        if (alreadyClaimed) {
          log.debug({ walletAddress: normalizedAddress }, 'NFT already claimed');
          res.status(403).json({
            message: 'NFT already claimed',
            alreadyClaimed: true,
          });
          return;
        }

        log.debug({ walletAddress: normalizedAddress, alreadyClaimed }, 'NFT claim status checked');
      } catch (error: any) {
        log.warn({ error: error.message, context: 'NFT claim status check' }, 'Failed to check NFT claim status, continuing with signature generation');
        // Continue even if check fails - contract will reject if already claimed
      }

      // Generate signature (matches contract verification)
      // keccak256(abi.encodePacked(address(this), block.chainid, msg.sender))
      const signer = new ethers.Wallet(signerPrivateKey);
      const messageHash = ethers.utils.solidityKeccak256(
        ['address', 'uint256', 'address'],
        [contractAddress, ChainId.CITREA_TESTNET, normalizedAddress]
      );
      const signature = await signer.signMessage(ethers.utils.arrayify(messageHash));

      log.info(
        {
          walletAddress: normalizedAddress,
          contractAddress,
          signerAddress: signer.address,
        },
        'NFT claim signature generated'
      );

      res.status(200).json({
        signature,
        contractAddress,
      });
    } catch (error: any) {
      log.error({ error: error.message, stack: error.stack }, 'Error in handleNFTSignature');
      res.status(500).json({ message: 'Failed to generate signature' });
    }
  };
}
