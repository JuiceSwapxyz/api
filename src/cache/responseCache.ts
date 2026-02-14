import Logger from "bunyan";

interface CachedEntry {
  data: any;
  timestamp: number;
}

export class ResponseCache {
  private static instances: Set<ResponseCache> = new Set();

  private cache: Map<string, CachedEntry> = new Map();
  private readonly ttl: number;
  private readonly maxSize: number;
  private readonly name: string;
  private logger?: Logger;
  private cleanupTimer: NodeJS.Timeout;

  private readonly CLEANUP_INTERVAL = 60_000;

  constructor({
    ttl,
    maxSize,
    name,
    logger,
  }: {
    ttl: number;
    maxSize: number;
    name: string;
    logger?: Logger;
  }) {
    this.ttl = ttl;
    this.maxSize = maxSize;
    this.name = name;
    this.logger = logger;
    this.cleanupTimer = setInterval(
      () => this.cleanup(),
      this.CLEANUP_INTERVAL,
    );
    this.cleanupTimer.unref();
    ResponseCache.instances.add(this);
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.cache.clear();
    ResponseCache.instances.delete(this);
  }

  static destroyAll(): void {
    for (const instance of ResponseCache.instances) {
      clearInterval(instance.cleanupTimer);
      instance.cache.clear();
    }
    ResponseCache.instances.clear();
  }

  get(key: string): any | null {
    const cached = this.cache.get(key);
    if (!cached) {
      return null;
    }
    if (Date.now() - cached.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    return cached.data;
  }

  set(key: string, data: any): void {
    if (this.cache.size >= this.maxSize) {
      this.evictOldest();
    }
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  private cleanup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.ttl) {
        this.cache.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      this.logger?.debug(
        `[${this.name}] Cleanup removed ${removed} expired entries`,
      );
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (value.timestamp < oldestTime) {
        oldestTime = value.timestamp;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }
}
