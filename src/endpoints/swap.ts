import { Request, Response } from 'express';
import { ChainId } from '@juiceswapxyz/sdk-core';
import { RouterService } from '../core/RouterService';
import { ethers } from 'ethers';
import Logger from 'bunyan';

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
}

const NATIVE_CURRENCY_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEFAULT_MAX_FEE_PER_GAS = '0x1dcd6500'; // 500 gwei fallback
const DEFAULT_MAX_PRIORITY_FEE_PER_GAS = '0x3b9aca00'; // 1 gwei fallback

// V3 Swap Router addresses for different chains
const SWAP_ROUTER_ADDRESSES: Record<number, string> = {
  1: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', // Mainnet
  10: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', // Optimism
  137: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', // Polygon
  8453: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', // Base
  42161: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', // Arbitrum
  11155111: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E', // Sepolia
  5115: '0x610c98EAD0df13EA906854b6041122e8A8D14413', // Citrea
};

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

export function createSwapHandler(
  routerService: RouterService,
  logger: Logger
) {
  return async function handleSwap(req: Request, res: Response): Promise<void> {
    const requestId = req.headers['x-request-id'] as string || `swap-${Date.now()}`;
    const log = logger.child({ requestId, endpoint: 'swap' });

    try {
      const body: SwapRequestBody = req.body;
      const swapType = body.type || 'exactIn';

      // Handle WRAP/UNWRAP operations
      if (swapType === 'WRAP' || swapType === 'UNWRAP') {
        return await handleWrapUnwrap(body, res, log, routerService);
      }

      // Handle classic swaps (exactIn/exactOut)
      return await handleClassicSwap(body, res, log, routerService);
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
      tokenOutAddress,
      amount,
      type,
      recipient,
      from,
      chainId,
    } = body;

    // Validate required fields
    const missingFields = [];
    if (!tokenInAddress) missingFields.push('tokenInAddress');
    if (!tokenOutAddress) missingFields.push('tokenOutAddress');
    if (!amount) missingFields.push('amount');
    if (!type) missingFields.push('type');
    if (!recipient) missingFields.push('recipient');
    if (!from) missingFields.push('from');
    if (!chainId) missingFields.push('chainId');

    if (missingFields.length > 0) {
      res.status(400).json({
        error: 'Missing required fields',
        detail: `The following fields are required: ${missingFields.join(', ')}`,
      });
      return;
    }

    // Type assertion after validation - all fields are now guaranteed to be defined
    const validatedTokenIn = tokenInAddress!;
    const validatedTokenOut = tokenOutAddress!;

    // Validate operation type
    if (type !== 'WRAP' && type !== 'UNWRAP') {
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

    log.info({ type, amount, wrappedTokenAddress }, 'Wrap/unwrap transaction prepared');
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
 * Handle classic swap operations (token <-> token)
 */
async function handleClassicSwap(
  body: SwapRequestBody,
  res: Response,
  log: Logger,
  routerService: RouterService
): Promise<void> {
  try {
    // Validate required fields
    const missingFields = [];
    const tokenIn = body.tokenIn || body.tokenInAddress;
    const tokenOut = body.tokenOut || body.tokenOutAddress;

    if (!tokenIn) missingFields.push('tokenInAddress');
    if (!tokenOut) missingFields.push('tokenOutAddress');
    if (!body.amount) missingFields.push('amount');
    if (!body.recipient) missingFields.push('recipient');
    if (!body.slippageTolerance) missingFields.push('slippageTolerance');
    if (!body.from) missingFields.push('from');

    if (missingFields.length > 0) {
      res.status(400).json({
        error: 'Missing required fields',
        detail: `The following fields are required: ${missingFields.join(', ')}`,
      });
      return;
    }

    // Type assertions after validation
    const validatedTokenIn = tokenIn!;
    const validatedTokenOut = tokenOut!;

    const chainId = (body.chainId || body.tokenInChainId) as ChainId;

    // Check if chain is supported
    if (!routerService.isChainSupported(chainId)) {
      res.status(400).json({
        error: 'Unsupported chain',
        detail: `Chain ID ${chainId} is not supported`,
      });
      return;
    }

    // Get router address
    const routerAddress = SWAP_ROUTER_ADDRESSES[chainId];
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
      deadline: body.deadline ? parseInt(body.deadline) : undefined,
      from: body.from,
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

    // Format response
    const swapData = {
      data: swapRoute.methodParameters.calldata,
      to: routerAddress,
      value: swapRoute.methodParameters.value,
      from: body.from,
      maxFeePerGas: gasPrices.maxFeePerGas,
      maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
    };

    log.info(
      {
        tokenIn: validatedTokenIn,
        tokenOut: validatedTokenOut,
        amount: body.amount,
        route: swapRoute.route.length,
      },
      'Classic swap transaction prepared'
    );

    res.json(swapData);
  } catch (error) {
    log.error({ error }, 'Error in handleClassicSwap');
    res.status(500).json({
      error: 'Internal server error',
      detail: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
}
