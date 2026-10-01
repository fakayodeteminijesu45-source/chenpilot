/**
 * Cost-Basis Lot Accounting — Issue #862
 *
 * Defines the domain model for transaction-lot cost-basis tracking and the
 * provenance record that captures *how* each lot was imported.
 *
 * A "lot" is the unit of tax-lot accounting: one acquisition event whose
 * cost-basis, quantity, and acquisition date are tracked independently so that
 * any disposal can be matched to the specific lots being released.
 *
 * Provenance captures the audit trail of *where the imported data came from*:
 * the source system, the import operator, the raw-file reference, and a
 * content checksum so tampering is detectable.
 */

// ── Provenance ──────────────────────────────────────────────────────────────

export type CostBasisSourceSystem =
  | "csv_upload"       // Manual CSV upload through the UI or API
  | "exchange_api"     // Direct pull from a connected exchange
  | "blockchain_scan"  // Derived from on-chain history
  | "manual_entry"     // Operator keyed in directly
  | "migration";       // Imported as part of a data-migration batch

export interface CostBasisProvenance {
  /** Identifies the originating system/channel. */
  sourceSystem: CostBasisSourceSystem;
  /**
   * Opaque reference into the source — e.g. S3 key, exchange job ID, or
   * migration batch name.  Absent for `manual_entry`.
   */
  sourceRef?: string;
  /**
   * SHA-256 hex of the raw import payload (file bytes for CSV, JSON body for
   * API imports). Lets auditors re-verify the bytes that produced this lot.
   * Absent when the input cannot be hashed (e.g. pure manual entry).
   */
  contentChecksum?: string;
  /** User-ID or service account that triggered the import. */
  importedBy: string;
  /** ISO-8601 timestamp of the import event (set by the service layer). */
  importedAt: string;
  /**
   * Free-text note the operator may attach at import time, e.g.
   * "Year-end reconciliation from Kraken CSV".
   */
  note?: string;
}

// ── Lot status ───────────────────────────────────────────────────────────────

export type LotStatus =
  | "open"       // Full quantity still held
  | "partial"    // Some quantity has been disposed of
  | "closed";    // Fully disposed of

// ── Cost-basis lot ───────────────────────────────────────────────────────────

export interface CostBasisLot {
  /** Stable UUID, assigned at import time. */
  id: string;
  /**
   * Account that holds (or held) the asset — a Stellar public key or an
   * external account identifier for off-chain assets.
   */
  accountId: string;
  /** Asset code, e.g. "XLM", "USDC". */
  assetCode: string;
  /**
   * Issuer public key for non-native assets.  Empty string for native XLM.
   */
  assetIssuer: string;
  /**
   * Total units acquired in this lot (decimal string, precision up to the
   * asset's native decimals — 7 for Stellar assets).
   */
  quantity: string;
  /**
   * Units of this lot not yet disposed of.  Starts equal to `quantity`;
   * decremented as disposals are matched to this lot.
   */
  remainingQuantity: string;
  /**
   * Acquisition cost per unit, denominated in `costCurrency` (decimal string).
   */
  unitCostBasis: string;
  /** Currency of `unitCostBasis`, e.g. "USD". */
  costCurrency: string;
  /**
   * The on-chain or exchange transaction ID that acquired this lot, if known.
   * For imported legacy data this may be absent.
   */
  acquisitionTxId?: string;
  /** ISO-8601 date/time of acquisition. */
  acquiredAt: string;
  status: LotStatus;
  /** Full provenance record — who imported this, from where, and when. */
  provenance: CostBasisProvenance;
  /** ISO-8601 timestamp when this record was created. */
  createdAt: string;
  /** ISO-8601 timestamp of the last mutation (partial/closed). */
  updatedAt: string;
}

// ── Import row (raw input) ───────────────────────────────────────────────────

/**
 * Shape of one row in an import payload before provenance is stamped.
 * Intentionally kept flat so CSV parsers and API handlers can map to it
 * without extra transformation.
 */
export interface CostBasisImportRow {
  accountId: string;
  assetCode: string;
  assetIssuer: string;
  quantity: string;
  unitCostBasis: string;
  costCurrency: string;
  acquiredAt: string;
  acquisitionTxId?: string;
}
