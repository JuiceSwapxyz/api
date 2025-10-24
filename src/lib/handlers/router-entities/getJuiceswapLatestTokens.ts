import { log } from '@juiceswapxyz/smart-order-router';
import { getPonderClient } from '../../../services/PonderClient';
import Logger from 'bunyan';

export interface HttpTokenResponse {
  tokens: {
    address: string;
    symbol: string;
    decimals: number;
    name?: string;
  }[];
}

// Convert smart-order-router log to bunyan logger for PonderClient
const bunyanLogger = Logger.createLogger({
  name: 'juiceswap-token-list',
  level: 'info',
});

export async function getJuiceswapLatestTokens() {
  try {
    const ponderClient = getPonderClient(bunyanLogger);
    const response = await ponderClient.get<HttpTokenResponse>('/tokens/all');

    log.debug(`Got juiceswap latest tokens with ${response.data.tokens.length} tokens`);
    return response.data.tokens.map((token) => ({
      ...token,
      chainId: 5115,
      logoURI: '',
    }));
  } catch (error) {
    log.error({ error }, `Error getting juiceswap latest tokens`);
    return [];
  }
}
