import { z } from 'zod';
import { ethers } from 'ethers';

/**
 * Validation schemas for API endpoints using Zod
 * Provides runtime validation with type inference
 */

// Common schemas
export const AddressSchema = z.string().refine(
  (val) => ethers.utils.isAddress(val),
  'Invalid Ethereum address'
);
export const ChainIdSchema = z.number().int().refine(
  (val) => [1, 11155111, 5115].includes(val),
  'Unsupported chain ID'
);
export const AmountSchema = z.string().regex(/^\d+$/, 'Amount must be a positive integer string');

// Quote endpoint schema
export const QuoteRequestSchema = z.object({
  tokenInChainId: ChainIdSchema,
  tokenIn: AddressSchema.optional(),
  tokenInAddress: AddressSchema.optional(),
  tokenInDecimals: z.coerce.number().int().positive().optional(),
  tokenOutChainId: ChainIdSchema,
  tokenOut: AddressSchema.optional(),
  tokenOutAddress: AddressSchema.optional(),
  tokenOutDecimals: z.coerce.number().int().positive().optional(),
  amount: AmountSchema,
  type: z.enum(['EXACT_INPUT', 'EXACT_OUTPUT']).optional(),
  swapper: AddressSchema.optional(),
  slippageTolerance: z.coerce.string().optional(),
  deadline: z.coerce.number().int().positive().optional(),
  enableUniversalRouter: z.boolean().optional(),
  protocols: z.array(z.string()).optional(),
}).refine(
  (data) => data.tokenIn || data.tokenInAddress,
  {
    message: 'Either tokenIn or tokenInAddress must be provided',
    path: ['tokenInAddress'],
  }
).refine(
  (data) => data.tokenOut || data.tokenOutAddress,
  {
    message: 'Either tokenOut or tokenOutAddress must be provided',
    path: ['tokenOutAddress'],
  }
);

export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;

// Swap endpoint schema
export const SwapRequestSchema = z.object({
  type: z.enum(['WRAP', 'UNWRAP', 'exactIn', 'exactOut']).optional(),
  tokenInChainId: ChainIdSchema,
  tokenIn: AddressSchema.optional(),
  tokenInAddress: AddressSchema.optional(),
  tokenInDecimals: z.coerce.number().int().positive().optional(),
  tokenOutChainId: ChainIdSchema,
  tokenOut: AddressSchema.optional(),
  tokenOutAddress: AddressSchema.optional(),
  tokenOutDecimals: z.coerce.number().int().positive().optional(),
  amount: AmountSchema,
  recipient: AddressSchema,
  slippageTolerance: z.coerce.string(),
  deadline: z.coerce.string().optional(),
  from: AddressSchema,
  chainId: ChainIdSchema.optional(),
  enableUniversalRouter: z.boolean().optional(),
  simulate: z.boolean().optional(),
}).refine(
  (data) => data.tokenIn || data.tokenInAddress,
  {
    message: 'Either tokenIn or tokenInAddress must be provided',
    path: ['tokenInAddress'],
  }
).refine(
  (data) => data.tokenOut || data.tokenOutAddress,
  {
    message: 'Either tokenOut or tokenOutAddress must be provided',
    path: ['tokenOutAddress'],
  }
);

export type SwapRequest = z.infer<typeof SwapRequestSchema>;

// Swappable tokens query schema
export const SwappableTokensQuerySchema = z.object({
  tokenInChainId: z.string().transform((val) => parseInt(val, 10)).pipe(ChainIdSchema),
  tokenIn: AddressSchema.optional(),
});

export type SwappableTokensQuery = z.infer<typeof SwappableTokensQuerySchema>;

// Swaps status query schema
export const SwapsQuerySchema = z.object({
  txHashes: z.string().min(1, 'txHashes cannot be empty'),
  chainId: z.string().transform((val) => parseInt(val, 10)).pipe(ChainIdSchema),
});

export type SwapsQuery = z.infer<typeof SwapsQuerySchema>;

// Swap Approve schema
export const SwapApproveRequestSchema = z.object({
  walletAddress: AddressSchema,
  chainId: ChainIdSchema,
  tokenIn: AddressSchema,
  spenderAddress: AddressSchema,
});

export type SwapApproveRequest = z.infer<typeof SwapApproveRequestSchema>;

// LP Approve schema
export const LpApproveRequestSchema = z.object({
  simulateTransaction: z.boolean().optional(),
  walletAddress: AddressSchema,
  chainId: ChainIdSchema,
  protocol: z.literal('V3'),
  token0: AddressSchema,
  token1: AddressSchema,
  amount0: AmountSchema,
  amount1: AmountSchema,
});

export type LpApproveRequest = z.infer<typeof LpApproveRequestSchema>;

// LP Create schema
const PoolInfoSchema = z.object({
  tickSpacing: z.coerce.number().int().optional(),
  token0: z.string(), // Can be ADDRESS_ZERO
  token1: z.string(), // Can be ADDRESS_ZERO
  fee: z.coerce.number().int().positive(),
});

const PositionInfoSchema = z.object({
  tickLower: z.coerce.number().int(),
  tickUpper: z.coerce.number().int(),
  pool: PoolInfoSchema,
});

export const LpCreateRequestSchema = z.object({
  simulateTransaction: z.boolean().optional(),
  protocol: z.literal('V3'),
  walletAddress: AddressSchema,
  chainId: ChainIdSchema,
  independentAmount: AmountSchema,
  independentToken: z.enum(['TOKEN_0', 'TOKEN_1']),
  initialDependentAmount: AmountSchema.optional(),
  initialPrice: z.string().optional(),
  position: PositionInfoSchema,
}).refine(
  (data) => {
    // Either both initialPrice and initialDependentAmount are provided (new pool)
    // or neither is provided (existing pool)
    const hasInitialPrice = !!data.initialPrice;
    const hasInitialDependentAmount = !!data.initialDependentAmount;
    return hasInitialPrice === hasInitialDependentAmount;
  },
  {
    message: 'initialPrice and initialDependentAmount must both be provided or both be omitted',
    path: ['initialPrice'],
  }
);

export type LpCreateRequest = z.infer<typeof LpCreateRequestSchema>;

// Portfolio endpoint schema
export const PortfolioQuerySchema = z.object({
  chainId: z.string().optional().default('5115').transform((val) => parseInt(val, 10)).pipe(ChainIdSchema),
});

export type PortfolioQuery = z.infer<typeof PortfolioQuerySchema>;
