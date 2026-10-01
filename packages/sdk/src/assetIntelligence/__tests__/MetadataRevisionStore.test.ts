import { MetadataRevisionStore } from '../core/MetadataRevisionStore';
import { Asset } from '../core/types';

const asset: Asset = { code: 'USDC', issuer: 'GISSUER', network: 'testnet' };

describe('MetadataRevisionStore', () => {
  it('returns the same revision for identical metadata', () => {
    const store = new MetadataRevisionStore();
    const a = store.record(asset, { name: 'USDC', decimals: 7 });
    const b = store.record(asset, { decimals: 7, name: 'USDC' });
    expect(b.revisionId).toBe(a.revisionId);
    expect(store.getHistory(asset)).toHaveLength(1);
  });

  it('keeps every revision when metadata changes', () => {
    const store = new MetadataRevisionStore();
    const v1 = store.record(asset, { name: 'USDC', homeDomain: 'old.example' });
    const v2 = store.record(asset, { name: 'USDC', homeDomain: 'new.example' });
    expect(v2.revisionId).not.toBe(v1.revisionId);
    expect(store.get(v1.revisionId)?.metadata.homeDomain).toBe('old.example');
    expect(store.getHistory(asset).map((r) => r.revisionId)).toEqual([
      v1.revisionId,
      v2.revisionId,
    ]);
  });

  it('does not let callers mutate a stored revision', () => {
    const store = new MetadataRevisionStore();
    const input = { name: 'USDC' };
    const rev = store.record(asset, input);
    input.name = 'CHANGED';
    expect(store.get(rev.revisionId)?.metadata.name).toBe('USDC');
  });

  it('separates revisions by asset', () => {
    const store = new MetadataRevisionStore();
    const other: Asset = { ...asset, code: 'EURC' };
    const a = store.record(asset, { name: 'X' });
    const b = store.record(other, { name: 'X' });
    expect(a.revisionId).not.toBe(b.revisionId);
  });
});