export const typeDefs = `#graphql
  enum Chain {
    ETHEREUM
    ETHEREUM_SEPOLIA
    POLYGON
    CITREA_MAINNET
    CITREA_TESTNET
  }

  type Query {
    """
    Get swap transaction statuses by transaction hashes
    """
    swaps(txHashes: [String!]!, chainId: Int!): SwapsResponse!

    """
    Get a quote for swapping tokens
    """
    quote(input: QuoteInput!): QuoteResponse!

    """
    Health check
    """
    health: String!

    """
    V2 pool transactions for Explore (paginated by timestamp)
    """
    v2Transactions(chain: Chain!, first: Int!, timestampCursor: Int): [PoolTransaction!]!

    """
    V3 pool transactions for Explore (paginated by timestamp)
    """
    v3Transactions(chain: Chain!, first: Int!, timestampCursor: Int): [PoolTransaction!]!

    """
    V4 pool transactions for Explore (paginated by timestamp)
    """
    v4Transactions(chain: Chain!, first: Int!, timestampCursor: Int): [PoolTransaction!]!
  }

  type Amount {
    id: ID!
    currency: String
    value: Float!
  }

  type Image {
    id: ID!
    url: String
  }

  type TokenProject {
    id: ID!
    name: String
    tokens: [Token!]
    logo: Image
  }

  enum PoolTransactionType {
    SWAP
    ADD
    REMOVE
  }

  enum ProtocolVersion {
    V2
    V3
    V4
  }

  type PoolTransaction {
    id: ID!
    chain: Chain!
    protocolVersion: ProtocolVersion!
    type: PoolTransactionType!
    hash: String!
    timestamp: Int!
    usdValue: Amount!
    account: String!
    token0: Token!
    token0Quantity: String!
    token1: Token!
    token1Quantity: String!
  }

  type SwapsResponse {
    requestId: String!
    swaps: [Swap!]!
  }

  type Swap {
    swapType: String
    status: SwapStatus
    txHash: String
    swapId: String
  }

  enum SwapStatus {
    PENDING
    SUCCESS
    NOT_FOUND
    FAILED
    EXPIRED
  }

  input QuoteInput {
    tokenInAddress: String!
    tokenInChainId: Int!
    tokenOutAddress: String!
    tokenOutChainId: Int!
    amount: String!
    type: String!
    swapper: String
    slippageTolerance: String
    deadline: Int
  }

  type QuoteResponse {
    routing: String!
    quote: QuoteDetails!
    allQuotes: [QuoteOption!]!
  }

  type QuoteOption {
    routing: String!
    quote: QuoteDetails!
  }

  type QuoteDetails {
    blockNumber: String!
    amount: String!
    amountDecimals: String!
    quote: String!
    quoteDecimals: String!
    quoteGasAdjusted: String!
    quoteGasAdjustedDecimals: String!
    gasUseEstimateQuote: String!
    gasUseEstimateQuoteDecimals: String!
    gasUseEstimate: String!
    gasUseEstimateUSD: String!
    simulationStatus: String!
    simulationError: Boolean!
    gasPriceWei: String!
    route: [[RoutePool!]!]!
    routeString: String!
    quoteId: String!
    hitsCachedRoutes: Boolean
    priceImpact: String
    swapper: String
  }

  type RoutePool {
    type: String!
    address: String!
    tokenIn: RouteToken!
    tokenOut: RouteToken!
    fee: String
    liquidity: String
    sqrtRatioX96: String
    tickCurrent: String
    amountIn: String
    amountOut: String
  }

  type RouteToken {
    chainId: Int!
    decimals: String!
    address: String!
    symbol: String!
  }

  type Token {
    id: ID!
    chainId: Int!
    chain: Chain!
    address: String!
    symbol: String!
    decimals: Int
    project: TokenProject
  }
`;
