/**
 * Metadata Revision Store
 * Append-only record of the metadata revisions returned for each asset.
 * Kept separate from AssetCache on purpose: cache invalidation, TTL expiry
 * and clear() must never remove a revision that a historical record uses.
 */

import { createHash } from 'crypto';
import { Asset, AssetMetadata, MetadataRevision } from './types';

export class MetadataRevisionStore {
  private revisions = new Map<string, MetadataRevision>();
  private history = new Map<string, string[]>();

  /**
   * Record the metadata used for an asset. Identical metadata maps to the
   * same revision, so repeated refreshes don't create duplicates.
   */
  record(
    asset: Asset,
    metadata: AssetMetadata,
    recordedAt: number = Date.now()
  ): MetadataRevision {
    const assetKey = MetadataRevisionStore.assetKey(asset);
    const revisionId = MetadataRevisionStore.computeRevisionId(assetKey, metadata);

    let revision = this.revisions.get(revisionId);
    if (!revision) {
      revision = Object.freeze({
        revisionId,
        asset: Object.freeze({ ...asset }),
        metadata: Object.freeze({ ...metadata }),
        recordedAt,
      });
      this.revisions.set(revisionId, revision);
    }

    const ids = this.history.get(assetKey) ?? [];
    if (ids[ids.length - 1] !== revisionId) {
      ids.push(revisionId);
      this.history.set(assetKey, ids);
    }

    return revision;
  }

  get(revisionId: string): MetadataRevision | undefined {
    return this.revisions.get(revisionId);
  }

  /** Revisions for an asset, oldest first. */
  getHistory(asset: Asset): MetadataRevision[] {
    const ids = this.history.get(MetadataRevisionStore.assetKey(asset)) ?? [];
    return ids.map((id) => this.revisions.get(id) as MetadataRevision);
  }

  private static assetKey(asset: Asset): string {
    return `${asset.network}:${asset.code}:${asset.issuer || 'native'}`;
  }

  private static computeRevisionId(assetKey: string, metadata: AssetMetadata): string {
    const entries = Object.keys(metadata)
      .sort()
      .filter((k) => metadata[k as keyof AssetMetadata] !== undefined)
      .map((k) => [k, metadata[k as keyof AssetMetadata]]);
    return createHash('sha256')
      .update(JSON.stringify([assetKey, entries]))
      .digest('hex');
  }
}