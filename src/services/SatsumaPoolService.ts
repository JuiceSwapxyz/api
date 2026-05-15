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

export interface SatsumaQuoteResult {
  amountOut: string;
  gasEstimate: string;
  poolAddress: string;
  routerAddress: string;
  /** Price impact as a percentage string, e.g. "0.42". May be negative. */
  priceImpact: string;
}

// 1 token of the input asset, used as a near-zero-impact reference quote so
// we can treat its output/input ratio as the pool's mid-price. Both supported
// tokens (USDC.e, ctUSD) have 6 decimals.
const MID_PRICE_PROBE_AMOUNT = "1000000";

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

    try {
      // Quote the real trade and a tiny reference trade in parallel. The
      // reference trade approximates the pool's mid-price (zero-slippage
      // execution rate) and is used to derive a real price impact instead of
      // returning a hardcoded value.
      const probeAmount = BigNumber.from(MID_PRICE_PROBE_AMOUNT);
      const [result, probeResult] = await Promise.all([
        quoter.callStatic.quoteExactInputSingle({
          tokenIn,
          tokenOut,
          deployer: ethers.constants.AddressZero,
          amountIn: BigNumber.from(amountIn),
          limitSqrtPrice: 0,
        }),
        quoter.callStatic.quoteExactInputSingle({
          tokenIn,
          tokenOut,
          deployer: ethers.constants.AddressZero,
          amountIn: probeAmount,
          limitSqrtPrice: 0,
        }),
      ]);

      const amountOut = BigNumber.from(result.amountOut);
      const probeOut = BigNumber.from(probeResult.amountOut);

      return {
        amountOut: amountOut.toString(),
        gasEstimate: BigNumber.from(result.gasEstimate).toString(),
        poolAddress: SATSUMA_POOL_USDC_E_CTUSD,
        routerAddress: SATSUMA_SWAP_ROUTER,
        priceImpact: this.computePriceImpact(
          BigNumber.from(amountIn),
          amountOut,
          probeAmount,
          probeOut,
        ),
      };
    } catch (err) {
      this.logger.debug(
        { err: err instanceof Error ? err.message : err, tokenIn, tokenOut },
        "Satsuma QuoterV2 reverted",
      );
      return null;
    }
  }

  /**
   * Price impact as `(expected - actual) / expected`, expressed as a
   * percentage with 2 decimals. `expected` is derived from a small reference
   * quote whose own impact is treated as negligible (≈$0.000001 of slippage
   * for the actual Satsuma USDC.e/ctUSD pool today). Returns "0.00" if the
   * probe yields no output (degenerate path) so the caller still has a
   * truthy, well-formed string.
   */
  private computePriceImpact(
    amountIn: BigNumber,
    amountOut: BigNumber,
    probeIn: BigNumber,
    probeOut: BigNumber,
  ): string {
    if (probeOut.isZero() || amountIn.isZero()) {
      return "0.00";
    }
    const expectedOut = amountIn.mul(probeOut).div(probeIn);
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
