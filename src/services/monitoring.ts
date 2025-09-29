/**
 * Monitoring Service for JuiceSwap API
 *
 * Tracks performance metrics, errors, and provides a dashboard endpoint
 * for monitoring API health during high-traffic events.
 */

import { Request, Response } from 'express';
import { quoteCache } from './quoteCache';
import { rpcPool } from './rpcConnectionPool';
import { rateLimiter } from '../middleware/rateLimit';
import { citreaOptimizer } from './citreaCampaignOptimizer';

interface PerformanceMetric {
  endpoint: string;
  method: string;
  duration: number;
  statusCode: number;
  cached: boolean;
  timestamp: number;
}

interface ErrorMetric {
  type: string;
  message: string;
  endpoint: string;
  timestamp: number;
  stack?: string;
}

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  message: string;
  checks: {
    cache: boolean;
    rpcPool: boolean;
    rateLimit: boolean;
    memory: boolean;
    responseTime: boolean;
  };
}

export class MonitoringService {
  private metrics: PerformanceMetric[] = [];
  private errors: ErrorMetric[] = [];
  private startTime = Date.now();

  // Performance thresholds
  private readonly SLOW_REQUEST_THRESHOLD = 5000; // 5 seconds
  private readonly CRITICAL_REQUEST_THRESHOLD = 10000; // 10 seconds
  private readonly MAX_METRICS_STORED = 1000;
  private readonly METRICS_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

  // Health check thresholds
  private readonly UNHEALTHY_ERROR_RATE = 0.1; // 10% error rate
  private readonly DEGRADED_ERROR_RATE = 0.05; // 5% error rate
  private readonly UNHEALTHY_RESPONSE_TIME = 8000; // 8 seconds
  private readonly DEGRADED_RESPONSE_TIME = 4000; // 4 seconds

  private cleanupTimer: NodeJS.Timeout;

  constructor() {
    console.log('[Monitoring] Service initialized');

    // Start cleanup timer
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.METRICS_CLEANUP_INTERVAL);
  }

  /**
   * Express middleware to track request performance
   */
  middleware() {
    return (req: Request, res: Response, next: Function) => {
      const startTime = Date.now();
      const originalSend = res.send;
      const originalJson = res.json;

      // Track response
      const trackResponse = (body: any) => {
        const duration = Date.now() - startTime;
        const cached = typeof body === 'string' && body.includes('"hitsCachedRoutes":true');

        this.recordMetric({
          endpoint: req.path,
          method: req.method,
          duration,
          statusCode: res.statusCode,
          cached,
          timestamp: Date.now()
        });

        // Log slow requests
        if (duration > this.SLOW_REQUEST_THRESHOLD) {
          console.warn(`[Monitoring] Slow request detected: ${req.method} ${req.path} - ${duration}ms`);
        }

        if (duration > this.CRITICAL_REQUEST_THRESHOLD) {
          console.error(`[Monitoring] Critical slow request: ${req.method} ${req.path} - ${duration}ms`);
        }
      };

      // Override send methods
      res.send = function(body: any) {
        trackResponse(body);
        return originalSend.call(this, body);
      };

      res.json = function(body: any) {
        trackResponse(JSON.stringify(body));
        return originalJson.call(this, body);
      };

      next();
    };
  }

  /**
   * Record a performance metric
   */
  private recordMetric(metric: PerformanceMetric) {
    this.metrics.push(metric);

    // Keep metrics array bounded
    if (this.metrics.length > this.MAX_METRICS_STORED) {
      this.metrics.shift();
    }
  }

  /**
   * Record an error
   */
  recordError(error: Error, endpoint: string) {
    this.errors.push({
      type: error.name,
      message: error.message,
      endpoint,
      timestamp: Date.now(),
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });

    // Keep errors array bounded
    if (this.errors.length > 100) {
      this.errors.shift();
    }

    console.error(`[Monitoring] Error recorded: ${error.name} - ${error.message} at ${endpoint}`);
  }

  /**
   * Get current performance statistics
   */
  getPerformanceStats() {
    if (this.metrics.length === 0) {
      return {
        avgResponseTime: 0,
        p50ResponseTime: 0,
        p95ResponseTime: 0,
        p99ResponseTime: 0,
        requestCount: 0,
        errorRate: 0,
        cacheHitRate: 0,
        slowRequests: 0,
        criticalRequests: 0
      };
    }

    const sortedDurations = this.metrics
      .map(m => m.duration)
      .sort((a, b) => a - b);

    const totalDuration = sortedDurations.reduce((sum, d) => sum + d, 0);
    const errorCount = this.metrics.filter(m => m.statusCode >= 400).length;
    const cachedCount = this.metrics.filter(m => m.cached).length;
    const slowCount = this.metrics.filter(m => m.duration > this.SLOW_REQUEST_THRESHOLD).length;
    const criticalCount = this.metrics.filter(m => m.duration > this.CRITICAL_REQUEST_THRESHOLD).length;

    return {
      avgResponseTime: Math.round(totalDuration / this.metrics.length),
      p50ResponseTime: sortedDurations[Math.floor(sortedDurations.length * 0.5)],
      p95ResponseTime: sortedDurations[Math.floor(sortedDurations.length * 0.95)],
      p99ResponseTime: sortedDurations[Math.floor(sortedDurations.length * 0.99)],
      requestCount: this.metrics.length,
      errorRate: (errorCount / this.metrics.length * 100).toFixed(2) + '%',
      cacheHitRate: (cachedCount / this.metrics.length * 100).toFixed(2) + '%',
      slowRequests: slowCount,
      criticalRequests: criticalCount
    };
  }

  /**
   * Get health status
   */
  getHealthStatus(): HealthStatus {
    const perfStats = this.getPerformanceStats();
    const errorRate = this.metrics.length > 0
      ? this.metrics.filter(m => m.statusCode >= 400).length / this.metrics.length
      : 0;

    const checks = {
      cache: true, // Assume cache is working
      rpcPool: true, // Assume RPC pool is working
      rateLimit: true, // Assume rate limiter is working
      memory: process.memoryUsage().heapUsed < 500 * 1024 * 1024, // Less than 500MB
      responseTime: perfStats.avgResponseTime < this.UNHEALTHY_RESPONSE_TIME
    };

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    let message = 'All systems operational';

    if (errorRate >= this.UNHEALTHY_ERROR_RATE ||
        perfStats.avgResponseTime >= this.UNHEALTHY_RESPONSE_TIME ||
        !checks.memory) {
      status = 'unhealthy';
      message = 'System experiencing issues';
    } else if (errorRate >= this.DEGRADED_ERROR_RATE ||
               perfStats.avgResponseTime >= this.DEGRADED_RESPONSE_TIME) {
      status = 'degraded';
      message = 'System performance degraded';
    }

    return {
      status,
      message,
      checks
    };
  }

  /**
   * Get comprehensive dashboard data
   */
  getDashboard() {
    const uptime = Date.now() - this.startTime;
    const cacheStats = quoteCache.getStats();
    const rpcStats = rpcPool.getStats();
    const rateLimitStats = rateLimiter.getStats();
    const campaignStats = citreaOptimizer.getStats();
    const perfStats = this.getPerformanceStats();
    const health = this.getHealthStatus();

    // Memory usage
    const memUsage = process.memoryUsage();
    const memoryStats = {
      heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
      external: `${Math.round(memUsage.external / 1024 / 1024)}MB`,
      rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`
    };

    // Recent errors
    const recentErrors = this.errors.slice(-10).map(e => ({
      type: e.type,
      message: e.message,
      endpoint: e.endpoint,
      age: `${Math.round((Date.now() - e.timestamp) / 1000)}s ago`
    }));

    return {
      health,
      uptime: {
        seconds: Math.floor(uptime / 1000),
        formatted: this.formatUptime(uptime)
      },
      performance: perfStats,
      cache: {
        ...cacheStats,
        hitRate: `${cacheStats.avgHitRate.toFixed(2)}%`
      },
      rpcPool: rpcStats,
      rateLimit: rateLimitStats,
      campaign: campaignStats,
      memory: memoryStats,
      recentErrors,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Get metrics for specific endpoint
   */
  getEndpointMetrics(endpoint: string) {
    const endpointMetrics = this.metrics.filter(m => m.endpoint === endpoint);

    if (endpointMetrics.length === 0) {
      return null;
    }

    const durations = endpointMetrics.map(m => m.duration);
    const avgDuration = durations.reduce((sum, d) => sum + d, 0) / durations.length;
    const errors = endpointMetrics.filter(m => m.statusCode >= 400).length;

    return {
      endpoint,
      requestCount: endpointMetrics.length,
      avgResponseTime: Math.round(avgDuration),
      minResponseTime: Math.min(...durations),
      maxResponseTime: Math.max(...durations),
      errorCount: errors,
      errorRate: `${(errors / endpointMetrics.length * 100).toFixed(2)}%`,
      lastRequest: new Date(endpointMetrics[endpointMetrics.length - 1].timestamp).toISOString()
    };
  }

  /**
   * Format uptime for display
   */
  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h ${minutes % 60}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Clean up old metrics
   */
  private cleanup() {
    const cutoff = Date.now() - 15 * 60 * 1000; // Keep last 15 minutes

    const oldMetricsCount = this.metrics.length;
    this.metrics = this.metrics.filter(m => m.timestamp > cutoff);

    const oldErrorsCount = this.errors.length;
    this.errors = this.errors.filter(e => e.timestamp > cutoff);

    if (oldMetricsCount - this.metrics.length > 0 ||
        oldErrorsCount - this.errors.length > 0) {
      console.log(`[Monitoring] Cleanup: removed ${oldMetricsCount - this.metrics.length} metrics, ${oldErrorsCount - this.errors.length} errors`);
    }
  }

  /**
   * Shutdown monitoring
   */
  shutdown() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    console.log('[Monitoring] Service shut down');
  }
}

// Singleton instance
export const monitoring = new MonitoringService();

// Express route handler for dashboard
export const monitoringDashboard = (_req: Request, res: Response) => {
  res.json(monitoring.getDashboard());
};

// Express route handler for health check
export const healthCheck = (_req: Request, res: Response) => {
  const health = monitoring.getHealthStatus();
  const statusCode = health.status === 'healthy' ? 200 :
                     health.status === 'degraded' ? 503 : 500;
  res.status(statusCode).json(health);
};