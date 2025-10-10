import { Request, Response } from 'express';
import Logger from 'bunyan';
import { getTwitterOAuthService } from '../services/TwitterOAuthService';
import { prisma } from '../db/prisma';

/**
 * First Squeezer Campaign - Twitter OAuth Endpoints
 */

/**
 * @swagger
 * /v1/campaigns/first-squeezer/twitter/start:
 *   get:
 *     tags: [Campaign]
 *     summary: Start Twitter OAuth flow
 *     parameters:
 *       - in: query
 *         name: walletAddress
 *         required: true
 *         schema:
 *           type: string
 *         example: "0x2F0cC51C02E5D4EC68bC155728798969D5c0F714"
 *         description: User's wallet address
 *     responses:
 *       200:
 *         description: OAuth URL generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 authUrl:
 *                   type: string
 *                   description: Twitter OAuth authorization URL
 *                 state:
 *                   type: string
 *                   description: State token for CSRF protection
 *       400:
 *         description: Missing or invalid wallet address
 *       500:
 *         description: Internal server error
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
      const twitterService = getTwitterOAuthService();

      // Generate authorization URL (now async with database storage)
      const { authUrl, state } = await twitterService.generateAuthUrl(normalizedAddress);

      log.debug({ walletAddress: normalizedAddress, state }, 'OAuth URL generated');

      res.status(200).json({
        authUrl,
        state,
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
 *     summary: Twitter OAuth callback handler
 *     parameters:
 *       - in: query
 *         name: code
 *         required: true
 *         schema:
 *           type: string
 *         description: OAuth authorization code
 *       - in: query
 *         name: state
 *         required: true
 *         schema:
 *           type: string
 *         description: State token for CSRF protection
 *     responses:
 *       302:
 *         description: Redirects to frontend with success/error
 */
export function createTwitterCallbackHandler(logger: Logger) {
  return async function handleTwitterCallback(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'twitter-callback' });

    try {
      const code = req.query.code as string;
      const state = req.query.state as string;

      // Validate parameters
      if (!code || !state) {
        log.warn('Missing code or state parameter');
        res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/oauth-callback?twitter=error&message=missing_params`);
        return;
      }

      log.debug({ state }, 'Processing Twitter OAuth callback');

      // Get Twitter OAuth service
      const twitterService = getTwitterOAuthService();

      // Complete OAuth flow
      log.debug({ state }, 'Starting OAuth flow completion');
      const { walletAddress, twitterUser } = await twitterService.completeOAuthFlow(code, state);
      log.debug({ walletAddress, username: twitterUser.username }, 'OAuth flow completed successfully');

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
        `${process.env.FRONTEND_URL || 'http://localhost:3000'}/oauth-callback?twitter=success&username=${encodeURIComponent(twitterUser.username)}`
      );
    } catch (error: any) {
      log.error({
        error: error.message,
        stack: error.stack,
        fullError: error
      }, 'Error in handleTwitterCallback');

      // Redirect to OAuth callback page (popup window)
      res.redirect(
        `${process.env.FRONTEND_URL || 'http://localhost:3000'}/oauth-callback?twitter=error&message=${encodeURIComponent(error.message || 'unknown_error')}`
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
 *         description: User's wallet address
 *     responses:
 *       200:
 *         description: Status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 verified:
 *                   type: boolean
 *                   description: Whether Twitter is verified
 *                 username:
 *                   type: string
 *                   description: Twitter username (if verified)
 *                 verifiedAt:
 *                   type: string
 *                   format: date-time
 *                   description: Verification timestamp (if verified)
 *       400:
 *         description: Missing or invalid wallet address
 *       500:
 *         description: Internal server error
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
