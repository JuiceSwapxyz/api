import { ChainId, Token } from '@juiceswapxyz/sdk-core';
import { FeeAmount } from '@juiceswapxyz/v3-sdk';

/**
 * Static pool configuration for Citrea Testnet (5115)
 * Hardcoded pools to avoid expensive on-chain discovery.
 */

// Citrea tokens - using checksummed addresses
const CITREA_TOKENS = {
  WCBTC: new Token(ChainId.CITREA_TESTNET, '0x4370e27F7d91D9341bFf232d7Ee8bdfE3a9933a0', 18, 'WCBTC', 'Wrapped cBTC'),
  CUSD: new Token(ChainId.CITREA_TESTNET, '0x2fFC18aC99D367b70dd922771dF8c2074af4aCE0', 18, 'cUSD', 'cUSD'),
  USDC: new Token(ChainId.CITREA_TESTNET, '0x36c16eaC6B0Ba6c50f494914ff015fCa95B7835F', 6, 'USDC', 'USDC'),
  NUSD: new Token(ChainId.CITREA_TESTNET, '0x9B28B690550522608890C3C7e63c0b4A7eBab9AA', 18, 'NUSD', 'Nectra USD'),
  TFC: new Token(ChainId.CITREA_TESTNET, '0x14ADf6B87096Ef750a956756BA191fc6BE94e473', 18, 'TFC', 'TaprootFreakCoin'),
  KCDU: new Token(ChainId.CITREA_TESTNET, '0x302670d7830684C14fB8bb9B20f5D8F874e65cA4', 18, 'KCDU', 'KucingDully'),
  MTK: new Token(ChainId.CITREA_TESTNET, '0x6434B863529F585633A1A71a9bfe9bbd7119Dd25', 18, 'MTK', 'MyToken'),
  CTR: new Token(ChainId.CITREA_TESTNET, '0x8025aAfab9881D9E9163e1956c3bfb8D3606bb55', 18, 'CTR', 'CITREAN'),
};

// Static pools
export const CITREA_STATIC_POOLS = [
  // WCBTC/NUSD pools
  {
    token0: CITREA_TOKENS.WCBTC,
    token1: CITREA_TOKENS.NUSD,
    fee: FeeAmount.MEDIUM,
    liquidity: '36000000000000000000000',
  },

  // TFC/WCBTC pools
  {
    token0: CITREA_TOKENS.TFC,
    token1: CITREA_TOKENS.WCBTC,
    fee: FeeAmount.MEDIUM,
    liquidity: '30000000000000000000000',
  },
  {
    token0: CITREA_TOKENS.TFC,
    token1: CITREA_TOKENS.WCBTC,
    fee: FeeAmount.HIGH,
    liquidity: '25000000000000000000000',
  },

  // TFC/USDC pools
  {
    token0: CITREA_TOKENS.TFC,
    token1: CITREA_TOKENS.USDC,
    fee: FeeAmount.MEDIUM,
    liquidity: '20000000000000000000000',
  },

  // USDC/WCBTC pools (multiple fee tiers)
  {
    token0: CITREA_TOKENS.USDC,
    token1: CITREA_TOKENS.WCBTC,
    fee: FeeAmount.LOWEST,
    liquidity: '80000000000000000000000',
  },
  {
    token0: CITREA_TOKENS.USDC,
    token1: CITREA_TOKENS.WCBTC,
    fee: FeeAmount.LOW,
    liquidity: '70000000000000000000000',
  },
  {
    token0: CITREA_TOKENS.USDC,
    token1: CITREA_TOKENS.WCBTC,
    fee: FeeAmount.MEDIUM,
    liquidity: '60000000000000000000000',
  },

  // cUSD/WCBTC pools
  {
    token0: CITREA_TOKENS.CUSD,
    token1: CITREA_TOKENS.WCBTC,
    fee: FeeAmount.MEDIUM,
    liquidity: '45000000000000000000000',
  },

  // MTK pools
  {
    token0: CITREA_TOKENS.WCBTC,
    token1: CITREA_TOKENS.MTK,
    fee: FeeAmount.MEDIUM,
    liquidity: '15000000000000000000000',
  },
  {
    token0: CITREA_TOKENS.CUSD,
    token1: CITREA_TOKENS.MTK,
    fee: FeeAmount.MEDIUM,
    liquidity: '18000000000000000000000',
  },

  // KCDU pools
  {
    token0: CITREA_TOKENS.KCDU,
    token1: CITREA_TOKENS.WCBTC,
    fee: FeeAmount.HIGH,
    liquidity: '12000000000000000000000',
  },

  // CTR pools
  {
    token0: CITREA_TOKENS.WCBTC,
    token1: CITREA_TOKENS.CTR,
    fee: FeeAmount.HIGH,
    liquidity: '22000000000000000000000',
  },

  // USD stablecoin pools
  {
    token0: CITREA_TOKENS.USDC,
    token1: CITREA_TOKENS.NUSD,
    fee: FeeAmount.MEDIUM,
    liquidity: '40000000000000000000000',
  },
  {
    token0: CITREA_TOKENS.CUSD,
    token1: CITREA_TOKENS.NUSD,
    fee: FeeAmount.MEDIUM,
    liquidity: '35000000000000000000000',
  },

  // Additional token pair pools for better routing coverage
  {
    token0: CITREA_TOKENS.CTR,
    token1: CITREA_TOKENS.USDC,
    fee: FeeAmount.MEDIUM,
    liquidity: '25000000000000000000000',
  },
  {
    token0: CITREA_TOKENS.KCDU,
    token1: CITREA_TOKENS.USDC,
    fee: FeeAmount.MEDIUM,
    liquidity: '18000000000000000000000',
  },
  {
    token0: CITREA_TOKENS.MTK,
    token1: CITREA_TOKENS.USDC,
    fee: FeeAmount.MEDIUM,
    liquidity: '15000000000000000000000',
  },
  {
    token0: CITREA_TOKENS.MTK,
    token1: CITREA_TOKENS.NUSD,
    fee: FeeAmount.MEDIUM,
    liquidity: '12000000000000000000000',
  },
  {
    token0: CITREA_TOKENS.CTR,
    token1: CITREA_TOKENS.MTK,
    fee: FeeAmount.HIGH,
    liquidity: '10000000000000000000000',
  },
  {
    token0: CITREA_TOKENS.CUSD,
    token1: CITREA_TOKENS.TFC,
    fee: FeeAmount.MEDIUM,
    liquidity: '28000000000000000000000',
  },
];

export { CITREA_TOKENS };
