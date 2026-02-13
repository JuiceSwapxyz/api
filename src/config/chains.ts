/**
 * Canonical chain ID → chain name mapping.
 * Used by pool endpoints and ExploreStatsService for the frontend protobuf format.
 */
const CHAIN_ID_TO_CHAIN_NAME: Record<number, string> = {
  1: "ETHEREUM",
  11155111: "ETHEREUM_SEPOLIA",
  137: "POLYGON",
  5115: "CITREA_TESTNET",
  4114: "CITREA_MAINNET",
};

/**
 * Get the chain name for a given chain ID.
 * Falls back to `CHAIN_<chainId>` for unknown chains.
 */
export function getChainName(chainId: number): string {
  return CHAIN_ID_TO_CHAIN_NAME[chainId] || `CHAIN_${chainId}`;
}
