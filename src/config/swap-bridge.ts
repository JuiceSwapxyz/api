import { ChainId } from "@juiceswapxyz/sdk-core";

export enum BridgeAsset {
  BTC = "BTC",
  cBTC = "cBTC",
  JUSD_CITREA = "JUSD_CITREA",
  USDT_POLYGON = "USDT_POLYGON",
  USDT_ETH = "USDT_ETH",
  USDC_ETH = "USDC_ETH",
  WBTC_ETH = "WBTC_ETH",
  WBTC_CITREA = "WBTC_CITREA",
  WBTCe_CITREA = "WBTCe_CITREA",
}

export const Erc20Asset = [
  BridgeAsset.JUSD_CITREA,
  BridgeAsset.USDT_POLYGON,
  BridgeAsset.USDT_ETH,
  BridgeAsset.USDC_ETH,
  BridgeAsset.WBTC_ETH,
  BridgeAsset.WBTC_CITREA,
  BridgeAsset.WBTCe_CITREA,
] as const;

export const EvmAssets = [BridgeAsset.cBTC, ...Erc20Asset] as const;

export const MapAssetToChain: Record<(typeof EvmAssets)[number], ChainId> = {
  [BridgeAsset.cBTC]: ChainId.CITREA_MAINNET,
  [BridgeAsset.JUSD_CITREA]: ChainId.CITREA_MAINNET,
  [BridgeAsset.USDT_POLYGON]: ChainId.POLYGON,
  [BridgeAsset.USDT_ETH]: ChainId.MAINNET,
  [BridgeAsset.USDC_ETH]: ChainId.MAINNET,
  [BridgeAsset.WBTC_ETH]: ChainId.MAINNET,
  [BridgeAsset.WBTC_CITREA]: ChainId.CITREA_MAINNET,
  [BridgeAsset.WBTCe_CITREA]: ChainId.CITREA_MAINNET,
};
