/**
 * Simple retry utility for async operations
 * Retries a function with delays between attempts on failure
 */

export async function retryAsync<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 2,
  delayMs: number = 1000,
  operationName?: string,
): Promise<T> {
  let lastError: Error;
  const operation = operationName || "operation";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        console.log(
          `[Retry] Attempting ${operation} (attempt ${attempt}/${maxAttempts})`,
        );
      }
      return await fn();
    } catch (error: any) {
      lastError = error;

      if (attempt < maxAttempts) {
        console.warn(
          `[Retry] ${operation} failed on attempt ${attempt}/${maxAttempts}:`,
          error.message,
          `- retrying in ${delayMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } else {
        console.error(
          `[Retry] ${operation} failed after ${maxAttempts} attempts:`,
          error.message,
        );
      }
    }
  }

  // All attempts failed
  throw lastError!;
}
