import { ChainId } from "@juiceswapxyz/sdk-core";
import Logger from "bunyan";
import { quoteCache } from "../../cache/quoteCache";
import { JuiceGatewayService } from "../../services/JuiceGatewayService";
import { getChainContracts } from "../../config/contracts";
import {
  initializeResolvers,
  resolvers,
} from "../../adapters/handleGraphQL/resolvers";
import { createLpCreateHandler } from "../lpCreate";
import { createLpIncreaseHandler } from "../lpIncrease";
import { createQuoteHandler, Routing } from "../quote";
import { createSwapHandler } from "../swap";

jest.mock("../../services/LaunchpadTokenService", () => ({
  isGraduatedLaunchpadToken: jest.fn().mockResolvedValue(false),
}));
jest.mock("../../services/userTracking", () => ({
  trackUser: jest.fn(),
}));

function createMockLogger(): Logger {
  const logger = {
    child: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger as unknown as Logger;
}

function createMockResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
  };
}

describe("Gateway deposit disabled endpoint gating", () => {
  const chainId = ChainId.CITREA_MAINNET;
  const contracts = getChainContracts(chainId)!;
  const savingsAddress = "0x0000000000000000000000000000000000000001";
  let logger: Logger;
  let juiceGatewayService: JuiceGatewayService;

  beforeEach(() => {
    quoteCache.clear();
    logger = createMockLogger();
    juiceGatewayService = new JuiceGatewayService(new Map(), logger);
    juiceGatewayService.setSavingsRateOverride(chainId, 0, savingsAddress);
  });

  afterEach(() => {
    quoteCache.clear();
  });

  it("returns GATEWAY_DEPOSIT_DISABLED before serving a stale cached quote", async () => {
    const body = {
      tokenIn: contracts.JUSD,
      tokenOut: contracts.WCBTC,
      tokenInChainId: chainId,
      tokenOutChainId: chainId,
      tokenInDecimals: 18,
      tokenOutDecimals: 18,
      amount: "1000000000000000000",
      type: "EXACT_INPUT",
      swapper: "0x000000000000000000000000000000000000dead",
    };
    quoteCache.set(body, {
      requestId: "cached",
      routing: Routing.GATEWAY_JUSD,
      permitData: null,
      quote: { quote: "1" },
    });
    const routerService = {
      isChainSupported: jest.fn().mockReturnValue(true),
      getQuote: jest.fn(),
    };
    const handler = createQuoteHandler(
      routerService as any,
      logger,
      juiceGatewayService,
    );
    const res = createMockResponse();

    await handler({ body, headers: {} } as any, res as any);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "GATEWAY_DEPOSIT_DISABLED" }),
    );
    expect(routerService.getQuote).not.toHaveBeenCalled();
  });

  it("rejects JUICE input swaps before building the old multi-step calldata", async () => {
    const body = {
      tokenIn: contracts.JUICE,
      tokenOut: contracts.WCBTC,
      tokenInChainId: chainId,
      tokenOutChainId: chainId,
      tokenInDecimals: 18,
      tokenOutDecimals: 18,
      amount: "1000000000000000000",
      type: "exactIn",
      recipient: "0x000000000000000000000000000000000000dead",
      from: "0x000000000000000000000000000000000000dead",
      slippageTolerance: "0.5",
    };
    const routerService = {
      getProvider: jest.fn(),
    };
    const handler = createSwapHandler(
      routerService as any,
      logger,
      juiceGatewayService,
    );
    const res = createMockResponse();

    await handler({ body, headers: {} } as any, res as any);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "GATEWAY_DEPOSIT_DISABLED" }),
    );
    expect(routerService.getProvider).not.toHaveBeenCalled();
  });

  it("applies the same stale-cache gate to the GraphQL quote resolver", async () => {
    const input = {
      tokenInAddress: contracts.JUSD,
      tokenOutAddress: contracts.WCBTC,
      tokenInChainId: chainId,
      tokenOutChainId: chainId,
      amount: "1000000000000000000",
      type: "EXACT_INPUT",
      swapper: "0x000000000000000000000000000000000000dead",
    };
    quoteCache.set(
      {
        ...input,
        tokenIn: undefined,
        tokenOut: undefined,
      },
      {
        requestId: "cached",
        routing: Routing.GATEWAY_JUSD,
        permitData: null,
        quote: { quote: "1" },
      },
    );
    const routerService = {
      isChainSupported: jest.fn().mockReturnValue(true),
      getQuote: jest.fn(),
    };
    initializeResolvers(
      routerService as any,
      logger,
      undefined,
      juiceGatewayService,
    );

    await expect(resolvers.Query.quote(null, { input })).rejects.toThrow(
      "JUSD savings rate is zero",
    );
    expect(routerService.getQuote).not.toHaveBeenCalled();
  });

  it("rejects LP create with JUSD before provider or pool work", async () => {
    const body = {
      protocol: "V3",
      walletAddress: "0x000000000000000000000000000000000000dead",
      chainId,
      independentAmount: "1000000000000000000",
      independentToken: "TOKEN_0",
      position: {
        tickLower: -600,
        tickUpper: 600,
        pool: {
          token0: contracts.JUSD,
          token1: contracts.WCBTC,
          fee: 3000,
        },
      },
    };
    const routerService = {
      getProvider: jest.fn(),
    };
    const handler = createLpCreateHandler(
      routerService as any,
      logger,
      juiceGatewayService,
    );
    const res = createMockResponse();

    await handler({ body, headers: {} } as any, res as any);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "GATEWAY_DEPOSIT_DISABLED" }),
    );
    expect(routerService.getProvider).not.toHaveBeenCalled();
  });

  it("rejects LP increase with bridged stable input before provider or Ponder work", async () => {
    const body = {
      protocol: "V3",
      walletAddress: "0x000000000000000000000000000000000000dead",
      chainId,
      tokenId: "123",
      independentAmount: "1000000",
      independentToken: "TOKEN_0",
      position: {
        tickLower: -600,
        tickUpper: 600,
        pool: {
          token0: contracts.USDC,
          token1: contracts.WCBTC,
          fee: 3000,
        },
      },
    };
    const routerService = {
      getProvider: jest.fn(),
    };
    const handler = createLpIncreaseHandler(
      routerService as any,
      logger,
      juiceGatewayService,
    );
    const res = createMockResponse();

    await handler({ body, headers: {} } as any, res as any);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "GATEWAY_DEPOSIT_DISABLED" }),
    );
    expect(routerService.getProvider).not.toHaveBeenCalled();
  });
});
