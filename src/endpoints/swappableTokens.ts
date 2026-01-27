import { Request, Response } from 'express';
import Logger from 'bunyan';
import { citreaMainnetTokenList } from '../config/citrea-mainnet.tokenlist';
import { citreaTestnetTokenList } from '../config/citrea-testnet.tokenlist';

interface Token {
  address: string;
  chainId: number;
  decimals: number;
  name: string;
  symbol: string;
  logoURI?: string;
}

// Map chainId to token list
const TOKEN_LISTS: Record<number, { tokens: Token[] }> = {
  4114: citreaMainnetTokenList as { tokens: Token[] },
  5115: citreaTestnetTokenList as { tokens: Token[] },
};

/**
 * @swagger
 * /v1/swappable_tokens:
 *   get:
 *     tags: [Utility]
 *     summary: Get swappable tokens
 *     parameters:
 *       - in: query
 *         name: tokenInChainId
 *         required: true
 *         schema:
 *           type: integer
 *         example: 5115
 *       - in: query
 *         name: tokenIn
 *         schema:
 *           type: string
 *         example: "0x8d0c9d1c17aE5e40ffF9bE350f57840E9E66Cd93"
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TokenListResponse'
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createSwappableTokensHandler(logger: Logger) {
  return async function handleSwappableTokens(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'swappable_tokens' });

    try {
      const { tokenIn, tokenInChainId } = req.query;

      if (!tokenInChainId) {
        log.debug('Validation failed: missing tokenInChainId parameter');
        res.status(400).json({ message: 'Missing tokenInChainId parameter' });
        return;
      }

      const chainId = parseInt(tokenInChainId.toString());

      // Get token list for the chain (supports Citrea Mainnet 4114 and Testnet 5115)
      const tokenList = TOKEN_LISTS[chainId];
      if (!tokenList) {
        res.status(200).json({ tokens: [] });
        return;
      }

      // Get all tokens from the token list
      let tokens: Token[] = tokenList.tokens;

      // Filter out the input token if specified
      if (tokenIn) {
        const tokenInAddress = tokenIn.toString().toLowerCase();
        tokens = tokens.filter(token => token.address.toLowerCase() !== tokenInAddress);
      }

      // Return tokens in the expected format
      res.status(200).json({
        tokens: tokens.map(token => ({
          address: token.address,
          chainId: token.chainId,
          decimals: token.decimals,
          name: token.name,
          symbol: token.symbol,
          logoURI: token.logoURI || `https://raw.githubusercontent.com/Uniswap/assets/master/blockchains/citrea/assets/${token.address}/logo.png`
        }))
      });

      log.debug({ chainId, tokenCount: tokens.length }, 'Returned swappable tokens');

    } catch (error: any) {
      log.error({ error }, 'Error in handleSwappableTokens');
      res.status(500).json({ message: 'Internal server error' });
    }
  };
}
