import { ChainId } from "@juiceswapxyz/sdk-core";
import Logger from "bunyan";
import { getChainContracts } from "../../config/contracts";
import { createQuoteHandler } from "../quote";
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

// Production wiring (src/server.ts) passes `undefined` for juiceGatewayService
// into createQuoteHandler/createSwapHandler so quote/swap always resolve via
// Classic Uniswap routing. These tests pin that exact shape, since the rest of
// the suite only ever exercises these handlers with a live JuiceGatewayService.
describe("Quote/swap with JuiceDollar Gateway routing disabled", () => {
  const chainId = ChainId.CITREA_MAINNET;
  const contracts = getChainContracts(chainId)!;
  let logger: Logger;

  it("quote: JUSD -> JUICE falls through to the Classic router instead of Gateway's direct conversion", async () => {
    logger = createMockLogger();
    // With Gateway live, JUSD -> JUICE resolves as an isDirectConversion route
    // (Equity.invest()) and never calls routerService.getQuote at all — so
    // getQuote being called here is unambiguous proof Gateway did not run.
    const body = {
      tokenIn: contracts.JUSD,
      tokenOut: contracts.JUICE,
      tokenInChainId: chainId,
      tokenOutChainId: chainId,
      tokenInDecimals: 18,
      tokenOutDecimals: 18,
      amount: "1000000000000000000",
      type: "EXACT_INPUT",
      swapper: "0x000000000000000000000000000000000000dead",
    };
    const routerService = {
      isChainSupported: jest.fn().mockReturnValue(true),
      getQuote: jest.fn().mockRejectedValue(new Error("CLASSIC_PATH_REACHED")),
    };
    const handler = createQuoteHandler(routerService as any, logger, undefined);
    const res = createMockResponse();

    await handler({ body, headers: {} } as any, res as any);

    expect(routerService.getQuote).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalledWith(
      expect.objectContaining({ error: "NO_ROUTE" }),
    );
  });

  it("swap: JUSD -> JUICE falls through to the Classic router instead of Gateway's direct conversion", async () => {
    logger = createMockLogger();
    const body = {
      tokenIn: contracts.JUSD,
      tokenOut: contracts.JUICE,
      tokenInChainId: chainId,
      tokenOutChainId: chainId,
      amount: "1000000000000000000",
      type: "exactIn",
      recipient: "0x000000000000000000000000000000000000dead",
      from: "0x000000000000000000000000000000000000dead",
      slippageTolerance: "0.5",
    };
    const routerService = {
      isChainSupported: jest.fn().mockReturnValue(true),
      getTokenInfo: jest
        .fn()
        .mockRejectedValue(new Error("CLASSIC_PATH_REACHED")),
    };
    const handler = createSwapHandler(routerService as any, logger, undefined);
    const res = createMockResponse();

    await handler({ body, headers: {} } as any, res as any);

    // getTokenInfo is only ever called from the Classic swap path (Gateway
    // swaps resolve token info via the Gateway service instead), so this
    // proves the request never entered Gateway routing.
    expect(routerService.getTokenInfo).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalledWith(
      expect.objectContaining({ error: "NO_ROUTE" }),
    );
  });
});
