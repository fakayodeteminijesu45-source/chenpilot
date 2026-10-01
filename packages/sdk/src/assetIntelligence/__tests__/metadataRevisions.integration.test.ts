import { AssetIntelligence } from '../core/AssetIntelligence';
import { Asset, AssetIntelligenceConfig } from '../core/types';

const asset: Asset = { code: 'USDC', issuer: 'GISSUER', network: 'testnet' };

const config: AssetIntelligenceConfig = {
  cache: {
    memory: { maxSize: 100, ttl: 60000 },
    persistent: { enabled: false, path: '', ttl: 0 },
  },
  providers: {
    metadata: { horizonUrl: 'https://horizon-testnet.stellar.org' },
    price: { sources: [], updateInterval: 60000 },
    trust: { sources: [], weights: {} },
  },
  invalidation: { priceChangeThreshold: 100, maxAge: 3600000, eventDriven: false },
  compatibility: { strictMode: false, allowedNetworks: ['testnet'], blockedIssuers: [] },
};

describe('AssetIntelligence metadata revisions', () => {
  let ai: AssetIntelligence;
  const v1 = { name: 'USDC', homeDomain: 'old.example', decimals: 7 };
  const v2 = { name: 'USDC', homeDomain: 'new.example', decimals: 7 };

  beforeEach(() => {
    ai = new AssetIntelligence(config);
    jest.spyOn((ai as any).trustScorer, 'calculateTrustScore').mockResolvedValue({
      overall: 90,
      signals: [],
      verificationStatus: 'verified',
      lastUpdated: 0,
    });
    jest.spyOn(ai, 'checkCompatibility').mockResolvedValue({
      compatible: true,
      reasons: [],
      warnings: [],
      lastChecked: 0,
    });
  });

  afterEach(() => {
    ai.destroy();
    jest.restoreAllMocks();
  });

  it('keeps the metadata a record used after refresh, invalidate and clear', async () => {
    jest
      .spyOn(ai as any, 'fetchMetadata')
      .mockResolvedValueOnce(v1)
      .mockResolvedValueOnce(v2);

    const first = await ai.getAssetInfo(asset);
    const id1 = first!.metadataRevisionId!;
    expect(id1).toBeDefined();

    await ai.refreshAsset(asset); // metadata changed upstream
    const id2 = (await ai.getAssetInfo(asset))!.metadataRevisionId!;
    expect(id2).not.toBe(id1);

    await ai.invalidateAsset(asset);
    await ai.clearCache();

    expect(ai.getMetadataRevision(id1)?.metadata).toEqual(v1);
    expect(ai.getMetadataRevision(id2)?.metadata).toEqual(v2);
    expect(ai.getMetadataHistory(asset).map((r) => r.revisionId)).toEqual([id1, id2]);
  });

  it('reuses the revision when refreshed metadata is unchanged', async () => {
    jest.spyOn(ai as any, 'fetchMetadata').mockResolvedValue(v1);

    const id1 = (await ai.getAssetInfo(asset))!.metadataRevisionId!;
    await ai.refreshAsset(asset);
    const id2 = (await ai.getAssetInfo(asset))!.metadataRevisionId!;

    expect(id2).toBe(id1);
    expect(ai.getMetadataHistory(asset)).toHaveLength(1);
  });
});