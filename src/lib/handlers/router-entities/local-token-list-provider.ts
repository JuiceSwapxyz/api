import defaultTokenList from '@uniswap/default-token-list/build/uniswap-default.tokenlist.json';
import { CachingTokenListProvider, NodeJSCache } from '@juiceswapxyz/smart-order-router';
import { ChainId } from '@juiceswapxyz/sdk-core';
import NodeCache from 'node-cache';
import { getJuiceswapLatestTokens } from './getJuiceswapLatestTokens';

export async function createLocalTokenListProvider(chainId: ChainId) {
  const tokenCache = new NodeCache({ stdTTL: 360, useClones: false });

  if (chainId === ChainId.CITREA_TESTNET || chainId === ChainId.CITREA_MAINNET) {
    const juiceswapLatestTokens = await getJuiceswapLatestTokens(chainId);
    const map = new Map<string, any>();

    juiceswapLatestTokens.forEach((token: { address: string; chainId: number; decimals: number; name: string; symbol: string }) => map.set(token.address, token));

    const aggregatedTokenList = {
      name: `Juiceswap Token List for ${chainId}`,
      version: {
        major: 1,
        minor: 0,
        patch: 0
      },
      tokens: Array.from(map.values()),
    };

    return CachingTokenListProvider.fromTokenList(chainId, aggregatedTokenList as any, new NodeJSCache(tokenCache));
  }

  return CachingTokenListProvider.fromTokenList(chainId, defaultTokenList as any, new NodeJSCache(tokenCache));
}
