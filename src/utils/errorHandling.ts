import { STATUS_CODES } from "http";

export interface ClassifiedError {
  status: number;
  isClientError: boolean;
  label: string;
}

// Matches this codebase's sentence-case convention ("Not found", "Bad request")
// rather than Node's Title Case ("Not Found", "Bad Request").
function toSentenceCase(text: string): string {
  const lower = text.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function classifyError(err: any): ClassifiedError {
  const raw = Number(err?.status ?? err?.statusCode);
  const status = Number.isInteger(raw) && raw >= 400 && raw < 600 ? raw : 500;
  const isClientError = status >= 400 && status < 500;

  return {
    status,
    isClientError,
    label: isClientError
      ? toSentenceCase(STATUS_CODES[status] ?? "Bad request")
      : "Internal server error",
  };
}
