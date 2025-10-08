/**
 * @swagger
 * components:
 *   schemas:
 *     Token:
 *       type: object
 *       properties:
 *         chainId:
 *           type: integer
 *           description: Chain ID where token exists
 *         decimals:
 *           type: string
 *           description: Number of decimals for the token
 *         address:
 *           type: string
 *           description: Token contract address
 *         symbol:
 *           type: string
 *           description: Token symbol (e.g., ETH, USDC)
 *
 *     RoutePool:
 *       type: object
 *       properties:
 *         type:
 *           type: string
 *           enum: [v3-pool]
 *           description: Pool type
 *         address:
 *           type: string
 *           description: Pool contract address
 *         tokenIn:
 *           $ref: '#/components/schemas/Token'
 *         tokenOut:
 *           $ref: '#/components/schemas/Token'
 *         fee:
 *           type: string
 *           description: Pool fee tier (e.g., 3000 for 0.3%)
 *         liquidity:
 *           type: string
 *           description: Pool liquidity
 *         sqrtRatioX96:
 *           type: string
 *           description: Current sqrt price ratio
 *         tickCurrent:
 *           type: string
 *           description: Current tick
 *         amountIn:
 *           type: string
 *           description: Input amount for this pool (if first pool)
 *         amountOut:
 *           type: string
 *           description: Output amount from this pool (if last pool)
 *
 *     QuoteDetails:
 *       type: object
 *       properties:
 *         blockNumber:
 *           type: string
 *           description: Block number when quote was generated
 *         amount:
 *           type: string
 *           description: Input amount in wei
 *         amountDecimals:
 *           type: string
 *           description: Input amount in human-readable format
 *         quote:
 *           type: string
 *           description: Output amount in wei
 *         quoteDecimals:
 *           type: string
 *           description: Output amount in human-readable format
 *         quoteGasAdjusted:
 *           type: string
 *           description: Quote adjusted for gas costs (wei)
 *         quoteGasAdjustedDecimals:
 *           type: string
 *           description: Gas-adjusted quote in human-readable format
 *         gasUseEstimateQuote:
 *           type: string
 *           description: Estimated gas cost in output token (wei)
 *         gasUseEstimateQuoteDecimals:
 *           type: string
 *           description: Gas cost in output token (human-readable)
 *         gasUseEstimate:
 *           type: string
 *           description: Estimated gas units
 *         gasUseEstimateUSD:
 *           type: string
 *           description: Estimated gas cost in USD
 *         simulationStatus:
 *           type: string
 *           enum: [UNATTEMPTED, SUCCESS, FAILED]
 *           description: Simulation status
 *         simulationError:
 *           type: boolean
 *           description: Whether simulation encountered an error
 *         gasPriceWei:
 *           type: string
 *           description: Gas price in wei
 *         route:
 *           type: array
 *           description: Array of routes (each route is an array of pools)
 *           items:
 *             type: array
 *             items:
 *               $ref: '#/components/schemas/RoutePool'
 *         routeString:
 *           type: string
 *           description: Human-readable route description
 *         quoteId:
 *           type: string
 *           description: Unique quote identifier
 *         hitsCachedRoutes:
 *           type: boolean
 *           description: Whether this quote used cached routes
 *         priceImpact:
 *           type: string
 *           description: Estimated price impact percentage
 *         swapper:
 *           type: string
 *           description: Address of the swapper
 *
 *     QuoteResponse:
 *       type: object
 *       properties:
 *         requestId:
 *           type: string
 *           description: Unique request identifier
 *         routing:
 *           type: string
 *           enum: [CLASSIC, WRAP]
 *           description: Routing type
 *         permitData:
 *           type: object
 *           nullable: true
 *           description: Permit2 data if applicable
 *         quote:
 *           $ref: '#/components/schemas/QuoteDetails'
 *         allQuotes:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               routing:
 *                 type: string
 *                 enum: [CLASSIC]
 *               quote:
 *                 $ref: '#/components/schemas/QuoteDetails'
 *
 *     SwapTransaction:
 *       type: object
 *       properties:
 *         data:
 *           type: string
 *           description: Hex-encoded transaction data
 *         to:
 *           type: string
 *           description: Contract address to call
 *         value:
 *           type: string
 *           description: ETH value to send (hex)
 *         from:
 *           type: string
 *           description: Sender address
 *         maxFeePerGas:
 *           type: string
 *           description: Maximum fee per gas (hex)
 *         maxPriorityFeePerGas:
 *           type: string
 *           description: Maximum priority fee per gas (hex)
 *         gasLimit:
 *           type: string
 *           description: Gas limit (hex or decimal)
 *         chainId:
 *           type: integer
 *           description: Chain ID for this transaction
 *
 *     SwapResponse:
 *       type: object
 *       properties:
 *         requestId:
 *           type: string
 *           description: Unique request identifier
 *         swap:
 *           $ref: '#/components/schemas/SwapTransaction'
 *         gasFee:
 *           type: string
 *           description: Estimated gas fee in wei
 *         gasEstimates:
 *           type: array
 *           description: Gas estimation details
 *           items:
 *             type: object
 *
 *     TokenListResponse:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Token list name
 *         timestamp:
 *           type: string
 *           description: Last updated timestamp
 *         version:
 *           type: object
 *           properties:
 *             major:
 *               type: integer
 *             minor:
 *               type: integer
 *             patch:
 *               type: integer
 *         tokens:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               chainId:
 *                 type: integer
 *               address:
 *                 type: string
 *               symbol:
 *                 type: string
 *               name:
 *                 type: string
 *               decimals:
 *                 type: integer
 *               logoURI:
 *                 type: string
 *
 *     SwapStatus:
 *       type: object
 *       properties:
 *         requestId:
 *           type: string
 *           description: Request identifier
 *         swaps:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               swapType:
 *                 type: string
 *                 nullable: true
 *               status:
 *                 type: string
 *                 enum: [PENDING, SUCCESS, NOT_FOUND, FAILED, EXPIRED]
 *               txHash:
 *                 type: string
 *               swapId:
 *                 type: string
 *
 *     LpApprovalResponse:
 *       type: object
 *       properties:
 *         requestId:
 *           type: string
 *         token0Approval:
 *           oneOf:
 *             - $ref: '#/components/schemas/SwapTransaction'
 *             - type: 'null'
 *         token1Approval:
 *           oneOf:
 *             - $ref: '#/components/schemas/SwapTransaction'
 *             - type: 'null'
 *         token0Cancel:
 *           type: 'null'
 *         token1Cancel:
 *           type: 'null'
 *         positionTokenApproval:
 *           type: 'null'
 *         permitData:
 *           type: 'null'
 *         token0PermitTransaction:
 *           type: 'null'
 *         token1PermitTransaction:
 *           type: 'null'
 *         positionTokenPermitTransaction:
 *           type: 'null'
 *         gasFeeToken0Approval:
 *           type: string
 *
 *     LpCreateResponse:
 *       type: object
 *       properties:
 *         requestId:
 *           type: string
 *         create:
 *           $ref: '#/components/schemas/SwapTransaction'
 *         dependentAmount:
 *           type: string
 *           description: Calculated amount for the dependent token
 *         gasFee:
 *           type: string
 *           description: Estimated gas fee in ETH
 *
 *     QuoteRequest:
 *       type: object
 *       required:
 *         - tokenInChainId
 *         - tokenOutChainId
 *         - amount
 *       properties:
 *         tokenInChainId:
 *           type: integer
 *         tokenIn:
 *           type: string
 *         tokenInAddress:
 *           type: string
 *         tokenInDecimals:
 *           type: integer
 *         tokenOutChainId:
 *           type: integer
 *         tokenOut:
 *           type: string
 *         tokenOutAddress:
 *           type: string
 *         tokenOutDecimals:
 *           type: integer
 *         amount:
 *           type: string
 *         type:
 *           type: string
 *           enum: [EXACT_INPUT, EXACT_OUTPUT]
 *         swapper:
 *           type: string
 *         slippageTolerance:
 *           type: string
 *         deadline:
 *           type: integer
 *         enableUniversalRouter:
 *           type: boolean
 *         protocols:
 *           type: array
 *           items:
 *             type: string
 *
 *     SwapRequest:
 *       type: object
 *       required:
 *         - tokenInChainId
 *         - tokenOutChainId
 *         - amount
 *         - recipient
 *         - slippageTolerance
 *         - from
 *       properties:
 *         type:
 *           type: string
 *           enum: [WRAP, UNWRAP, exactIn, exactOut]
 *         tokenInChainId:
 *           type: integer
 *         tokenIn:
 *           type: string
 *         tokenInAddress:
 *           type: string
 *         tokenInDecimals:
 *           type: integer
 *         tokenOutChainId:
 *           type: integer
 *         tokenOut:
 *           type: string
 *         tokenOutAddress:
 *           type: string
 *         tokenOutDecimals:
 *           type: integer
 *         amount:
 *           type: string
 *         recipient:
 *           type: string
 *         slippageTolerance:
 *           type: string
 *         deadline:
 *           type: string
 *         from:
 *           type: string
 *         chainId:
 *           type: integer
 *         enableUniversalRouter:
 *           type: boolean
 *         simulate:
 *           type: boolean
 *
 *     LpApproveRequest:
 *       type: object
 *       required:
 *         - walletAddress
 *         - chainId
 *         - protocol
 *         - token0
 *         - token1
 *         - amount0
 *         - amount1
 *       properties:
 *         simulateTransaction:
 *           type: boolean
 *         walletAddress:
 *           type: string
 *         chainId:
 *           type: integer
 *         protocol:
 *           type: string
 *           enum: [V3]
 *         token0:
 *           type: string
 *         token1:
 *           type: string
 *         amount0:
 *           type: string
 *         amount1:
 *           type: string
 *
 *     LpCreateRequest:
 *       type: object
 *       required:
 *         - protocol
 *         - walletAddress
 *         - chainId
 *         - independentAmount
 *         - independentToken
 *         - position
 *       properties:
 *         simulateTransaction:
 *           type: boolean
 *         protocol:
 *           type: string
 *           enum: [V3]
 *         walletAddress:
 *           type: string
 *         chainId:
 *           type: integer
 *         independentAmount:
 *           type: string
 *         independentToken:
 *           type: string
 *           enum: [TOKEN_0, TOKEN_1]
 *         initialDependentAmount:
 *           type: string
 *         initialPrice:
 *           type: string
 *         position:
 *           type: object
 *           required:
 *             - tickLower
 *             - tickUpper
 *             - pool
 *           properties:
 *             tickLower:
 *               type: integer
 *             tickUpper:
 *               type: integer
 *             pool:
 *               type: object
 *               required:
 *                 - token0
 *                 - token1
 *                 - fee
 *               properties:
 *                 tickSpacing:
 *                   type: integer
 *                 token0:
 *                   type: string
 *                 token1:
 *                   type: string
 *                 fee:
 *                   type: integer
 */

// This file provides OpenAPI schema definitions via JSDoc comments
export {};
