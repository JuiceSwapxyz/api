import { Request, Response } from 'express';
import { ChainId } from '@juiceswapxyz/sdk-core';
import { Protocol } from '@juiceswapxyz/router-sdk';
import { nativeOnChain } from '@juiceswapxyz/smart-order-router';
import { isNativeCurrency } from '@juiceswapxyz/universal-router-sdk';
import { RouterService } from '../core/RouterService';
import { quoteCache } from '../cache/quoteCache';
import { getRPCMonitor } from '../utils/rpcMonitor';
import Logger from 'bunyan';

// Helper functions for AWS-compatible response formatting
function formatDecimals(amount: string, decimals: number): string {
  const num = Number(amount) / Math.pow(10, decimals);
  return num.toString();
}

function generateQuoteId(): string {
  return Math.random().toString(36).substring(2, 13);
}

function generateRouteString(formattedRoute: any[]): string {
  if (!formattedRoute || formattedRoute.length === 0) return '';

  // For simple single-route with single pool
  if (formattedRoute.length === 1 && formattedRoute[0].length === 1) {
    const pool = formattedRoute[0][0];
    const feePercent = pool.fee ? (Number(pool.fee) / 10000).toFixed(1) : '0.3';
    return `[V3] 100.00% = ${pool.tokenIn?.symbol || 'TOKEN'} -- ${feePercent}% [${pool.address}]${pool.tokenOut?.symbol || 'TOKEN'}`;
  }

  // For multi-hop or multi-route, build more complex string
  return '[V3] Multi-hop route';
}

function calculatePriceImpact(_route: any): string {
  // Simple price impact calculation - can be enhanced
  return '0.30';
}

export interface QuoteRequestBody {
  tokenIn?: string;
  tokenInAddress?: string;
  tokenOut?: string;
  tokenOutAddress?: string;
  tokenInChainId: number;
  tokenOutChainId: number;
  tokenInDecimals?: number;  // Optional - will be fetched from token lists if not provided
  tokenOutDecimals?: number;  // Optional - will be fetched from token lists if not provided
  amount: string;
  type?: 'EXACT_INPUT' | 'EXACT_OUTPUT';
  swapper?: string;
  protocols?: string[];
  enableUniversalRouter?: boolean;
}

export interface QuoteResponse {
  requestId: string;
  routing: 'CLASSIC' | 'WRAP';
  permitData: any | null;
  quote: any;
  allQuotes?: Array<{
    routing: 'CLASSIC';
    quote: any;
  }>;
}

export function createQuoteHandler(
  routerService: RouterService,
  logger: Logger
) {
  return async function handleQuote(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = req.headers['x-request-id'] as string || `quote-${Date.now()}`;

    const log = logger.child({ requestId, endpoint: 'quote' });

    try {
      const body: QuoteRequestBody = req.body;

      // Validate required fields
      if (!body.amount) {
        log.debug({ body }, 'Validation failed: missing amount');
        res.status(400).json({
          error: 'Missing required fields',
          detail: 'amount is required',
        });
        return;
      }

      // Normalize token addresses
      const tokenIn = body.tokenIn || body.tokenInAddress;
      const tokenOut = body.tokenOut || body.tokenOutAddress;

      if (!tokenIn || !tokenOut) {
        log.debug({ body }, 'Validation failed: missing token addresses');
        res.status(400).json({
          error: 'Missing token addresses',
          detail: 'tokenIn/tokenInAddress and tokenOut/tokenOutAddress are required',
        });
        return;
      }

      // Check if both tokens are on the same chain (current limitation)
      if (body.tokenInChainId !== body.tokenOutChainId) {
        log.debug({
          tokenInChainId: body.tokenInChainId,
          tokenOutChainId: body.tokenOutChainId,
        }, 'Validation failed: cross-chain swaps not supported');
        res.status(400).json({
          error: 'Cross-chain swaps not supported',
          detail: 'tokenInChainId and tokenOutChainId must be the same',
        });
        return;
      }

      const chainId = body.tokenInChainId as ChainId;

      // Check if chain is supported
      if (!routerService.isChainSupported(chainId)) {
        log.debug({ chainId }, 'Validation failed: unsupported chain');
        res.status(400).json({
          error: 'Unsupported chain',
          detail: `Chain ID ${chainId} is not supported`,
        });
        return;
      }

      // Fetch token decimals from token lists if not provided (matches develop behavior)
      let tokenInDecimals = body.tokenInDecimals;
      let tokenOutDecimals = body.tokenOutDecimals;

      if (tokenInDecimals === undefined || tokenOutDecimals === undefined) {
        try {
          if (tokenInDecimals === undefined) {
            const tokenInInfo = await routerService.getTokenInfo(tokenIn, chainId);
            tokenInDecimals = tokenInInfo.decimals;
            log.debug({ tokenIn, decimals: tokenInDecimals }, 'Fetched tokenIn decimals from token list');
          }

          if (tokenOutDecimals === undefined) {
            const tokenOutInfo = await routerService.getTokenInfo(tokenOut, chainId);
            tokenOutDecimals = tokenOutInfo.decimals;
            log.debug({ tokenOut, decimals: tokenOutDecimals }, 'Fetched tokenOut decimals from token list');
          }
        } catch (error: any) {
          res.status(400).json({
            error: 'Token lookup failed',
            detail: error.message || 'Could not find token information. Please provide tokenInDecimals and tokenOutDecimals.',
          });
          return;
        }
      }

      // Check cache first
      const cachedQuote = quoteCache.get(body);
      if (cachedQuote) {
        res.setHeader('X-Quote-Cache', 'HIT');
        res.setHeader('X-Response-Time', `${Date.now() - startTime}ms`);
        log.info({ cacheHit: true, responseTime: Date.now() - startTime }, 'Quote served from cache');
        res.json(cachedQuote);
        return;
      }

      res.setHeader('X-Quote-Cache', 'MISS');

      // Start RPC call tracking for this request
      const rpcMonitor = getRPCMonitor();
      rpcMonitor?.startRequest(requestId);

      // Handle native <-> wrapped token operations (cBTC <-> WCBTC)
      const wrappedAddress = nativeOnChain(chainId).wrapped.address;
      const isWrapOperation =
        (isNativeCurrency(tokenIn) && tokenOut.toLowerCase() === wrappedAddress.toLowerCase()) ||
        (isNativeCurrency(tokenOut) && tokenIn.toLowerCase() === wrappedAddress.toLowerCase());

      if (isWrapOperation) {
        // Return AWS-compatible WRAP response
        const wrapResponse: QuoteResponse = {
          requestId: generateQuoteId(),
          routing: 'WRAP',
          permitData: null,
          quote: {
            chainId: chainId,
            swapper: body.swapper || '0x0000000000000000000000000000000000000000',
            input: {
              amount: body.amount,
              token: tokenIn
            },
            output: {
              amount: body.amount, // 1:1 exchange for wrap/unwrap
              token: tokenOut,
              recipient: body.swapper || '0x0000000000000000000000000000000000000000'
            },
            tradeType: body.type || 'EXACT_INPUT',
            gasFee: '0x5a995c00',
            gasFeeQuote: '0x5a995c00',
            gasUseEstimate: '0x5a995c00',
            maxFeePerGas: '0x5a995c00',
            maxPriorityFeePerGas: '0x59682f00'
          }
        };

        quoteCache.set(body, wrapResponse);

        log.info({
          tokenIn,
          tokenOut,
          amount: body.amount,
          routing: 'WRAP',
          responseTime: Date.now() - startTime,
        }, 'Wrap quote generated');

        res.setHeader('X-Response-Time', `${Date.now() - startTime}ms`);
        res.json(wrapResponse);
        return;
      }

      // Parse protocols - V3 only (V4 not yet supported in route building)
      let protocols: Protocol[] | undefined = undefined;
      if (body.protocols) {
        protocols = body.protocols
          .map(p => p.toUpperCase())
          .filter(p => p === 'V3')
          .map(_ => Protocol.V3);
      }

      // Get quote from router
      const route = await routerService.getQuote({
        tokenIn,
        tokenOut,
        tokenInDecimals,
        tokenOutDecimals,
        amount: body.amount,
        chainId,
        type: body.type === 'EXACT_OUTPUT' ? 'exactOut' : 'exactIn',
        recipient: body.swapper,
        protocols,
        enableUniversalRouter: body.enableUniversalRouter,
      });

      // Log RPC call statistics
      const rpcCallCount = rpcMonitor?.endRequest(requestId) || 0;
      rpcMonitor?.logRequest(requestId, 'POST /v1/quote', rpcCallCount);

      if (!route) {
        res.status(404).json({
          error: 'NO_ROUTE',
          detail: 'No route found',
        });
        return;
      }

      // Get cache status
      const hitsCachedRoutes = quoteCache.get(body) !== undefined;
      const quoteId = generateQuoteId();

      // Calculate decimal representations
      const inputAmountDecimals = formatDecimals(body.amount, tokenInDecimals);
      const quoteDecimals = route.quote.toExact();
      const quoteGasAdjustedDecimals = route.quoteGasAdjusted.toExact();

      // Calculate gas estimates in output token terms
      const gasUseEstimateQuote = route.estimatedGasUsedQuoteToken.quotient.toString();
      const gasUseEstimateQuoteDecimals = route.estimatedGasUsedQuoteToken.toExact();

      // Calculate price impact
      const priceImpact = calculatePriceImpact(route);

      // Build route response
      const routes = route.route;
      const routeResponse: any[] = [];

      // Get v3PoolProvider for address computation (matching develop branch)
      const v3PoolProvider = routerService.getV3PoolProvider(chainId);

      if (routes && routes.length > 0) {
        // Each route has: route.pools, route.tokenPath, amount, quote
        for (const subRoute of routes) {
          const pools = (subRoute.route as any)?.pools || [];
          const tokenPath = (subRoute.route as any)?.tokenPath || [];
          const curRoute: any[] = [];

          for (let i = 0; i < pools.length; i++) {
            const pool = pools[i];
            const tokenIn = tokenPath[i];
            const tokenOut = tokenPath[i + 1];

            // Calculate edge amounts for first and last pools
            let amountIn = undefined;
            if (i === 0) {
              amountIn = body.type === 'EXACT_OUTPUT'
                ? subRoute.quote.quotient.toString()
                : subRoute.amount.quotient.toString();
            }

            let amountOut = undefined;
            if (i === pools.length - 1) {
              amountOut = body.type === 'EXACT_OUTPUT'
                ? subRoute.amount.quotient.toString()
                : subRoute.quote.quotient.toString();
            }

            // Calculate pool address using v3PoolProvider (matching develop branch)
            const poolAddress = v3PoolProvider && pool.token0 && pool.token1 && pool.fee
              ? v3PoolProvider.getPoolAddress(pool.token0, pool.token1, pool.fee).poolAddress
              : 'unknown';

            curRoute.push({
              type: 'v3-pool',
              address: poolAddress,
              tokenIn: {
                chainId: tokenIn.chainId,
                decimals: tokenIn.decimals.toString(),
                address: tokenIn.wrapped?.address || tokenIn.address,
                symbol: tokenIn.symbol || 'TOKEN',
              },
              tokenOut: {
                chainId: tokenOut.chainId,
                decimals: tokenOut.decimals.toString(),
                address: tokenOut.wrapped?.address || tokenOut.address,
                symbol: tokenOut.symbol || 'TOKEN',
              },
              fee: pool.fee?.toString() || '3000',
              liquidity: pool.liquidity?.toString() || '0',
              sqrtRatioX96: pool.sqrtRatioX96?.toString() || '0',
              tickCurrent: pool.tickCurrent?.toString() || '0',
              amountIn,
              amountOut,
            });
          }

          routeResponse.push(curRoute);
        }
      }

      // Generate route string from formatted route
      const routeString = generateRouteString(routeResponse);

      // Format response to match AWS format exactly
      const formattedQuote = {
        blockNumber: route.blockNumber?.toString(),
        amount: body.amount,
        amountDecimals: inputAmountDecimals,
        quote: route.quote.quotient.toString(),
        quoteDecimals: quoteDecimals,
        quoteGasAdjusted: route.quoteGasAdjusted.quotient.toString(),
        quoteGasAdjustedDecimals: quoteGasAdjustedDecimals,
        gasUseEstimateQuote: gasUseEstimateQuote,
        gasUseEstimateQuoteDecimals: gasUseEstimateQuoteDecimals,
        gasUseEstimate: route.estimatedGasUsed.toString(),
        gasUseEstimateUSD: route.estimatedGasUsedUSD.toExact(),
        simulationStatus: route.simulationStatus || 'UNATTEMPTED',
        simulationError: false,
        gasPriceWei: route.gasPriceWei.toString(),
        route: routeResponse,
        routeString: routeString,
        quoteId: quoteId,
        hitsCachedRoutes: hitsCachedRoutes,
        priceImpact: priceImpact,
        swapper: body.swapper,
      };

      const response: QuoteResponse = {
        requestId: quoteId,
        routing: 'CLASSIC',
        permitData: null,
        quote: formattedQuote,
        allQuotes: [{ routing: 'CLASSIC', quote: formattedQuote }],
      };

      // Cache successful quotes
      if (quoteCache.shouldCache(body, response)) {
        quoteCache.set(body, response);
      }

      // Set response headers
      res.setHeader('X-Response-Time', `${Date.now() - startTime}ms`);

      log.info({
        responseTime: Date.now() - startTime,
        quote: route.quote.toExact(),
        gasEstimate: route.estimatedGasUsed.toString(),
      }, 'Quote generated successfully');

      res.json(response);

    } catch (error) {
      // Check if this is a ProviderGasError (route found but quote estimation failed)
      const isProviderGasError = error instanceof Error &&
        error.message.includes('ProviderGasError');

      if (isProviderGasError) {
        log.warn({
          error: error instanceof Error ? {
            message: error.message,
            name: error.name
          } : error
        }, 'Route found but quote estimation failed');

        res.status(404).json({
          errorCode: 'QUOTE_UNAVAILABLE',
          detail: 'Route found but unable to estimate quote. This may be due to insufficient liquidity or network issues. Please try again.',
        });
        return;
      }

      // For other errors, return 500
      log.error({
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name
        } : error
      }, 'Failed to generate quote');

      res.status(500).json({
        error: 'Internal server error',
        detail: error instanceof Error ? error.message : 'Unknown error occurred',
      });
    }
  };
}