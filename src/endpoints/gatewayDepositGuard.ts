import { Response } from "express";
import Logger from "bunyan";

/**
 * Shared handling for the GATEWAY_DEPOSIT_DISABLED guard raised by
 * JuiceGatewayService while the JUSD Savings rate is zero. Used by the quote,
 * swap and LP endpoints so the error code, status and detail stay in sync.
 */
export interface GatewayDepositDisabledError {
  code?: string;
  message?: string;
  savingsRate?: string;
  savingsAddress?: string | null;
}

const FALLBACK_DETAIL =
  "JUSD savings rate is zero; svJUSD deposits revert while Savings is disabled.";

export function isGatewayDepositDisabledError(
  error: unknown,
): error is GatewayDepositDisabledError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as GatewayDepositDisabledError).code === "GATEWAY_DEPOSIT_DISABLED"
  );
}

/**
 * Log the rejection (with the probed savings rate/address for the audit trail)
 * and respond with the canonical 404 structured error.
 */
export function sendGatewayDepositDisabled(
  res: Response,
  log: Logger,
  error: GatewayDepositDisabledError,
  context: Record<string, unknown>,
): void {
  log.warn(
    {
      ...context,
      savingsRate: error.savingsRate,
      savingsAddress: error.savingsAddress,
    },
    "Gateway deposit disabled",
  );
  res.status(404).json({
    error: "GATEWAY_DEPOSIT_DISABLED",
    detail: error.message || FALLBACK_DETAIL,
  });
}
