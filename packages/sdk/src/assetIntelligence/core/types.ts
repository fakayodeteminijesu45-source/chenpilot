/**
 * Core type definitions for Asset Intelligence Layer
 */

export type Network = 'public' | 'testnet' | 'futurenet' | 'standalone';

export interface Asset {
  code: string;
  issuer?: string;
  network: Network;
}

export interface AssetData {
  metadata?: AssetMetadata;
  metadataRevisionId?: string;
  price?: PriceInfo;
  trust?: TrustScore;
  compatibility?: CompatibilityMap;
  lastUpdated: number;
}

export interface AssetMetadata {
  name?: string;
  description?: string;
  image?: string;
  homeDomain?: string;
  decimals?: number;
  isAuthRequired?: boolean;
  authRevoked?: boolean;
  tomlUrl?: string;
}

export interface MetadataRevision {
  revisionId: string; // content hash of asset + metadata
  asset: Asset;
  metadata: AssetMetadata;
  recordedAt: number;
}

export interface PriceInfo {
  price: number;
  priceChange24h?: number;
  volume24h?: number;
  lastTrade?: number;
  source: string;
  timestamp: number;
}

export interface TrustScore {
  overall: number; // 0-100
  signals: TrustSignal[];
  verificationStatus: 'verified' | 'unverified' | 'malicious';
  lastUpdated: number;
}

export interface TrustSignal {
  type: string;
  value: number;
  weight: number;
  description: string;
  source: string;
  timestamp: number;
}

export interface CompatibilityMap {
  [network: string]: CompatibilityResult;
}

export interface CompatibilityResult {
  compatible: boolean;
  reasons: string[];
  warnings: string[];
  lastChecked: number;
}

export interface CompatibilityContext {
  network: Network;
  operation?: Operation;
  version?: string;
}

export type Operation = 
  | 'payment'
  | 'create_account'
  | 'manage_sell_offer'
  | 'manage_buy_offer'
  | 'set_trustline'
  | 'change_trust';

export interface AssetEvent {
  type: 'price_change' | 'metadata_update' | 'trust_change' | 'compatibility_change' | 'manual_invalidation';
  asset: Asset;
  timestamp: number;
  data?: any;
}

export interface VerificationResult {
  verified: boolean;
  status: 'verified' | 'unverified' | 'malicious';
  reasons: string[];
  score: number;
}

export interface PriceSource {
  name: string;
  url: string;
  priority: number;
  enabled: boolean;
}

export interface TrustSource {
  name: string;
  type: 'domain' | 'issuer' | 'community' | 'blacklist';
  priority: number;
  enabled: boolean;
}

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

export interface AssetIntelligenceConfig {
  cache: CacheConfig;
  providers: {
    metadata: {
      horizonUrl: string;
      tomlUrl?: string;
    };
    price: {
      sources: PriceSource[];
      updateInterval: number;
    };
    trust: {
      sources: TrustSource[];
      weights: Record<string, number>;
    };
  };
  invalidation: {
    priceChangeThreshold: number; // basis points
    maxAge: number; // milliseconds
    eventDriven: boolean;
  };
  compatibility: {
    strictMode: boolean;
    allowedNetworks: Network[];
    blockedIssuers: string[];
  };
}

export type ErrorCode =
  | 'ASSET_NOT_FOUND'
  | 'METADATA_UNAVAILABLE'
  | 'PRICE_UNAVAILABLE'
  | 'TRUST_CHECK_FAILED'
  | 'COMPATIBILITY_CHECK_FAILED'
  | 'CACHE_ERROR'
  | 'PROVIDER_ERROR';

export class AssetIntelligenceError extends Error {
  code: ErrorCode;
  asset?: Asset;
  context?: Record<string, any>;

  constructor(code: ErrorCode, message: string, asset?: Asset, context?: Record<string, any>) {
    super(message);
    this.name = 'AssetIntelligenceError';
    this.code = code;
    this.asset = asset;
    this.context = context;
  }
}
