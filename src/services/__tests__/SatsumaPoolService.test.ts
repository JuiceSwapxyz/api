import { ChainId } from "@juiceswapxyz/sdk-core";
import Logger from "bunyan";
import { ethers } from "ethers";
import { SatsumaPoolService } from "../SatsumaPoolService";

const mockLogger = {
  child: () => mockLogger,
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

const USDC_E = "0xE045e6c36cF77FAA2CfB54466D71A3aEF7bbE839";
const CTUSD = "0x8D82c4E3c936C7B5724A382a9c5a4E6Eb7aB6d5D";
const RANDOM = "0x1234567890123456789012345678901234567890";

describe("SatsumaPoolService.isSupported()", () => {
  let service: SatsumaPoolService;

  beforeEach(() => {
    service = new SatsumaPoolService(
      new Map<ChainId, ethers.providers.StaticJsonRpcProvider>(),
      mockLogger,
    );
  });

  it("supports USDC.e -> ctUSD on Citrea Mainnet", () => {
    expect(service.isSupported(ChainId.CITREA_MAINNET, USDC_E, CTUSD)).toBe(
      true,
    );
  });

  it("supports ctUSD -> USDC.e on Citrea Mainnet", () => {
    expect(service.isSupported(ChainId.CITREA_MAINNET, CTUSD, USDC_E)).toBe(
      true,
    );
  });

  it("is case-insensitive", () => {
    expect(
      service.isSupported(
        ChainId.CITREA_MAINNET,
        USDC_E.toLowerCase(),
        CTUSD.toUpperCase(),
      ),
    ).toBe(true);
  });

  it("rejects pairs with a third token", () => {
    expect(service.isSupported(ChainId.CITREA_MAINNET, USDC_E, RANDOM)).toBe(
      false,
    );
    expect(service.isSupported(ChainId.CITREA_MAINNET, RANDOM, CTUSD)).toBe(
      false,
    );
  });

  it("rejects non-Citrea-Mainnet chains", () => {
    expect(service.isSupported(ChainId.CITREA_TESTNET, USDC_E, CTUSD)).toBe(
      false,
    );
    expect(service.isSupported(ChainId.MAINNET, USDC_E, CTUSD)).toBe(false);
  });
});

describe("SatsumaPoolService.quoteExactInput()", () => {
  let service: SatsumaPoolService;

  beforeEach(() => {
    service = new SatsumaPoolService(
      new Map<ChainId, ethers.providers.StaticJsonRpcProvider>(),
      mockLogger,
    );
  });

  it("returns null when no provider is configured for the chain", async () => {
    const result = await service.quoteExactInput(
      ChainId.CITREA_MAINNET,
      USDC_E,
      CTUSD,
      "1000000",
    );
    expect(result).toBeNull();
  });

  it("returns null when QuoterV2 reverts", async () => {
    // Real StaticJsonRpcProvider, but its low-level send() is mocked to
    // reject — exactly the path a real on-chain revert takes.
    const provider = new ethers.providers.StaticJsonRpcProvider(
      "http://example.invalid",
    );
    jest
      .spyOn(provider, "send")
      .mockRejectedValue(new Error("execution reverted"));

    service = new SatsumaPoolService(
      new Map([[ChainId.CITREA_MAINNET, provider]]),
      mockLogger,
    );

    const result = await service.quoteExactInput(
      ChainId.CITREA_MAINNET,
      USDC_E,
      CTUSD,
      "1000000",
    );
    expect(result).toBeNull();
  });

  describe("priceImpact", () => {
    const quoterIface = new ethers.utils.Interface([
      "function quoteExactInputSingle((address tokenIn, address tokenOut, address deployer, uint256 amountIn, uint160 limitSqrtPrice)) returns (uint256 amountOut, uint160 limitSqrtPriceAfter, uint32 initializedTicksCrossed, uint256 gasEstimate, uint16 fee)",
    ]);
    const poolIface = new ethers.utils.Interface([
      "function globalState() external view returns (uint160 price, int24 tick, uint16 lastFee, uint8 pluginConfig, uint16 communityFee, bool unlocked)",
    ]);

    // sqrt(1) * 2^96 — the exact mid-price of a 1:1 stable pool with equal
    // token decimals. Used in all tests below since both USDC.e and ctUSD
    // have 6 decimals and trade approximately 1:1 in the real Satsuma pool.
    const SQRT_PRICE_1_TO_1 = ethers.BigNumber.from(2).pow(96).toString();

    const QUOTER_ADDRESS = "0xa77ad9f635a3fb3bccc5e6d1a87cb269746aba17";
    const POOL_ADDRESS = "0x172d2ab563afdaace7247a6592ee1be62e791165";

    // Builds a provider whose eth_call dispatches to either the QuoterV2
    // (returning a caller-supplied amountOut for the requested amountIn) or
    // the pool (returning a caller-supplied sqrtPriceX96 for globalState).
    function buildProvider(opts: {
      quoteOutputs: Record<string, string>;
      sqrtPriceX96: string;
    }) {
      const provider = new ethers.providers.StaticJsonRpcProvider(
        "http://example.invalid",
        { name: "citrea", chainId: ChainId.CITREA_MAINNET },
      );
      jest
        .spyOn(provider, "send")
        .mockImplementation(async (method, params) => {
          if (method !== "eth_call") {
            throw new Error(`Unexpected RPC call: ${method}`);
          }
          const [tx] = params as [{ data: string; to: string }];
          const to = tx.to.toLowerCase();
          if (to === QUOTER_ADDRESS) {
            const decoded = quoterIface.decodeFunctionData(
              "quoteExactInputSingle",
              tx.data,
            );
            const amountIn = (
              decoded[0].amountIn as ethers.BigNumber
            ).toString();
            const out = opts.quoteOutputs[amountIn];
            if (out === undefined) {
              throw new Error(`Unexpected amountIn: ${amountIn}`);
            }
            return quoterIface.encodeFunctionResult("quoteExactInputSingle", [
              ethers.BigNumber.from(out),
              0,
              0,
              ethers.BigNumber.from("100000"),
              500,
            ]);
          }
          if (to === POOL_ADDRESS) {
            return poolIface.encodeFunctionResult("globalState", [
              ethers.BigNumber.from(opts.sqrtPriceX96),
              0,
              500,
              0,
              0,
              true,
            ]);
          }
          throw new Error(`Unexpected eth_call target: ${tx.to}`);
        });
      return provider;
    }

    it("derives real price impact from sqrtPriceX96 + actual quote", async () => {
      // Reproduces the issue #764 trade: 3,003.416087 USDC.e -> 1,756.651830
      // ctUSD on a pool with a 1:1 mid-price. Expected impact ≈
      // (3003.416087 - 1756.651830) / 3003.416087 ≈ 41.51%.
      const provider = buildProvider({
        quoteOutputs: { "3003416087": "1756651830" },
        sqrtPriceX96: SQRT_PRICE_1_TO_1,
      });
      service = new SatsumaPoolService(
        new Map([[ChainId.CITREA_MAINNET, provider]]),
        mockLogger,
      );

      const result = await service.quoteExactInput(
        ChainId.CITREA_MAINNET,
        USDC_E,
        CTUSD,
        "3003416087",
      );

      expect(result).not.toBeNull();
      expect(result!.amountOut).toBe("1756651830");
      expect(result!.priceImpact).toBe("41.51");
    });

    it("reports a small, non-zero impact for routine swaps", async () => {
      // 100 USDC.e -> 99.95 ctUSD on a 1:1 pool -> 0.05% impact
      const provider = buildProvider({
        quoteOutputs: { "100000000": "99950000" },
        sqrtPriceX96: SQRT_PRICE_1_TO_1,
      });
      service = new SatsumaPoolService(
        new Map([[ChainId.CITREA_MAINNET, provider]]),
        mockLogger,
      );

      const result = await service.quoteExactInput(
        ChainId.CITREA_MAINNET,
        USDC_E,
        CTUSD,
        "100000000",
      );

      expect(result).not.toBeNull();
      expect(result!.priceImpact).toBe("0.05");
    });

    it("handles the reverse direction (ctUSD -> USDC.e) symmetrically", async () => {
      // Same 1:1 pool, opposite direction. token0 in this pool is the lex-
      // smaller address (ctUSD = 0x8D82..., USDC.e = 0xE045...), so the
      // reverse swap exercises the token1->token0 branch of the math.
      const provider = buildProvider({
        quoteOutputs: { "100000000": "99950000" },
        sqrtPriceX96: SQRT_PRICE_1_TO_1,
      });
      service = new SatsumaPoolService(
        new Map([[ChainId.CITREA_MAINNET, provider]]),
        mockLogger,
      );

      const result = await service.quoteExactInput(
        ChainId.CITREA_MAINNET,
        CTUSD,
        USDC_E,
        "100000000",
      );

      expect(result).not.toBeNull();
      expect(result!.priceImpact).toBe("0.05");
    });

    it("reports negative price impact for positive slippage", async () => {
      // Pool returns more than the mid-price would imply (rare, e.g. JIT
      // liquidity rebate). Frontend formats negative impacts as "+0.05%".
      const provider = buildProvider({
        quoteOutputs: { "100000000": "100050000" },
        sqrtPriceX96: SQRT_PRICE_1_TO_1,
      });
      service = new SatsumaPoolService(
        new Map([[ChainId.CITREA_MAINNET, provider]]),
        mockLogger,
      );

      const result = await service.quoteExactInput(
        ChainId.CITREA_MAINNET,
        USDC_E,
        CTUSD,
        "100000000",
      );

      expect(result!.priceImpact).toBe("-0.05");
    });

    it("never falls back to the legacy hardcoded 0.05 / 0.30 strings", async () => {
      // The bug we're fixing: legacy code returned "0.05" regardless of the
      // actual trade. Use a trade where the real impact is decisively *not*
      // 0.05% (or 0.30%) so this test would have failed under the old code.
      const provider = buildProvider({
        quoteOutputs: { "3003416087": "1756651830" },
        sqrtPriceX96: SQRT_PRICE_1_TO_1,
      });
      service = new SatsumaPoolService(
        new Map([[ChainId.CITREA_MAINNET, provider]]),
        mockLogger,
      );

      const result = await service.quoteExactInput(
        ChainId.CITREA_MAINNET,
        USDC_E,
        CTUSD,
        "3003416087",
      );

      expect(result!.priceImpact).not.toBe("0.05");
      expect(result!.priceImpact).not.toBe("0.30");
    });
  });
});

describe("SatsumaPoolService.buildExactInputSingleCalldata()", () => {
  let service: SatsumaPoolService;

  beforeEach(() => {
    service = new SatsumaPoolService(
      new Map<ChainId, ethers.providers.StaticJsonRpcProvider>(),
      mockLogger,
    );
  });

  it("encodes a valid Algebra exactInputSingle call", () => {
    const calldata = service.buildExactInputSingleCalldata({
      tokenIn: USDC_E,
      tokenOut: CTUSD,
      recipient: "0xa9798102cea07a07e5afdd55129c584d54c3d9ea",
      deadline: 1715000000,
      amountIn: "3000000000",
      amountOutMinimum: "2999000000",
    });

    // Algebra exactInputSingle((address,address,address,address,uint256,uint256,uint256,uint160))
    // selector is the first 4 bytes
    expect(calldata.startsWith("0x")).toBe(true);
    expect(calldata.length).toBeGreaterThan(2 + 8); // selector + tuple data

    // Decode and verify the round-trip
    const iface = new ethers.utils.Interface([
      "function exactInputSingle((address tokenIn, address tokenOut, address deployer, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 limitSqrtPrice)) payable returns (uint256 amountOut)",
    ]);
    const decoded = iface.decodeFunctionData("exactInputSingle", calldata);
    const params = decoded[0];
    expect(params.tokenIn.toLowerCase()).toBe(USDC_E.toLowerCase());
    expect(params.tokenOut.toLowerCase()).toBe(CTUSD.toLowerCase());
    expect(params.deployer).toBe(ethers.constants.AddressZero);
    expect(params.recipient.toLowerCase()).toBe(
      "0xa9798102cea07a07e5afdd55129c584d54c3d9ea",
    );
    expect(params.deadline.toString()).toBe("1715000000");
    expect(params.amountIn.toString()).toBe("3000000000");
    expect(params.amountOutMinimum.toString()).toBe("2999000000");
    expect(params.limitSqrtPrice.toString()).toBe("0");
  });
});

describe("SatsumaPoolService addresses", () => {
  let service: SatsumaPoolService;

  beforeEach(() => {
    service = new SatsumaPoolService(
      new Map<ChainId, ethers.providers.StaticJsonRpcProvider>(),
      mockLogger,
    );
  });

  it("exposes the Satsuma USDC.e/ctUSD pool address", () => {
    expect(service.poolAddress().toLowerCase()).toBe(
      "0x172d2ab563afdaace7247a6592ee1be62e791165",
    );
  });

  it("exposes the Satsuma SwapRouter address", () => {
    expect(service.routerAddress().toLowerCase()).toBe(
      "0x3012e9049d05b4b5369d690114d5a5861ebb85cb",
    );
  });
});
