import { STATUS_CODES } from "http";

export interface ClassifiedError {
  status: number;
  isClientError: boolean;
  label: string;
}

export function classifyError(err: any): ClassifiedError {
  const raw = Number(err?.status ?? err?.statusCode);
  const status = Number.isInteger(raw) && raw >= 400 && raw < 600 ? raw : 500;
  const isClientError = status >= 400 && status < 500;

  return {
    status,
    isClientError,
    label: isClientError
      ? (STATUS_CODES[status] ?? "Bad request")
      : "Internal server error",
  };
}
