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

// ---------------------------------------------------------------------------
// Juicer NFT campaign
// ---------------------------------------------------------------------------

// JP that must be spent (burned off the available balance) to unlock the
// Juicer NFT claim. Must match JUICER_JP_COST in the frontend campaign types.
export const JUICER_JP_COST = 5_000 as const;

// Reason tag written to the JpSpend ledger for the Juicer claim. Part of the
// (walletAddress, chainId, reason) idempotency key.
export const JUICER_SPEND_REASON = "juicer_nft" as const;

// Canonical chain for the Juicer campaign (mirrors JUICER_CAMPAIGN_CHAIN_ID in
// the Ponder points engine). The meme-token-created condition and the on-chain
// claim are both scoped to this chain.
export const JUICER_CAMPAIGN_CHAIN_ID = 4114 as const; // Citrea Mainnet

// Deployed JuicerNFT.sol addresses. Sourced from env first so a fresh
// deployment can be wired in without a code change; the empty-string fallback
// makes a missing deployment fail loudly in /nft/signature rather than
// silently signing against the zero address.
export const JUICER_NFT_CONTRACT_MAINNET =
  process.env.JUICER_NFT_CONTRACT_MAINNET || "";
export const JUICER_NFT_CONTRACT_TESTNET =
  process.env.JUICER_NFT_CONTRACT_TESTNET || "";

export function getJuicerNftContract(chainId: number): string {
  if (chainId === 5115) return JUICER_NFT_CONTRACT_TESTNET;
  return JUICER_NFT_CONTRACT_MAINNET;
}

// JuiceSwap Discord server (guild) ID.
export const DISCORD_GUILD_ID = "1416006072748998720" as const;

// Juicer role in the JuiceSwap Discord. Required for First Squeezer mainnet
// eligibility — gates the Discord verification condition.
export const DISCORD_JUICER_ROLE_ID = "1418526943501881445" as const;
