/**
 * Citrea Campaign Optimizer
 *
 * Specific optimizations for the Citrea bApps Campaign to handle
 * high traffic from campaign participants.
 */

import { quoteCache } from './quoteCache';

interface CampaignPool {
  address: string;
  tokenIn: string;
  tokenOut: string;
  description: string;
}

interface CampaignStats {
  totalRequests: number;
  uniqueUsers: Set<string>;
  requestsByTask: Map<number, number>;
  startTime: number;
  peakRequestsPerMinute: number;
}

export class CitreaCampaignOptimizer {
  private readonly CITREA_CHAIN_ID = 5115;

  // Known campaign pools
  private readonly campaignPools: CampaignPool[] = [
    {
      address: '0x6006797369E2A595D31Df4ab3691044038AAa7FE',
      tokenIn: '0x0000000000000000000000000000000000000000', // cBTC (native)
      tokenOut: '0x9B28B690550522608890C3C7e63c0b4A7eBab9AA', // NUSD
      description: 'Task 1: cBTC → NUSD'
    },
    {
      address: '0xA69De906B9A830Deb64edB97B2eb0848139306d2',
      tokenIn: '0x0000000000000000000000000000000000000000', // cBTC (native)
      tokenOut: '0x2fFC18aC99D367b70dd922771dF8c2074af4aCE0', // cUSD
      description: 'Task 2: cBTC → cUSD'
    },
    {
      address: '0x428EdD2607A6983732d9B7dB2325F6287af57704',
      tokenIn: '0x0000000000000000000000000000000000000000', // cBTC (native)
      tokenOut: '0x36c16eaC6B0Ba6c50f494914ff015fCa95B7835F', // USDC
      description: 'Task 3: cBTC → USDC'
    }
  ];

  private stats: CampaignStats = {
    totalRequests: 0,
    uniqueUsers: new Set(),
    requestsByTask: new Map([
      [1, 0],
      [2, 0],
      [3, 0]
    ]),
    startTime: Date.now(),
    peakRequestsPerMinute: 0
  };

  private requestsInCurrentMinute = 0;
  private minuteTimer: NodeJS.Timeout;

  constructor() {
    console.log('[CitreaOptimizer] Initialized for Citrea testnet campaign');
    this.prewarmCache();

    // Track requests per minute
    this.minuteTimer = setInterval(() => {
      if (this.requestsInCurrentMinute > this.stats.peakRequestsPerMinute) {
        this.stats.peakRequestsPerMinute = this.requestsInCurrentMinute;
      }
      this.requestsInCurrentMinute = 0;
    }, 60000);
  }

  /**
   * Pre-warm cache with common campaign routes
   */
  private async prewarmCache() {
    console.log('[CitreaOptimizer] Pre-warming cache with campaign routes...');

    // Common amounts used in the campaign
    const commonAmounts = [
      '10000000000',     // 0.00001 cBTC (Task 1 & 2)
      '10',              // 10 satoshi (Task 3)
      '1000000000',      // 0.000001 cBTC
      '100000000000'     // 0.0001 cBTC
    ];

    for (const pool of this.campaignPools) {
      for (const amount of commonAmounts) {
        const mockParams = {
          tokenInChainId: this.CITREA_CHAIN_ID,
          tokenOutChainId: this.CITREA_CHAIN_ID,
          tokenIn: pool.tokenIn,
          tokenOut: pool.tokenOut,
          amount: amount,
          type: 'EXACT_INPUT'
        };

        // Note: In production, you would actually fetch these quotes
        // to pre-populate the cache
        console.log(`[CitreaOptimizer] Would pre-warm: ${pool.description} with amount ${amount}`);
      }
    }
  }

  /**
   * Check if this is a campaign-related request
   */
  isCampaignRequest(params: any): boolean {
    if (params.tokenInChainId !== this.CITREA_CHAIN_ID ||
        params.tokenOutChainId !== this.CITREA_CHAIN_ID) {
      return false;
    }

    const tokenIn = (params.tokenIn || params.tokenInAddress || '').toLowerCase();
    const tokenOut = (params.tokenOut || params.tokenOutAddress || '').toLowerCase();

    return this.campaignPools.some(pool =>
      pool.tokenIn.toLowerCase() === tokenIn &&
      pool.tokenOut.toLowerCase() === tokenOut
    );
  }

  /**
   * Get task number from request params
   */
  private getTaskNumber(params: any): number {
    const tokenOut = (params.tokenOut || params.tokenOutAddress || '').toLowerCase();

    if (tokenOut === '0x9b28b690550522608890c3c7e63c0b4a7ebab9aa') return 1; // NUSD
    if (tokenOut === '0x2ffc18ac99d367b70dd922771df8c2074af4ace0') return 2; // cUSD
    if (tokenOut === '0x36c16eac6b0ba6c50f494914ff015fca95b7835f') return 3; // USDC

    return 0;
  }

  /**
   * Track campaign request
   */
  trackRequest(params: any, userIdentifier?: string) {
    if (!this.isCampaignRequest(params)) {
      return;
    }

    this.stats.totalRequests++;
    this.requestsInCurrentMinute++;

    if (userIdentifier) {
      this.stats.uniqueUsers.add(userIdentifier);
    }

    const taskNumber = this.getTaskNumber(params);
    if (taskNumber > 0) {
      const current = this.stats.requestsByTask.get(taskNumber) || 0;
      this.stats.requestsByTask.set(taskNumber, current + 1);
    }

    // Log milestone requests
    if (this.stats.totalRequests % 100 === 0) {
      console.log(`[CitreaOptimizer] Milestone: ${this.stats.totalRequests} campaign requests processed`);
    }
  }

  /**
   * Optimize quote parameters for campaign
   */
  optimizeQuoteParams(params: any): any {
    if (!this.isCampaignRequest(params)) {
      return params;
    }

    // For campaign requests, we can make certain optimizations
    const optimized = { ...params };

    // Remove user-specific fields from cache key generation
    delete optimized.recipient;
    delete optimized.swapper;

    // Use consistent slippage for campaign
    if (!optimized.slippageTolerance) {
      optimized.slippageTolerance = 0.5;
    }

    // Ensure amount is string (for consistent caching)
    if (typeof optimized.amount === 'number') {
      optimized.amount = optimized.amount.toString();
    }

    return optimized;
  }

  /**
   * Check if we should use extended cache TTL
   */
  shouldUseExtendedCache(params: any): boolean {
    // Campaign requests get extended cache
    if (this.isCampaignRequest(params)) {
      return true;
    }

    // Also extend cache for any Citrea testnet request during campaign period
    return params.tokenInChainId === this.CITREA_CHAIN_ID ||
           params.tokenOutChainId === this.CITREA_CHAIN_ID;
  }

  /**
   * Get campaign statistics
   */
  getStats() {
    const runtime = Date.now() - this.stats.startTime;
    const runtimeMinutes = Math.floor(runtime / 60000);

    return {
      totalRequests: this.stats.totalRequests,
      uniqueUsers: this.stats.uniqueUsers.size,
      requestsByTask: {
        task1: this.stats.requestsByTask.get(1) || 0,
        task2: this.stats.requestsByTask.get(2) || 0,
        task3: this.stats.requestsByTask.get(3) || 0
      },
      runtimeMinutes,
      averageRequestsPerMinute: runtimeMinutes > 0
        ? Math.round(this.stats.totalRequests / runtimeMinutes)
        : 0,
      peakRequestsPerMinute: this.stats.peakRequestsPerMinute,
      currentRequestsPerMinute: this.requestsInCurrentMinute
    };
  }

  /**
   * Get recommended settings for current load
   */
  getRecommendedSettings() {
    const load = this.requestsInCurrentMinute;

    if (load > 100) {
      return {
        cacheTTL: 120000, // 2 minutes
        maxConnectionsPerProvider: 15,
        rateLimitPerIP: 300,
        message: 'High load detected - using aggressive caching'
      };
    } else if (load > 50) {
      return {
        cacheTTL: 90000, // 90 seconds
        maxConnectionsPerProvider: 10,
        rateLimitPerIP: 200,
        message: 'Moderate load - balanced settings'
      };
    } else {
      return {
        cacheTTL: 60000, // 60 seconds
        maxConnectionsPerProvider: 5,
        rateLimitPerIP: 100,
        message: 'Normal load - standard settings'
      };
    }
  }

  /**
   * Cleanup
   */
  shutdown() {
    if (this.minuteTimer) {
      clearInterval(this.minuteTimer);
    }
    console.log('[CitreaOptimizer] Shut down');
  }
}

// Singleton instance
export const citreaOptimizer = new CitreaCampaignOptimizer();