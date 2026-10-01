/**
 * Asset Intelligence - Main Orchestrator
 * Coordinates all asset intelligence operations
 */

import { AssetCache } from './AssetCache.js';
import { CacheInvalidator } from './CacheInvalidator.js';
import { MetadataRevisionStore } from './MetadataRevisionStore.js';
import { TrustScorer } from '../trust/TrustScorer.js';
import { TrustSignals } from '../trust/TrustSignals.js';
import { TrustRegistry } from '../trust/TrustRegistry.js';
import { AssetValidator } from '../compatibility/AssetValidator.js';
import { NetworkCompatibility } from '../compatibility/NetworkCompatibility.js';
import { VersionCompatibility } from '../compatibility/VersionCompatibility.js';
import { 
  Asset, 
  AssetData, 
  PriceInfo, 
  TrustScore, 
  CompatibilityResult, 
  CompatibilityContext,
  AssetIntelligenceConfig,
  AssetEvent,
  AssetIntelligenceError,
  ErrorCode,
  MetadataRevision,
} from './types.js';

export class AssetIntelligence {
  private cache: AssetCache;
  private invalidator: CacheInvalidator;
  private trustScorer: TrustScorer;
  private trustSignals: TrustSignals;
  private trustRegistry: TrustRegistry;
  private assetValidator: AssetValidator;
  private networkCompatibility: NetworkCompatibility;
  private versionCompatibility: VersionCompatibility;
  private metadataRevisions: MetadataRevisionStore;
  private config: AssetIntelligenceConfig;

  constructor(config: AssetIntelligenceConfig) {
    this.config = config;

    // Initialize metadata revision store (kept separate from the cache so
    // invalidation and TTL expiry never remove historical revisions)
    this.metadataRevisions = new MetadataRevisionStore();
    
    // Initialize cache
    this.cache = new AssetCache(config.cache);
    
    // Initialize invalidator
    this.invalidator = new CacheInvalidator(this.cache, config.invalidation);
    
    // Initialize trust components
    this.trustRegistry = new TrustRegistry();
    this.trustSignals = new TrustSignals();
    this.trustScorer = new TrustScorer(
      this.trustSignals,
      this.trustRegistry,
      {
        weights: config.providers.trust.weights,
        thresholds: {
          verified: 80,
          unverified: 50,
          malicious: 20,
        },
      }
    );
    
    // Initialize compatibility components
    this.assetValidator = new AssetValidator({
      strictMode: config.compatibility.strictMode,
      allowedNetworks: config.compatibility.allowedNetworks,
      blockedIssuers: config.compatibility.blockedIssuers,
      requireAuth: true,
      requireTOML: false,
    });
    
    this.networkCompatibility = new NetworkCompatibility();
    this.versionCompatibility = new VersionCompatibility();
  }

  /**
   * Get comprehensive asset information
   */
  async getAssetInfo(asset: Asset): Promise<AssetData | null> {
    try {
      // Check cache first
      const cached = await this.cache.get(asset, 'general');
      if (cached) {
        return cached;
      }

      // Fetch metadata
      const metadata = await this.fetchMetadata(asset);

      // Record the metadata revision so historical records can refer to it
      const revision = this.metadataRevisions.record(asset, metadata);
      
      // Fetch trust score
      const trust = await this.trustScorer.calculateTrustScore(asset);
      
      // Check compatibility
      const compatibility = await this.checkCompatibility(asset, {
        network: asset.network,
      });

      const assetData: AssetData = {
        metadata,
        metadataRevisionId: revision.revisionId,
        trust,
        compatibility: {
          [asset.network]: compatibility,
        },
        lastUpdated: Date.now(),
      };

      // Cache the result
      await this.cache.set(asset, 'general', assetData);

      return assetData;
    } catch (error) {
      throw new AssetIntelligenceError(
        'PROVIDER_ERROR',
        `Failed to get asset info: ${error instanceof Error ? error.message : String(error)}`,
        asset
      );
    }
  }

  /**
   * Get asset price information
   */
  async getAssetPrice(asset: Asset): Promise<PriceInfo | null> {
    try {
      // Check cache first
      const cached = await this.cache.get(asset, 'price');
      if (cached && cached.price) {
        return cached.price;
      }

      // TODO: Implement actual price fetching from configured sources
      const priceInfo: PriceInfo = {
        price: 0, // Placeholder
        priceChange24h: 0,
        volume24h: 0,
        source: 'placeholder',
        timestamp: Date.now(),
      };

      // Cache the result
      const assetData: AssetData = {
        price: priceInfo,
        lastUpdated: Date.now(),
      };
      await this.cache.set(asset, 'price', assetData);

      return priceInfo;
    } catch (error) {
      throw new AssetIntelligenceError(
        'PRICE_UNAVAILABLE',
        `Failed to get asset price: ${error instanceof Error ? error.message : String(error)}`,
        asset
      );
    }
  }

  /**
   * Get trust score for asset
   */
  async getTrustScore(asset: Asset): Promise<TrustScore> {
    try {
      // Check cache first
      const cached = await this.cache.get(asset, 'trust');
      if (cached && cached.trust) {
        return cached.trust;
      }

      // Calculate trust score
      const trustScore = await this.trustScorer.calculateTrustScore(asset);

      // Cache the result
      const assetData: AssetData = {
        trust: trustScore,
        lastUpdated: Date.now(),
      };
      await this.cache.set(asset, 'trust', assetData);

      return trustScore;
    } catch (error) {
      throw new AssetIntelligenceError(
        'TRUST_CHECK_FAILED',
        `Failed to get trust score: ${error instanceof Error ? error.message : String(error)}`,
        asset
      );
    }
  }

  /**
   * Check asset compatibility
   */
  async checkCompatibility(asset: Asset, context: CompatibilityContext): Promise<CompatibilityResult> {
    try {
      // Check cache first
      const cacheKey = `${context.network}:${context.operation || 'any'}:${context.version || 'any'}`;
      const cached = await this.cache.get(asset, 'compatibility');
      if (cached && cached.compatibility && cached.compatibility[context.network]) {
        return cached.compatibility[context.network];
      }

      // Check network compatibility
      const networkResult = await this.networkCompatibility.checkCompatibility(asset, context);

      // Check asset validation
      const validationResult = await this.assetValidator.validateMetadata(asset, {});

      const reasons = [...networkResult.reasons, ...validationResult.reasons];
      const warnings = [...networkResult.warnings, ...validationResult.reasons];
      const compatible = networkResult.compatible && validationResult.verified;

      const result: CompatibilityResult = {
        compatible,
        reasons,
        warnings,
        lastChecked: Date.now(),
      };

      // Cache the result
      const assetData: AssetData = {
        compatibility: {
          [context.network]: result,
        },
        lastUpdated: Date.now(),
      };
      await this.cache.set(asset, 'compatibility', assetData);

      return result;
    } catch (error) {
      throw new AssetIntelligenceError(
        'COMPATIBILITY_CHECK_FAILED',
        `Failed to check compatibility: ${error instanceof Error ? error.message : String(error)}`,
        asset
      );
    }
  }

  /**
   * Get the exact metadata revision a historical record was built from.
   * Revisions are kept when the cache is invalidated, refreshed or cleared.
   */
  getMetadataRevision(revisionId: string): MetadataRevision | undefined {
    return this.metadataRevisions.get(revisionId);
  }

  /**
   * Get all recorded metadata revisions for an asset, oldest first.
   */
  getMetadataHistory(asset: Asset): MetadataRevision[] {
    return this.metadataRevisions.getHistory(asset);
  }

  /**
   * Invalidate asset cache
   */
  async invalidateAsset(asset: Asset): Promise<void> {
    await this.cache.invalidate(asset);
  }

  /**
   * Refresh asset data
   */
  async refreshAsset(asset: Asset): Promise<void> {
    await this.invalidateAsset(asset);
    await this.getAssetInfo(asset); // This will re-fetch and cache
  }

  /**
   * Handle asset event
   */
  async handleEvent(event: AssetEvent): Promise<void> {
    await this.invalidator.invalidateOnEvent(event);
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return this.cache.getStats();
  }

  /**
   * Clear all caches
   */
  async clearCache(): Promise<void> {
    await this.cache.clear();
  }

  /**
   * Fetch asset metadata (placeholder implementation)
   */
  private async fetchMetadata(asset: Asset) {
    // TODO: Implement actual metadata fetching from configured providers
    return {
      name: asset.code,
      description: `Asset ${asset.code}`,
      homeDomain: undefined,
      decimals: 7,
      isAuthRequired: false,
      authRevoked: false,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<AssetIntelligenceConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): AssetIntelligenceConfig {
    return { ...this.config };
  }

  /**
   * Destroy and clean up resources
   */
  destroy(): void {
    this.invalidator.destroy();
  }
}
