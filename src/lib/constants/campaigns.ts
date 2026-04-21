/**
 * Campaign contract addresses and configuration
 * These are public, immutable smart contract addresses deployed on-chain
 */

export const FIRST_SQUEEZER_NFT_CONTRACT =
  "0x428B878cB6383216AaDc4e8495037E8d31612621" as const;

// Testnet First Squeezer NFT (Oct 2025 campaign). Identical address to
// FIRST_SQUEEZER_NFT_CONTRACT today purely by deterministic deployment-nonce
// coincidence; keep a separate constant so future redeploys don't silently
// break the mainnet claim eligibility gate.
export const FIRST_SQUEEZER_TESTNET_NFT_CONTRACT =
  "0x428B878cB6383216AaDc4e8495037E8d31612621" as const;
