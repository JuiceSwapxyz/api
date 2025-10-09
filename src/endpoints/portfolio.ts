import { Request, Response } from 'express';
import { providers, utils } from 'ethers';
import { ChainId } from '@juiceswapxyz/sdk-core';
import Logger from 'bunyan';
import { BalanceService } from '../services/BalanceService';
import { portfolioCache } from '../cache/portfolioCache';

/**
 * @swagger
 * /v1/portfolio/{address}:
 *   get:
 *     tags: [Portfolio]
 *     summary: Get wallet portfolio balances
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *         example: "0x2F0cC51C02E5D4EC68bC155728798969D5c0F714"
 *       - in: query
 *         name: chainId
 *         schema:
 *           type: integer
 *         example: 5115
 *         description: Chain ID (defaults to 5115 for Citrea Testnet)
 *     responses:
 *       200:
 *         description: Portfolio balances retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 portfolio:
 *                   type: object
 *                   properties:
 *                     balances:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           address:
 *                             type: string
 *                             description: Token contract address (0x0...0 for native token)
 *                           chainId:
 *                             type: integer
 *                             description: Chain ID
 *                           decimals:
 *                             type: integer
 *                             description: Token decimals
 *                           name:
 *                             type: string
 *                             description: Token name
 *                           symbol:
 *                             type: string
 *                             description: Token symbol
 *                           logoURI:
 *                             type: string
 *                             description: Token logo URI
 *                           balance:
 *                             type: string
 *                             description: Raw balance (wei/smallest unit)
 *                           balanceFormatted:
 *                             type: string
 *                             description: Formatted balance (human-readable)
 *                         required:
 *                           - address
 *                           - chainId
 *                           - decimals
 *                           - name
 *                           - symbol
 *                           - balance
 *                           - balanceFormatted
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createPortfolioHandler(
  providers: Map<ChainId, providers.StaticJsonRpcProvider>,
  logger: Logger
) {
  return async function handlePortfolio(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'portfolio' });

    try {
      const { address } = req.params;
      const chainId = req.query.chainId ? parseInt(req.query.chainId.toString()) : 5115;

      // Validate address parameter
      if (!address) {
        log.debug('Validation failed: missing address parameter');
        res.status(400).json({ message: 'Missing address parameter' });
        return;
      }

      // Validate address format
      if (!utils.isAddress(address)) {
        log.debug({ address }, 'Validation failed: invalid address format');
        res.status(400).json({ message: 'Invalid Ethereum address format' });
        return;
      }

      // Normalize address to lowercase for consistent caching
      const normalizedAddress = address.toLowerCase();

      log.debug({ address: normalizedAddress, chainId }, 'Fetching portfolio');

      // Check cache first
      const cached = portfolioCache.get(chainId, normalizedAddress);
      if (cached) {
        log.debug({ address: normalizedAddress, chainId }, 'Returning cached portfolio');
        res.status(200).json(cached);
        return;
      }

      // Get provider for the chain
      const provider = providers.get(chainId);
      if (!provider) {
        log.warn({ chainId }, 'Provider not found for chain');
        res.status(400).json({ message: `Chain ID ${chainId} not supported` });
        return;
      }

      // Create balance service and fetch balances
      const balanceService = new BalanceService(provider, chainId, logger);
      const portfolio = await balanceService.fetchBalances(normalizedAddress);

      // Cache the result
      portfolioCache.set(chainId, normalizedAddress, portfolio);

      // Return portfolio
      res.status(200).json(portfolio);

      log.debug(
        {
          address: normalizedAddress,
          chainId,
          balanceCount: portfolio.portfolio.balances.length,
        },
        'Successfully returned portfolio'
      );
    } catch (error: any) {
      log.error({ error }, 'Error in handlePortfolio');
      res.status(500).json({ message: 'Internal server error' });
    }
  };
}
