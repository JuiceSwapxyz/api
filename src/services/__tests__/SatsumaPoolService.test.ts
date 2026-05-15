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

    // Builds a provider whose eth_call resolves the real and probe quotes
    // according to a caller-supplied (amountIn -> amountOut) map.
    function buildProvider(outputs: Record<string, string>) {
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
          const [tx] = params as [{ data: string }];
          const decoded = quoterIface.decodeFunctionData(
            "quoteExactInputSingle",
            tx.data,
          );
          const amountIn = (decoded[0].amountIn as ethers.BigNumber).toString();
          const out = outputs[amountIn];
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
        });
      return provider;
    }

    it("derives real price impact from probe + actual quotes", async () => {
      // Reproduces the issue #764 trade: 3,003.416087 USDC.e -> 1,756.651830
      // ctUSD on a pool whose mid-price (1 USDC.e -> 1 ctUSD) is essentially
      // 1:1. Expected impact ≈ (3003.416087 - 1756.651830) / 3003.416087
      // ≈ 41.51%.
      const provider = buildProvider({
        "1000000": "1000000",
        "3003416087": "1756651830",
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
      // 100 USDC.e -> 99.95 ctUSD (mid-price 1:1) -> 0.05% impact
      const provider = buildProvider({
        "1000000": "1000000",
        "100000000": "99950000",
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

    it("never falls back to the legacy hardcoded 0.05 / 0.30 strings", async () => {
      // The bug we're fixing: legacy code returned "0.05" regardless of the
      // actual trade. Use a trade where the real impact is decisively *not*
      // 0.05% (or 0.30%) so this test would have failed under the old code.
      const provider = buildProvider({
        "1000000": "1000000",
        "3003416087": "1756651830",
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
