import { WETH9, ChainId, Token } from '@juiceswapxyz/sdk-core';
import { ADDRESS } from '@juicedollar/jusd';

/**
 * Static pool configuration for Citrea Testnet (5115)
 * Hardcoded pools to avoid expensive on-chain discovery.
 */

// Get JuiceDollar addresses from package (single source of truth)
const JUSD_ADDRESSES = ADDRESS[ChainId.CITREA_TESTNET];

// Citrea tokens - using checksummed addresses from canonical packages
const CITREA_TOKENS = {
  // WcBTC from SDK WETH9 - single source of truth
  WCBTC: new Token(ChainId.CITREA_TESTNET, WETH9[ChainId.CITREA_TESTNET].address, 18, 'WCBTC', 'Wrapped cBTC'),
  // JuiceDollar tokens from @juicedollar/jusd package
  JUSD: new Token(ChainId.CITREA_TESTNET, JUSD_ADDRESSES.juiceDollar, 18, 'JUSD', 'Juice Dollar'),
  SV_JUSD: new Token(ChainId.CITREA_TESTNET, JUSD_ADDRESSES.savingsVaultJUSD, 18, 'svJUSD', 'Savings Vault JUSD'),
  JUICE: new Token(ChainId.CITREA_TESTNET, JUSD_ADDRESSES.equity, 18, 'JUICE', 'JUICE Equity'),
  USDC: new Token(ChainId.CITREA_TESTNET, '0x2fFC18aC99D367b70dd922771dF8c2074af4aCE0', 18, 'USDC', 'USDC'),
  NUSD: new Token(ChainId.CITREA_TESTNET, '0x9B28B690550522608890C3C7e63c0b4A7eBab9AA', 18, 'NUSD', 'Nectra USD'),
  TFC: new Token(ChainId.CITREA_TESTNET, '0x14ADf6B87096Ef750a956756BA191fc6BE94e473', 18, 'TFC', 'TaprootFreakCoin'),
  KCDU: new Token(ChainId.CITREA_TESTNET, '0x302670d7830684C14fB8bb9B20f5D8F874e65cA4', 18, 'KCDU', 'KucingDully'),
  MTK: new Token(ChainId.CITREA_TESTNET, '0x6434B863529F585633A1A71a9bfe9bbd7119Dd25', 18, 'MTK', 'MyToken'),
  CTR: new Token(ChainId.CITREA_TESTNET, '0x8025aAfab9881D9E9163e1956c3bfb8D3606bb55', 18, 'CTR', 'CITREAN'),
};

// V2 pools for gas estimation (required for V2 gas model to price gas in USD)
export const CITREA_V2_POOLS = {
  WCBTC_JUSD: {
    pairAddress: '0x6d091877B1Fb834E3dBdB14a98533573BC963AAB',
    token0: CITREA_TOKENS.WCBTC,
    token1: CITREA_TOKENS.JUSD,
  },
};

export { CITREA_TOKENS };
