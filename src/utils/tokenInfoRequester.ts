import { TokenProvider, UniswapMulticallProvider } from '@juiceswapxyz/smart-order-router';
import { ChainId, Token } from '@juiceswapxyz/sdk-core';
import NodeCache from 'node-cache';

export class TokenInfoRequester {
  private readonly cache: NodeCache;
  private readonly multicallProvider;
  private readonly chainId: ChainId;

  constructor(multicallProvider: UniswapMulticallProvider, chainId: ChainId) {
    this.cache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
    this.multicallProvider = multicallProvider;
    this.chainId = chainId;
  }

  async getTokenInfo(address: string): Promise<Token> {
    const cachedToken = await this.cache.get(address);
    if (cachedToken) {
      return cachedToken as Token;
    }

    const tokenProvider = new TokenProvider(this.chainId, this.multicallProvider);
    const tokenAccessor = await tokenProvider.getTokens([address]);
    const token = await tokenAccessor.getTokenByAddress(address);
    if (!token) {
      throw new Error(`Token not found: ${address}`);
    }
    await this.cache.set(address, token);
    return token;
  }
}