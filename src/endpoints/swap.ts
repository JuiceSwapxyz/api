import { Request, Response } from 'express';
import { ChainId } from '@juiceswapxyz/sdk-core';
import { RouterService } from '../core/RouterService';
import Logger from 'bunyan';

export interface SwapRequestBody {
  type?: 'WRAP' | 'UNWRAP' | 'SWAP';
  tokenInAddress?: string;
  tokenIn?: string;
  tokenInChainId: number;
  tokenInDecimals: number;
  tokenOutAddress?: string;
  tokenOut?: string;
  tokenOutChainId: number;
  tokenOutDecimals: number;
  amount: string;
  recipient: string;
  slippageTolerance: string;
  deadline?: string;
  from: string;
  chainId?: number;
}

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

// WETH addresses for wrap/unwrap operations
const WETH_ADDRESSES: Record<number, string> = {
  1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  10: '0x4200000000000000000000000000000000000006',
  137: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WMATIC
  8453: '0x4200000000000000000000000000000000000006',
  42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  11155111: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
  5115: '0x5C2048092510177c7103054551c87f8f14A0D799', // Citrea WETH
};

export function createSwapHandler(
  routerService: RouterService,
  logger: Logger
) {
  return async function handleSwap(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = req.headers['x-request-id'] as string || `swap-${Date.now()}`;
    const log = logger.child({ requestId, endpoint: 'swap' });

    try {
      const body: SwapRequestBody = req.body;
      const swapType = body.type || 'SWAP';

      // Handle WRAP/UNWRAP operations
      if (swapType === 'WRAP' || swapType === 'UNWRAP') {
        return handleWrapUnwrap(body, res, log);
      }

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
      if (body.tokenInDecimals === undefined) missingFields.push('tokenInDecimals');
      if (body.tokenOutDecimals === undefined) missingFields.push('tokenOutDecimals');

      if (missingFields.length > 0) {
        res.status(400).json({
          error: 'Missing required fields',
          detail: `The following fields are required: ${missingFields.join(', ')}`,
        });
        return;
      }

      const chainId = (body.chainId || body.tokenInChainId) as ChainId;

      // Check if chain is supported
      if (!routerService.isChainSupported(chainId)) {
        res.status(400).json({
          error: 'Unsupported chain',
          detail: `Chain ID ${chainId} is not supported`,
        });
        return;
      }

      const routerAddress = SWAP_ROUTER_ADDRESSES[chainId];
      if (!routerAddress) {
        res.status(400).json({
          error: 'No router address',
          detail: `No router address configured for chain ${chainId}`,
        });
        return;
      }

      // Get swap route from router
      const route = await routerService.getSwap({
        tokenIn: tokenIn!,
        tokenOut: tokenOut!,
        tokenInDecimals: body.tokenInDecimals,
        tokenOutDecimals: body.tokenOutDecimals,
        amount: body.amount,
        chainId,
        type: 'exactIn',
        recipient: body.recipient,
        slippageTolerance: parseFloat(body.slippageTolerance),
        deadline: body.deadline ? parseInt(body.deadline) : 1800,
        from: body.from,
      });

      if (!route || !route.methodParameters) {
        res.status(404).json({
          error: 'No route found',
          detail: 'Unable to find a valid route for this swap',
        });
        return;
      }

      // Get gas prices
      const gasPrices = await routerService.getGasPrices(chainId);

      // Build transaction data
      const swapData = {
        data: route.methodParameters.calldata,
        to: routerAddress,
        value: route.methodParameters.value,
        from: body.from,
        maxFeePerGas: gasPrices.maxFeePerGas,
        maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
        gasLimit: route.estimatedGasUsed.mul(120).div(100).toString(), // Add 20% buffer
      };

      log.info({
        responseTime: Date.now() - startTime,
        quote: route.quote.toExact(),
        gasEstimate: route.estimatedGasUsed.toString(),
      }, 'Swap transaction prepared successfully');

      res.json(swapData);

    } catch (error) {
      log.error({ error }, 'Failed to prepare swap');

      res.status(500).json({
        error: 'Internal server error',
        detail: error instanceof Error ? error.message : 'Unknown error occurred',
      });
    }
  };

  function handleWrapUnwrap(
    body: SwapRequestBody,
    res: Response,
    log: Logger
  ): void {
    const chainId = body.chainId || body.tokenInChainId;
    const wethAddress = WETH_ADDRESSES[chainId];

    if (!wethAddress) {
      res.status(400).json({
        error: 'Unsupported chain for wrap/unwrap',
        detail: `Chain ID ${chainId} does not support WETH operations`,
      });
      return;
    }

    const isWrap = body.type === 'WRAP';
    let calldata: string;
    let value: string;

    if (isWrap) {
      // Wrap ETH -> WETH
      // Function selector for deposit(): 0xd0e30db0
      calldata = '0xd0e30db0';
      value = body.amount;
    } else {
      // Unwrap WETH -> ETH
      // Function selector for withdraw(uint256): 0x2e1a7d4d
      const amountHex = '0x' + BigInt(body.amount).toString(16).padStart(64, '0');
      calldata = '0x2e1a7d4d' + amountHex.slice(2);
      value = '0x0';
    }

    const swapData = {
      data: calldata,
      to: wethAddress,
      value,
      from: body.from,
      gasLimit: '50000', // Wrap/unwrap typically uses ~46k gas
    };

    log.info({ type: body.type, amount: body.amount }, 'Wrap/unwrap transaction prepared');
    res.json(swapData);
  }
}