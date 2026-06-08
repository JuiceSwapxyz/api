import Logger from "bunyan";
import {
  isGatewayDepositDisabledError,
  sendGatewayDepositDisabled,
} from "../gatewayDepositGuard";

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
  };
}

describe("gatewayDepositGuard", () => {
  describe("isGatewayDepositDisabledError", () => {
    it("recognises the GATEWAY_DEPOSIT_DISABLED error", () => {
      expect(
        isGatewayDepositDisabledError({ code: "GATEWAY_DEPOSIT_DISABLED" }),
      ).toBe(true);
    });

    it("rejects other errors and non-objects", () => {
      expect(isGatewayDepositDisabledError(new Error("boom"))).toBe(false);
      expect(isGatewayDepositDisabledError({ code: "SOMETHING_ELSE" })).toBe(
        false,
      );
      expect(isGatewayDepositDisabledError(null)).toBe(false);
      expect(isGatewayDepositDisabledError("nope")).toBe(false);
    });
  });

  describe("sendGatewayDepositDisabled", () => {
    it("uses the error message as the detail when present", () => {
      const res = createMockResponse();
      const log = createMockLogger();

      sendGatewayDepositDisabled(
        res as never,
        log,
        {
          code: "GATEWAY_DEPOSIT_DISABLED",
          message: "custom detail",
          savingsRate: "0",
          savingsAddress: "0xabc",
        },
        { chainId: 4114 },
      );

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: "GATEWAY_DEPOSIT_DISABLED",
        detail: "custom detail",
      });
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          chainId: 4114,
          savingsRate: "0",
          savingsAddress: "0xabc",
        }),
        "Gateway deposit disabled",
      );
    });

    it("falls back to the canonical detail when no message is set", () => {
      const res = createMockResponse();
      const log = createMockLogger();

      sendGatewayDepositDisabled(
        res as never,
        log,
        { code: "GATEWAY_DEPOSIT_DISABLED" },
        {},
      );

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: "GATEWAY_DEPOSIT_DISABLED",
        detail:
          "JUSD savings rate is zero; svJUSD deposits revert while Savings is disabled.",
      });
    });
  });
});
