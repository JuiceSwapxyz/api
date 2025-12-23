import { ChainId, Token } from '@juiceswapxyz/sdk-core';
import {
  ITokenProvider,
  TokenAccessor,
  UniswapMulticallProvider,
  TokenProvider,
  log,
} from '@juiceswapxyz/smart-order-router';
import NodeCache from 'node-cache';

/**
 * Token provider that wraps a primary provider and falls back to on-chain fetching.
 * This is needed for graduated launchpad tokens that aren't in the static token list.
 */
export class FallbackTokenProvider implements ITokenProvider {
  private readonly primaryProvider: ITokenProvider;
  private readonly onChainProvider: TokenProvider;
  private readonly onChainCache: NodeCache;

  constructor(
    chainId: ChainId,
    primaryProvider: ITokenProvider,
    multicallProvider: UniswapMulticallProvider
  ) {
    this.primaryProvider = primaryProvider;
    // Create on-chain provider once for reuse
    this.onChainProvider = new TokenProvider(chainId, multicallProvider);
    // Cache on-chain lookups for 1 hour
    this.onChainCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
  }

  async getTokens(addresses: string[]): Promise<TokenAccessor> {
    const foundTokens: Map<string, Token> = new Map();
    let missingAddresses: string[] = [];

    // First, try to get tokens from primary provider
    try {
      const primaryResult = await this.primaryProvider.getTokens(addresses);

      for (const address of addresses) {
        const token = primaryResult.getTokenByAddress(address);
        if (token) {
          foundTokens.set(address.toLowerCase(), token);
        } else {
          // Check on-chain cache first
          const cached = this.onChainCache.get<Token>(address.toLowerCase());
          if (cached) {
            foundTokens.set(address.toLowerCase(), cached);
          } else {
            missingAddresses.push(address);
          }
        }
      }
    } catch (error) {
      log.warn(
        { error, addresses },
        'FallbackTokenProvider: Primary provider failed, falling back to on-chain'
      );
      // Primary provider failed - check cache, then fetch remaining on-chain
      for (const address of addresses) {
        const cached = this.onChainCache.get<Token>(address.toLowerCase());
        if (cached) {
          foundTokens.set(address.toLowerCase(), cached);
        } else {
          missingAddresses.push(address);
        }
      }
    }

    // Fetch missing tokens on-chain
    if (missingAddresses.length > 0) {
      log.info(
        { missingAddresses },
        'FallbackTokenProvider: Fetching missing tokens on-chain'
      );

      try {
        const onChainResult = await this.onChainProvider.getTokens(missingAddresses);

        for (const address of missingAddresses) {
          const token = onChainResult.getTokenByAddress(address);
          if (token) {
            foundTokens.set(address.toLowerCase(), token);
            this.onChainCache.set(address.toLowerCase(), token);
            log.info(
              { address, symbol: token.symbol, decimals: token.decimals },
              'FallbackTokenProvider: Found token on-chain'
            );
          } else {
            log.warn({ address }, 'FallbackTokenProvider: Token not found on-chain');
          }
        }
      } catch (error) {
        log.error(
          { error, missingAddresses },
          'FallbackTokenProvider: Failed to fetch tokens on-chain'
        );
      }
    }

    // Return a TokenAccessor with all found tokens
    return {
      getTokenByAddress: (address: string): Token | undefined => {
        return foundTokens.get(address.toLowerCase());
      },
      getTokenBySymbol: (_symbol: string): Token | undefined => {
        // Symbol lookup is less important for routing, return undefined
        return undefined;
      },
      getAllTokens: (): Token[] => {
        return Array.from(foundTokens.values());
      },
    };
  }

  /**
   * For compatibility with token list providers that have this method.
   * Falls back to getTokens if the address is not found.
   */
  async getTokenByAddress(address: string): Promise<Token | undefined> {
    const result = await this.getTokens([address]);
    return result.getTokenByAddress(address);
  }
}
