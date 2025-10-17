import { TokenProvider, UniswapMulticallProvider } from '@juiceswapxyz/smart-order-router';
import { Token } from '@juiceswapxyz/sdk-core';
import NodeCache from 'node-cache';

export class TokenInfoRequester {
  private readonly cache: NodeCache;
  private readonly multicallProvider;

  constructor(multicallProvider: UniswapMulticallProvider    ) {
    this.cache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
    this.multicallProvider = multicallProvider;
  }

  async getTokenInfo(address: string): Promise<Token> {
    const cachedToken = await this.cache.get(address);
    if (cachedToken) {
      return cachedToken as Token;
    }

    const tokenProvider = new TokenProvider(5115, this.multicallProvider);
    const tokenAccessor = await tokenProvider.getTokens([address]);
    const token = await tokenAccessor.getTokenByAddress(address);
    if (!token) {
      throw new Error(`Token not found: ${address}`);
    }
    await this.cache.set(address, token);
    return token;
  }
}