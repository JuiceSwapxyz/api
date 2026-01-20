import { ChainId, WETH9 } from '@juiceswapxyz/sdk-core';

export const citreaTestnetTokenList = {
  "name": "Citrea Testnet Token List",
  "version": {
    "major": 1,
    "minor": 0,
    "patch": 0
  },
  "tokens": [
    {
      "address": "0x14ADf6B87096Ef750a956756BA191fc6BE94e473",
      "chainId": ChainId.CITREA_TESTNET,
      "decimals": 18,
      "name": "TaprootFreakCoin",
      "symbol": "TFC",
      "logoURI": ""
    },
    {
      "address": "0x2fFC18aC99D367b70dd922771dF8c2074af4aCE0",
      "chainId": ChainId.CITREA_TESTNET,
      "decimals": 18,
      "name": "cUSD",
      "symbol": "cUSD",
      "logoURI": ""
    },
    {
      "address": "0x302670d7830684C14fB8bb9B20f5D8F874e65cA4",
      "chainId": ChainId.CITREA_TESTNET,
      "decimals": 18,
      "name": "KucingDully",
      "symbol": "KCDU",
      "logoURI": ""
    },
    {
      "address": "0x36c16eaC6B0Ba6c50f494914ff015fCa95B7835F",
      "chainId": ChainId.CITREA_TESTNET,
      "decimals": 6,
      "name": "USDC",
      "symbol": "USDC",
      "logoURI": ""
    },
    {
      "address": WETH9[ChainId.CITREA_TESTNET].address,
      "chainId": ChainId.CITREA_TESTNET,
      "decimals": 18,
      "name": "Wrapped cBTC",
      "symbol": "WCBTC",
      "logoURI": ""
    },
    {
      "address": "0x6434B863529F585633A1A71a9bfe9bbd7119Dd25",
      "chainId": ChainId.CITREA_TESTNET,
      "decimals": 18,
      "name": "MyToken",
      "symbol": "MTK",
      "logoURI": ""
    },
    {
      "address": "0x8025aAfab9881D9E9163e1956c3bfb8D3606bb55",
      "chainId": ChainId.CITREA_TESTNET,
      "decimals": 18,
      "name": "CITREAN",
      "symbol": "CTR",
      "logoURI": ""
    },
    {
      "address": "0x9B28B690550522608890C3C7e63c0b4A7eBab9AA",
      "chainId": ChainId.CITREA_TESTNET,
      "decimals": 18,
      "name": "Nectra USD",
      "symbol": "NUSD",
      "logoURI": ""
    },
    {
      "address": "0xFdB0a83d94CD65151148a131167Eb499Cb85d015",
      "chainId": ChainId.CITREA_TESTNET,
      "decimals": 18,
      "name": "Juice Dollar",
      "symbol": "JUSD",
      "logoURI": ""
    },
    {
      "address": "0x9580498224551E3f2e3A04330a684BF025111C53",
      "chainId": 5115,
      "decimals": 18,
      "name": "Savings Vault JUSD",
      "symbol": "svJUSD",
      "logoURI": ""
    },
    {
      "address": "0x7b2A560bf72B0Dd2EAbE3271F829C2597c8420d5",
      "chainId": 5115,
      "decimals": 18,
      "name": "JUICE Equity",
      "symbol": "JUICE",
      "logoURI": ""
    }
  ]
};
