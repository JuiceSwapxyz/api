import { Request, Response } from 'express';
import { ChainId } from '@juiceswapxyz/sdk-core';
import { Protocol } from '@juiceswapxyz/router-sdk';
import { nativeOnChain } from '@juiceswapxyz/smart-order-router';
import { isNativeCurrency } from '@juiceswapxyz/universal-router-sdk';
import { RouterService } from '../core/RouterService';
import { quoteCache } from '../cache/quoteCache';
import { getRPCMonitor } from '../utils/rpcMonitor';
import { trackUser } from '../services/userTracking';
import { extractIpAddress } from '../utils/ipAddress';
import { JuiceGatewayService } from '../services/JuiceGatewayService';
import {
  getChainContracts,
  hasJuiceDollarIntegration,
} from '../config/contracts';
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
    const isV2 = pool.type === 'v2-pool';

    if (isV2) {
      return `[V2] 100.00% = ${pool.tokenIn?.symbol || 'TOKEN'} -- [${pool.address}] -- ${pool.tokenOut?.symbol || 'TOKEN'}`;
    } else {
      const feePercent = pool.fee ? (Number(pool.fee) / 10000).toFixed(1) : '0.3';
      return `[V3] 100.00% = ${pool.tokenIn?.symbol || 'TOKEN'} -- ${feePercent}% [${pool.address}] -- ${pool.tokenOut?.symbol || 'TOKEN'}`;
    }
  }

  // For multi-hop or multi-route, detect if any pool is V2
  const hasV2 = formattedRoute.some(route => route.some((pool: any) => pool.type === 'v2-pool'));
  const hasV3 = formattedRoute.some(route => route.some((pool: any) => pool.type === 'v3-pool'));

  if (hasV2 && hasV3) {
    return '[V2+V3] Multi-hop route';
  } else if (hasV2) {
    return '[V2] Multi-hop route';
  } else {
    return '[V3] Multi-hop route';
  }
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

export enum Routing {
  CLASSIC = 'CLASSIC',
  WRAP = 'WRAP',
  UNWRAP = 'UNWRAP',
  GATEWAY_JUSD = 'GATEWAY_JUSD',         // JUSD/SUSD swap via JuiceSwapGateway
  GATEWAY_JUICE_OUT = 'GATEWAY_JUICE_OUT', // Buy JUICE via Gateway + Equity
  GATEWAY_JUICE_IN = 'GATEWAY_JUICE_IN',   // Sell JUICE via Equity.redeem()
}

export interface QuoteResponse {
  requestId: string;
  routing: Routing;
  permitData: any | null;
  quote: any;
  allQuotes?: Array<{
    routing: Routing;
    quote: any;
  }>;
}

/**
 * @swagger
 * /v1/quote:
 *   post:
 *     tags: [Quoting]
 *     summary: Get swap quote
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/QuoteRequest'
 *           example:
 *             tokenInChainId: 5115
 *             tokenInAddress: "0x0000000000000000000000000000000000000000"
 *             tokenOutChainId: 5115
 *             tokenOutAddress: "0xFdB0a83d94CD65151148a131167Eb499Cb85d015"
 *             amount: "1000000000000000000"
 *             type: "EXACT_INPUT"
 *             swapper: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
 *             protocols: ["V2", "V3"]
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/QuoteResponse'
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createQuoteHandler(
  routerService: RouterService,
  logger: Logger,
  juiceGatewayService?: JuiceGatewayService
) {
  return async function handleQuote(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = req.headers['x-request-id'] as string || `quote-${Date.now()}`;

    const log = logger.child({ requestId, endpoint: 'quote' });

    try {
      const body: QuoteRequestBody = req.body;

      trackUser(body.swapper, extractIpAddress(req), log);

      // Normalize token addresses (Zod validation ensures at least one is present)
      const tokenIn = (body.tokenIn || body.tokenInAddress)!;
      const tokenOut = (body.tokenOut || body.tokenOutAddress)!;

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
      let tokenInSymbol: string | undefined;
      let tokenInName: string | undefined;
      let tokenOutSymbol: string | undefined;
      let tokenOutName: string | undefined;

      if (tokenInDecimals === undefined || tokenOutDecimals === undefined) {
        try {
          if (tokenInDecimals === undefined) {
            const tokenInInfo = await routerService.getTokenInfo(tokenIn, chainId);
            tokenInDecimals = tokenInInfo.decimals;
            tokenInSymbol = tokenInInfo.symbol;
            tokenInName = tokenInInfo.name;
            log.debug({ tokenIn, decimals: tokenInDecimals }, 'Fetched tokenIn decimals from token list');
          }

          if (tokenOutDecimals === undefined) {
            const tokenOutInfo = await routerService.getTokenInfo(tokenOut, chainId);
            tokenOutDecimals = tokenOutInfo.decimals;
            tokenOutSymbol = tokenOutInfo.symbol;
            tokenOutName = tokenOutInfo.name;
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
        log.debug({ cacheHit: true, responseTime: Date.now() - startTime }, 'Quote served from cache');
        
        const formattedQuoteCached = {
          ...cachedQuote.quote,
          swapper: body.swapper,
        };

        const allQuotes = cachedQuote.allQuotes ? cachedQuote.allQuotes.map((q: any) => ({
          ...q,
          quote: {
            ...q.quote,
            swapper: body.swapper,
          }
        })) : undefined;

        res.json({
          ...cachedQuote,
          requestId: generateQuoteId(),
          quote: formattedQuoteCached,
          allQuotes,
        });
        
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
          routing: isNativeCurrency(tokenIn) ? Routing.WRAP : Routing.UNWRAP,
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

        log.debug({
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

      // ============================================
      // JuiceDollar Gateway Routing (JUSD/JUICE/SUSD)
      // ============================================
      // SUSD is routed through Gateway via registerBridgedToken() - no separate bridge service needed
      // Detect if this swap involves JUSD or JUICE tokens that need Gateway routing
      if (juiceGatewayService && hasJuiceDollarIntegration(chainId)) {
        const routingType = juiceGatewayService.detectRoutingType(chainId, tokenIn, tokenOut);

        if (routingType) {
          log.debug({ routingType, tokenIn, tokenOut }, 'Gateway routing detected');

          try {
            // Check if Gateway is paused
            const isPaused = await juiceGatewayService.isGatewayPaused(chainId);
            if (isPaused) {
              res.status(503).json({
                error: 'GATEWAY_PAUSED',
                detail: 'JuiceSwap Gateway is currently paused. Please try again later.',
              });
              return;
            }

            // Prepare quote with internal token conversions
            const gatewayQuote = await juiceGatewayService.prepareQuote(
              chainId,
              tokenIn,
              tokenOut,
              body.amount
            );

            if (!gatewayQuote) {
              // Gateway doesn't support this route (e.g., JUICE → non-JUSD)
              // Return NO_ROUTE to indicate the swap is not supported
              log.debug({ routingType, tokenIn, tokenOut }, 'Gateway route not supported');
              res.status(404).json({
                error: 'NO_ROUTE',
                detail: 'This token combination is not supported. For JUICE swaps, you can only swap directly to JUSD.',
              });
              return;
            }

            // For JUICE input, we've already converted to JUSD amount internally
            // Now route using internal tokens (svJUSD-based pools)
            const contracts = getChainContracts(chainId)!;

            // Get decimals for internal tokens
            let internalTokenInDecimals = tokenInDecimals;
            let internalTokenOutDecimals = tokenOutDecimals;

            // svJUSD and JUSD both have 18 decimals
            if (gatewayQuote.internalTokenIn.toLowerCase() === contracts.SV_JUSD.toLowerCase()) {
              internalTokenInDecimals = 18;
            }
            if (gatewayQuote.internalTokenOut.toLowerCase() === contracts.SV_JUSD.toLowerCase()) {
              internalTokenOutDecimals = 18;
            }

            // Parse protocols
            let protocols: Protocol[] | undefined = undefined;
            if (body.protocols) {
              protocols = body.protocols
                .map(p => p.toUpperCase())
                .filter(p => p === 'V2' || p === 'V3')
                .map(p => p === 'V2' ? Protocol.V2 : Protocol.V3);
            }

            // Get internal route quote
            const internalRoute = await routerService.getQuote({
              tokenIn: gatewayQuote.internalTokenIn,
              tokenOut: gatewayQuote.internalTokenOut,
              tokenInDecimals: internalTokenInDecimals,
              tokenOutDecimals: internalTokenOutDecimals,
              amount: gatewayQuote.internalAmountIn,
              chainId,
              type: body.type === 'EXACT_OUTPUT' ? 'exactOut' : 'exactIn',
              recipient: body.swapper,
              protocols,
              enableUniversalRouter: body.enableUniversalRouter,
            });

            if (!internalRoute) {
              res.status(404).json({
                error: 'NO_ROUTE',
                detail: 'No route found for Gateway swap',
              });
              return;
            }

            // Convert internal output to user-facing token
            const internalOutputAmount = internalRoute.quote.quotient.toString();
            const userOutputAmount = await juiceGatewayService.convertOutputToUserToken(
              chainId,
              tokenOut,
              internalOutputAmount,
              routingType
            );

            // Build Gateway quote response
            const quoteId = generateQuoteId();
            const inputAmountDecimals = formatDecimals(body.amount, tokenInDecimals);
            const outputAmountDecimals = formatDecimals(userOutputAmount, tokenOutDecimals);

            // Map routing type to Routing enum
            const gatewayRouting = routingType === 'GATEWAY_JUICE_IN'
              ? Routing.GATEWAY_JUICE_IN
              : routingType === 'GATEWAY_JUICE_OUT'
                ? Routing.GATEWAY_JUICE_OUT
                : Routing.GATEWAY_JUSD;

            const gatewayResponse: QuoteResponse = {
              requestId: quoteId,
              routing: gatewayRouting,
              permitData: null,
              quote: {
                chainId: chainId,
                swapper: body.swapper || '0x0000000000000000000000000000000000000000',
                input: {
                  amount: body.amount,
                  token: tokenIn,
                },
                output: {
                  amount: userOutputAmount,
                  token: tokenOut,
                  recipient: body.swapper || '0x0000000000000000000000000000000000000000',
                },
                tradeType: body.type || 'EXACT_INPUT',
                amount: body.amount,
                amountDecimals: inputAmountDecimals,
                quote: userOutputAmount,
                quoteDecimals: outputAmountDecimals,
                quoteGasAdjusted: internalRoute.quoteGasAdjusted.quotient.toString(),
                gasUseEstimate: internalRoute.estimatedGasUsed.toString(),
                gasUseEstimateUSD: internalRoute.estimatedGasUsedUSD.toExact(),
                gasPriceWei: internalRoute.gasPriceWei.toString(),
                // Include internal routing info for swap endpoint
                _internal: {
                  routingType,
                  internalTokenIn: gatewayQuote.internalTokenIn,
                  internalTokenOut: gatewayQuote.internalTokenOut,
                  internalAmountIn: gatewayQuote.internalAmountIn,
                  internalOutputAmount,
                },
              },
            };

            // Cache Gateway quotes
            if (quoteCache.shouldCache(body, gatewayResponse)) {
              quoteCache.set(body, gatewayResponse);
            }

            res.setHeader('X-Response-Time', `${Date.now() - startTime}ms`);
            log.debug({
              routingType,
              userInput: body.amount,
              userOutput: userOutputAmount,
              responseTime: Date.now() - startTime,
            }, 'Gateway quote generated');

            res.json(gatewayResponse);
            return;

          } catch (error) {
            log.error({ error, routingType }, 'Gateway quote failed');
            res.status(500).json({
              error: 'GATEWAY_ERROR',
              detail: error instanceof Error ? error.message : 'Gateway routing failed',
            });
            return;
          }
        }
      }

      // Parse protocols - V2 and V3 supported (V4 not yet supported in route building)
      let protocols: Protocol[] | undefined = undefined;
      if (body.protocols) {
        protocols = body.protocols
          .map(p => p.toUpperCase())
          .filter(p => p === 'V2' || p === 'V3')
          .map(p => p === 'V2' ? Protocol.V2 : Protocol.V3);
      }

      // Get quote from router
      const route = await routerService.getQuote({
        tokenIn,
        tokenOut,
        tokenInDecimals,
        tokenOutDecimals,
        tokenInSymbol,
        tokenInName,
        tokenOutSymbol,
        tokenOutName,
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
        // Each route has: route.pools (V3) or route.pairs (V2), route.tokenPath, amount, quote
        for (const subRoute of routes) {
          // Handle both V3 pools and V2 pairs
          const pools = (subRoute.route as any)?.pools || (subRoute.route as any)?.pairs || [];
          // V2 routes use 'path', V3 routes use 'tokenPath'
          const tokenPath = (subRoute.route as any)?.path || (subRoute.route as any)?.tokenPath || [];
          const isV2Route = !!(subRoute.route as any)?.pairs;
          const curRoute: any[] = [];

          for (let i = 0; i < pools.length; i++) {
            const pool = pools[i];
            const tokenIn = tokenPath[i];
            const tokenOut = tokenPath[i + 1];

            // Skip if token path is incomplete (shouldn't happen with valid routes)
            if (!tokenIn || !tokenOut) {
              continue;
            }

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

            if (isV2Route) {
              // V2 Pair formatting - reserve0/reserve1 must include token objects
              curRoute.push({
                type: 'v2-pool',
                address: pool.liquidityToken?.address || 'unknown',
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
                reserve0: {
                  token: {
                    chainId: pool.token0.chainId,
                    address: pool.token0.address,
                    decimals: pool.token0.decimals.toString(),
                    symbol: pool.token0.symbol || 'TOKEN',
                  },
                  quotient: pool.reserve0?.quotient?.toString() || '0',
                },
                reserve1: {
                  token: {
                    chainId: pool.token1.chainId,
                    address: pool.token1.address,
                    decimals: pool.token1.decimals.toString(),
                    symbol: pool.token1.symbol || 'TOKEN',
                  },
                  quotient: pool.reserve1?.quotient?.toString() || '0',
                },
                amountIn,
                amountOut,
              });
            } else {
              // V3 Pool formatting
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
        routing: Routing.CLASSIC,
        permitData: null,
        quote: formattedQuote,
        allQuotes: [{ routing: Routing.CLASSIC, quote: formattedQuote }],
      };

      // Cache successful quotes
      if (quoteCache.shouldCache(body, response)) {
        quoteCache.set(body, response);
      }

      // Set response headers
      res.setHeader('X-Response-Time', `${Date.now() - startTime}ms`);

      log.debug({
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