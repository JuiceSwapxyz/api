import { Request, Response } from 'express';
import { utils } from 'ethers';
import Logger from 'bunyan';
import { getPonderClient } from '../services/PonderClient';

/**
 * Launchpad API endpoints - proxy to Ponder's launchpad endpoints
 * Provides automatic failover and retry logic via PonderClient
 */

/**
 * @swagger
 * /v1/launchpad/tokens:
 *   get:
 *     tags: [Launchpad]
 *     summary: List all launchpad tokens
 *     description: Fetches launchpad tokens with filtering, pagination, and sorting options
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema:
 *           type: string
 *           enum: [all, active, graduating, graduated]
 *           default: all
 *         description: Filter tokens by status
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Page number (0-indexed)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 100
 *         description: Number of tokens per page
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           enum: [newest, volume, trades]
 *           default: newest
 *         description: Sort order
 *       - in: query
 *         name: chainId
 *         schema:
 *           type: integer
 *         description: Filter by chain ID
 *     responses:
 *       200:
 *         description: List of launchpad tokens
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tokens:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/LaunchpadToken'
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     total:
 *                       type: integer
 *                     totalPages:
 *                       type: integer
 */
export function createLaunchpadTokensHandler(logger: Logger) {
  return async function handleLaunchpadTokens(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'launchpad/tokens' });

    try {
      // Build query string from validated params
      const { filter, page, limit, sort, chainId } = req.query;
      const params = new URLSearchParams();
      if (filter) params.append('filter', String(filter));
      if (page !== undefined) params.append('page', String(page));
      if (limit !== undefined) params.append('limit', String(limit));
      if (sort) params.append('sort', String(sort));
      if (chainId) params.append('chainId', String(chainId));

      const queryString = params.toString();
      const path = `/launchpad/tokens${queryString ? `?${queryString}` : ''}`;

      log.debug({ path }, 'Fetching launchpad tokens from Ponder');

      const ponderClient = getPonderClient(logger);
      const response = await ponderClient.get(path);

      res.status(200).json(response.data);
    } catch (error: any) {
      log.error({ error: error.message }, 'Error fetching launchpad tokens');
      res.status(error.response?.status || 500).json({
        error: error.response?.data?.error || 'Failed to fetch launchpad tokens',
      });
    }
  };
}

/**
 * @swagger
 * /v1/launchpad/token/{address}:
 *   get:
 *     tags: [Launchpad]
 *     summary: Get single token details
 *     description: Fetches details for a specific launchpad token by address
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *         description: Token contract address
 *     responses:
 *       200:
 *         description: Token details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   $ref: '#/components/schemas/LaunchpadToken'
 *       400:
 *         description: Invalid address format
 *       404:
 *         description: Token not found
 */
export function createLaunchpadTokenHandler(logger: Logger) {
  return async function handleLaunchpadToken(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'launchpad/token' });

    try {
      const { address } = req.params;

      // Validate address format
      if (!address || !utils.isAddress(address)) {
        log.debug({ address }, 'Validation failed: invalid address format');
        res.status(400).json({ error: 'Invalid Ethereum address format' });
        return;
      }

      const path = `/launchpad/token/${address}`;
      log.debug({ path }, 'Fetching launchpad token from Ponder');

      const ponderClient = getPonderClient(logger);
      const response = await ponderClient.get(path);

      res.status(200).json(response.data);
    } catch (error: any) {
      log.error({ error: error.message }, 'Error fetching launchpad token');
      const status = error.response?.status || 500;
      res.status(status).json({
        error: error.response?.data?.error || 'Failed to fetch launchpad token',
      });
    }
  };
}

/**
 * @swagger
 * /v1/launchpad/token/{address}/trades:
 *   get:
 *     tags: [Launchpad]
 *     summary: Get token trade history
 *     description: Fetches trade history for a specific launchpad token
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *         description: Token contract address
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 100
 *         description: Number of trades to return
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Page number (0-indexed)
 *     responses:
 *       200:
 *         description: List of trades
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 trades:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/LaunchpadTrade'
 *       400:
 *         description: Invalid address format
 */
export function createLaunchpadTokenTradesHandler(logger: Logger) {
  return async function handleLaunchpadTokenTrades(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'launchpad/token/trades' });

    try {
      const { address } = req.params;

      // Validate address format
      if (!address || !utils.isAddress(address)) {
        log.debug({ address }, 'Validation failed: invalid address format');
        res.status(400).json({ error: 'Invalid Ethereum address format' });
        return;
      }

      // Build query string from validated params
      const { limit, page } = req.query;
      const params = new URLSearchParams();
      if (limit !== undefined) params.append('limit', String(limit));
      if (page !== undefined) params.append('page', String(page));

      const queryString = params.toString();
      const path = `/launchpad/token/${address}/trades${queryString ? `?${queryString}` : ''}`;

      log.debug({ path }, 'Fetching launchpad token trades from Ponder');

      const ponderClient = getPonderClient(logger);
      const response = await ponderClient.get(path);

      res.status(200).json(response.data);
    } catch (error: any) {
      log.error({ error: error.message }, 'Error fetching launchpad token trades');
      res.status(error.response?.status || 500).json({
        error: error.response?.data?.error || 'Failed to fetch token trades',
      });
    }
  };
}

/**
 * @swagger
 * /v1/launchpad/stats:
 *   get:
 *     tags: [Launchpad]
 *     summary: Get overall launchpad statistics
 *     description: Fetches aggregate statistics for the launchpad
 *     parameters:
 *       - in: query
 *         name: chainId
 *         schema:
 *           type: integer
 *         description: Filter by chain ID
 *     responses:
 *       200:
 *         description: Launchpad statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalTokens:
 *                   type: integer
 *                   description: Total number of tokens created
 *                 graduatedTokens:
 *                   type: integer
 *                   description: Number of graduated tokens
 *                 activeTokens:
 *                   type: integer
 *                   description: Number of active tokens
 *                 graduatingTokens:
 *                   type: integer
 *                   description: Number of tokens ready to graduate
 *                 totalTrades:
 *                   type: integer
 *                   description: Total number of trades
 *                 totalVolumeBase:
 *                   type: string
 *                   description: Total trading volume in base asset (wei)
 */
export function createLaunchpadStatsHandler(logger: Logger) {
  return async function handleLaunchpadStats(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'launchpad/stats' });

    try {
      // Build query string with optional chainId
      const { chainId } = req.query;
      const params = new URLSearchParams();
      if (chainId) params.append('chainId', String(chainId));

      const queryString = params.toString();
      const path = `/launchpad/stats${queryString ? `?${queryString}` : ''}`;
      log.debug({ path }, 'Fetching launchpad stats from Ponder');

      const ponderClient = getPonderClient(logger);
      const response = await ponderClient.get(path);

      res.status(200).json(response.data);
    } catch (error: any) {
      log.error({ error: error.message }, 'Error fetching launchpad stats');
      res.status(error.response?.status || 500).json({
        error: error.response?.data?.error || 'Failed to fetch launchpad stats',
      });
    }
  };
}

/**
 * @swagger
 * /v1/launchpad/recent-trades:
 *   get:
 *     tags: [Launchpad]
 *     summary: Get recent trades across all tokens
 *     description: Fetches the most recent trades across all launchpad tokens
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 50
 *         description: Number of trades to return
 *       - in: query
 *         name: chainId
 *         schema:
 *           type: integer
 *         description: Filter by chain ID
 *     responses:
 *       200:
 *         description: List of recent trades with token info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 trades:
 *                   type: array
 *                   items:
 *                     allOf:
 *                       - $ref: '#/components/schemas/LaunchpadTrade'
 *                       - type: object
 *                         properties:
 *                           tokenName:
 *                             type: string
 *                           tokenSymbol:
 *                             type: string
 */
export function createLaunchpadRecentTradesHandler(logger: Logger) {
  return async function handleLaunchpadRecentTrades(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'launchpad/recent-trades' });

    try {
      // Build query string from validated params
      const { limit, chainId } = req.query;
      const params = new URLSearchParams();
      if (limit !== undefined) params.append('limit', String(limit));
      if (chainId) params.append('chainId', String(chainId));

      const queryString = params.toString();
      const path = `/launchpad/recent-trades${queryString ? `?${queryString}` : ''}`;

      log.debug({ path }, 'Fetching recent launchpad trades from Ponder');

      const ponderClient = getPonderClient(logger);
      const response = await ponderClient.get(path);

      res.status(200).json(response.data);
    } catch (error: any) {
      log.error({ error: error.message }, 'Error fetching recent launchpad trades');
      res.status(error.response?.status || 500).json({
        error: error.response?.data?.error || 'Failed to fetch recent trades',
      });
    }
  };
}
