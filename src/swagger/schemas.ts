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
 *           enum: [v2-pool, v3-pool]
 *           description: Pool type (v2-pool for Uniswap V2, v3-pool for Uniswap V3)
 *         address:
 *           type: string
 *           description: Pool contract address
 *         tokenIn:
 *           $ref: '#/components/schemas/Token'
 *         tokenOut:
 *           $ref: '#/components/schemas/Token'
 *         fee:
 *           type: string
 *           description: Pool fee tier in bps (V3 only, e.g., 3000 for 0.3%)
 *         liquidity:
 *           type: string
 *           description: Pool liquidity (V3 only)
 *         sqrtRatioX96:
 *           type: string
 *           description: Current sqrt price ratio (V3 only)
 *         tickCurrent:
 *           type: string
 *           description: Current tick (V3 only)
 *         reserve0:
 *           type: object
 *           description: Reserve of token0 with token info (V2 only)
 *           properties:
 *             token:
 *               $ref: '#/components/schemas/Token'
 *             quotient:
 *               type: string
 *               description: Reserve amount in wei
 *         reserve1:
 *           type: object
 *           description: Reserve of token1 with token info (V2 only)
 *           properties:
 *             token:
 *               $ref: '#/components/schemas/Token'
 *             quotient:
 *               type: string
 *               description: Reserve amount in wei
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
 *     LpIncreaseResponse:
 *       type: object
 *       properties:
 *         requestId:
 *           type: string
 *         increase:
 *           $ref: '#/components/schemas/SwapTransaction'
 *         dependentAmount:
 *           type: string
 *           description: Calculated amount for the dependent token
 *         gasFee:
 *           type: string
 *           description: Estimated gas fee in ETH
 *
 *     LpDecreaseResponse:
 *       type: object
 *       properties:
 *         requestId:
 *           type: string
 *         decrease:
 *           $ref: '#/components/schemas/SwapTransaction'
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
 *             enum: [V2, V3]
 *           description: Routing protocols to use (defaults to all available)
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
 *         tokenId:
 *           type: integer
 *           description: NFT position token ID (for increase/decrease liquidity)
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
 *
 *     LpIncreaseRequest:
 *       type: object
 *       required:
 *         - protocol
 *         - walletAddress
 *         - chainId
 *         - tokenId
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
 *         tokenId:
 *           type: string
 *           description: NFT tokenId of the position to increase
 *         independentAmount:
 *           type: string
 *         independentToken:
 *           type: string
 *           enum: [TOKEN_0, TOKEN_1]
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
 *
 *     LpDecreaseRequest:
 *       type: object
 *       required:
 *         - simulateTransaction
 *         - protocol
 *         - tokenId
 *         - chainId
 *         - walletAddress
 *         - liquidityPercentageToDecrease
 *         - positionLiquidity
 *         - expectedTokenOwed0RawAmount
 *         - expectedTokenOwed1RawAmount
 *         - position
 *       properties:
 *         simulateTransaction:
 *           type: boolean
 *         protocol:
 *           type: string
 *           enum: [V3]
 *         tokenId:
 *           type: integer
 *         chainId:
 *           type: integer
 *         walletAddress:
 *           type: string
 *         liquidityPercentageToDecrease:
 *           type: number
 *           description: Percent (0-100) of position liquidity to remove
 *         positionLiquidity:
 *           type: string
 *           description: Raw liquidity of the position (as integer string)
 *         expectedTokenOwed0RawAmount:
 *           type: string
 *         expectedTokenOwed1RawAmount:
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
 *
 *     LaunchpadToken:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Token address (primary key)
 *         address:
 *           type: string
 *           description: Token contract address
 *         chainId:
 *           type: integer
 *           description: Chain ID
 *         name:
 *           type: string
 *           description: Token name
 *         symbol:
 *           type: string
 *           description: Token symbol
 *         creator:
 *           type: string
 *           description: Creator wallet address
 *         baseAsset:
 *           type: string
 *           description: Base asset address (e.g., WBTC)
 *         createdAt:
 *           type: string
 *           description: Creation timestamp (bigint as string)
 *         createdAtBlock:
 *           type: string
 *           description: Creation block number
 *         txHash:
 *           type: string
 *           description: Creation transaction hash
 *         graduated:
 *           type: boolean
 *           description: Whether token has graduated to V2 pool
 *         canGraduate:
 *           type: boolean
 *           description: Whether token is ready to graduate
 *         v2Pair:
 *           type: string
 *           nullable: true
 *           description: V2 pair address after graduation
 *         graduatedAt:
 *           type: string
 *           nullable: true
 *           description: Graduation timestamp
 *         totalBuys:
 *           type: integer
 *           description: Total number of buy transactions
 *         totalSells:
 *           type: integer
 *           description: Total number of sell transactions
 *         totalVolumeBase:
 *           type: string
 *           description: Total trading volume in base asset (wei as string)
 *         lastTradeAt:
 *           type: string
 *           nullable: true
 *           description: Last trade timestamp
 *
 *     LaunchpadTrade:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Trade ID (txHash-logIndex)
 *         tokenAddress:
 *           type: string
 *           description: Token contract address
 *         trader:
 *           type: string
 *           description: Trader wallet address
 *         isBuy:
 *           type: boolean
 *           description: Whether this is a buy (true) or sell (false)
 *         baseAmount:
 *           type: string
 *           description: Base asset amount (wei as string)
 *         tokenAmount:
 *           type: string
 *           description: Token amount (wei as string)
 *         timestamp:
 *           type: string
 *           description: Trade timestamp
 *         txHash:
 *           type: string
 *           description: Transaction hash
 *         tokenName:
 *           type: string
 *           description: Token name (only in recent-trades endpoint)
 *         tokenSymbol:
 *           type: string
 *           description: Token symbol (only in recent-trades endpoint)
 *
 *     LaunchpadStats:
 *       type: object
 *       properties:
 *         totalTokens:
 *           type: integer
 *           description: Total number of tokens created
 *         graduatedTokens:
 *           type: integer
 *           description: Number of graduated tokens
 *         activeTokens:
 *           type: integer
 *           description: Number of active (not graduating) tokens
 *         graduatingTokens:
 *           type: integer
 *           description: Number of tokens ready to graduate
 *         totalTrades:
 *           type: integer
 *           description: Total number of trades
 *         totalVolumeBase:
 *           type: string
 *           description: Total trading volume in base asset (wei as string)
 */

// This file provides OpenAPI schema definitions via JSDoc comments
export {};
