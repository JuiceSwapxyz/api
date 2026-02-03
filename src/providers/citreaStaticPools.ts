import { WETH9, ChainId, Token } from "@juiceswapxyz/sdk-core";
import { ADDRESS } from "@juicedollar/jusd";

/**
 * Static pool configuration for Citrea chains
 * Hardcoded pools for gas estimation (required for V2 gas model to price gas in USD)
 */

// Get JuiceDollar addresses from package (single source of truth)
const JUSD_ADDRESSES_TESTNET = ADDRESS[ChainId.CITREA_TESTNET];
const JUSD_ADDRESSES_MAINNET = ADDRESS[ChainId.CITREA_MAINNET];

// Citrea Testnet tokens
const CITREA_TESTNET_TOKENS = {
  WCBTC: new Token(
    ChainId.CITREA_TESTNET,
    WETH9[ChainId.CITREA_TESTNET].address,
    18,
    "WCBTC",
    "Wrapped cBTC",
  ),
  JUSD: new Token(
    ChainId.CITREA_TESTNET,
    JUSD_ADDRESSES_TESTNET.juiceDollar,
    18,
    "JUSD",
    "Juice Dollar",
  ),
};

// Citrea Mainnet tokens
const CITREA_MAINNET_TOKENS = {
  WCBTC: new Token(
    ChainId.CITREA_MAINNET,
    WETH9[ChainId.CITREA_MAINNET].address,
    18,
    "WCBTC",
    "Wrapped cBTC",
  ),
  JUSD: new Token(
    ChainId.CITREA_MAINNET,
    JUSD_ADDRESSES_MAINNET.juiceDollar,
    18,
    "JUSD",
    "Juice Dollar",
  ),
};

// V2 pool type
interface V2PoolConfig {
  pairAddress: string;
  token0: Token;
  token1: Token;
}

// V2 pools by chain for gas estimation
export const CITREA_V2_POOLS_BY_CHAIN: Record<number, V2PoolConfig[]> = {
  [ChainId.CITREA_TESTNET]: [
    {
      pairAddress: "0x6d091877B1Fb834E3dBdB14a98533573BC963AAB",
      token0: CITREA_TESTNET_TOKENS.WCBTC,
      token1: CITREA_TESTNET_TOKENS.JUSD,
    },
  ],
  [ChainId.CITREA_MAINNET]: [
    {
      pairAddress: "0x8e7474c310bDC74b1eac1f983c242Bb77a4fe158",
      token0: CITREA_MAINNET_TOKENS.JUSD, // token0 is JUSD (lower address)
      token1: CITREA_MAINNET_TOKENS.WCBTC, // token1 is WcBTC (higher address)
    },
  ],
};

// Legacy export for backwards compatibility
export const CITREA_V2_POOLS = {
  WCBTC_JUSD: {
    pairAddress: "0x6d091877B1Fb834E3dBdB14a98533573BC963AAB",
    token0: CITREA_TESTNET_TOKENS.WCBTC,
    token1: CITREA_TESTNET_TOKENS.JUSD,
  },
};

// Legacy export
export const CITREA_TOKENS = CITREA_TESTNET_TOKENS;
