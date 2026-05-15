import { ChainId } from "@juiceswapxyz/sdk-core";
import Logger from "bunyan";
import { BigNumber, ethers, providers } from "ethers";

/**
 * Satsuma is the second main DEX on Citrea (Algebra Integral). For now we
 * integrate exactly one Satsuma pool — the deep USDC.e/ctUSD stable pool —
 * because today it is the single largest source of cross-DEX price
 * improvement for JuiceSwap users (≈$1.4M of liquidity vs JuiceSwap's own
 * thin V3 pools).
 *
 * The flow is intentionally narrow: we read quotes via Satsuma's Algebra
 * QuoterV2 contract and let the caller decide whether the Satsuma route
 * beats the existing CLASSIC route.
 */
const SATSUMA_QUOTER_V2 = "0xa77aD9f635a3FB3bCCC5E6d1A87cB269746Aba17";
const SATSUMA_SWAP_ROUTER = "0x3012e9049d05b4b5369d690114d5a5861ebb85cb";
const SATSUMA_POOL_USDC_E_CTUSD = "0x172d2ab563afdaace7247a6592ee1be62e791165";

const USDC_E = "0xE045e6c36cF77FAA2CfB54466D71A3aEF7bbE839";
const CTUSD = "0x8D82c4E3c936C7B5724A382a9c5a4E6Eb7aB6d5D";

// Algebra Integral v1.9 QuoterV2 ABI — the `deployer` field can be the zero
// address to use the factory's default pool deployer for a given pair.
const QUOTER_V2_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, address deployer, uint256 amountIn, uint160 limitSqrtPrice)) returns (uint256 amountOut, uint160 limitSqrtPriceAfter, uint32 initializedTicksCrossed, uint256 gasEstimate, uint16 fee)",
];

// Algebra Integral v1.9 SwapRouter — same `deployer=0x0` convention as Quoter.
const SWAP_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, address deployer, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 limitSqrtPrice)) payable returns (uint256 amountOut)",
];

// Algebra Integral v1.9 pool ABI — `price` is the current sqrt(token1/token0)
// in Q64.96, the canonical zero-impact mid-price for the pool.
const POOL_ABI = [
  "function globalState() external view returns (uint160 price, int24 tick, uint16 lastFee, uint8 pluginConfig, uint16 communityFee, bool unlocked)",
];

const Q192 = BigNumber.from(2).pow(192);

export interface SatsumaQuoteResult {
  amountOut: string;
  gasEstimate: string;
  poolAddress: string;
  routerAddress: string;
  /** Price impact as a percentage string, e.g. "0.42". May be negative. */
  priceImpact: string;
}

export class SatsumaPoolService {
  private readonly providersMap: Map<ChainId, providers.StaticJsonRpcProvider>;
  private readonly logger: Logger;

  constructor(
    providersMap: Map<ChainId, providers.StaticJsonRpcProvider>,
    logger: Logger,
  ) {
    this.providersMap = providersMap;
    this.logger = logger.child({ service: "SatsumaPoolService" });
  }

  /**
   * True if this exact-input swap is one we have a Satsuma pool for.
   * Today: USDC.e <-> ctUSD on Citrea Mainnet only.
   */
  isSupported(chainId: number, tokenIn: string, tokenOut: string): boolean {
    if (chainId !== ChainId.CITREA_MAINNET) {
      return false;
    }
    const ti = tokenIn.toLowerCase();
    const to = tokenOut.toLowerCase();
    const usdc = USDC_E.toLowerCase();
    const ctusd = CTUSD.toLowerCase();
    return (ti === usdc && to === ctusd) || (ti === ctusd && to === usdc);
  }

  async quoteExactInput(
    chainId: ChainId,
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
  ): Promise<SatsumaQuoteResult | null> {
    const provider = this.providersMap.get(chainId);
    if (!provider) {
      this.logger.warn({ chainId }, "No provider for Satsuma quote");
      return null;
    }

    const quoter = new ethers.Contract(
      SATSUMA_QUOTER_V2,
      QUOTER_V2_ABI,
      provider,
    );
    const pool = new ethers.Contract(
      SATSUMA_POOL_USDC_E_CTUSD,
      POOL_ABI,
      provider,
    );

    try {
      // Quote the real trade and read the pool's mid-price in parallel.
      // `globalState().price` is the canonical sqrt(token1/token0) Q64.96 —
      // the zero-impact spot price the trade would execute at if liquidity
      // were infinite. We use it to derive the trade's true price impact.
      const [result, state] = await Promise.all([
        quoter.callStatic.quoteExactInputSingle({
          tokenIn,
          tokenOut,
          deployer: ethers.constants.AddressZero,
          amountIn: BigNumber.from(amountIn),
          limitSqrtPrice: 0,
        }),
        pool.callStatic.globalState(),
      ]);

      const amountOut = BigNumber.from(result.amountOut);

      return {
        amountOut: amountOut.toString(),
        gasEstimate: BigNumber.from(result.gasEstimate).toString(),
        poolAddress: SATSUMA_POOL_USDC_E_CTUSD,
        routerAddress: SATSUMA_SWAP_ROUTER,
        priceImpact: this.computePriceImpact(
          tokenIn,
          tokenOut,
          BigNumber.from(amountIn),
          amountOut,
          BigNumber.from(state.price),
        ),
      };
    } catch (err) {
      this.logger.debug(
        { err: err instanceof Error ? err.message : err, tokenIn, tokenOut },
        "Satsuma quote or pool state read reverted",
      );
      return null;
    }
  }

  /**
   * Price impact as `(expected - actual) / expected`, in percent with 2
   * decimals. `expected` is the zero-impact output derived from the pool's
   * spot sqrt-price (`sqrtPriceX96`):
   *
   *   priceRatio (token1 per token0) = sqrtPriceX96^2 / 2^192
   *   token1_out = token0_in * priceRatio
   *   token0_out = token1_in / priceRatio
   *
   * Token ordering follows the Uniswap/Algebra convention: token0 is the
   * lexicographically smaller address. Both currently supported tokens
   * (USDC.e, ctUSD) have 6 decimals, so no decimal scaling is applied; if
   * `isSupported()` is widened to mixed-decimal pairs, this needs to take
   * decimals into account.
   *
   * Returns "0.00" if `sqrtPriceX96` or the expected output is zero so the
   * caller still receives a well-formed string.
   */
  private computePriceImpact(
    tokenIn: string,
    tokenOut: string,
    amountIn: BigNumber,
    amountOut: BigNumber,
    sqrtPriceX96: BigNumber,
  ): string {
    if (sqrtPriceX96.isZero() || amountIn.isZero()) {
      return "0.00";
    }
    const priceX192 = sqrtPriceX96.mul(sqrtPriceX96);
    const tokenInIsToken0 = tokenIn.toLowerCase() < tokenOut.toLowerCase();
    const expectedOut = tokenInIsToken0
      ? amountIn.mul(priceX192).div(Q192)
      : amountIn.mul(Q192).div(priceX192);
    if (expectedOut.isZero()) {
      return "0.00";
    }
    const bps = expectedOut.sub(amountOut).mul(10_000).div(expectedOut);
    return (bps.toNumber() / 100).toFixed(2);
  }

  poolAddress(): string {
    return SATSUMA_POOL_USDC_E_CTUSD;
  }

  routerAddress(): string {
    return SATSUMA_SWAP_ROUTER;
  }

  /**
   * Builds the calldata for a Satsuma SwapRouter `exactInputSingle` call.
   * Caller is responsible for computing the correct `amountOutMinimum`
   * (typically `quote * (1 - slippageTolerance)`).
   */
  buildExactInputSingleCalldata(params: {
    tokenIn: string;
    tokenOut: string;
    recipient: string;
    deadline: number;
    amountIn: string;
    amountOutMinimum: string;
  }): string {
    const iface = new ethers.utils.Interface(SWAP_ROUTER_ABI);
    return iface.encodeFunctionData("exactInputSingle", [
      {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        deployer: ethers.constants.AddressZero,
        recipient: params.recipient,
        deadline: BigNumber.from(params.deadline),
        amountIn: BigNumber.from(params.amountIn),
        amountOutMinimum: BigNumber.from(params.amountOutMinimum),
        limitSqrtPrice: 0,
      },
    ]);
  }
}
