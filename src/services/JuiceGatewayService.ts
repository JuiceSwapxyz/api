import { ethers } from 'ethers';
import { ChainId } from '@juiceswapxyz/sdk-core';
import Logger from 'bunyan';
import {
  getChainContracts,
  hasJuiceDollarIntegration,
  isJusdAddress,
  isJuiceAddress,
  isSusdAddress,
  ChainContracts,
} from '../config/contracts';

/**
 * ABI fragments for JuiceSwapGateway contract
 */
const GATEWAY_ABI = [
  // View functions for conversion rates
  'function jusdToSvJusd(uint256 jusdAmount) view returns (uint256)',
  'function svJusdToJusd(uint256 svJusdAmount) view returns (uint256)',
  'function jusdToJuice(uint256 jusdAmount) view returns (uint256)',
  'function juiceToJusd(uint256 juiceAmount) view returns (uint256)',
  // Swap function
  'function swapExactTokensForTokens(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minAmountOut, address to, uint256 deadline) payable returns (uint256)',
  // LP functions
  'function addLiquidity(address tokenA, address tokenB, uint24 fee, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) payable returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function increaseLiquidity(uint256 tokenId, address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, uint256 deadline) payable returns (uint256 amountA, uint256 amountB, uint128 liquidity)',
  'function removeLiquidity(uint256 tokenId, uint128 liquidityToRemove, address tokenA, address tokenB, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB)',
  // Settings
  'function defaultFee() view returns (uint24)',
];

/**
 * ABI fragments for JUICE Equity contract
 */
const EQUITY_ABI = [
  'function invest(uint256 amount, uint256 expectedShares) returns (uint256)',
  'function redeem(address target, uint256 shares) returns (uint256)',
  'function calculateProceeds(uint256 shares) view returns (uint256)',
  'function calculateShares(uint256 investment) view returns (uint256)',
];

export interface GatewayQuoteResult {
  internalTokenIn: string;
  internalTokenOut: string;
  internalAmountIn: string;
  expectedOutput: string;
  routingType: 'GATEWAY_JUSD' | 'GATEWAY_JUICE_OUT' | 'GATEWAY_JUICE_IN';
}

export interface GatewaySwapParams {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amountIn: string;
  minAmountOut: string;
  recipient: string;
  deadline: number;
}

export interface EquityRedeemParams {
  juiceAmount: string;
  recipient: string;
}

export interface GatewayLpParams {
  tokenA: string;
  tokenB: string;
  fee: number;
  amountADesired: string;
  amountBDesired: string;
  amountAMin: string;
  amountBMin: string;
  recipient: string;
  deadline: number;
}

export interface GatewayIncreaseLiquidityParams {
  tokenId: string;
  tokenA: string;
  tokenB: string;
  amountADesired: string;
  amountBDesired: string;
  amountAMin: string;
  amountBMin: string;
  deadline: number;
}

export interface GatewayRemoveLiquidityParams {
  tokenId: string;
  liquidityToRemove: string; // 0 = remove all
  tokenA: string;
  tokenB: string;
  amountAMin: string;
  amountBMin: string;
  recipient: string;
  deadline: number;
}

/**
 * JuiceGatewayService - Handles JuiceDollar integration for swaps
 *
 * This service provides:
 * 1. Detection of JUSD/JUICE tokens in swap requests
 * 2. Conversion calculations (JUSD ↔ svJUSD, JUSD ↔ JUICE)
 * 3. Transaction calldata building for Gateway and Equity contracts
 *
 * The goal is to abstract away svJUSD from users - they interact with JUSD,
 * but all pools use svJUSD internally for capital efficiency.
 */
export class JuiceGatewayService {
  private logger: Logger;
  private gatewayContracts: Map<ChainId, ethers.Contract> = new Map();
  private equityContracts: Map<ChainId, ethers.Contract> = new Map();

  constructor(
    providers: Map<ChainId, ethers.providers.StaticJsonRpcProvider>,
    logger: Logger
  ) {
    this.logger = logger.child({ service: 'JuiceGatewayService' });

    // Initialize contracts for chains with JuiceDollar integration
    for (const [chainId, provider] of providers) {
      const contracts = getChainContracts(chainId);
      if (contracts && hasJuiceDollarIntegration(chainId)) {
        this.initializeContracts(chainId, provider, contracts);
      }
    }
  }

  private initializeContracts(
    chainId: ChainId,
    provider: ethers.providers.StaticJsonRpcProvider,
    contracts: ChainContracts
  ): void {
    this.gatewayContracts.set(
      chainId,
      new ethers.Contract(contracts.JUICE_SWAP_GATEWAY, GATEWAY_ABI, provider)
    );
    this.equityContracts.set(
      chainId,
      new ethers.Contract(contracts.JUICE, EQUITY_ABI, provider)
    );
    this.logger.info({ chainId }, 'JuiceDollar contracts initialized');
  }

  /**
   * Check if a token requires Gateway routing
   * @returns Routing type or null if standard routing should be used
   *
   * SUSD (StartUSD) is handled via Gateway's registerBridgedToken() mechanism.
   * When SUSD is registered as a bridged token, the Gateway automatically:
   * - Input: SUSD → bridge.mint() → JUSD → svJUSD
   * - Output: svJUSD → JUSD → bridge.burnAndSend() → SUSD
   */
  detectRoutingType(
    chainId: number,
    tokenIn: string,
    tokenOut: string
  ): 'GATEWAY_JUSD' | 'GATEWAY_JUICE_OUT' | 'GATEWAY_JUICE_IN' | null {
    if (!hasJuiceDollarIntegration(chainId)) {
      return null;
    }

    const isJusdIn = isJusdAddress(chainId, tokenIn);
    const isJusdOut = isJusdAddress(chainId, tokenOut);
    const isJuiceIn = isJuiceAddress(chainId, tokenIn);
    const isJuiceOut = isJuiceAddress(chainId, tokenOut);
    const isSusdIn = isSusdAddress(chainId, tokenIn);
    const isSusdOut = isSusdAddress(chainId, tokenOut);

    // JUICE as input - route through Equity.redeem()
    if (isJuiceIn) {
      return 'GATEWAY_JUICE_IN';
    }

    // JUICE as output - route through Gateway (which calls Equity.invest())
    if (isJuiceOut) {
      return 'GATEWAY_JUICE_OUT';
    }

    // JUSD or SUSD involved - route through Gateway
    // SUSD is handled via Gateway's registerBridgedToken() mechanism
    if (isJusdIn || isJusdOut || isSusdIn || isSusdOut) {
      return 'GATEWAY_JUSD';
    }

    return null;
  }

  /**
   * Get default fee tier from Gateway
   */
  async getDefaultFee(chainId: ChainId): Promise<number> {
    const contract = this.gatewayContracts.get(chainId);
    if (!contract) return 3000; // Default 0.3%

    try {
      const fee = await contract.defaultFee();
      return (fee as ethers.BigNumber).toNumber();
    } catch (error) {
      this.logger.warn({ chainId, error }, 'Failed to get default fee, using 3000');
      return 3000;
    }
  }

  // ============================================
  // Conversion Functions
  // ============================================

  /**
   * Convert JUSD amount to svJUSD shares
   */
  async jusdToSvJusd(chainId: ChainId, jusdAmount: string): Promise<string> {
    const contract = this.gatewayContracts.get(chainId);
    if (!contract) {
      throw new Error(`No Gateway contract for chain ${chainId}`);
    }

    try {
      const shares = await contract.jusdToSvJusd(jusdAmount);
      return shares.toString();
    } catch (error) {
      this.logger.error({ chainId, jusdAmount, error }, 'jusdToSvJusd failed');
      throw error;
    }
  }

  /**
   * Convert svJUSD shares to JUSD amount
   */
  async svJusdToJusd(chainId: ChainId, svJusdAmount: string): Promise<string> {
    const contract = this.gatewayContracts.get(chainId);
    if (!contract) {
      throw new Error(`No Gateway contract for chain ${chainId}`);
    }

    try {
      const assets = await contract.svJusdToJusd(svJusdAmount);
      return assets.toString();
    } catch (error) {
      this.logger.error({ chainId, svJusdAmount, error }, 'svJusdToJusd failed');
      throw error;
    }
  }

  /**
   * Calculate JUICE received when investing JUSD
   */
  async jusdToJuice(chainId: ChainId, jusdAmount: string): Promise<string> {
    const contract = this.gatewayContracts.get(chainId);
    if (!contract) {
      throw new Error(`No Gateway contract for chain ${chainId}`);
    }

    try {
      const juiceAmount = await contract.jusdToJuice(jusdAmount);
      return juiceAmount.toString();
    } catch (error) {
      this.logger.error({ chainId, jusdAmount, error }, 'jusdToJuice failed');
      throw error;
    }
  }

  /**
   * Calculate JUSD received when redeeming JUICE
   */
  async juiceToJusd(chainId: ChainId, juiceAmount: string): Promise<string> {
    const contract = this.gatewayContracts.get(chainId);
    if (!contract) {
      throw new Error(`No Gateway contract for chain ${chainId}`);
    }

    try {
      const jusdAmount = await contract.juiceToJusd(juiceAmount);
      return jusdAmount.toString();
    } catch (error) {
      this.logger.error({ chainId, juiceAmount, error }, 'juiceToJusd failed');
      throw error;
    }
  }

  /**
   * Calculate expected JUSD from Equity.redeem()
   * Uses Equity.calculateProceeds() for accurate estimation
   */
  async calculateRedeemProceeds(chainId: ChainId, juiceShares: string): Promise<string> {
    const contract = this.equityContracts.get(chainId);
    if (!contract) {
      throw new Error(`No Equity contract for chain ${chainId}`);
    }

    try {
      const proceeds = await contract.calculateProceeds(juiceShares);
      return proceeds.toString();
    } catch (error) {
      this.logger.error({ chainId, juiceShares, error }, 'calculateRedeemProceeds failed');
      throw error;
    }
  }

  // ============================================
  // Transaction Building
  // ============================================

  /**
   * Build Gateway swap transaction calldata
   */
  buildGatewaySwapCalldata(params: GatewaySwapParams): string {
    const iface = new ethers.utils.Interface(GATEWAY_ABI);
    return iface.encodeFunctionData('swapExactTokensForTokens', [
      params.tokenIn,
      params.tokenOut,
      params.fee,
      params.amountIn,
      params.minAmountOut,
      params.recipient,
      params.deadline,
    ]);
  }

  /**
   * Build Equity.redeem() calldata for JUICE input swaps
   */
  buildEquityRedeemCalldata(params: EquityRedeemParams): string {
    const iface = new ethers.utils.Interface(EQUITY_ABI);
    return iface.encodeFunctionData('redeem', [
      params.recipient,
      params.juiceAmount,
    ]);
  }

  /**
   * Get Gateway contract address for a chain
   */
  getGatewayAddress(chainId: number): string | null {
    const contracts = getChainContracts(chainId);
    return contracts?.JUICE_SWAP_GATEWAY || null;
  }

  /**
   * Get Equity (JUICE) contract address for a chain
   */
  getEquityAddress(chainId: number): string | null {
    const contracts = getChainContracts(chainId);
    return contracts?.JUICE || null;
  }

  /**
   * Get svJUSD address for a chain
   */
  getSvJusdAddress(chainId: number): string | null {
    const contracts = getChainContracts(chainId);
    return contracts?.SV_JUSD || null;
  }

  /**
   * Get JUSD address for a chain
   */
  getJusdAddress(chainId: number): string | null {
    const contracts = getChainContracts(chainId);
    return contracts?.JUSD || null;
  }

  // ============================================
  // Quote Preparation
  // ============================================

  /**
   * Prepare quote parameters for Gateway routing
   *
   * This converts user-facing tokens to internal pool tokens:
   * - JUSD input → svJUSD for routing
   * - JUSD output → svJUSD for routing, then convert result back
   * - JUICE output → route to svJUSD, then calculate JUICE via Equity
   * - JUICE input → calculate JUSD via Equity.calculateProceeds(), then route
   *
   * @returns Internal tokens and amounts for routing, plus routing type
   */
  async prepareQuote(
    chainId: ChainId,
    tokenIn: string,
    tokenOut: string,
    amountIn: string
  ): Promise<GatewayQuoteResult | null> {
    const routingType = this.detectRoutingType(chainId, tokenIn, tokenOut);
    if (!routingType) return null;

    const contracts = getChainContracts(chainId);
    if (!contracts) return null;

    let internalTokenIn = tokenIn;
    let internalTokenOut = tokenOut;
    let internalAmountIn = amountIn;

    switch (routingType) {
      case 'GATEWAY_JUSD':
        // JUSD or SUSD input/output - convert to svJUSD for internal routing
        // SUSD is 1:1 with JUSD via StablecoinBridge (both 18 decimals)
        if (isJusdAddress(chainId, tokenIn) || isSusdAddress(chainId, tokenIn)) {
          internalTokenIn = contracts.SV_JUSD;
          internalAmountIn = await this.jusdToSvJusd(chainId, amountIn);
        }
        if (isJusdAddress(chainId, tokenOut) || isSusdAddress(chainId, tokenOut)) {
          internalTokenOut = contracts.SV_JUSD;
        }
        break;

      case 'GATEWAY_JUICE_OUT':
        // Buying JUICE - route to svJUSD first
        // Also handle SUSD input (1:1 with JUSD)
        if (isJusdAddress(chainId, tokenIn) || isSusdAddress(chainId, tokenIn)) {
          internalTokenIn = contracts.SV_JUSD;
          internalAmountIn = await this.jusdToSvJusd(chainId, amountIn);
        }
        // Output is svJUSD internally, then converted to JUICE
        internalTokenOut = contracts.SV_JUSD;
        break;

      case 'GATEWAY_JUICE_IN': {
        // JUICE can only be swapped directly to JUSD
        // Multi-hop swaps (JUICE → X where X is not JUSD) are not supported
        // Users must manually redeem JUICE for JUSD first, then swap JUSD → X
        if (!isJusdAddress(chainId, tokenOut)) {
          return null; // Signal unsupported - will fall through to NO_ROUTE
        }
        // Selling JUICE - first get JUSD via Equity.redeem()
        const jusdFromRedeem = await this.calculateRedeemProceeds(chainId, amountIn);
        internalTokenIn = contracts.SV_JUSD;
        internalAmountIn = await this.jusdToSvJusd(chainId, jusdFromRedeem);
        internalTokenOut = contracts.SV_JUSD;
        break;
      }
    }

    return {
      internalTokenIn,
      internalTokenOut,
      internalAmountIn,
      expectedOutput: '0', // To be filled by router
      routingType,
    };
  }

  /**
   * Convert router output back to user-facing token amount
   *
   * @param chainId Chain ID
   * @param tokenOut User's desired output token
   * @param routerOutput Router's output amount (in internal tokens)
   * @param routingType The routing type used
   * @returns User-facing output amount
   */
  async convertOutputToUserToken(
    chainId: ChainId,
    tokenOut: string,
    routerOutput: string,
    routingType: 'GATEWAY_JUSD' | 'GATEWAY_JUICE_OUT' | 'GATEWAY_JUICE_IN'
  ): Promise<string> {
    switch (routingType) {
      case 'GATEWAY_JUSD':
        // If output is JUSD or SUSD, convert from svJUSD
        // SUSD is 1:1 with JUSD (both 18 decimals), so same conversion applies
        if (isJusdAddress(chainId, tokenOut) || isSusdAddress(chainId, tokenOut)) {
          return await this.svJusdToJusd(chainId, routerOutput);
        }
        return routerOutput;

      case 'GATEWAY_JUICE_OUT': {
        // Convert svJUSD output to JUICE via Equity
        const jusdOutput = await this.svJusdToJusd(chainId, routerOutput);
        return await this.jusdToJuice(chainId, jusdOutput);
      }

      case 'GATEWAY_JUICE_IN':
        // If output is JUSD or SUSD, convert from svJUSD
        if (isJusdAddress(chainId, tokenOut) || isSusdAddress(chainId, tokenOut)) {
          return await this.svJusdToJusd(chainId, routerOutput);
        }
        return routerOutput;

      default:
        return routerOutput;
    }
  }

  // ============================================
  // LP (Liquidity Provision) Functions
  // ============================================

  /**
   * Check if LP operation involves JUSD and should route through Gateway
   * @returns true if either token is JUSD (requires Gateway for JUSD → svJUSD conversion)
   */
  detectLpGatewayRouting(chainId: number, tokenA: string, tokenB: string): boolean {
    if (!hasJuiceDollarIntegration(chainId)) {
      return false;
    }
    return isJusdAddress(chainId, tokenA) || isJusdAddress(chainId, tokenB);
  }

  /**
   * Check if tick range is full-range (or near full-range)
   * Gateway.addLiquidity() only supports full-range positions.
   *
   * @param tickLower The lower tick
   * @param tickUpper The upper tick
   * @param tickSpacing The tick spacing for the fee tier
   * @returns true if ticks represent a full-range position
   */
  isFullRangeTicks(tickLower: number, tickUpper: number, tickSpacing: number): boolean {
    // Uniswap V3 tick bounds
    const MIN_TICK = -887272;
    const MAX_TICK = 887272;

    // Calculate full-range ticks for this spacing
    const fullRangeLower = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
    const fullRangeUpper = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;

    // Allow some tolerance (within 2 tick spacings of full range)
    const tolerance = tickSpacing * 2;
    const isLowerFullRange = Math.abs(tickLower - fullRangeLower) <= tolerance;
    const isUpperFullRange = Math.abs(tickUpper - fullRangeUpper) <= tolerance;

    return isLowerFullRange && isUpperFullRange;
  }

  /**
   * Build Gateway.addLiquidity() calldata
   * User provides JUSD amounts, Gateway converts to svJUSD internally
   */
  buildGatewayAddLiquidityCalldata(params: GatewayLpParams): string {
    const iface = new ethers.utils.Interface(GATEWAY_ABI);
    return iface.encodeFunctionData('addLiquidity', [
      params.tokenA,
      params.tokenB,
      params.fee,
      params.amountADesired,
      params.amountBDesired,
      params.amountAMin,
      params.amountBMin,
      params.recipient,
      params.deadline,
    ]);
  }

  /**
   * Build Gateway.increaseLiquidity() calldata
   * Increases liquidity for an existing position with automatic JUSD→svJUSD conversion
   */
  buildGatewayIncreaseLiquidityCalldata(params: GatewayIncreaseLiquidityParams): string {
    const iface = new ethers.utils.Interface(GATEWAY_ABI);
    return iface.encodeFunctionData('increaseLiquidity', [
      params.tokenId,
      params.tokenA,
      params.tokenB,
      params.amountADesired,
      params.amountBDesired,
      params.amountAMin,
      params.amountBMin,
      params.deadline,
    ]);
  }

  /**
   * Build Gateway.removeLiquidity() calldata
   * Removes liquidity from a position with automatic svJUSD→JUSD conversion
   * @param params.liquidityToRemove - Amount of liquidity to remove (0 = remove all)
   */
  buildGatewayRemoveLiquidityCalldata(params: GatewayRemoveLiquidityParams): string {
    const iface = new ethers.utils.Interface(GATEWAY_ABI);
    return iface.encodeFunctionData('removeLiquidity', [
      params.tokenId,
      params.liquidityToRemove,
      params.tokenA,
      params.tokenB,
      params.amountAMin,
      params.amountBMin,
      params.recipient,
      params.deadline,
    ]);
  }

  /**
   * Convert token address to internal pool token
   * JUSD → svJUSD for LP operations
   */
  getInternalPoolToken(chainId: number, token: string): string {
    const contracts = getChainContracts(chainId);
    if (!contracts) return token;

    if (isJusdAddress(chainId, token)) {
      return contracts.SV_JUSD;
    }
    return token;
  }
}
