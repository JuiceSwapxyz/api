import { Request, Response } from 'express';
import Logger from 'bunyan';
import { FirstSqueezerCampaignService } from '../services/firstSqueezerCampaign';
import { TwitterOAuthService } from '../services/twitterOAuth';

/**
 * GET /v1/campaign/first-squeezer/progress
 * Get campaign progress for a wallet
 * Query params: address, chainId
 */
export function createGetProgressHandler(logger: Logger) {
  const campaignService = new FirstSqueezerCampaignService(logger);

  return async (req: Request, res: Response) => {
    try {
      const { address, chainId } = req.query;

      if (!address || typeof address !== 'string') {
        return res.status(400).json({
          error: 'Bad Request',
          detail: 'address query parameter is required',
        });
      }

      const chain = chainId ? parseInt(chainId as string) : 5115; // Default to Citrea Testnet

      const progress = await campaignService.getProgress(address, chain);

      res.json(progress);
    } catch (error) {
      logger.error({ error }, 'Failed to get campaign progress');
      res.status(500).json({
        error: 'Internal Server Error',
        detail: 'Failed to fetch campaign progress',
      });
    }
  };
}

/**
 * GET /v1/campaign/first-squeezer/twitter/auth
 * Generate Twitter OAuth URL
 * Query params: address
 */
export function createTwitterAuthHandler(logger: Logger) {
  const twitterService = new TwitterOAuthService(logger);

  return async (req: Request, res: Response) => {
    try {
      const { address } = req.query;

      if (!address || typeof address !== 'string') {
        return res.status(400).json({
          error: 'Bad Request',
          detail: 'address query parameter is required',
        });
      }

      const { url, state } = twitterService.generateAuthUrl(address);

      res.json({ url, state });
    } catch (error) {
      logger.error({ error }, 'Failed to generate Twitter auth URL');
      res.status(500).json({
        error: 'Internal Server Error',
        detail: 'Failed to generate Twitter authorization URL',
      });
    }
  };
}

/**
 * GET /v1/campaign/first-squeezer/twitter/callback
 * Twitter OAuth callback handler
 * Query params: code, state, address
 */
export function createTwitterCallbackHandler(logger: Logger) {
  const twitterService = new TwitterOAuthService(logger);
  const campaignService = new FirstSqueezerCampaignService(logger);

  return async (req: Request, res: Response) => {
    try {
      const { code, state, address } = req.query;

      if (
        !code ||
        typeof code !== 'string' ||
        !state ||
        typeof state !== 'string' ||
        !address ||
        typeof address !== 'string'
      ) {
        return res.status(400).json({
          error: 'Bad Request',
          detail: 'code, state, and address query parameters are required',
        });
      }

      // Verify state
      if (!twitterService.verifyState(address, state)) {
        return res.status(400).json({
          error: 'Bad Request',
          detail: 'Invalid state parameter',
        });
      }

      // Complete OAuth flow
      const { user, followsJuiceSwap } = await twitterService.completeOAuthFlow(
        code,
        address
      );

      if (!followsJuiceSwap) {
        return res.status(400).json({
          error: 'Verification Failed',
          detail: 'You must follow @JuiceSwap_com to complete this task',
          user: {
            id: user.id,
            username: user.username,
          },
        });
      }

      // Mark Twitter follow as verified
      await campaignService.verifyTwitterFollow(
        address,
        user.id,
        user.username
      );

      res.json({
        success: true,
        verified: true,
        user: {
          id: user.id,
          username: user.username,
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to handle Twitter callback');
      res.status(500).json({
        error: 'Internal Server Error',
        detail: 'Failed to verify Twitter account',
      });
    }
  };
}

/**
 * POST /v1/campaign/first-squeezer/verify/twitter
 * Alternative: Simple verification endpoint (if user already completed OAuth)
 * Body: { address, code, state }
 */
export function createVerifyTwitterHandler(logger: Logger) {
  const twitterService = new TwitterOAuthService(logger);
  const campaignService = new FirstSqueezerCampaignService(logger);

  return async (req: Request, res: Response) => {
    try {
      const { address, code, state } = req.body;

      if (!address || !code || !state) {
        return res.status(400).json({
          error: 'Bad Request',
          detail: 'address, code, and state are required',
        });
      }

      // Verify state
      if (!twitterService.verifyState(address, state)) {
        return res.status(400).json({
          error: 'Bad Request',
          detail: 'Invalid state parameter',
        });
      }

      // Complete OAuth flow
      const { user, followsJuiceSwap } = await twitterService.completeOAuthFlow(
        code,
        address
      );

      if (!followsJuiceSwap) {
        return res.json({
          success: false,
          verified: false,
          error: 'You must follow @JuiceSwap_com to complete this task',
          user: {
            id: user.id,
            username: user.username,
          },
        });
      }

      // Mark Twitter follow as verified
      await campaignService.verifyTwitterFollow(
        address,
        user.id,
        user.username
      );

      res.json({
        success: true,
        verified: true,
        user: {
          id: user.id,
          username: user.username,
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to verify Twitter');
      res.status(500).json({
        success: false,
        verified: false,
        error: 'Failed to verify Twitter account',
      });
    }
  };
}
