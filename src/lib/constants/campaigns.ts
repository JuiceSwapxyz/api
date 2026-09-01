/**
 * Campaign contract addresses and configuration
 * These are public, immutable identifiers — stable across environments.
 */

export const FIRST_SQUEEZER_NFT_CONTRACT =
  "0x428B878cB6383216AaDc4e8495037E8d31612621" as const;

// Testnet First Squeezer NFT (Oct 2025 campaign). Identical address to
// FIRST_SQUEEZER_NFT_CONTRACT today purely by deterministic deployment-nonce
// coincidence; keep a separate constant so future redeploys don't silently
// break the mainnet claim eligibility gate.
export const FIRST_SQUEEZER_TESTNET_NFT_CONTRACT =
  "0x428B878cB6383216AaDc4e8495037E8d31612621" as const;

// JuiceSwap Discord server (guild) ID.
export const DISCORD_GUILD_ID = "1416006072748998720" as const;

// Juicer role in the JuiceSwap Discord. Required for First Squeezer mainnet
// eligibility — gates the Discord verification condition.
export const DISCORD_JUICER_ROLE_ID = "1418526943501881445" as const;

/**
 * Juicer NFT (post-launch loyalty drop). Mints are paid in Juice Points
 * (JUICER_JP_COST per mint). The contract address is the deployed
 * `contracts/nft/JuicerNFT.sol` from JuiceSwapxyz/smart-contracts on
 * Citrea Mainnet — populate via the JUICER_NFT_CONTRACT env var once
 * `JuiceSwapxyz/smart-contracts#56` is merged and deployed. Until then
 * the spend handler fails closed with 503 so the frontend can render a
 * "not yet live" state.
 */
export const JUICER_NFT_CONTRACT = (process.env.JUICER_NFT_CONTRACT ?? "") as
  | `0x${string}`
  | "";

/** Juice Points required to mint one Juicer NFT. Frontend mirrors this. */
export const JUICER_JP_COST = 5000;
