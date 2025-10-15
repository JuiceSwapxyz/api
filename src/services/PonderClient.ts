import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import Logger from 'bunyan';

/**
 * PonderClient - Centralized Ponder API client with automatic fallback
 *
 * Inspired by deuro's Apollo Client fallback pattern, adapted for REST/axios
 *
 * Features:
 * - Automatic fallback on 503 (Ponder syncing) for 10 minutes
 * - Built-in retry logic (2 attempts, 1s delay)
 * - Consistent timeout (10 seconds)
 * - Centralized error handling and logging
 */

// Fallback URL management (similar to deuro's pattern)
let fallbackUntil: number | null = null;

function getIndexerUrl(): string {
  const primary = process.env.PONDER_URL || 'https://ponder.juiceswap.com';
  const fallback = process.env.PONDER_FALLBACK_URL || 'https://dev.ponder.juiceswap.com';

  return fallbackUntil && Date.now() < fallbackUntil ? fallback : primary;
}

function activateFallback(logger: Logger): void {
  if (!fallbackUntil) {
    const fallback = process.env.PONDER_FALLBACK_URL || 'https://dev.ponder.juiceswap.com';
    fallbackUntil = Date.now() + 10 * 60 * 1000; // 10 minutes
    logger.warn(`[Ponder] Switching to fallback for 10 minutes: ${fallback}`);
  }
}

function is503Error(error: any): boolean {
  // Robust 503 detection - check multiple possible error structures
  return (
    error?.response?.status === 503 ||
    error?.statusCode === 503 ||
    error?.status === 503
  );
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class PonderClient {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ service: 'PonderClient' });
  }

  /**
   * Generic request method with retry and fallback logic
   */
  private async request<T = any>(
    method: 'GET' | 'POST',
    path: string,
    data?: any,
    maxRetries: number = 2,
    retryDelay: number = 1000
  ): Promise<AxiosResponse<T>> {
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let url: string | undefined;

      try {
        url = getIndexerUrl();
        const fullUrl = `${url}${path}`;

        this.logger.debug({
          method,
          url: fullUrl,
          attempt,
          maxRetries,
          usingFallback: !!fallbackUntil,
        }, 'Ponder API request');

        const config: AxiosRequestConfig = {
          method,
          url: fullUrl,
          timeout: 10000, // 10 second timeout
          headers: { 'Content-Type': 'application/json' },
        };

        if (method === 'POST' && data) {
          config.data = data;
        }

        const response = await axios(config);

        this.logger.debug({
          method,
          url: fullUrl,
          status: response.status,
          attempt,
        }, 'Ponder API request successful');

        return response;

      } catch (error: any) {
        lastError = error;

        // Defensive: if url wasn't set (should never happen), give up immediately
        if (!url) {
          this.logger.error('[Ponder] Failed to determine URL before error occurred');
          throw error;
        }

        const isAxiosError = error.isAxiosError;
        const status = error?.response?.status;
        const wasUsingFallback = url === (process.env.PONDER_FALLBACK_URL || 'https://dev.ponder.juiceswap.com');

        this.logger.warn({
          method,
          path,
          attempt,
          maxRetries,
          error: error.message,
          status,
          isAxiosError,
          wasUsingFallback,
        }, 'Ponder API request failed');

        // If fallback failed, give up immediately (like deuro's guard at line 36)
        // No retries on fallback errors - just return the error to the caller
        if (wasUsingFallback) {
          this.logger.error('[Ponder] Fallback server failed, giving up');
          throw error;
        }

        // We're on primary - only handle network errors (like deuro's guard)
        // Network errors include: 503 and connection/timeout errors
        let shouldRetry = false;

        // Check for 503 Service Unavailable (Ponder syncing)
        if (is503Error(error)) {
          this.logger.warn('[Ponder] 503 from primary, switching to fallback');
          activateFallback(this.logger);
          shouldRetry = true;
        }
        // For network errors (timeout, connection refused, etc.)
        else if (isAxiosError && !status) {
          this.logger.warn('[Ponder] Network error from primary, switching to fallback');
          activateFallback(this.logger);
          shouldRetry = true;
        }
        // Other errors (400, 404, 500, etc.) - don't retry, just throw
        else {
          this.logger.error('[Ponder] Non-network error from primary, not retrying', {
            status,
            error: error.message,
          });
          throw error;
        }

        // Retry with fallback URL if we activated fallback
        if (shouldRetry && attempt < maxRetries) {
          this.logger.info(`[Ponder] Retrying after ${retryDelay}ms`);
          await delay(retryDelay);
          continue;
        }

        // Max retries exceeded
        throw error;
      }
    }

    // Should never reach here, but TypeScript needs it
    throw lastError;
  }

  /**
   * GET request to Ponder API
   */
  async get<T = any>(path: string): Promise<AxiosResponse<T>> {
    return this.request<T>('GET', path);
  }

  /**
   * POST request to Ponder API
   */
  async post<T = any>(path: string, data: any): Promise<AxiosResponse<T>> {
    return this.request<T>('POST', path, data);
  }

  /**
   * Check current fallback status (useful for debugging)
   */
  getFallbackStatus(): { usingFallback: boolean; fallbackUntil: number | null } {
    return {
      usingFallback: !!fallbackUntil && Date.now() < fallbackUntil,
      fallbackUntil,
    };
  }

  /**
   * Manually clear fallback (useful for testing)
   */
  clearFallback(): void {
    fallbackUntil = null;
    this.logger.info('[Ponder] Fallback cleared, using primary URL');
  }
}

/**
 * Singleton instance (optional - can also create new instances per use case)
 */
let sharedInstance: PonderClient | null = null;

export function getPonderClient(logger: Logger): PonderClient {
  if (!sharedInstance) {
    sharedInstance = new PonderClient(logger);
  }
  return sharedInstance;
}
