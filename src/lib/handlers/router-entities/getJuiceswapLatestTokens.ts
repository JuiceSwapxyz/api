import { log } from "@juiceswapxyz/smart-order-router";
import { getPonderClient } from "../../../services/PonderClient";
import Logger from "bunyan";
import { ChainId } from "@juiceswapxyz/sdk-core";

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
  name: "juiceswap-token-list",
  level: "info",
});

export async function getJuiceswapLatestTokens(chainId: ChainId) {
  try {
    const ponderClient = getPonderClient(bunyanLogger);
    const response = await ponderClient.query(
      `
        query AllTokens($where: tokenFilter = {}) {
          tokens(where: $where) {
            items {
              address
              chainId
              decimals
              name
              symbol
            }
          }
        }
      `,
      {
        where: {
          chainId: chainId,
        },
      },
    );

    log.debug(
      `Got juiceswap latest tokens with ${response.tokens.items.length} tokens`,
    );
    return response.tokens.items.map(
      (token: {
        address: string;
        chainId: number;
        decimals: number;
        name: string;
        symbol: string;
      }) => ({
        ...token,
        logoURI: "",
      }),
    );
  } catch (error) {
    log.error({ error }, `Error getting juiceswap latest tokens`);
    return [];
  }
}
