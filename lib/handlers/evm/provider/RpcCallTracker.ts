/**
 * RPC Call Tracker - Comprehensive tracking of all JSON-RPC calls
 * Provides rolling 1-hour window statistics and periodic reporting
 */

interface CallRecord {
  timestamp: number
  method: string
  success: boolean
  latencyMs: number
}

export interface RpcCallStats {
  method: string
  totalCalls: number
  successCount: number
  failureCount: number
  totalLatencyMs: number
  avgLatencyMs: number
  maxLatencyMs: number
  minLatencyMs: number
  callsPerMinute: number[]
  lastCallTime: number
}

export interface HourlyReport {
  timestamp: number
  totalCalls: number
  uniqueMethods: number
  topMethods: Array<{method: string, count: number, percentage: number}>
  errorRate: number
  avgLatency: number
  callsByMethod: { [method: string]: RpcCallStats }
  warnings: string[]
}

export class RpcCallTracker {
  private static instance: RpcCallTracker

  private callHistory: CallRecord[] = []
  private methodStats: Map<string, RpcCallStats> = new Map()

  // Configuration
  private readonly HISTORY_WINDOW_MS = 60 * 60 * 1000 // 1 hour
  private readonly BUCKET_SIZE_MS = 60 * 1000 // 1 minute buckets
  private readonly LOG_INTERVAL_MS = 5 * 60 * 1000 // Log every 5 minutes
  private readonly WARNING_THRESHOLD_PER_MIN = 1000 // Warn if > 1000 calls/min for any method
  private readonly ERROR_RATE_THRESHOLD = 0.05 // Warn if error rate > 5%

  private totalCallsSinceStart: number = 0

  private constructor() {
    // Start periodic logging
    setInterval(() => this.logReport(), this.LOG_INTERVAL_MS)
    console.log('[RpcCallTracker] Initialized with 1-hour rolling window, 5-minute reporting')
  }

  static getInstance(): RpcCallTracker {
    if (!RpcCallTracker.instance) {
      RpcCallTracker.instance = new RpcCallTracker()
    }
    return RpcCallTracker.instance
  }

  /**
   * Track an RPC call
   */
  trackCall(method: string, success: boolean, latencyMs: number): void {
    const now = Date.now()

    // Add to history
    this.callHistory.push({
      timestamp: now,
      method,
      success,
      latencyMs
    })

    // Update method stats
    if (!this.methodStats.has(method)) {
      this.methodStats.set(method, {
        method,
        totalCalls: 0,
        successCount: 0,
        failureCount: 0,
        totalLatencyMs: 0,
        avgLatencyMs: 0,
        maxLatencyMs: 0,
        minLatencyMs: Number.MAX_SAFE_INTEGER,
        callsPerMinute: new Array(60).fill(0),
        lastCallTime: now
      })
    }

    const stats = this.methodStats.get(method)!
    stats.totalCalls++
    stats.totalLatencyMs += latencyMs
    stats.avgLatencyMs = stats.totalLatencyMs / stats.totalCalls
    stats.maxLatencyMs = Math.max(stats.maxLatencyMs, latencyMs)
    stats.minLatencyMs = Math.min(stats.minLatencyMs, latencyMs)
    stats.lastCallTime = now

    if (success) {
      stats.successCount++
    } else {
      stats.failureCount++
    }

    this.totalCallsSinceStart++

    // Clean old history periodically (every 100 calls)
    if (this.totalCallsSinceStart % 100 === 0) {
      this.cleanOldHistory()
    }
  }

  /**
   * Clean history older than 1 hour
   */
  private cleanOldHistory(): void {
    const cutoffTime = Date.now() - this.HISTORY_WINDOW_MS
    const beforeCount = this.callHistory.length

    this.callHistory = this.callHistory.filter(call => call.timestamp > cutoffTime)

    const removed = beforeCount - this.callHistory.length
    if (removed > 0) {
      console.log(`[RpcCallTracker] Cleaned ${removed} old records`)
    }
  }

  /**
   * Get current statistics
   */
  getStats(): HourlyReport {
    this.cleanOldHistory()

    const now = Date.now()
    const hourAgo = now - this.HISTORY_WINDOW_MS

    // Calculate stats for the last hour
    const recentCalls = this.callHistory.filter(call => call.timestamp > hourAgo)
    const totalCalls = recentCalls.length
    const failedCalls = recentCalls.filter(call => !call.success).length
    const errorRate = totalCalls > 0 ? failedCalls / totalCalls : 0

    // Count by method
    const methodCounts = new Map<string, number>()
    const methodLatencies = new Map<string, number[]>()

    recentCalls.forEach(call => {
      methodCounts.set(call.method, (methodCounts.get(call.method) || 0) + 1)

      if (!methodLatencies.has(call.method)) {
        methodLatencies.set(call.method, [])
      }
      methodLatencies.get(call.method)!.push(call.latencyMs)
    })

    // Calculate per-minute distribution
    const callsByMethod = new Map<string, RpcCallStats>()
    methodCounts.forEach((count, method) => {
      const methodCalls = recentCalls.filter(c => c.method === method)
      const successCount = methodCalls.filter(c => c.success).length
      const latencies = methodLatencies.get(method) || []
      const totalLatency = latencies.reduce((sum, l) => sum + l, 0)

      // Calculate calls per minute
      const callsPerMinute = new Array(60).fill(0)
      methodCalls.forEach(call => {
        const minutesAgo = Math.floor((now - call.timestamp) / this.BUCKET_SIZE_MS)
        if (minutesAgo >= 0 && minutesAgo < 60) {
          callsPerMinute[59 - minutesAgo]++
        }
      })

      callsByMethod.set(method, {
        method,
        totalCalls: count,
        successCount,
        failureCount: count - successCount,
        totalLatencyMs: totalLatency,
        avgLatencyMs: totalLatency / count,
        maxLatencyMs: Math.max(...latencies, 0),
        minLatencyMs: Math.min(...latencies, Number.MAX_SAFE_INTEGER),
        callsPerMinute,
        lastCallTime: Math.max(...methodCalls.map(c => c.timestamp), 0)
      })
    })

    // Sort methods by count
    const topMethods = Array.from(methodCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([method, count]) => ({
        method,
        count,
        percentage: (count / totalCalls) * 100
      }))

    // Calculate average latency
    const avgLatency = totalCalls > 0
      ? recentCalls.reduce((sum, call) => sum + call.latencyMs, 0) / totalCalls
      : 0

    // Generate warnings
    const warnings: string[] = []

    // Check for high call rates
    callsByMethod.forEach((stats, method) => {
      const maxCallsPerMin = Math.max(...stats.callsPerMinute)
      if (maxCallsPerMin > this.WARNING_THRESHOLD_PER_MIN) {
        warnings.push(`High call rate for ${method}: ${maxCallsPerMin} calls/min`)
      }

      // Check error rates by method
      if (stats.totalCalls > 10) {
        const methodErrorRate = stats.failureCount / stats.totalCalls
        if (methodErrorRate > this.ERROR_RATE_THRESHOLD) {
          warnings.push(`High error rate for ${method}: ${(methodErrorRate * 100).toFixed(1)}%`)
        }
      }
    })

    // Check overall error rate
    if (errorRate > this.ERROR_RATE_THRESHOLD) {
      warnings.push(`Overall error rate high: ${(errorRate * 100).toFixed(1)}%`)
    }

    // Check for suspicious patterns
    if (topMethods.length > 0 && topMethods[0].percentage > 80) {
      warnings.push(`${topMethods[0].method} accounts for ${topMethods[0].percentage.toFixed(1)}% of all calls`)
    }

    // Convert Map to plain object for JSON serialization
    const callsByMethodObj: { [key: string]: RpcCallStats } = {}
    callsByMethod.forEach((value, key) => {
      callsByMethodObj[key] = value
    })

    return {
      timestamp: now,
      totalCalls,
      uniqueMethods: methodCounts.size,
      topMethods,
      errorRate,
      avgLatency,
      callsByMethod: callsByMethodObj,
      warnings
    }
  }

  /**
   * Log periodic report
   */
  private logReport(): void {
    const report = this.getStats()

    if (report.totalCalls === 0) {
      console.log('[RpcCallTracker] No RPC calls in the last hour')
      return
    }

    const timestamp = new Date(report.timestamp).toISOString()

    console.log(`
╔════════════════════════════════════════════════════════════════╗
║                    RPC CALL TRACKER REPORT                        ║
║                    ${timestamp}                     ║
╠════════════════════════════════════════════════════════════════╣
║ Total Calls (1h): ${report.totalCalls.toString().padEnd(45)}║
║ Unique Methods: ${report.uniqueMethods.toString().padEnd(47)}║
║ Error Rate: ${(report.errorRate * 100).toFixed(2)}%${' '.padEnd(46)}║
║ Avg Latency: ${report.avgLatency.toFixed(2)}ms${' '.padEnd(45)}║
╠════════════════════════════════════════════════════════════════╣
║ TOP METHODS:                                                      ║`)

    report.topMethods.forEach((method, index) => {
      const line = `║ ${(index + 1).toString().padEnd(2)}. ${method.method.padEnd(25)} ${method.count.toString().padEnd(10)} (${method.percentage.toFixed(1)}%)${' '.padEnd(8)}║`
      console.log(line)
    })

    if (report.warnings.length > 0) {
      console.log(`╠════════════════════════════════════════════════════════════════╣
║ WARNINGS:                                                         ║`)
      report.warnings.forEach(warning => {
        const truncated = warning.length > 60 ? warning.substring(0, 57) + '...' : warning
        console.log(`║ ⚠ ${truncated.padEnd(61)}║`)
      })
    }

    console.log(`╚════════════════════════════════════════════════════════════════╝`)

    // Log detailed stats for problematic methods
    Object.entries(report.callsByMethod).forEach(([method, stats]) => {
      if (stats.failureCount > stats.successCount || stats.avgLatencyMs > 1000) {
        console.log(`[RpcCallTracker] Problem detected with ${method}:`)
        console.log(`  - Success rate: ${((stats.successCount / stats.totalCalls) * 100).toFixed(1)}%`)
        console.log(`  - Avg latency: ${stats.avgLatencyMs.toFixed(0)}ms`)
        console.log(`  - Max latency: ${stats.maxLatencyMs.toFixed(0)}ms`)
      }
    })
  }

  /**
   * Get statistics for a specific method
   */
  getMethodStats(method: string): RpcCallStats | undefined {
    this.cleanOldHistory()
    const report = this.getStats()
    return report.callsByMethod[method]
  }

  /**
   * Reset all statistics
   */
  reset(): void {
    this.callHistory = []
    this.methodStats.clear()
    this.totalCallsSinceStart = 0
    console.log('[RpcCallTracker] Statistics reset')
  }

  /**
   * Get call volume time series for a method (last hour, per minute)
   */
  getCallVolume(method?: string): number[] {
    this.cleanOldHistory()

    const now = Date.now()
    const volumes = new Array(60).fill(0)

    const calls = method
      ? this.callHistory.filter(c => c.method === method)
      : this.callHistory

    calls.forEach(call => {
      const minutesAgo = Math.floor((now - call.timestamp) / this.BUCKET_SIZE_MS)
      if (minutesAgo >= 0 && minutesAgo < 60) {
        volumes[59 - minutesAgo]++
      }
    })

    return volumes
  }
}

// Export singleton instance getter
export const getRpcCallTracker = () => RpcCallTracker.getInstance()