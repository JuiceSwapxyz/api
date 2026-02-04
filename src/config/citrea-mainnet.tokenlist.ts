import { ChainId, WETH9 } from "@juiceswapxyz/sdk-core";
import { ADDRESS } from "@juicedollar/jusd";

export const citreaMainnetTokenList = {
  name: "Citrea Mainnet Token List",
  version: {
    major: 1,
    minor: 0,
    patch: 0,
  },
  tokens: [
    {
      address: WETH9[ChainId.CITREA_MAINNET].address,
      chainId: ChainId.CITREA_MAINNET,
      decimals: 18,
      name: "Wrapped cBTC",
      symbol: "WCBTC",
      logoURI: "",
    },
    {
      address: ADDRESS[4114]!.juiceDollar,
      chainId: ChainId.CITREA_MAINNET,
      decimals: 18,
      name: "Juice Dollar",
      symbol: "JUSD",
      logoURI: "",
    },
    {
      address: ADDRESS[4114]!.savingsVaultJUSD,
      chainId: ChainId.CITREA_MAINNET,
      decimals: 18,
      name: "Savings Vault JUSD",
      symbol: "svJUSD",
      logoURI: "",
    },
    {
      address: ADDRESS[4114]!.equity,
      chainId: ChainId.CITREA_MAINNET,
      decimals: 18,
      name: "JUICE Equity",
      symbol: "JUICE",
      logoURI: "",
    },
    {
      address: ADDRESS[4114]!.startUSD,
      chainId: ChainId.CITREA_MAINNET,
      decimals: 18,
      name: "StartUSD",
      symbol: "startUSD",
      logoURI: "",
    },
    {
      address: ADDRESS[4114]!.USDC,
      chainId: ChainId.CITREA_MAINNET,
      decimals: 6,
      name: "USD Coin",
      symbol: "USDC",
      logoURI: "",
    },
    {
      address: ADDRESS[4114]!.USDT,
      chainId: ChainId.CITREA_MAINNET,
      decimals: 6,
      name: "Tether USD",
      symbol: "USDT",
      logoURI: "",
    },
    {
      address: ADDRESS[4114]!.CTUSD,
      chainId: ChainId.CITREA_MAINNET,
      decimals: 6,
      name: "Citrea USD",
      symbol: "ctUSD",
      logoURI: "",
    },
  ],
};
