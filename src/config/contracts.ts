import { WETH9, CHAIN_TO_ADDRESSES_MAP, ChainId } from "@juiceswapxyz/sdk-core";
import { ADDRESS } from "@juicedollar/jusd";

/**
 * Contract addresses for JuiceDollar + JuiceSwap integration
 *
 * All addresses are imported from their canonical source packages:
 * - @juicedollar/jusd: JUSD, svJUSD, JUICE (JuiceDollar protocol)
 * - @juiceswapxyz/sdk-core: WcBTC, SwapRouter, PositionManager, Gateway (DEX infrastructure)
 *
 * This ensures single source of truth and eliminates sync issues!
 */

export interface ChainContracts {
  JUSD: string;
  SV_JUSD: string;
  JUICE: string;
  SUSD: string;
  USDC: string;
  USDT: string;
  CTUSD: string;
  WCBTC: string;
  SY_BTC: string;
  JUICE_SWAP_GATEWAY: string;
  SWAP_ROUTER: string;
  POSITION_MANAGER: string;
  BRIDGE_SUSD: string;
  BRIDGE_USDC: string;
  BRIDGE_USDT: string;
  BRIDGE_CTUSD: string;
}

// Type for supported chains in CHAIN_TO_ADDRESSES_MAP
type SupportedDexChain = keyof typeof CHAIN_TO_ADDRESSES_MAP;

/**
 * Build ChainContracts from package imports for a given chainId
 */
function buildChainContracts(chainId: number): ChainContracts | null {
  // Get JuiceDollar addresses
  const juiceDollarAddresses = ADDRESS[chainId];
  if (!juiceDollarAddresses) {
    return null;
  }

  // Get DEX addresses from sdk-core (with proper type narrowing)
  const dexChainId = chainId as SupportedDexChain;
  if (!(chainId in CHAIN_TO_ADDRESSES_MAP)) {
    return null;
  }
  const dexAddresses = CHAIN_TO_ADDRESSES_MAP[dexChainId];

  // Get wrapped native token (WcBTC on Citrea)
  const wcbtc = WETH9[chainId as ChainId];
  if (!wcbtc) {
    return null;
  }

  // syBTC (Solv Protocol yield-bearing BTC) — not yet available in any package.
  // Mainnet address verified from Citrea explorer. Update here if the token is redeployed.
  const SY_BTC_MAINNET = "0x384157027B1CDEAc4e26e3709667BB28735379Bb";

  return {
    // From @juicedollar/jusd
    JUSD: juiceDollarAddresses.juiceDollar,
    SV_JUSD: juiceDollarAddresses.savingsVaultJUSD,
    JUICE: juiceDollarAddresses.equity,
    SUSD: juiceDollarAddresses.startUSD,
    USDC: juiceDollarAddresses.USDC ?? "",
    USDT: juiceDollarAddresses.USDT ?? "",
    CTUSD: juiceDollarAddresses.CTUSD ?? "",
    // From @juiceswapxyz/sdk-core
    WCBTC: wcbtc.address,
    // Hardcoded — not in any package yet (only deployed on mainnet)
    SY_BTC: chainId === ChainId.CITREA_MAINNET ? SY_BTC_MAINNET : "",
    JUICE_SWAP_GATEWAY: dexAddresses.juiceSwapGatewayAddress ?? "",
    SWAP_ROUTER: dexAddresses.swapRouter02Address ?? "",
    POSITION_MANAGER: dexAddresses.nonfungiblePositionManagerAddress ?? "",
    // Bridge contracts (StablecoinBridge instances from @juicedollar/jusd)
    BRIDGE_SUSD: juiceDollarAddresses.bridgeStartUSD,
    BRIDGE_USDC: juiceDollarAddresses.bridgeUSDC ?? "",
    BRIDGE_USDT: juiceDollarAddresses.bridgeUSDT ?? "",
    BRIDGE_CTUSD: juiceDollarAddresses.bridgeCTUSD ?? "",
  };
}

// Build contract map dynamically from packages
const CONTRACT_MAP: Record<number, ChainContracts> = {};

// Initialize supported chains
const SUPPORTED_JUICE_CHAINS = [ChainId.CITREA_TESTNET, ChainId.CITREA_MAINNET];
for (const chainId of SUPPORTED_JUICE_CHAINS) {
  const contracts = buildChainContracts(chainId);
  if (contracts) {
    CONTRACT_MAP[chainId] = contracts;
  }
}

// Export for backwards compatibility
export const CITREA_TESTNET_CONTRACTS = CONTRACT_MAP[ChainId.CITREA_TESTNET];

/**
 * Get contract addresses for a given chain ID
 * @param chainId - The chain ID to get contracts for
 * @returns Contract addresses or null if chain not supported
 */
export function getChainContracts(chainId: number): ChainContracts | null {
  return CONTRACT_MAP[chainId] || null;
}

/**
 * Check if a chain has JuiceDollar integration configured
 * @param chainId - The chain ID to check
 * @returns true if JuiceDollar contracts are available
 */
export function hasJuiceDollarIntegration(chainId: number): boolean {
  const contracts = getChainContracts(chainId);
  return (
    contracts !== null &&
    contracts.JUSD !== "" &&
    contracts.JUICE_SWAP_GATEWAY !== ""
  );
}

/**
 * Normalize address for comparison (lowercase)
 */
export function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

/**
 * Check if an address is JUSD
 */
export function isJusdAddress(chainId: number, address: string): boolean {
  const contracts = getChainContracts(chainId);
  if (!contracts) return false;
  return normalizeAddress(address) === normalizeAddress(contracts.JUSD);
}

/**
 * Check if an address is svJUSD
 */
export function isSvJusdAddress(chainId: number, address: string): boolean {
  const contracts = getChainContracts(chainId);
  if (!contracts) return false;
  return normalizeAddress(address) === normalizeAddress(contracts.SV_JUSD);
}

/**
 * Check if an address is JUICE
 */
export function isJuiceAddress(chainId: number, address: string): boolean {
  const contracts = getChainContracts(chainId);
  if (!contracts) return false;
  return normalizeAddress(address) === normalizeAddress(contracts.JUICE);
}

/**
 * Check if an address is SUSD (StartUSD)
 */
export function isSusdAddress(chainId: number, address: string): boolean {
  const contracts = getChainContracts(chainId);
  if (!contracts || !contracts.SUSD) return false;
  return normalizeAddress(address) === normalizeAddress(contracts.SUSD);
}

/**
 * Check if an address is USDC
 */
export function isUsdcAddress(chainId: number, address: string): boolean {
  const contracts = getChainContracts(chainId);
  if (!contracts || !contracts.USDC) return false;
  return normalizeAddress(address) === normalizeAddress(contracts.USDC);
}

/**
 * Check if an address is USDT
 */
export function isUsdtAddress(chainId: number, address: string): boolean {
  const contracts = getChainContracts(chainId);
  if (!contracts || !contracts.USDT) return false;
  return normalizeAddress(address) === normalizeAddress(contracts.USDT);
}

/**
 * Check if an address is CTUSD
 */
export function isCtusdAddress(chainId: number, address: string): boolean {
  const contracts = getChainContracts(chainId);
  if (!contracts || !contracts.CTUSD) return false;
  return normalizeAddress(address) === normalizeAddress(contracts.CTUSD);
}

/**
 * Check if an address is a bridged stablecoin (SUSD, USDC, USDT, CTUSD)
 * These are stablecoins that bridge to JUSD via registered bridges on the Gateway
 */
export function isBridgedStablecoin(chainId: number, address: string): boolean {
  return (
    isSusdAddress(chainId, address) ||
    isUsdcAddress(chainId, address) ||
    isUsdtAddress(chainId, address) ||
    isCtusdAddress(chainId, address)
  );
}

/**
 * Check if an address is any USD-pegged token (JUSD, svJUSD, or bridged stablecoins)
 * This includes all tokens that can be swapped 1:1 via the Gateway
 */
export function isUsdToken(chainId: number, address: string): boolean {
  return (
    isJusdAddress(chainId, address) ||
    isSvJusdAddress(chainId, address) ||
    isBridgedStablecoin(chainId, address)
  );
}

/**
 * Detect which JuiceDollar token type an address is
 * @returns 'JUSD' | 'SV_JUSD' | 'JUICE' | 'SUSD' | 'USDC' | 'USDT' | 'CTUSD' | null
 */
export function detectJuiceDollarToken(
  chainId: number,
  address: string,
): "JUSD" | "SV_JUSD" | "JUICE" | "SUSD" | "USDC" | "USDT" | "CTUSD" | null {
  if (isJusdAddress(chainId, address)) return "JUSD";
  if (isSvJusdAddress(chainId, address)) return "SV_JUSD";
  if (isJuiceAddress(chainId, address)) return "JUICE";
  if (isSusdAddress(chainId, address)) return "SUSD";
  if (isUsdcAddress(chainId, address)) return "USDC";
  if (isUsdtAddress(chainId, address)) return "USDT";
  if (isCtusdAddress(chainId, address)) return "CTUSD";
  return null;
}

/**
 * TickLens contract addresses per chain.
 * Used by the poolTicks endpoint to read populated ticks.
 */
const TICK_LENS_ADDRESSES: Record<number, string> = {
  4114: "0xD9d430f27F922A3316d22Cd9d58558f45Dad8012",
  5115: "0x00Ba410Bd715d0D9F9eFAbC65c7df8F0C5D4E7Eb",
};

/**
 * Get the TickLens contract address for a given chain ID.
 * Returns undefined if no TickLens is deployed on that chain.
 */
export function getTickLensAddress(chainId: number): string | undefined {
  return TICK_LENS_ADDRESSES[chainId];
}
