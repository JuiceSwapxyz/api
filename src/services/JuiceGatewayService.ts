import { ethers } from "ethers";
import { ChainId } from "@juiceswapxyz/sdk-core";
import Logger from "bunyan";
import {
  getChainContracts,
  hasJuiceDollarIntegration,
  isJusdAddress,
  isJuiceAddress,
  isSvJusdAddress,
  isUsdToken,
  isBridgedStablecoin,
  ChainContracts,
} from "../config/contracts";
import { JuiceSwapGatewayAbi } from "../abi/JuiceSwapGateway";

/**
 * ABI fragments for JUICE Equity contract
 */
const EQUITY_ABI = [
  "function invest(uint256 amount, uint256 expectedShares) returns (uint256)",
  "function redeem(address target, uint256 shares) returns (uint256)",
  "function calculateProceeds(uint256 shares) view returns (uint256)",
  "function calculateShares(uint256 investment) view returns (uint256)",
];

export interface GatewayQuoteResult {
  internalTokenIn: string;
  internalTokenOut: string;
  internalAmountIn: string;
  expectedOutput: string;
  routingType: "GATEWAY_JUSD" | "GATEWAY_JUICE_OUT" | "GATEWAY_JUICE_IN";
  isDirectConversion?: boolean; // True for direct USD↔USD conversions (no pool routing needed)
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
  tickLower: number;
  tickUpper: number;
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

export interface BridgeStatus {
  canMint: boolean;
  canBurn: boolean;
  mintCapacity: string;
  burnCapacity: string;
  mintBlockReason: string;
  burnBlockReason: string;
}

export class BridgeLiquidityError extends Error {
  code = "INSUFFICIENT_BRIDGE_LIQUIDITY";
  available?: string;
  required?: string;

  constructor(reason?: string, available?: string, required?: string) {
    super(reason || "Insufficient bridge liquidity");
    this.name = "BridgeLiquidityError";
    this.available = available;
    this.required = required;
  }
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
    logger: Logger,
  ) {
    this.logger = logger.child({ service: "JuiceGatewayService" });

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
    contracts: ChainContracts,
  ): void {
    this.gatewayContracts.set(
      chainId,
      new ethers.Contract(
        contracts.JUICE_SWAP_GATEWAY,
        JuiceSwapGatewayAbi,
        provider,
      ),
    );
    this.equityContracts.set(
      chainId,
      new ethers.Contract(contracts.JUICE, EQUITY_ABI, provider),
    );
    this.logger.info({ chainId }, "JuiceDollar contracts initialized");
  }

  /**
   * Check if a token requires Gateway routing
   * @returns Routing type or null if standard routing should be used
   *
   * All bridged stablecoins (SUSD, USDC, USDT, CTUSD) are handled via Gateway's
   * registerBridgedToken() mechanism. When a bridge is registered, the Gateway automatically:
   * - Input: BridgedToken → bridge.mint() → JUSD → svJUSD
   * - Output: svJUSD → JUSD → bridge.burnAndSend() → BridgedToken
   */
  detectRoutingType(
    chainId: number,
    tokenIn: string,
    tokenOut: string,
  ): "GATEWAY_JUSD" | "GATEWAY_JUICE_OUT" | "GATEWAY_JUICE_IN" | null {
    if (!hasJuiceDollarIntegration(chainId)) {
      return null;
    }

    const isJuiceIn = isJuiceAddress(chainId, tokenIn);
    const isJuiceOut = isJuiceAddress(chainId, tokenOut);

    // Check if either token is a USD token (JUSD, svJUSD, or any bridged stablecoin)
    const isUsdIn = isUsdToken(chainId, tokenIn);
    const isUsdOut = isUsdToken(chainId, tokenOut);

    // JUICE as input - route through Equity.redeem()
    if (isJuiceIn) {
      return "GATEWAY_JUICE_IN";
    }

    // JUICE as output - route through Gateway (which calls Equity.invest())
    if (isJuiceOut) {
      return "GATEWAY_JUICE_OUT";
    }

    // Any USD token involved - route through Gateway
    // This includes JUSD, svJUSD, SUSD, USDC, USDT, CTUSD
    if (isUsdIn || isUsdOut) {
      return "GATEWAY_JUSD";
    }

    return null;
  }

  /**
   * Check if this is a direct USD-to-USD conversion
   * Direct conversions don't need pool routing - they go through the Gateway bridges only
   */
  isDirectUsdConversion(
    chainId: number,
    tokenIn: string,
    tokenOut: string,
  ): boolean {
    return isUsdToken(chainId, tokenIn) && isUsdToken(chainId, tokenOut);
  }

  /**
   * Get default fee tier from Gateway
   */
  async getDefaultFee(chainId: ChainId): Promise<number> {
    const contract = this.gatewayContracts.get(chainId);
    if (!contract) return 3000; // Default 0.3%

    try {
      const fee = await contract.DEFAULT_FEE();
      return (fee as ethers.BigNumber).toNumber();
    } catch (error) {
      this.logger.warn(
        { chainId, error },
        "Failed to get default fee, using 3000",
      );
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
      this.logger.error({ chainId, jusdAmount, error }, "jusdToSvJusd failed");
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
      this.logger.error(
        { chainId, svJusdAmount, error },
        "svJusdToJusd failed",
      );
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
      this.logger.error({ chainId, jusdAmount, error }, "jusdToJuice failed");
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
      this.logger.error({ chainId, juiceAmount, error }, "juiceToJusd failed");
      throw error;
    }
  }

  /**
   * Calculate expected JUSD from Equity.redeem()
   * Uses Equity.calculateProceeds() for accurate estimation
   */
  async calculateRedeemProceeds(
    chainId: ChainId,
    juiceShares: string,
  ): Promise<string> {
    const contract = this.equityContracts.get(chainId);
    if (!contract) {
      throw new Error(`No Equity contract for chain ${chainId}`);
    }

    try {
      const proceeds = await contract.calculateProceeds(juiceShares);
      return proceeds.toString();
    } catch (error) {
      this.logger.error(
        { chainId, juiceShares, error },
        "calculateRedeemProceeds failed",
      );
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
    const iface = new ethers.utils.Interface(JuiceSwapGatewayAbi);
    return iface.encodeFunctionData("swapExactTokensForTokens", [
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
    return iface.encodeFunctionData("redeem", [
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

  /**
   * Get bridge status for a bridged token
   */
  async getBridgeStatus(
    chainId: ChainId,
    bridgedToken: string,
  ): Promise<BridgeStatus> {
    const contract = this.gatewayContracts.get(chainId);
    if (!contract) {
      throw new Error(`No Gateway contract for chain ${chainId}`);
    }

    try {
      const status = await contract.getBridgeStatus(bridgedToken);
      return {
        canMint: status.canMint,
        canBurn: status.canBurn,
        mintCapacity: status.mintCapacity.toString(),
        burnCapacity: status.burnCapacity.toString(),
        mintBlockReason: status.mintBlockReason,
        burnBlockReason: status.burnBlockReason,
      };
    } catch (error) {
      this.logger.error(
        { chainId, bridgedToken, error },
        "getBridgeStatus failed",
      );
      throw error;
    }
  }

  /**
   * Check if bridge has sufficient liquidity for a swap
   * @param direction 'burn' for JUSD→bridged, 'mint' for bridged→JUSD
   */
  async checkBridgeLiquidity(
    chainId: ChainId,
    bridgedToken: string,
    amount: string,
    direction: "mint" | "burn",
  ): Promise<void> {
    const status = await this.getBridgeStatus(chainId, bridgedToken);

    if (direction === "burn") {
      // JUSD → bridged token
      if (!status.canBurn) {
        throw new BridgeLiquidityError(
          status.burnBlockReason || "Bridge burn not available",
        );
      }
      const available = ethers.BigNumber.from(status.burnCapacity);
      const required = ethers.BigNumber.from(amount);
      if (required.gt(available)) {
        throw new BridgeLiquidityError(
          "Insufficient bridge liquidity",
          status.burnCapacity,
          amount,
        );
      }
    } else {
      // bridged token → JUSD
      if (!status.canMint) {
        throw new BridgeLiquidityError(
          status.mintBlockReason || "Bridge mint not available",
        );
      }
      // Note: For mint, we'd need to convert amount to JUSD to compare against mintCapacity
      // For now, checking canMint is sufficient as limit checks are complex
    }
  }

  // ============================================
  // Quote Preparation
  // ============================================

  /**
   * Convert bridged stablecoin amount to svJUSD shares
   * Uses Gateway's bridgedToSvJusd() which handles decimal conversion internally
   */
  async bridgedToSvJusd(
    chainId: ChainId,
    bridgedToken: string,
    amount: string,
  ): Promise<string> {
    const contract = this.gatewayContracts.get(chainId);
    if (!contract) throw new Error(`No Gateway contract for chain ${chainId}`);

    try {
      const shares = await contract.bridgedToSvJusd(bridgedToken, amount);
      return shares.toString();
    } catch (error) {
      this.logger.error(
        { chainId, bridgedToken, amount, error },
        "bridgedToSvJusd failed",
      );
      throw error;
    }
  }

  /**
   * Convert svJUSD shares to bridged stablecoin amount
   * Uses Gateway's svJusdToBridged() which handles decimal conversion internally
   */
  async svJusdToBridged(
    chainId: ChainId,
    bridgedToken: string,
    svJusdAmount: string,
  ): Promise<string> {
    const contract = this.gatewayContracts.get(chainId);
    if (!contract) throw new Error(`No Gateway contract for chain ${chainId}`);

    try {
      const amount = await contract.svJusdToBridged(bridgedToken, svJusdAmount);
      return amount.toString();
    } catch (error) {
      this.logger.error(
        { chainId, bridgedToken, svJusdAmount, error },
        "svJusdToBridged failed",
      );
      throw error;
    }
  }

  /**
   * Prepare quote parameters for Gateway routing
   *
   * This converts user-facing tokens to internal pool tokens:
   * - JUSD/bridged stablecoin input → svJUSD for routing
   * - JUSD/bridged stablecoin output → svJUSD for routing, then convert result back
   * - JUICE output → route to svJUSD, then calculate JUICE via Equity
   * - JUICE input → calculate JUSD via Equity.calculateProceeds(), then route
   *
   * For direct USD↔USD conversions (e.g., JUSD↔USDC), no pool routing is needed.
   * The Gateway handles the conversion via bridges.
   *
   * @returns Internal tokens and amounts for routing, plus routing type
   */
  async prepareQuote(
    chainId: ChainId,
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
  ): Promise<GatewayQuoteResult | null> {
    const routingType = this.detectRoutingType(chainId, tokenIn, tokenOut);
    if (!routingType) return null;

    const contracts = getChainContracts(chainId);
    if (!contracts) return null;

    let internalTokenIn = tokenIn;
    let internalTokenOut = tokenOut;
    let internalAmountIn = amountIn;

    // Check if this is a direct USD↔USD conversion (no pool routing needed)
    if (
      routingType === "GATEWAY_JUSD" &&
      this.isDirectUsdConversion(chainId, tokenIn, tokenOut)
    ) {
      // Direct conversion between USD tokens using Gateway view functions
      // Chain the appropriate conversions based on token types
      // Bridge liquidity is checked inline to avoid duplicate RPC calls
      let expectedOutput: string;

      const isBridgedIn = isBridgedStablecoin(chainId, tokenIn);
      const isBridgedOut = isBridgedStablecoin(chainId, tokenOut);
      const isJusdIn = isJusdAddress(chainId, tokenIn);
      const isJusdOut = isJusdAddress(chainId, tokenOut);
      const isSvJusdIn = isSvJusdAddress(chainId, tokenIn);
      const isSvJusdOut = isSvJusdAddress(chainId, tokenOut);

      if (isBridgedIn && isBridgedOut) {
        // Bridged → Bridged: check mint, convert, check burn
        await this.checkBridgeLiquidity(chainId, tokenIn, amountIn, "mint");
        const svJusdAmount = await this.bridgedToSvJusd(
          chainId,
          tokenIn,
          amountIn,
        );
        expectedOutput = await this.svJusdToBridged(
          chainId,
          tokenOut,
          svJusdAmount,
        );
        await this.checkBridgeLiquidity(
          chainId,
          tokenOut,
          expectedOutput,
          "burn",
        );
      } else if (isBridgedIn && isJusdOut) {
        // Bridged → JUSD: check mint, convert
        await this.checkBridgeLiquidity(chainId, tokenIn, amountIn, "mint");
        const svJusdAmount = await this.bridgedToSvJusd(
          chainId,
          tokenIn,
          amountIn,
        );
        expectedOutput = await this.svJusdToJusd(chainId, svJusdAmount);
      } else if (isBridgedIn && isSvJusdOut) {
        // Bridged → svJUSD: check mint, convert
        await this.checkBridgeLiquidity(chainId, tokenIn, amountIn, "mint");
        expectedOutput = await this.bridgedToSvJusd(chainId, tokenIn, amountIn);
      } else if (isJusdIn && isBridgedOut) {
        // JUSD → Bridged: convert, check burn
        const svJusdAmount = await this.jusdToSvJusd(chainId, amountIn);
        expectedOutput = await this.svJusdToBridged(
          chainId,
          tokenOut,
          svJusdAmount,
        );
        await this.checkBridgeLiquidity(
          chainId,
          tokenOut,
          expectedOutput,
          "burn",
        );
      } else if (isSvJusdIn && isBridgedOut) {
        // svJUSD → Bridged: convert, check burn
        expectedOutput = await this.svJusdToBridged(
          chainId,
          tokenOut,
          amountIn,
        );
        await this.checkBridgeLiquidity(
          chainId,
          tokenOut,
          expectedOutput,
          "burn",
        );
      } else if (isJusdIn && isSvJusdOut) {
        // JUSD → svJUSD (no bridge involved)
        expectedOutput = await this.jusdToSvJusd(chainId, amountIn);
      } else if (isSvJusdIn && isJusdOut) {
        // svJUSD → JUSD (no bridge involved)
        expectedOutput = await this.svJusdToJusd(chainId, amountIn);
      } else {
        // Same token (JUSD→JUSD, svJUSD→svJUSD) — amount stays the same
        expectedOutput = amountIn;
      }

      return {
        internalTokenIn: tokenIn,
        internalTokenOut: tokenOut,
        internalAmountIn: amountIn,
        expectedOutput,
        routingType,
        isDirectConversion: true,
      };
    }

    switch (routingType) {
      case "GATEWAY_JUSD": {
        // USD token input/output - convert to svJUSD for internal routing
        const isUsdIn = isUsdToken(chainId, tokenIn);
        const isUsdOut = isUsdToken(chainId, tokenOut);

        if (isUsdIn) {
          internalTokenIn = contracts.SV_JUSD;
          if (isBridgedStablecoin(chainId, tokenIn)) {
            // Bridged stablecoin → svJUSD directly via Gateway view function
            internalAmountIn = await this.bridgedToSvJusd(
              chainId,
              tokenIn,
              amountIn,
            );
          } else if (isSvJusdAddress(chainId, tokenIn)) {
            // svJUSD → use as-is
            internalAmountIn = amountIn;
          } else {
            // JUSD → svJUSD
            internalAmountIn = await this.jusdToSvJusd(chainId, amountIn);
          }
        }
        if (isUsdOut) {
          internalTokenOut = contracts.SV_JUSD;
        }
        break;
      }

      case "GATEWAY_JUICE_OUT": {
        // Buying JUICE - route to svJUSD first
        const isUsdIn = isUsdToken(chainId, tokenIn);

        if (isUsdIn) {
          internalTokenIn = contracts.SV_JUSD;
          if (isBridgedStablecoin(chainId, tokenIn)) {
            internalAmountIn = await this.bridgedToSvJusd(
              chainId,
              tokenIn,
              amountIn,
            );
          } else if (isSvJusdAddress(chainId, tokenIn)) {
            internalAmountIn = amountIn;
          } else {
            internalAmountIn = await this.jusdToSvJusd(chainId, amountIn);
          }
        }
        // Output is svJUSD internally, then converted to JUICE
        internalTokenOut = contracts.SV_JUSD;
        break;
      }

      case "GATEWAY_JUICE_IN": {
        // JUICE can only be swapped directly to JUSD
        // Multi-hop swaps (JUICE → X where X is not JUSD) are not supported
        // Users must manually redeem JUICE for JUSD first, then swap JUSD → X
        if (!isJusdAddress(chainId, tokenOut)) {
          return null; // Signal unsupported - will fall through to NO_ROUTE
        }
        // Selling JUICE - first get JUSD via Equity.redeem()
        const jusdFromRedeem = await this.calculateRedeemProceeds(
          chainId,
          amountIn,
        );
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
      expectedOutput: "0", // To be filled by router
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
    routingType: "GATEWAY_JUSD" | "GATEWAY_JUICE_OUT" | "GATEWAY_JUICE_IN",
  ): Promise<string> {
    switch (routingType) {
      case "GATEWAY_JUSD": {
        // If output is any USD token, convert from svJUSD
        const isUsdOut = isUsdToken(chainId, tokenOut);
        if (isUsdOut) {
          if (isBridgedStablecoin(chainId, tokenOut)) {
            // svJUSD → bridged stablecoin directly via Gateway view function
            return await this.svJusdToBridged(chainId, tokenOut, routerOutput);
          } else if (isSvJusdAddress(chainId, tokenOut)) {
            // svJUSD output — return as-is
            return routerOutput;
          } else {
            // svJUSD → JUSD
            return await this.svJusdToJusd(chainId, routerOutput);
          }
        }
        return routerOutput;
      }

      case "GATEWAY_JUICE_OUT": {
        // Convert svJUSD output to JUICE via Equity
        const jusdOutput = await this.svJusdToJusd(chainId, routerOutput);
        return await this.jusdToJuice(chainId, jusdOutput);
      }

      case "GATEWAY_JUICE_IN": {
        // If output is any USD token, convert from svJUSD
        const isUsdOut = isUsdToken(chainId, tokenOut);
        if (isUsdOut) {
          if (isBridgedStablecoin(chainId, tokenOut)) {
            return await this.svJusdToBridged(chainId, tokenOut, routerOutput);
          } else if (isSvJusdAddress(chainId, tokenOut)) {
            return routerOutput;
          } else {
            return await this.svJusdToJusd(chainId, routerOutput);
          }
        }
        return routerOutput;
      }

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
  detectLpGatewayRouting(
    chainId: number,
    tokenA: string,
    tokenB: string,
  ): boolean {
    if (!hasJuiceDollarIntegration(chainId)) {
      return false;
    }
    return isJusdAddress(chainId, tokenA) || isJusdAddress(chainId, tokenB);
  }

  /**
   * Build Gateway.addLiquidity() calldata
   * User provides JUSD amounts, Gateway converts to svJUSD internally
   */
  buildGatewayAddLiquidityCalldata(params: GatewayLpParams): string {
    const iface = new ethers.utils.Interface(JuiceSwapGatewayAbi);
    return iface.encodeFunctionData("addLiquidity", [
      params.tokenA,
      params.tokenB,
      params.fee,
      params.tickLower,
      params.tickUpper,
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
  buildGatewayIncreaseLiquidityCalldata(
    params: GatewayIncreaseLiquidityParams,
  ): string {
    const iface = new ethers.utils.Interface(JuiceSwapGatewayAbi);
    return iface.encodeFunctionData("increaseLiquidity", [
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
  buildGatewayRemoveLiquidityCalldata(
    params: GatewayRemoveLiquidityParams,
  ): string {
    const iface = new ethers.utils.Interface(JuiceSwapGatewayAbi);
    return iface.encodeFunctionData("removeLiquidity", [
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
