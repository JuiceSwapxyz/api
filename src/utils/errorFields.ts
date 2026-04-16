/**
 * Serializes an unknown caught value into plain enumerable fields suitable for
 * structured loggers (Bunyan, Pino, etc.).
 *
 * Using `{ error: e }` directly causes two problems:
 *  1. Error properties (message, stack) are non-enumerable — Bunyan logs `{}`.
 *  2. Grafana promotes any log entry that contains an `error` key to ERROR
 *     level, regardless of the actual log level.
 *
 * Usage:
 *   logger.warn({ ...errorFields(e) }, "Something failed, using default");
 */
export function errorFields(error: unknown): {
  errMessage: string | undefined;
  errCode: string | number | undefined;
  errReason: string | undefined;
  errStatus: number | undefined;
  rpcMessage: string | undefined;
  rpcCode: number | undefined;
} {
  const e = error as {
    message?: string;
    code?: string | number;
    reason?: string;
    status?: number;
    error?: { message?: string; code?: number };
  };

  return {
    errMessage: e?.message,
    errCode: e?.code,
    errReason: e?.reason,
    errStatus: e?.status,
    rpcMessage: e?.error?.message,
    rpcCode: e?.error?.code,
  };
}
