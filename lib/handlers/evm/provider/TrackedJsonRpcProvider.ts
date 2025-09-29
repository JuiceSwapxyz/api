import { StaticJsonRpcProvider } from '@ethersproject/providers'
import { ConnectionInfo } from '@ethersproject/web'
import { Networkish } from '@ethersproject/networks'
import { getRpcCallTracker } from './RpcCallTracker'

// Environment-based debug logging
const DEBUG_RPC = process.env.DEBUG_RPC === 'true'

export interface TrackedJsonRpcProviderConfig {
  url?: ConnectionInfo | string
  network?: Networkish
  name?: string
  chainId?: number
}

/**
 * Enhanced JSON-RPC Provider that tracks all RPC calls
 * Intercepts at the lowest level to capture actual JSON-RPC method names
 */
export class TrackedJsonRpcProvider extends StaticJsonRpcProvider {
  private readonly providerName: string
  private readonly chainId?: number

  // Block number caching (kept from InstrumentedEVMProvider)
  private cachedBlockNumber?: { value: number; timestamp: number }
  private readonly BLOCK_NUMBER_CACHE_TTL: number

  constructor(config: TrackedJsonRpcProviderConfig) {
    super(config.url, config.network)

    this.providerName = config.name || 'unknown'
    this.chainId = config.chainId

    // Configure block caching based on chain
    const isCitrea = this.chainId && (this.chainId === 5115 || this.chainId === 5003)
    this.BLOCK_NUMBER_CACHE_TTL = isCitrea ? 30000 : 12000 // 30s for Citrea, 12s for others

    if (DEBUG_RPC) {
      console.log(`[TrackedJsonRpcProvider] Initialized for ${this.providerName} on chain ${this.chainId || 'unknown'}`)
    }
  }

  /**
   * Override the core send method to track ALL RPC calls
   * This captures the actual JSON-RPC method names
   */
  async send(method: string, params: Array<any>): Promise<any> {
    const tracker = getRpcCallTracker()
    const startTime = Date.now()

    // Special handling for getBlockNumber with caching
    if (method === 'eth_blockNumber') {
      const cached = this.getCachedBlockNumber()
      if (cached !== null) {
        // Track the cache hit
        tracker.trackCall('eth_blockNumber', true, 0)
        if (DEBUG_RPC) {
          console.log(`[RPC Cache] Block number cache hit: ${cached}`)
        }
        return `0x${cached.toString(16)}`
      }
    }

    if (DEBUG_RPC) {
      console.log(`[RPC] Calling ${method} on ${this.providerName}`)
    }

    try {
      const result = await super.send(method, params)
      const latency = Date.now() - startTime

      // Cache block number if applicable
      if (method === 'eth_blockNumber' && result) {
        const blockNumber = parseInt(result, 16)
        this.setCachedBlockNumber(blockNumber)
      }

      // Track successful call
      tracker.trackCall(method, true, latency)

      // Log slow calls
      if (latency > 1000) {
        console.warn(`[RPC] Slow call: ${method} took ${latency}ms`)
      }

      return result
    } catch (error) {
      const latency = Date.now() - startTime

      // Track failed call
      tracker.trackCall(method, false, latency)

      console.error(`[RPC] Failed call: ${method} after ${latency}ms`, error)
      throw error
    }
  }

  /**
   * Override perform for additional tracking
   * This is called by high-level methods and eventually calls send()
   */
  async perform(method: string, params: any): Promise<any> {
    // Log high-level method calls for debugging
    if (DEBUG_RPC && method !== 'getBlockNumber' && method !== 'call') {
      console.log(`[RPC] High-level call: ${method}`)
    }

    return super.perform(method, params)
  }

  /**
   * Get cached block number if available
   */
  private getCachedBlockNumber(): number | null {
    if (!this.cachedBlockNumber) {
      return null
    }

    const age = Date.now() - this.cachedBlockNumber.timestamp
    if (age > this.BLOCK_NUMBER_CACHE_TTL) {
      this.cachedBlockNumber = undefined
      return null
    }

    return this.cachedBlockNumber.value
  }

  /**
   * Set cached block number
   */
  private setCachedBlockNumber(blockNumber: number): void {
    this.cachedBlockNumber = {
      value: blockNumber,
      timestamp: Date.now()
    }
    if (DEBUG_RPC) {
      console.log(`[RPC Cache] Cached block number: ${blockNumber} for ${this.BLOCK_NUMBER_CACHE_TTL}ms`)
    }
  }

  /**
   * Override getBlockNumber to use caching
   */
  async getBlockNumber(): Promise<number> {
    const cached = this.getCachedBlockNumber()
    if (cached !== null) {
      if (DEBUG_RPC) {
        console.log(`[RPC Cache] Using cached block number: ${cached}`)
      }
      return cached
    }

    const blockNumber = await super.getBlockNumber()
    this.setCachedBlockNumber(blockNumber)
    return blockNumber
  }

  /**
   * Get provider statistics
   */
  getStats() {
    const tracker = getRpcCallTracker()
    return tracker.getStats()
  }

  /**
   * Static utility to detect network and return configured provider
   */
  static async create(config: TrackedJsonRpcProviderConfig): Promise<TrackedJsonRpcProvider> {
    const provider = new TrackedJsonRpcProvider(config)

    // Detect network if not provided
    if (!config.network) {
      try {
        const network = await provider.detectNetwork()
        if (DEBUG_RPC) {
          console.log(`[TrackedJsonRpcProvider] Detected network: ${network.name} (${network.chainId})`)
        }
      } catch (error) {
        console.warn('[TrackedJsonRpcProvider] Failed to detect network:', error)
      }
    }

    return provider
  }
}