import { Request, Response } from 'express';
import { ChainId, SWAP_ROUTER_02_ADDRESSES } from '@juiceswapxyz/sdk-core';
import { Protocol } from '@juiceswapxyz/router-sdk';
import { RouterService } from '../core/RouterService';
import { trackUser } from '../services/userTracking';
import { extractIpAddress } from '../utils/ipAddress';
import { JuiceGatewayService } from '../services/JuiceGatewayService';
import {
  getChainContracts,
  hasJuiceDollarIntegration,
} from '../config/contracts';
import { isGraduatedLaunchpadToken } from '../services/LaunchpadTokenService';
import { ethers } from 'ethers';
import Logger from 'bunyan';
import { Routing } from './quote';

const BASIS_POINTS_DENOMINATOR = 10000;

export interface SwapRequestBody {
  type?: 'WRAP' | 'UNWRAP' | 'exactIn' | 'exactOut';
  tokenInAddress?: string;
  tokenIn?: string;
  tokenInChainId: number;
  tokenInDecimals?: number;
  tokenOutAddress?: string;
  tokenOut?: string;
  tokenOutChainId: number;
  tokenOutDecimals?: number;
  amount: string;
  recipient: string;
  slippageTolerance: string;
  deadline?: string;
  from: string;
  chainId?: number;
  protocols?: string[];
}

const NATIVE_CURRENCY_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEFAULT_MAX_FEE_PER_GAS = '0x1dcd6500'; // 500 gwei fallback
const DEFAULT_MAX_PRIORITY_FEE_PER_GAS = '0x3b9aca00'; // 1 gwei fallback

// SwapRouter02 addresses are imported from @juiceswapxyz/sdk-core
// Source of truth: sdk-core/src/addresses.ts

/**
 * Fetch current gas prices from RPC provider
 */
async function getGasPrices(
  provider: ethers.providers.JsonRpcProvider,
  log: Logger
): Promise<{
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}> {
  try {
    const gasPrice = await provider.getGasPrice();
    const feeData = await provider.getFeeData();

    let maxFeePerGas: string;
    let maxPriorityFeePerGas: string;

    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      // Use EIP-1559 gas prices if available
      maxFeePerGas = feeData.maxFeePerGas.toHexString();
      maxPriorityFeePerGas = feeData.maxPriorityFeePerGas.toHexString();
    } else {
      // Fallback to legacy gas price with buffer
      const gasPriceWithBuffer = gasPrice.mul(120).div(100); // 20% buffer
      maxFeePerGas = gasPriceWithBuffer.toHexString();
      maxPriorityFeePerGas = gasPrice.mul(10).div(100).toHexString(); // 10% of gas price
    }

    return { maxFeePerGas, maxPriorityFeePerGas };
  } catch (error) {
    log.warn({ error }, 'Failed to fetch gas prices, using defaults');
    return {
      maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
    };
  }
}

/**
 * @swagger
 * /v1/swap:
 *   post:
 *     tags: [Swaps]
 *     summary: Build swap transaction
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SwapRequest'
 *           example:
 *             tokenInChainId: 5115
 *             tokenInAddress: "0x8d0c9d1c17aE5e40ffF9bE350f57840E9E66Cd93"
 *             tokenOutChainId: 5115
 *             tokenOutAddress: "0xFdB0a83d94CD65151148a131167Eb499Cb85d015"
 *             amount: "1000000000000000000"
 *             type: "exactIn"
 *             recipient: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
 *             from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
 *             slippageTolerance: "0.5"
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SwapResponse'
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createSwapHandler(
  routerService: RouterService,
  logger: Logger,
  juiceGatewayService?: JuiceGatewayService
) {
  return async function handleSwap(req: Request, res: Response): Promise<void> {
    const requestId = req.headers['x-request-id'] as string || `swap-${Date.now()}`;
    const log = logger.child({ requestId, endpoint: 'swap' });

    try {
      const body: SwapRequestBody = req.body;
      const swapType = body.type || 'exactIn';

      trackUser(body.from, extractIpAddress(req), log);

      // Handle WRAP/UNWRAP operations
      if (swapType === 'WRAP' || swapType === 'UNWRAP') {
        return await handleWrapUnwrap(body, res, log, routerService);
      }

      // Normalize token addresses
      const tokenIn = body.tokenIn || body.tokenInAddress!;
      const tokenOut = body.tokenOut || body.tokenOutAddress!;
      const chainId = (body.chainId || body.tokenInChainId) as ChainId;

      // ============================================
      // Check for Launchpad Tokens FIRST
      // ============================================
      // Launchpad tokens ALWAYS use V2 pools with JUSD directly (not svJUSD)
      // They must BYPASS Gateway routing entirely
      const [isGraduatedIn, isGraduatedOut] = await Promise.all([
        isGraduatedLaunchpadToken(chainId, tokenIn),
        isGraduatedLaunchpadToken(chainId, tokenOut),
      ]);
      const hasLaunchpadToken = isGraduatedIn || isGraduatedOut;

      if (hasLaunchpadToken) {
        log.debug(
          { tokenIn, tokenOut, isGraduatedIn, isGraduatedOut },
          'Graduated launchpad token detected - bypassing Gateway, using direct V2 swap with JUSD'
        );
      }

      // Check for Gateway routing (JUSD/JUICE/SUSD)
      // SUSD is routed through Gateway via registerBridgedToken() - no separate bridge service needed
      // NOTE: Launchpad tokens BYPASS Gateway - they use V2 pools with JUSD directly
      if (!hasLaunchpadToken && juiceGatewayService && hasJuiceDollarIntegration(chainId)) {
        const routingType = juiceGatewayService.detectRoutingType(chainId, tokenIn, tokenOut);

        if (routingType) {
          return await handleGatewaySwap(body, res, log, routerService, juiceGatewayService, routingType);
        }
      }

      // Handle classic swaps (exactIn/exactOut)
      return await handleClassicSwap(body, res, log, routerService, hasLaunchpadToken);
    } catch (error) {
      log.error({ error }, 'Failed to prepare swap');
      res.status(500).json({
        error: 'Internal server error',
        detail: error instanceof Error ? error.message : 'Unknown error occurred',
      });
    }
  };
}

/**
 * Handle wrap/unwrap operations (native <-> wrapped token)
 */
async function handleWrapUnwrap(
  body: SwapRequestBody,
  res: Response,
  log: Logger,
  routerService: RouterService
): Promise<void> {
  try {
    const {
      tokenInAddress,
      tokenIn,
      tokenOutAddress,
      tokenOut,
      amount,
      type,
      from,
      chainId,
    } = body;

    // Normalize token addresses (Zod validation ensures at least one is present)
    const validatedTokenIn = tokenInAddress || tokenIn!;
    const validatedTokenOut = tokenOutAddress || tokenOut!;

    // Validate operation type
    if (type !== 'WRAP' && type !== 'UNWRAP') {
      log.debug({ type }, 'Validation failed: invalid wrap operation type');
      res.status(400).json({
        error: 'Invalid operation type',
        detail: 'Type must be WRAP or UNWRAP',
      });
      return;
    }

    // Determine wrapped token address
    let wrappedTokenAddress: string;
    if (validatedTokenIn.toLowerCase() === NATIVE_CURRENCY_ADDRESS.toLowerCase()) {
      wrappedTokenAddress = validatedTokenOut;
    } else if (validatedTokenOut.toLowerCase() === NATIVE_CURRENCY_ADDRESS.toLowerCase()) {
      wrappedTokenAddress = validatedTokenIn;
    } else {
      res.status(400).json({
        error: 'Invalid wrap/unwrap request',
        detail: 'One token must be native currency (0x0000000000000000000000000000000000000000)',
      });
      return;
    }

    // Validate wrap/unwrap pattern
    const isWrap = type === 'WRAP';
    const isUnwrap = type === 'UNWRAP';

    if (isWrap) {
      const isValidWrap =
        validatedTokenIn.toLowerCase() === NATIVE_CURRENCY_ADDRESS.toLowerCase() &&
        validatedTokenOut.toLowerCase() === wrappedTokenAddress.toLowerCase();
      if (!isValidWrap) {
        res.status(400).json({
          error: 'Invalid WRAP request',
          detail: 'For WRAP, tokenIn must be native currency and tokenOut must be wrapped token',
        });
        return;
      }
    } else if (isUnwrap) {
      const isValidUnwrap =
        validatedTokenIn.toLowerCase() === wrappedTokenAddress.toLowerCase() &&
        validatedTokenOut.toLowerCase() === NATIVE_CURRENCY_ADDRESS.toLowerCase();
      if (!isValidUnwrap) {
        res.status(400).json({
          error: 'Invalid UNWRAP request',
          detail: 'For UNWRAP, tokenIn must be wrapped token and tokenOut must be native currency',
        });
        return;
      }
    }

    // Get RPC provider
    const provider = routerService.getProvider(chainId as ChainId);
    if (!provider) {
      res.status(400).json({
        error: 'RPC provider not configured',
        detail: `No RPC provider found for chain ID ${chainId}`,
      });
      return;
    }

    // Get gas prices
    const gasPrices = await getGasPrices(provider, log);

    // Create WETH contract interface
    const wethInterface = new ethers.utils.Interface([
      'function deposit() payable',
      'function withdraw(uint256 amount)',
    ]);

    let transactionData: string;
    let value: string;
    const amountBN = ethers.BigNumber.from(amount);

    if (isWrap) {
      // WRAP: Call deposit() with ETH value
      transactionData = wethInterface.encodeFunctionData('deposit', []);
      value = amountBN.toHexString();
    } else {
      // UNWRAP: Call withdraw(amount) with no ETH value
      transactionData = wethInterface.encodeFunctionData('withdraw', [amountBN]);
      value = '0x0';
    }

    // Calculate gas fee
    const gasLimit = 46000; // Standard for WETH operations
    const gasFee = ethers.BigNumber.from(gasPrices.maxFeePerGas).mul(gasLimit);

    const response = {
      requestId: Math.random().toString(36).substring(2, 15),
      swap: {
        to: wrappedTokenAddress,
        from: from,
        value: value,
        data: transactionData,
        maxFeePerGas: gasPrices.maxFeePerGas.replace('0x', ''),
        maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas.replace('0x', ''),
        gasLimit: gasLimit.toString(),
        chainId: chainId,
      },
      gasFee: gasFee.toString(),
      gasEstimates: [
        {
          type: 'eip1559',
          strategy: {
            limitInflationFactor: 1.15,
            priceInflationFactor: 1.5,
            percentileThresholdFor1559Fee: 75,
            thresholdToInflateLastBlockBaseFee: 0.75,
            baseFeeMultiplier: 1,
            baseFeeHistoryWindow: 20,
            minPriorityFeeRatioOfBaseFee: 0.2,
            minPriorityFeeGwei: 2,
            maxPriorityFeeGwei: 9,
          },
          gasLimit: gasLimit.toString(),
          gasFee: gasFee.toString(),
          maxFeePerGas: gasPrices.maxFeePerGas.replace('0x', ''),
          maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas.replace('0x', ''),
        },
      ],
    };

    log.debug({ type, amount, wrappedTokenAddress }, 'Wrap/unwrap transaction prepared');
    res.json(response);
  } catch (error) {
    log.error({ error }, 'Error in handleWrapUnwrap');
    res.status(500).json({
      error: 'Internal server error',
      detail: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
}

/**
 * Handle Gateway swap operations (JUSD/JUICE/SUSD tokens)
 * Routes through JuiceSwapGateway or Equity contract
 * SUSD is handled via Gateway's registerBridgedToken() mechanism
 */
async function handleGatewaySwap(
  body: SwapRequestBody,
  res: Response,
  log: Logger,
  routerService: RouterService,
  juiceGatewayService: JuiceGatewayService,
  routingType: 'GATEWAY_JUSD' | 'GATEWAY_JUICE_OUT' | 'GATEWAY_JUICE_IN'
): Promise<void> {
  try {
    const tokenIn = body.tokenIn || body.tokenInAddress!;
    const tokenOut = body.tokenOut || body.tokenOutAddress!;
    const chainId = (body.chainId || body.tokenInChainId) as ChainId;

    const contracts = getChainContracts(chainId);
    if (!contracts) {
      res.status(400).json({
        error: 'GATEWAY_NOT_CONFIGURED',
        detail: `JuiceDollar Gateway not configured for chain ${chainId}`,
      });
      return;
    }

    // Get RPC provider for gas prices
    const provider = routerService.getProvider(chainId);
    if (!provider) {
      res.status(500).json({
        error: 'Provider error',
        detail: 'RPC provider not available',
      });
      return;
    }

    const gasPrices = await getGasPrices(provider, log);

    // Calculate deadline
    const deadline = body.deadline
      ? Math.floor(Date.now() / 1000) + parseInt(body.deadline)
      : Math.floor(Date.now() / 1000) + 1800; // 30 minutes default

    // Calculate slippage in basis points (e.g., "0.5" -> 50 bps)
    const slippageBps = Math.round(parseFloat(body.slippageTolerance) * 100);

    // Handle different routing types
    if (routingType === Routing.GATEWAY_JUICE_IN) {
      // JUICE input - use Equity.redeem() directly
      // This returns JUSD which user can then swap if needed
      const calldata = juiceGatewayService.buildEquityRedeemCalldata({
        juiceAmount: body.amount,
        recipient: body.recipient,
      });

      const equityAddress = juiceGatewayService.getEquityAddress(chainId);
      if (!equityAddress) {
        res.status(500).json({
          error: 'EQUITY_NOT_CONFIGURED',
          detail: 'Equity contract address not configured',
        });
        return;
      }

      // If output is not JUSD, we need a two-step transaction
      // For now, return the Equity.redeem() call and let frontend handle subsequent swap
      if (tokenOut.toLowerCase() !== contracts.JUSD.toLowerCase()) {
        // Return info that this needs a multi-step transaction
        const swapData = {
          data: calldata,
          to: equityAddress,
          value: '0x0',
          from: body.from,
          maxFeePerGas: gasPrices.maxFeePerGas,
          maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
          _routingType: routingType,
          _multiStep: true,
          _intermediateToken: contracts.JUSD,
        };

        log.debug({ routingType, tokenIn, tokenOut }, 'Gateway JUICE_IN swap prepared (step 1)');
        res.json(swapData);
        return;
      }

      // Direct JUICE -> JUSD redemption
      const swapData = {
        data: calldata,
        to: equityAddress,
        value: '0x0',
        from: body.from,
        maxFeePerGas: gasPrices.maxFeePerGas,
        maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
        _routingType: routingType,
      };

      log.debug({ routingType, tokenIn, tokenOut }, 'Gateway JUICE_IN swap prepared');
      res.json(swapData);
      return;
    }

    // GATEWAY_JUSD or GATEWAY_JUICE_OUT - use JuiceSwapGateway
    const gatewayAddress = juiceGatewayService.getGatewayAddress(chainId);
    if (!gatewayAddress) {
      res.status(500).json({
        error: 'GATEWAY_NOT_CONFIGURED',
        detail: 'JuiceSwapGateway address not configured',
      });
      return;
    }

    // Get default fee from Gateway
    const fee = await juiceGatewayService.getDefaultFee(chainId);

    // For Gateway swaps, we need to calculate minAmountOut
    // First get a quote to determine expected output
    const gatewayQuote = await juiceGatewayService.prepareQuote(
      chainId,
      tokenIn,
      tokenOut,
      body.amount
    );

    if (!gatewayQuote) {
      res.status(500).json({
        error: 'GATEWAY_QUOTE_FAILED',
        detail: 'Failed to prepare Gateway quote for swap',
      });
      return;
    }

    // Handle direct USD↔USD conversions (no pool routing needed)
    if (gatewayQuote.isDirectConversion) {
      // For direct conversions, the expectedOutput is already computed via Gateway view functions
      const userOutputBN = ethers.BigNumber.from(gatewayQuote.expectedOutput);
      const minAmountOut = userOutputBN.mul(BASIS_POINTS_DENOMINATOR - slippageBps).div(BASIS_POINTS_DENOMINATOR);

      // Build Gateway calldata for direct conversion
      const calldata = juiceGatewayService.buildGatewaySwapCalldata({
        tokenIn,
        tokenOut,
        fee,
        amountIn: body.amount,
        minAmountOut: minAmountOut.toString(),
        recipient: body.recipient,
        deadline,
      });

      // Estimate gas for the direct conversion swap
      const gasPrice = await provider.getGasPrice();
      let gasLimit = ethers.BigNumber.from('200000'); // Default for direct conversions
      try {
        const estimatedGas = await provider.estimateGas({
          to: gatewayAddress,
          from: body.from,
          data: calldata,
          value: '0x0',
        });
        gasLimit = estimatedGas.mul(110).div(100); // 10% buffer
      } catch (e) {
        log.warn({ error: e }, 'Gas estimation failed for direct conversion, using default');
      }

      const gasFee = gasLimit.mul(gasPrice);

      const swapData = {
        data: calldata,
        to: gatewayAddress,
        value: '0x0',
        from: body.from,
        maxFeePerGas: gasPrices.maxFeePerGas,
        maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
        gasLimit: gasLimit.toHexString(),
        _routingType: routingType,
        _isDirectConversion: true,
        _expectedOutput: gatewayQuote.expectedOutput,
        _minAmountOut: minAmountOut.toString(),
      };

      log.debug({
        routingType,
        tokenIn,
        tokenOut,
        isDirectConversion: true,
        expectedOutput: gatewayQuote.expectedOutput,
        minAmountOut: minAmountOut.toString(),
        gasLimit: gasLimit.toString(),
        gasFee: gasFee.toString(),
      }, 'Gateway direct conversion swap prepared');

      res.json({
        ...swapData,
        gasFee: gasFee.toString(),
        gasEstimates: [{
          type: 'eip1559',
          gasLimit: gasLimit.toString(),
          gasFee: gasFee.toString(),
          maxFeePerGas: gasPrices.maxFeePerGas,
          maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
        }],
      });
      return;
    }

    // Route internally to get expected output
    // Note: Launchpad tokens bypass Gateway entirely (checked in createSwapHandler),
    // so this function only handles non-launchpad swaps with svJUSD
    const internalRoute = await routerService.getQuote({
      tokenIn: gatewayQuote.internalTokenIn,
      tokenOut: gatewayQuote.internalTokenOut,
      tokenInDecimals: 18, // svJUSD has 18 decimals
      tokenOutDecimals: body.tokenOutDecimals || 18,
      amount: gatewayQuote.internalAmountIn,
      chainId,
      type: 'exactIn',
    });

    if (!internalRoute) {
      res.status(404).json({
        error: 'NO_ROUTE',
        detail: 'No route found for Gateway swap',
      });
      return;
    }

    // Calculate user-facing output and minAmountOut with slippage
    const internalOutputAmount = internalRoute.quote.quotient.toString();
    const userOutputAmount = await juiceGatewayService.convertOutputToUserToken(
      chainId,
      tokenOut,
      internalOutputAmount,
      routingType
    );

    // Apply slippage to get minAmountOut (using basis points directly)
    const userOutputBN = ethers.BigNumber.from(userOutputAmount);
    const minAmountOut = userOutputBN.mul(BASIS_POINTS_DENOMINATOR - slippageBps).div(BASIS_POINTS_DENOMINATOR);

    // Build Gateway calldata
    const calldata = juiceGatewayService.buildGatewaySwapCalldata({
      tokenIn,
      tokenOut,
      fee,
      amountIn: body.amount,
      minAmountOut: minAmountOut.toString(),
      recipient: body.recipient,
      deadline,
    });

    // Check if input is native token - Gateway expects msg.value == amount for native swaps
    const isNativeInput = tokenIn.toLowerCase() === NATIVE_CURRENCY_ADDRESS.toLowerCase();

    // Estimate gas for the swap transaction
    const gasPrice = await provider.getGasPrice();
    let gasLimit = ethers.BigNumber.from('300000'); // Default for complex Gateway swaps
    try {
      const estimatedGas = await provider.estimateGas({
        to: gatewayAddress,
        from: body.from,
        data: calldata,
        value: isNativeInput ? body.amount : '0x0',
      });
      gasLimit = estimatedGas.mul(110).div(100); // 10% buffer
    } catch (e) {
      log.warn({ error: e }, 'Gas estimation failed for Gateway swap, using default');
    }

    const gasFee = gasLimit.mul(gasPrice);

    const swapData = {
      data: calldata,
      to: gatewayAddress,
      value: isNativeInput ? ethers.BigNumber.from(body.amount).toHexString() : '0x0',
      from: body.from,
      maxFeePerGas: gasPrices.maxFeePerGas,
      maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
      gasLimit: gasLimit.toHexString(),
      _routingType: routingType,
      _expectedOutput: userOutputAmount,
      _minAmountOut: minAmountOut.toString(),
    };

    log.debug({
      routingType,
      tokenIn,
      tokenOut,
      expectedOutput: userOutputAmount,
      minAmountOut: minAmountOut.toString(),
      gasLimit: gasLimit.toString(),
      gasFee: gasFee.toString(),
    }, 'Gateway swap prepared');

    res.json({
      ...swapData,
      gasFee: gasFee.toString(),
      gasEstimates: [{
        type: 'eip1559',
        gasLimit: gasLimit.toString(),
        gasFee: gasFee.toString(),
        maxFeePerGas: gasPrices.maxFeePerGas,
        maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
      }],
    });

  } catch (error) {
    log.error({ error }, 'Error in handleGatewaySwap');
    res.status(500).json({
      error: 'Internal server error',
      detail: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
}

/**
 * Handle classic swap operations (token <-> token)
 * @param hasLaunchpadToken - Whether a graduated launchpad token is involved (pre-computed by caller)
 */
async function handleClassicSwap(
  body: SwapRequestBody,
  res: Response,
  log: Logger,
  routerService: RouterService,
  hasLaunchpadToken: boolean = false
): Promise<void> {
  try {
    // Normalize token addresses (Zod validation ensures at least one is present)
    const validatedTokenIn = body.tokenIn || body.tokenInAddress!;
    const validatedTokenOut = body.tokenOut || body.tokenOutAddress!;

    const chainId = (body.chainId || body.tokenInChainId) as ChainId;

    // Check if chain is supported
    if (!routerService.isChainSupported(chainId)) {
      log.debug({ chainId }, 'Validation failed: unsupported chain for swap');
      res.status(400).json({
        error: 'Unsupported chain',
        detail: `Chain ID ${chainId} is not supported`,
      });
      return;
    }

    // Get router address from sdk-core (single source of truth)
    const routerAddress = SWAP_ROUTER_02_ADDRESSES(chainId);
    if (!routerAddress) {
      res.status(400).json({
        error: 'No router address',
        detail: `No swap router configured for chain ${chainId}`,
      });
      return;
    }

    // Fetch token decimals if not provided
    let tokenInDecimals = body.tokenInDecimals;
    let tokenOutDecimals = body.tokenOutDecimals;

    if (tokenInDecimals === undefined || tokenOutDecimals === undefined) {
      try {
        if (tokenInDecimals === undefined) {
          const tokenInInfo = await routerService.getTokenInfo(validatedTokenIn, chainId);
          tokenInDecimals = tokenInInfo.decimals;
        }
        if (tokenOutDecimals === undefined) {
          const tokenOutInfo = await routerService.getTokenInfo(validatedTokenOut, chainId);
          tokenOutDecimals = tokenOutInfo.decimals;
        }
      } catch (error: any) {
        res.status(400).json({
          error: 'Token lookup failed',
          detail: error.message || 'Could not find token information',
        });
        return;
      }
    }

    // Type assertion after decimal lookup - decimals are now guaranteed to be defined
    const validatedTokenInDecimals = tokenInDecimals!;
    const validatedTokenOutDecimals = tokenOutDecimals!;

    // Parse protocols - V2 and V3 supported
    let protocols: Protocol[] | undefined = undefined;
    if (body.protocols) {
      protocols = body.protocols
        .map(p => p.toUpperCase())
        .filter(p => p === 'V2' || p === 'V3')
        .map(p => p === 'V2' ? Protocol.V2 : Protocol.V3);
    }

    // For launchpad tokens: use V2 ONLY (no V3)
    // hasLaunchpadToken is pre-computed by the caller to avoid redundant API calls
    if (hasLaunchpadToken) {
      // Launchpad tokens ONLY use V2 pools with JUSD - never V3
      protocols = [Protocol.V2];
      log.debug(
        { tokenIn: validatedTokenIn, tokenOut: validatedTokenOut, protocols },
        'Launchpad token: forcing V2-only routing'
      );
    }

    log.info(`Swap protocols - body.protocols: ${JSON.stringify(body.protocols)}, parsed: ${JSON.stringify(protocols)}`);

    // Get swap route with methodParameters
    const swapRoute = await routerService.getSwap({
      tokenIn: validatedTokenIn,
      tokenOut: validatedTokenOut,
      tokenInDecimals: validatedTokenInDecimals,
      tokenOutDecimals: validatedTokenOutDecimals,
      amount: body.amount,
      chainId,
      type: body.type === 'exactOut' ? 'exactOut' : 'exactIn',
      recipient: body.recipient,
      slippageTolerance: parseFloat(body.slippageTolerance) / 100, // Convert from percentage
      deadline: body.deadline ? Math.floor(Date.now() / 1000) + parseInt(body.deadline) : undefined,
      from: body.from,
      protocols,
    });

    if (!swapRoute || !swapRoute.methodParameters) {
      res.status(404).json({
        error: 'NO_ROUTE',
        detail: 'No route found for this swap',
      });
      return;
    }

    // Get gas prices
    const provider = routerService.getProvider(chainId);
    if (!provider) {
      res.status(500).json({
        error: 'Provider error',
        detail: 'RPC provider not available',
      });
      return;
    }

    const gasPrices = await getGasPrices(provider, log);

    // Estimate gas for the swap transaction
    const gasPrice = await provider.getGasPrice();
    let gasLimit = ethers.BigNumber.from('250000'); // Default for classic swaps
    try {
      const estimatedGas = await provider.estimateGas({
        to: routerAddress,
        from: body.from,
        data: swapRoute.methodParameters.calldata,
        value: swapRoute.methodParameters.value,
      });
      gasLimit = estimatedGas.mul(110).div(100); // 10% buffer
    } catch (e) {
      log.warn({ error: e }, 'Gas estimation failed for Classic swap, using default');
    }

    const gasFee = gasLimit.mul(gasPrice);

    // Format response
    const swapData = {
      data: swapRoute.methodParameters.calldata,
      to: routerAddress,
      value: swapRoute.methodParameters.value,
      from: body.from,
      maxFeePerGas: gasPrices.maxFeePerGas,
      maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
      gasLimit: gasLimit.toHexString(),
    };

    log.debug(
      {
        tokenIn: validatedTokenIn,
        tokenOut: validatedTokenOut,
        amount: body.amount,
        route: swapRoute.route.length,
        gasLimit: gasLimit.toString(),
        gasFee: gasFee.toString(),
      },
      'Classic swap transaction prepared'
    );

    res.json({
      ...swapData,
      gasFee: gasFee.toString(),
      gasEstimates: [{
        type: 'eip1559',
        gasLimit: gasLimit.toString(),
        gasFee: gasFee.toString(),
        maxFeePerGas: gasPrices.maxFeePerGas,
        maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
      }],
    });
  } catch (error) {
    log.error({ error }, 'Error in handleClassicSwap');
    res.status(500).json({
      error: 'Internal server error',
      detail: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
}
