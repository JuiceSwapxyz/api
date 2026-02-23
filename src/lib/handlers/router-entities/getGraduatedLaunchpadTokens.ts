import { log } from "@juiceswapxyz/smart-order-router";
import { getPonderClient } from "../../../services/PonderClient";
import Logger from "bunyan";
import { ChainId } from "@juiceswapxyz/sdk-core";

export interface GraduatedToken {
  address: string;
  chainId: number;
  decimals: number;
  name: string;
  symbol: string;
  logoURI: string;
}

interface LaunchpadTokenResponse {
  address: string;
  chainId: number;
  name: string;
  symbol: string;
}

interface LaunchpadTokensApiResponse {
  tokens: LaunchpadTokenResponse[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// Convert smart-order-router log to bunyan logger for PonderClient
const bunyanLogger = Logger.createLogger({
  name: "juiceswap-graduated-tokens",
  level: "info",
});

/**
 * Fetches graduated launchpad tokens from Ponder REST API.
 * These tokens have completed their bonding curve and migrated to Uniswap V2 pools.
 * They should be searchable and tradeable on /swap.
 */
export async function getGraduatedLaunchpadTokens(
  chainId: ChainId,
): Promise<GraduatedToken[]> {
  try {
    const ponderClient = getPonderClient(bunyanLogger);

    // Use the existing REST API endpoint which is more reliable
    // GET /launchpad/tokens?filter=graduated&chainId=<chainId>&limit=100
    const response =
      await ponderClient.get<LaunchpadTokensApiResponse>(
        `/launchpad/tokens?filter=graduated&chainId=${chainId}&limit=100`,
      );

    const tokens = response.data?.tokens || [];

    log.debug(`Got ${tokens.length} graduated launchpad tokens`);

    return tokens.map((token) => ({
      address: token.address,
      chainId: token.chainId,
      decimals: 18, // Launchpad tokens are always 18 decimals
      name: token.name,
      symbol: token.symbol,
      logoURI: "",
    }));
  } catch (error) {
    log.error({ error }, `Error getting graduated launchpad tokens`);
    return [];
  }
}
