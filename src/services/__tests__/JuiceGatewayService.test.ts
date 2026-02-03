import { ChainId } from "@juiceswapxyz/sdk-core";
import Logger from "bunyan";
import { ethers } from "ethers";
import { JuiceGatewayService } from "../JuiceGatewayService";
import { getChainContracts } from "../../config/contracts";

const mockLogger = {
  child: () => mockLogger,
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

describe("JuiceGatewayService.prepareQuote()", () => {
  const chainId = ChainId.CITREA_MAINNET;
  const contracts = getChainContracts(chainId)!;
  let service: JuiceGatewayService;

  // Token addresses for convenience
  const JUICE = contracts.JUICE;
  const JUSD = contracts.JUSD;
  const SV_JUSD = contracts.SV_JUSD;
  const USDC = contracts.USDC;
  const WCBTC = contracts.WCBTC;

  beforeEach(() => {
    // Create service with empty providers (no RPC calls will be made)
    service = new JuiceGatewayService(
      new Map<ChainId, ethers.providers.StaticJsonRpcProvider>(),
      mockLogger,
    );
  });

  describe("Regression: JUICE -> JUSD bug fix", () => {
    it("should keep internalTokenIn !== internalTokenOut for JUICE -> JUSD", async () => {
      // This test guards against the "Invariant failed: ADDRESSES" bug
      // where both internalTokenIn and internalTokenOut became svJUSD
      const amountIn = "1000000000000000000"; // 1 JUICE

      jest
        .spyOn(service as any, "calculateRedeemProceeds")
        .mockResolvedValue("1050000000000000000"); // 1.05 JUSD

      const result = await service.prepareQuote(chainId, JUICE, JUSD, amountIn);

      expect(result).not.toBeNull();
      // Verify we DON'T set both to svJUSD (the original bug)
      expect(result!.internalTokenIn).not.toBe(SV_JUSD);
      expect(result!.internalTokenOut).not.toBe(SV_JUSD);
      // Verify correct token routing
      expect(result!.internalTokenIn).toBe(JUICE);
      expect(result!.internalTokenOut).toBe(JUSD);
    });
  });

  describe("GATEWAY_JUICE_IN routing", () => {
    it("JUICE -> JUSD should be direct conversion", async () => {
      const amountIn = "1000000000000000000";

      jest
        .spyOn(service as any, "calculateRedeemProceeds")
        .mockResolvedValue("1050000000000000000");

      const result = await service.prepareQuote(chainId, JUICE, JUSD, amountIn);

      expect(result).not.toBeNull();
      expect(result!.isDirectConversion).toBe(true);
      expect(result!.routingType).toBe("GATEWAY_JUICE_IN");
      expect(result!.expectedOutput).toBe("1050000000000000000");
    });

    it("JUICE -> cBTC should return null (no route)", async () => {
      const amountIn = "1000000000000000000";

      // No mocks needed - the routing logic should reject this before RPC calls

      const result = await service.prepareQuote(
        chainId,
        JUICE,
        WCBTC,
        amountIn,
      );

      expect(result).toBeNull();
    });
  });

  describe("GATEWAY_JUICE_OUT routing", () => {
    it("JUSD -> JUICE should be direct conversion", async () => {
      const amountIn = "1000000000000000000"; // 1 JUSD

      jest
        .spyOn(service as any, "jusdToJuice")
        .mockResolvedValue("950000000000000000"); // 0.95 JUICE

      const result = await service.prepareQuote(chainId, JUSD, JUICE, amountIn);

      expect(result).not.toBeNull();
      expect(result!.isDirectConversion).toBe(true);
      expect(result!.routingType).toBe("GATEWAY_JUICE_OUT");
      expect(result!.expectedOutput).toBe("950000000000000000");
    });

    it("svJUSD -> JUICE should be direct conversion", async () => {
      const amountIn = "1000000000000000000"; // 1 svJUSD

      jest
        .spyOn(service as any, "svJusdToJusd")
        .mockResolvedValue("1020000000000000000"); // svJUSD -> JUSD
      jest
        .spyOn(service as any, "jusdToJuice")
        .mockResolvedValue("970000000000000000"); // JUSD -> JUICE

      const result = await service.prepareQuote(
        chainId,
        SV_JUSD,
        JUICE,
        amountIn,
      );

      expect(result).not.toBeNull();
      expect(result!.isDirectConversion).toBe(true);
      expect(result!.routingType).toBe("GATEWAY_JUICE_OUT");
    });

    it("USDC -> JUICE should be direct conversion", async () => {
      const amountIn = "1000000"; // 1 USDC (6 decimals)

      jest
        .spyOn(service as any, "bridgedToSvJusd")
        .mockResolvedValue("1000000000000000000"); // USDC -> svJUSD
      jest
        .spyOn(service as any, "svJusdToJusd")
        .mockResolvedValue("1000000000000000000"); // svJUSD -> JUSD
      jest
        .spyOn(service as any, "jusdToJuice")
        .mockResolvedValue("950000000000000000"); // JUSD -> JUICE

      const result = await service.prepareQuote(chainId, USDC, JUICE, amountIn);

      expect(result).not.toBeNull();
      expect(result!.isDirectConversion).toBe(true);
      expect(result!.routingType).toBe("GATEWAY_JUICE_OUT");
    });

    it("cBTC -> JUICE should use pool routing (not direct conversion)", async () => {
      const amountIn = "100000000"; // 1 cBTC (8 decimals)

      // No mocks needed for initial prepareQuote - it just sets up routing

      const result = await service.prepareQuote(
        chainId,
        WCBTC,
        JUICE,
        amountIn,
      );

      expect(result).not.toBeNull();
      expect(result!.isDirectConversion).toBeUndefined();
      expect(result!.routingType).toBe("GATEWAY_JUICE_OUT");
      expect(result!.internalTokenOut).toBe(SV_JUSD);
    });
  });

  describe("Non-JUICE routing (GATEWAY_JUSD)", () => {
    it("cBTC -> svJUSD should route through GATEWAY_JUSD", async () => {
      const amountIn = "100000000"; // 1 cBTC

      const result = await service.prepareQuote(
        chainId,
        WCBTC,
        SV_JUSD,
        amountIn,
      );

      expect(result).not.toBeNull();
      expect(result!.routingType).toBe("GATEWAY_JUSD");
      expect(result!.internalTokenOut).toBe(SV_JUSD);
    });
  });
});
