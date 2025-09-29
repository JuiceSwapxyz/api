/**
 * Quote Request Tracker - Track all quote requests with IP and wallet info
 * Helps identify traffic sources and patterns
 */

import fs from 'fs';
import path from 'path';

interface QuoteRequestLog {
  timestamp: number;
  ip: string;
  walletAddress?: string;
  recipient?: string;
  tokenIn: string;
  tokenOut: string;
  chainIdIn: number;
  chainIdOut: number;
  amount: string;
  origin?: string;
  userAgent?: string;
  country?: string;
  responseTime?: number;
  success: boolean;
}

interface RequestStats {
  totalRequests: number;
  uniqueIPs: number;
  uniqueWallets: number;
  topIPs: Array<{ip: string, count: number, percentage: number}>;
  topWallets: Array<{wallet: string, count: number, percentage: number}>;
  topPairs: Array<{pair: string, count: number}>;
  requestsByHour: number[];
  errorRate: number;
}

export class QuoteRequestTracker {
  private static instance: QuoteRequestTracker;
  private requests: QuoteRequestLog[] = [];
  private readonly MAX_MEMORY_LOGS = 10000; // Keep last 10k in memory
  private readonly LOG_FILE = path.join(process.cwd(), 'quote-requests.json');
  private readonly STATS_INTERVAL = 5 * 60 * 1000; // 5 minutes

  // In-memory aggregations for fast access
  private ipCounts: Map<string, number> = new Map();
  private walletCounts: Map<string, number> = new Map();
  private pairCounts: Map<string, number> = new Map();

  private constructor() {
    // Load existing logs if available
    this.loadLogs();

    // Start periodic stats reporting
    setInterval(() => this.reportStats(), this.STATS_INTERVAL);

    console.log('[QuoteRequestTracker] Initialized with tracking enabled');
  }

  static getInstance(): QuoteRequestTracker {
    if (!QuoteRequestTracker.instance) {
      QuoteRequestTracker.instance = new QuoteRequestTracker();
    }
    return QuoteRequestTracker.instance;
  }

  /**
   * Track a quote request
   */
  trackRequest(req: any, success: boolean, responseTime?: number): void {
    const body = req.body || {};
    const headers = req.headers || {};

    // Extract IP (considering proxy)
    const ip = req.ip ||
               req.connection?.remoteAddress ||
               headers['x-forwarded-for']?.split(',')[0] ||
               'unknown';

    // Extract wallet addresses
    const walletAddress = body.swapper || body.recipient || body.from;
    const recipient = body.recipient;

    // Create log entry
    const log: QuoteRequestLog = {
      timestamp: Date.now(),
      ip: ip,
      walletAddress: walletAddress?.toLowerCase(),
      recipient: recipient?.toLowerCase(),
      tokenIn: body.tokenIn || body.tokenInAddress || '',
      tokenOut: body.tokenOut || body.tokenOutAddress || '',
      chainIdIn: body.tokenInChainId || 0,
      chainIdOut: body.tokenOutChainId || 0,
      amount: body.amount || '0',
      origin: headers.origin,
      userAgent: headers['user-agent'],
      country: this.getCountryFromIP(ip),
      responseTime: responseTime,
      success: success
    };

    // Add to memory
    this.requests.push(log);
    if (this.requests.length > this.MAX_MEMORY_LOGS) {
      this.requests.shift(); // Remove oldest
    }

    // Update aggregations
    this.updateAggregations(log);

    // Persist periodically (every 100 requests)
    if (this.requests.length % 100 === 0) {
      this.persistLogs();
    }
  }

  /**
   * Update in-memory aggregations
   */
  private updateAggregations(log: QuoteRequestLog): void {
    // IP counts
    this.ipCounts.set(log.ip, (this.ipCounts.get(log.ip) || 0) + 1);

    // Wallet counts
    if (log.walletAddress) {
      this.walletCounts.set(log.walletAddress, (this.walletCounts.get(log.walletAddress) || 0) + 1);
    }

    // Pair counts
    const pairKey = `${log.chainIdIn}:${log.tokenIn}->${log.chainIdOut}:${log.tokenOut}`;
    this.pairCounts.set(pairKey, (this.pairCounts.get(pairKey) || 0) + 1);
  }

  /**
   * Get statistics
   */
  getStats(): RequestStats {
    const totalRequests = this.requests.length;
    const uniqueIPs = new Set(this.requests.map(r => r.ip)).size;
    const uniqueWallets = new Set(this.requests.filter(r => r.walletAddress).map(r => r.walletAddress)).size;

    // Sort and get top IPs
    const topIPs = Array.from(this.ipCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([ip, count]) => ({
        ip,
        count,
        percentage: (count / totalRequests) * 100
      }));

    // Sort and get top wallets
    const topWallets = Array.from(this.walletCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([wallet, count]) => ({
        wallet,
        count,
        percentage: (count / totalRequests) * 100
      }));

    // Sort and get top pairs
    const topPairs = Array.from(this.pairCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([pair, count]) => ({
        pair,
        count
      }));

    // Calculate hourly distribution
    const now = Date.now();
    const requestsByHour = new Array(24).fill(0);
    this.requests.forEach(req => {
      const hoursAgo = Math.floor((now - req.timestamp) / (60 * 60 * 1000));
      if (hoursAgo >= 0 && hoursAgo < 24) {
        requestsByHour[23 - hoursAgo]++;
      }
    });

    // Calculate error rate
    const failedRequests = this.requests.filter(r => !r.success).length;
    const errorRate = totalRequests > 0 ? failedRequests / totalRequests : 0;

    return {
      totalRequests,
      uniqueIPs,
      uniqueWallets,
      topIPs,
      topWallets,
      topPairs,
      requestsByHour,
      errorRate
    };
  }

  /**
   * Report statistics to console
   */
  private reportStats(): void {
    const stats = this.getStats();

    if (stats.totalRequests === 0) return;

    console.log(`
╔════════════════════════════════════════════════════════════════╗
║                 QUOTE REQUEST TRACKER REPORT                      ║
╠════════════════════════════════════════════════════════════════╣
║ Total Requests: ${stats.totalRequests.toString().padEnd(50)}║
║ Unique IPs: ${stats.uniqueIPs.toString().padEnd(54)}║
║ Unique Wallets: ${stats.uniqueWallets.toString().padEnd(50)}║
║ Error Rate: ${(stats.errorRate * 100).toFixed(2)}%${' '.padEnd(49)}║
╠════════════════════════════════════════════════════════════════╣`);

    if (stats.topIPs.length > 0) {
      console.log('║ TOP IPs:                                                         ║');
      stats.topIPs.slice(0, 5).forEach((item, i) => {
        const line = `║ ${(i+1)}. ${item.ip.padEnd(20)} ${item.count.toString().padEnd(10)} (${item.percentage.toFixed(1)}%)${' '.padEnd(15)}║`;
        console.log(line);
      });
    }

    if (stats.topWallets.length > 0) {
      console.log('║ TOP WALLETS:                                                     ║');
      stats.topWallets.slice(0, 3).forEach((item, i) => {
        const wallet = item.wallet.length > 20 ? item.wallet.substring(0, 17) + '...' : item.wallet;
        const line = `║ ${(i+1)}. ${wallet.padEnd(20)} ${item.count.toString().padEnd(10)} (${item.percentage.toFixed(1)}%)${' '.padEnd(15)}║`;
        console.log(line);
      });
    }

    console.log('╚════════════════════════════════════════════════════════════════╝');
  }

  /**
   * Get country from IP (placeholder - would need GeoIP service)
   */
  private getCountryFromIP(ip: string): string {
    // In production, use a GeoIP service
    // For now, just detect local/private IPs
    if (ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.')) {
      return 'LOCAL';
    }
    return 'UNKNOWN';
  }

  /**
   * Persist logs to file
   */
  private persistLogs(): void {
    try {
      const data = {
        lastUpdate: Date.now(),
        requests: this.requests.slice(-1000), // Keep last 1000
        aggregations: {
          ipCounts: Array.from(this.ipCounts.entries()),
          walletCounts: Array.from(this.walletCounts.entries()),
          pairCounts: Array.from(this.pairCounts.entries())
        }
      };
      fs.writeFileSync(this.LOG_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('[QuoteRequestTracker] Failed to persist logs:', error);
    }
  }

  /**
   * Load existing logs
   */
  private loadLogs(): void {
    try {
      if (fs.existsSync(this.LOG_FILE)) {
        const data = JSON.parse(fs.readFileSync(this.LOG_FILE, 'utf-8'));
        this.requests = data.requests || [];

        // Rebuild aggregations
        data.aggregations?.ipCounts?.forEach(([ip, count]: [string, number]) => {
          this.ipCounts.set(ip, count);
        });
        data.aggregations?.walletCounts?.forEach(([wallet, count]: [string, number]) => {
          this.walletCounts.set(wallet, count);
        });
        data.aggregations?.pairCounts?.forEach(([pair, count]: [string, number]) => {
          this.pairCounts.set(pair, count);
        });

        console.log(`[QuoteRequestTracker] Loaded ${this.requests.length} existing logs`);
      }
    } catch (error) {
      console.error('[QuoteRequestTracker] Failed to load logs:', error);
    }
  }

  /**
   * Get suspicious activity
   */
  getSuspiciousActivity(): any {
    const stats = this.getStats();
    const suspicious = {
      highVolumeIPs: stats.topIPs.filter(ip => ip.percentage > 10),
      highVolumeWallets: stats.topWallets.filter(w => w.percentage > 10),
      possibleBots: [] as string[]
    };

    // Detect possible bots (>100 requests per hour from same IP)
    const hourAgo = Date.now() - 60 * 60 * 1000;
    const recentByIP = new Map<string, number>();

    this.requests
      .filter(r => r.timestamp > hourAgo)
      .forEach(r => {
        recentByIP.set(r.ip, (recentByIP.get(r.ip) || 0) + 1);
      });

    recentByIP.forEach((count, ip) => {
      if (count > 100) {
        suspicious.possibleBots.push(`${ip} (${count} requests/hour)`);
      }
    });

    return suspicious;
  }
}

// Export singleton instance
export const quoteRequestTracker = QuoteRequestTracker.getInstance();