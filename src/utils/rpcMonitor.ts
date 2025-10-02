import { providers } from 'ethers';
import { ChainId } from '@juiceswapxyz/sdk-core';
import Logger from 'bunyan';

interface RPCStats {
  total: number;
  byMethod: Map<string, number>;
  byChain: Map<ChainId, number>;
}

export class RPCMonitor {
  private enabled: boolean;
  private stats: RPCStats;
  private requestStats: Map<string, number>; // Track per-request
  private logger: Logger;
  private summaryInterval: NodeJS.Timeout | null = null;

  constructor(logger: Logger) {
    this.enabled = process.env.ENABLE_RPC_LOGGING !== 'false';
    this.logger = logger;
    this.stats = {
      total: 0,
      byMethod: new Map(),
      byChain: new Map(),
    };
    this.requestStats = new Map();

    if (this.enabled) {
      this.logger.info('[RPC Monitor] Enabled - tracking all RPC calls');
      this.startSummaryReporting();
    }
  }

  /**
   * Attach monitoring to an ethers provider
   */
  attachToProvider(provider: providers.StaticJsonRpcProvider, chainId: ChainId): void {
    if (!this.enabled) return;

    // Monkey-patch the send method to intercept RPC calls
    const originalSend = provider.send.bind(provider);
    provider.send = async (method: string, params: any[]): Promise<any> => {
      this.recordCall(method, chainId);
      return originalSend(method, params);
    };

    this.logger.info(`[RPC Monitor] Attached to chain ${chainId}`);
  }

  /**
   * Record an RPC call
   */
  private recordCall(method: string, chainId: ChainId): void {
    this.stats.total++;

    // Track by method
    const methodCount = this.stats.byMethod.get(method) || 0;
    this.stats.byMethod.set(method, methodCount + 1);

    // Track by chain
    const chainCount = this.stats.byChain.get(chainId) || 0;
    this.stats.byChain.set(chainId, chainCount + 1);
  }

  /**
   * Start tracking RPC calls for a specific request
   */
  startRequest(requestId: string): void {
    if (!this.enabled) return;
    this.requestStats.set(requestId, this.stats.total);
  }

  /**
   * End tracking and return call count for request
   */
  endRequest(requestId: string): number {
    if (!this.enabled) return 0;

    const startCount = this.requestStats.get(requestId) || this.stats.total;
    const callCount = this.stats.total - startCount;
    this.requestStats.delete(requestId);

    return callCount;
  }

  /**
   * Log request-level RPC stats
   */
  logRequest(requestId: string, endpoint: string, callCount: number): void {
    if (!this.enabled || callCount === 0) return;

    this.logger.debug(
      `[RPC Monitor] ${endpoint} (${requestId}) - ${callCount} RPC calls`
    );
  }

  /**
   * Get current stats snapshot
   */
  getStats(): {
    total: number;
    byMethod: Record<string, number>;
    byChain: Record<number, number>;
  } {
    return {
      total: this.stats.total,
      byMethod: Object.fromEntries(this.stats.byMethod),
      byChain: Object.fromEntries(this.stats.byChain),
    };
  }

  /**
   * Start periodic summary reporting
   */
  private startSummaryReporting(): void {
    this.summaryInterval = setInterval(() => {
      this.logSummary();
    }, 30000); // Every 30 seconds
  }

  /**
   * Log summary of RPC calls
   */
  private logSummary(): void {
    if (this.stats.total === 0) return;

    const methodBreakdown = Array.from(this.stats.byMethod.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([method, count]) => `${method}:${count}`)
      .join(', ');

    this.logger.info(
      `[RPC Monitor] 30s summary - Total: ${this.stats.total} calls | Top methods: ${methodBreakdown}`
    );

    // Reset counters for next interval
    this.stats.total = 0;
    this.stats.byMethod.clear();
    this.stats.byChain.clear();
  }

  /**
   * Cleanup
   */
  stop(): void {
    if (this.summaryInterval) {
      clearInterval(this.summaryInterval);
      this.summaryInterval = null;
    }
  }
}

// Singleton instance
let monitor: RPCMonitor | null = null;

export function initializeRPCMonitor(logger: Logger): RPCMonitor {
  if (!monitor) {
    monitor = new RPCMonitor(logger);
  }
  return monitor;
}

export function getRPCMonitor(): RPCMonitor | null {
  return monitor;
}
