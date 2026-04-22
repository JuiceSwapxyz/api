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
