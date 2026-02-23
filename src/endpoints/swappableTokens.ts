import { Request, Response } from "express";
import Logger from "bunyan";
import { citreaMainnetTokenList } from "../config/citrea-mainnet.tokenlist";
import { citreaTestnetTokenList } from "../config/citrea-testnet.tokenlist";
import { getJuiceswapLatestTokens } from "../lib/handlers/router-entities/getJuiceswapLatestTokens";
import { getGraduatedLaunchpadTokens } from "../lib/handlers/router-entities/getGraduatedLaunchpadTokens";

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

// Tokens to hide from UI (internal vault/collateral tokens)
const HIDDEN_TOKENS = new Set(["svJUSD", "startUSD", "SUSD"]);

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
  return async function handleSwappableTokens(
    req: Request,
    res: Response,
  ): Promise<void> {
    const log = logger.child({ endpoint: "swappable_tokens" });

    try {
      const { tokenIn, tokenInChainId } = req.query;

      if (!tokenInChainId) {
        log.debug("Validation failed: missing tokenInChainId parameter");
        res.status(400).json({ message: "Missing tokenInChainId parameter" });
        return;
      }

      const chainId = parseInt(tokenInChainId.toString());

      // Get hardcoded token list for the chain (supports Citrea Mainnet 4114 and Testnet 5115)
      const hardcodedTokenList = TOKEN_LISTS[chainId];
      const hardcodedTokens: Token[] = hardcodedTokenList?.tokens ?? [];

      // Get Ponder tokens (auto-discovered from pools)
      let ponderTokens: Token[] = [];
      try {
        ponderTokens = await getJuiceswapLatestTokens(chainId);
        log.debug(
          { chainId, ponderTokenCount: ponderTokens.length },
          "Fetched Ponder tokens",
        );
      } catch (ponderError) {
        log.warn(
          { ponderError },
          "Failed to fetch Ponder tokens, using hardcoded only",
        );
      }

      // Get graduated launchpad tokens (they have V2 pools and should be tradeable on /swap)
      let graduatedTokens: Token[] = [];
      try {
        graduatedTokens = await getGraduatedLaunchpadTokens(chainId);
        log.debug(
          { chainId, graduatedTokenCount: graduatedTokens.length },
          "Fetched graduated launchpad tokens",
        );
      } catch (graduatedError) {
        log.warn(
          { graduatedError },
          "Failed to fetch graduated launchpad tokens",
        );
      }

      // Merge: hardcoded tokens take precedence (they have complete metadata)
      const seenAddresses = new Set<string>();
      const mergedTokens: Token[] = [];

      // Add hardcoded tokens first (they have complete metadata)
      for (const token of hardcodedTokens) {
        if (!HIDDEN_TOKENS.has(token.symbol)) {
          seenAddresses.add(token.address.toLowerCase());
          mergedTokens.push(token);
        }
      }

      // Add Ponder tokens not already in hardcoded list
      for (const token of ponderTokens) {
        if (
          !HIDDEN_TOKENS.has(token.symbol) &&
          !seenAddresses.has(token.address.toLowerCase())
        ) {
          seenAddresses.add(token.address.toLowerCase());
          mergedTokens.push(token);
        }
      }

      // Add graduated launchpad tokens (not already in hardcoded or ponder list)
      for (const token of graduatedTokens) {
        if (
          !HIDDEN_TOKENS.has(token.symbol) &&
          !seenAddresses.has(token.address.toLowerCase())
        ) {
          seenAddresses.add(token.address.toLowerCase());
          mergedTokens.push(token);
        }
      }

      // Filter out the input token if specified
      let filteredTokens = mergedTokens;
      if (tokenIn) {
        const tokenInAddress = tokenIn.toString().toLowerCase();
        filteredTokens = mergedTokens.filter(
          (token) => token.address.toLowerCase() !== tokenInAddress,
        );
      }

      // Return tokens in the expected format
      res.status(200).json({
        tokens: filteredTokens.map((token) => ({
          address: token.address,
          chainId: token.chainId,
          decimals: token.decimals,
          name: token.name,
          symbol: token.symbol,
          logoURI: token.logoURI || "",
        })),
      });

      log.debug(
        {
          chainId,
          tokenCount: filteredTokens.length,
          hardcodedCount: hardcodedTokens.length,
          ponderCount: ponderTokens.length,
          graduatedCount: graduatedTokens.length,
        },
        "Returned merged swappable tokens",
      );
    } catch (error: any) {
      log.error({ error }, "Error in handleSwappableTokens");
      res.status(500).json({ message: "Internal server error" });
    }
  };
}
