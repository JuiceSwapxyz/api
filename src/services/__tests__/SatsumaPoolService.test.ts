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
