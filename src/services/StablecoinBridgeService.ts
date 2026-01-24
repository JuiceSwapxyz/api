import { ethers } from 'ethers';
import { ChainId } from '@juiceswapxyz/sdk-core';
import Logger from 'bunyan';
import {
  getChainContracts,
  isSusdAddress,
  isJusdAddress,
  isStablecoinBridgeSwap,
  ChainContracts,
} from '../config/contracts';

/**
 * ABI fragments for StablecoinBridge contract
 * The bridge allows 1:1 swaps between SUSD and JUSD
 */
const STABLECOIN_BRIDGE_ABI = [
  // Mint JUSD from SUSD (SUSD → JUSD)
  'function mint(uint256 amount) external',
  'function mintTo(address target, uint256 amount) external',
  // Burn JUSD to get SUSD (JUSD → SUSD)
  'function burn(uint256 amount) external',
  'function burnAndSend(address target, uint256 amount) external',
  // View functions
  'function JUSD() view returns (address)',
  'function usd() view returns (address)',
  'function horizon() view returns (uint256)',
  'function limit() view returns (uint256)',
  'function minted() view returns (uint256)',
];

export interface StablecoinBridgeQuoteResult {
  inputToken: string;
  outputToken: string;
  inputAmount: string;
  outputAmount: string; // Same as input (1:1)
  bridgeFunction: 'mint' | 'burn';
  routingType: 'STABLECOIN_BRIDGE';
}

export interface StablecoinBridgeSwapParams {
  direction: 'mint' | 'burn';
  amount: string;
  recipient?: string; // If specified, uses mintTo/burnAndSend
}

/**
 * StablecoinBridgeService - Handles SUSD ↔ JUSD 1:1 bridge swaps
 *
 * This service provides:
 * 1. Detection of SUSD ↔ JUSD swap requests
 * 2. 1:1 quote generation (no slippage, no routing needed)
 * 3. Transaction calldata building for mint/burn operations
 *
 * The StablecoinBridge contract allows users to:
 * - mint(): Convert SUSD → JUSD (1:1)
 * - burn(): Convert JUSD → SUSD (1:1)
 */
export class StablecoinBridgeService {
  private logger: Logger;
  private bridgeContracts: Map<ChainId, ethers.Contract> = new Map();

  constructor(
    providers: Map<ChainId, ethers.providers.StaticJsonRpcProvider>,
    logger: Logger
  ) {
    this.logger = logger.child({ service: 'StablecoinBridgeService' });

    // Initialize contracts for chains with Stablecoin Bridge
    for (const [chainId, provider] of providers) {
      const contracts = getChainContracts(chainId);
      if (contracts && contracts.STABLECOIN_BRIDGE) {
        this.initializeContracts(chainId, provider, contracts);
      }
    }
  }

  private initializeContracts(
    chainId: ChainId,
    provider: ethers.providers.StaticJsonRpcProvider,
    contracts: ChainContracts
  ): void {
    this.bridgeContracts.set(
      chainId,
      new ethers.Contract(contracts.STABLECOIN_BRIDGE, STABLECOIN_BRIDGE_ABI, provider)
    );
    this.logger.info({ chainId, bridgeAddress: contracts.STABLECOIN_BRIDGE }, 'StablecoinBridge contract initialized');
  }

  /**
   * Check if this swap should be routed through the Stablecoin Bridge
   * @returns 'STABLECOIN_BRIDGE' if SUSD ↔ JUSD, null otherwise
   */
  detectRoutingType(
    chainId: number,
    tokenIn: string,
    tokenOut: string
  ): 'STABLECOIN_BRIDGE' | null {
    if (isStablecoinBridgeSwap(chainId, tokenIn, tokenOut)) {
      return 'STABLECOIN_BRIDGE';
    }
    return null;
  }

  /**
   * Determine bridge function based on token direction
   * @returns 'mint' for SUSD→JUSD, 'burn' for JUSD→SUSD
   */
  getBridgeFunction(chainId: number, tokenIn: string, tokenOut: string): 'mint' | 'burn' | null {
    if (!isStablecoinBridgeSwap(chainId, tokenIn, tokenOut)) {
      return null;
    }

    // SUSD → JUSD = mint
    if (isSusdAddress(chainId, tokenIn) && isJusdAddress(chainId, tokenOut)) {
      return 'mint';
    }

    // JUSD → SUSD = burn
    if (isJusdAddress(chainId, tokenIn) && isSusdAddress(chainId, tokenOut)) {
      return 'burn';
    }

    return null;
  }

  // ============================================
  // View Functions
  // ============================================

  /**
   * Get bridge expiration timestamp
   */
  async getHorizon(chainId: ChainId): Promise<number> {
    const contract = this.bridgeContracts.get(chainId);
    if (!contract) {
      throw new Error(`No StablecoinBridge contract for chain ${chainId}`);
    }

    try {
      const horizon = await contract.horizon();
      return (horizon as ethers.BigNumber).toNumber();
    } catch (error) {
      this.logger.error({ chainId, error }, 'Failed to get bridge horizon');
      throw error;
    }
  }

  /**
   * Get maximum mint limit
   */
  async getLimit(chainId: ChainId): Promise<string> {
    const contract = this.bridgeContracts.get(chainId);
    if (!contract) {
      throw new Error(`No StablecoinBridge contract for chain ${chainId}`);
    }

    try {
      const limit = await contract.limit();
      return limit.toString();
    } catch (error) {
      this.logger.error({ chainId, error }, 'Failed to get bridge limit');
      throw error;
    }
  }

  /**
   * Get current minted amount
   */
  async getMinted(chainId: ChainId): Promise<string> {
    const contract = this.bridgeContracts.get(chainId);
    if (!contract) {
      throw new Error(`No StablecoinBridge contract for chain ${chainId}`);
    }

    try {
      const minted = await contract.minted();
      return minted.toString();
    } catch (error) {
      this.logger.error({ chainId, error }, 'Failed to get minted amount');
      throw error;
    }
  }

  /**
   * Check if bridge is expired
   */
  async isExpired(chainId: ChainId): Promise<boolean> {
    try {
      const horizon = await this.getHorizon(chainId);
      return Date.now() / 1000 > horizon;
    } catch {
      return true; // Assume expired on error
    }
  }

  /**
   * Check if mint would exceed limit
   */
  async wouldExceedLimit(chainId: ChainId, amount: string): Promise<boolean> {
    try {
      const [limit, minted] = await Promise.all([
        this.getLimit(chainId),
        this.getMinted(chainId),
      ]);
      const newTotal = ethers.BigNumber.from(minted).add(amount);
      return newTotal.gt(limit);
    } catch {
      return true; // Assume would exceed on error
    }
  }

  // ============================================
  // Quote Generation
  // ============================================

  /**
   * Generate a 1:1 quote for Stablecoin Bridge swap
   * No actual routing needed - it's always 1:1
   */
  async getQuote(
    chainId: ChainId,
    tokenIn: string,
    tokenOut: string,
    amountIn: string
  ): Promise<StablecoinBridgeQuoteResult | null> {
    const bridgeFunction = this.getBridgeFunction(chainId, tokenIn, tokenOut);
    if (!bridgeFunction) {
      return null;
    }

    // Check bridge constraints for mint operations
    if (bridgeFunction === 'mint') {
      const [isExpired, wouldExceed] = await Promise.all([
        this.isExpired(chainId),
        this.wouldExceedLimit(chainId, amountIn),
      ]);

      if (isExpired) {
        this.logger.warn({ chainId }, 'StablecoinBridge has expired');
        return null;
      }

      if (wouldExceed) {
        this.logger.warn({ chainId, amountIn }, 'Mint would exceed bridge limit');
        return null;
      }
    }

    // 1:1 quote - output equals input
    return {
      inputToken: tokenIn,
      outputToken: tokenOut,
      inputAmount: amountIn,
      outputAmount: amountIn, // 1:1 ratio
      bridgeFunction,
      routingType: 'STABLECOIN_BRIDGE',
    };
  }

  // ============================================
  // Transaction Building
  // ============================================

  /**
   * Build mint calldata (SUSD → JUSD)
   */
  buildMintCalldata(amount: string, recipient?: string): string {
    const iface = new ethers.utils.Interface(STABLECOIN_BRIDGE_ABI);
    if (recipient) {
      return iface.encodeFunctionData('mintTo', [recipient, amount]);
    }
    return iface.encodeFunctionData('mint', [amount]);
  }

  /**
   * Build burn calldata (JUSD → SUSD)
   */
  buildBurnCalldata(amount: string, recipient?: string): string {
    const iface = new ethers.utils.Interface(STABLECOIN_BRIDGE_ABI);
    if (recipient) {
      return iface.encodeFunctionData('burnAndSend', [recipient, amount]);
    }
    return iface.encodeFunctionData('burn', [amount]);
  }

  /**
   * Build swap calldata based on direction
   */
  buildSwapCalldata(params: StablecoinBridgeSwapParams): string {
    if (params.direction === 'mint') {
      return this.buildMintCalldata(params.amount, params.recipient);
    }
    return this.buildBurnCalldata(params.amount, params.recipient);
  }

  /**
   * Get Stablecoin Bridge contract address for a chain
   */
  getBridgeAddress(chainId: number): string | null {
    const contracts = getChainContracts(chainId);
    return contracts?.STABLECOIN_BRIDGE || null;
  }

  /**
   * Get SUSD address for a chain
   */
  getSusdAddress(chainId: number): string | null {
    const contracts = getChainContracts(chainId);
    return contracts?.SUSD || null;
  }

  /**
   * Get JUSD address for a chain
   */
  getJusdAddress(chainId: number): string | null {
    const contracts = getChainContracts(chainId);
    return contracts?.JUSD || null;
  }

  /**
   * Get the token that needs approval for a bridge swap
   * - For mint (SUSD→JUSD): SUSD needs approval to bridge contract
   * - For burn (JUSD→SUSD): JUSD needs approval to bridge contract
   */
  getApprovalToken(chainId: number, direction: 'mint' | 'burn'): string | null {
    if (direction === 'mint') {
      return this.getSusdAddress(chainId);
    }
    return this.getJusdAddress(chainId);
  }
}
