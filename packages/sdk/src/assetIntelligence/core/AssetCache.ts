/**
 * Unified Asset Cache
 * Multi-layer caching with automatic invalidation
 */

import { MemoryCache } from '../cache/MemoryCache';
import { PersistentCache } from '../cache/PersistentCache';
import { CacheKey } from '../cache/CacheKey';
import { CachePolicy, EvictionPolicy } from '../cache/CachePolicy';
import { Asset, AssetData } from './types';

export interface CacheConfig {
  memory: {
    maxSize: number;
    ttl: number;
  };
  persistent: {
    enabled: boolean;
    path: string;
    ttl: number;
  };
  remote?: {
    enabled: boolean;
    host: string;
    port: number;
    ttl: number;
  };
}

export interface CacheEntry {
  data: AssetData;
  timestamp: number;
  ttl: number;
  hits: number;
}

export class AssetCache {
  private memoryCache: MemoryCache;
  private persistentCache: PersistentCache | null;
  private cachePolicy: CachePolicy;
  private config: CacheConfig;

  constructor(config: CacheConfig) {
    this.config = config;
    this.cachePolicy = new CachePolicy(EvictionPolicy.LRU);
    this.memoryCache = new MemoryCache(config.memory.maxSize, config.memory.ttl);
    
    if (config.persistent.enabled) {
      this.persistentCache = new PersistentCache(config.persistent.path, config.persistent.ttl);
    } else {
      this.persistentCache = null;
    }
  }

  /**
   * Get asset data from cache (L1 → L2 → L3)
   */
  async get(asset: Asset, dataType: 'general' | 'metadata' | 'price' | 'trust' | 'compatibility'): Promise<AssetData | null> {
    const key = this.getCacheKey(asset, dataType);

    // L1: Memory cache
    // MemoryCache wraps the entry we give it in its own entry, so the
    // AssetData sits one level further down in `.data`.
    const memoryEntry = this.memoryCache.get(key);
    if (memoryEntry && !this.isExpired(memoryEntry)) {
      memoryEntry.hits++;
      return (memoryEntry.data as CacheEntry).data;
    }

    // L2: Persistent cache
    if (this.persistentCache) {
      const persistentEntry = await this.persistentCache.get(key);
      if (persistentEntry && !this.isExpired(persistentEntry)) {
        // Promote to memory cache
        this.memoryCache.set(key, persistentEntry);
        persistentEntry.hits++;
        return persistentEntry.data;
      }
    }

    // L3: Remote cache (if configured)
    // TODO: Implement remote cache support

    return null;
  }

  /**
   * Set asset data in cache (all layers)
   */
  async set(asset: Asset, dataType: string, data: AssetData, ttl?: number): Promise<void> {
    const key = this.getCacheKey(asset, dataType);
    const entryTTL = ttl || this.getDefaultTTL(dataType);

    const entry: CacheEntry = {
      data,
      timestamp: Date.now(),
      ttl: entryTTL,
      hits: 0,
    };

    // Set in memory cache
    this.memoryCache.set(key, entry);

    // Set in persistent cache
    if (this.persistentCache) {
      await this.persistentCache.set(key, entry);
    }

    // TODO: Set in remote cache (if configured)
  }

  /**
   * Invalidate specific asset data
   */
  async invalidate(asset: Asset, dataType?: string): Promise<void> {
    const keys = dataType 
      ? [this.getCacheKey(asset, dataType)]
      : this.getAllCacheKeys(asset);

    for (const key of keys) {
      this.memoryCache.delete(key);
      if (this.persistentCache) {
        await this.persistentCache.delete(key);
      }
      // TODO: Invalidate in remote cache (if configured)
    }
  }

  /**
   * Invalidate all assets matching a pattern
   */
  async invalidatePattern(pattern: string): Promise<void> {
    const memoryKeys = this.memoryCache.keys();
    const matchingKeys = memoryKeys.filter(key => key.includes(pattern));

    for (const key of matchingKeys) {
      this.memoryCache.delete(key);
      if (this.persistentCache) {
        await this.persistentCache.delete(key);
      }
    }
  }

  /**
   * Clear all cache entries
   */
  async clear(): Promise<void> {
    this.memoryCache.clear();
    if (this.persistentCache) {
      await this.persistentCache.clear();
    }
    // TODO: Clear remote cache (if configured)
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    memory: { size: number; hits: number; misses: number };
    persistent: { size: number; hits: number; misses: number };
  } {
    const memoryStats = this.memoryCache.getStats();
    const persistentStats = this.persistentCache ? this.persistentCache.getStats() : { size: 0, hits: 0, misses: 0 };

    return {
      memory: memoryStats,
      persistent: persistentStats,
    };
  }

  /**
   * Check if cache entry is expired
   */
  private isExpired(entry: CacheEntry): boolean {
    const age = Date.now() - entry.timestamp;
    return age > entry.ttl;
  }

  /**
   * Get cache key for asset and data type
   */
  private getCacheKey(asset: Asset, dataType: string): string {
    return CacheKey.forDataType(asset, dataType);
  }

  /**
   * Get all cache keys for an asset
   */
  private getAllCacheKeys(asset: Asset): string[] {
    const dataTypes = ['general', 'metadata', 'price', 'trust', 'compatibility'];
    return dataTypes.map(type => this.getCacheKey(asset, type));
  }

  /**
   * Get default TTL for data type
   */
  private getDefaultTTL(dataType: string): number {
    switch (dataType) {
      case 'price':
        return 60000; // 1 minute
      case 'metadata':
        return 3600000; // 1 hour
      case 'trust':
        return 86400000; // 24 hours
      case 'compatibility':
        return 3600000; // 1 hour
      default:
        return 1800000; // 30 minutes
    }
  }
}
