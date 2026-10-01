/**
 * Cost-Basis Import Service — Issue #862
 *
 * Accepts a batch of raw import rows, stamps each one with a provenance
 * record (source system, operator, timestamp, content checksum), validates
 * the fields, and returns the fully formed CostBasisLot objects ready for
 * persistence.
 *
 * This layer is deliberately persistence-agnostic: callers are responsible
 * for writing the returned lots to their storage of choice.  This keeps the
 * core logic unit-testable without a database.
 */

import crypto from "crypto";
import { CostBasisImportRow, CostBasisLot, CostBasisProvenance, CostBasisSourceSystem } from "./costBasis";

// ── Validation ───────────────────────────────────────────────────────────────

const POSITIVE_DECIMAL_RE = /^\d+(\.\d+)?$/;
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/;
const SUPPORTED_CURRENCIES = new Set(["USD", "EUR", "GBP", "XLM", "BTC", "USDC"]);

export class CostBasisImportValidationError extends Error {
  constructor(
    public readonly rowIndex: number,
    public readonly field: string,
    message: string,
  ) {
    super(`Row ${rowIndex}: field '${field}' — ${message}`);
    this.name = "CostBasisImportValidationError";
  }
}

function validateRow(row: CostBasisImportRow, index: number): void {
  if (!row.accountId || typeof row.accountId !== "string" || row.accountId.trim() === "") {
    throw new CostBasisImportValidationError(index, "accountId", "must be a non-empty string");
  }
  if (!row.assetCode || typeof row.assetCode !== "string" || row.assetCode.trim() === "") {
    throw new CostBasisImportValidationError(index, "assetCode", "must be a non-empty string");
  }
  if (typeof row.assetIssuer !== "string") {
    throw new CostBasisImportValidationError(index, "assetIssuer", "must be a string (empty for native XLM)");
  }
  if (!POSITIVE_DECIMAL_RE.test(row.quantity) || parseFloat(row.quantity) <= 0) {
    throw new CostBasisImportValidationError(index, "quantity", "must be a positive decimal number");
  }
  if (!POSITIVE_DECIMAL_RE.test(row.unitCostBasis) || parseFloat(row.unitCostBasis) < 0) {
    throw new CostBasisImportValidationError(index, "unitCostBasis", "must be a non-negative decimal number");
  }
  if (!SUPPORTED_CURRENCIES.has(row.costCurrency.toUpperCase())) {
    throw new CostBasisImportValidationError(
      index,
      "costCurrency",
      `unsupported currency '${row.costCurrency}'; supported: ${[...SUPPORTED_CURRENCIES].join(", ")}`,
    );
  }
  if (!ISO8601_RE.test(row.acquiredAt)) {
    throw new CostBasisImportValidationError(index, "acquiredAt", "must be an ISO-8601 date or datetime string");
  }
  // acquiredAt must not be a future date
  if (new Date(row.acquiredAt) > new Date()) {
    throw new CostBasisImportValidationError(index, "acquiredAt", "acquisition date must not be in the future");
  }
}

// ── Import options ────────────────────────────────────────────────────────────

export interface ImportOptions {
  /**
   * Identifies the source system that produced the import payload.
   */
  sourceSystem: CostBasisSourceSystem;
  /**
   * Opaque reference into the source (S3 key, exchange job ID, etc.).
   * Optional — absent for manual entry.
   */
  sourceRef?: string;
  /**
   * User-ID or service account performing the import.
   */
  importedBy: string;
  /**
   * Optional human-readable note attached to all lots in this batch.
   */
  note?: string;
  /**
   * Raw bytes of the original import payload.  When provided, a SHA-256
   * checksum is computed and stored in the provenance record so the bytes
   * that produced each lot can be re-verified by auditors.
   */
  rawPayload?: Buffer | string;
  /**
   * Override the import timestamp.  Defaults to `new Date()`.
   * Exposed for deterministic testing.
   */
  now?: Date;
  /**
   * Override the UUID generator.  Defaults to `crypto.randomUUID()`.
   * Exposed for deterministic testing.
   */
  idFactory?: () => string;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class CostBasisImportService {
  /**
   * Validate `rows`, stamp provenance, and return fully formed
   * `CostBasisLot` objects.
   *
   * Throws `CostBasisImportValidationError` on the first invalid row.
   * No lots are returned (and no IDs are consumed) when validation fails.
   */
  importLots(rows: CostBasisImportRow[], options: ImportOptions): CostBasisLot[] {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error("import payload must be a non-empty array of cost-basis rows");
    }

    // Validate all rows before producing any output so the call is atomic
    // from the caller's perspective — either everything is valid or nothing
    // is returned.
    rows.forEach((row, i) => validateRow(row, i));

    const now = options.now ?? new Date();
    const importedAt = now.toISOString();
    const idFactory = options.idFactory ?? (() => crypto.randomUUID());

    // Compute content checksum when the raw payload is provided.
    let contentChecksum: string | undefined;
    if (options.rawPayload !== undefined) {
      const bytes =
        typeof options.rawPayload === "string"
          ? Buffer.from(options.rawPayload, "utf8")
          : options.rawPayload;
      contentChecksum = crypto.createHash("sha256").update(bytes).digest("hex");
    }

    const provenance: CostBasisProvenance = {
      sourceSystem: options.sourceSystem,
      ...(options.sourceRef !== undefined ? { sourceRef: options.sourceRef } : {}),
      ...(contentChecksum !== undefined ? { contentChecksum } : {}),
      importedBy: options.importedBy,
      importedAt,
      ...(options.note !== undefined ? { note: options.note } : {}),
    };

    const createdAt = importedAt;

    return rows.map((row): CostBasisLot => ({
      id: idFactory(),
      accountId: row.accountId.trim(),
      assetCode: row.assetCode.trim().toUpperCase(),
      assetIssuer: row.assetIssuer.trim(),
      quantity: row.quantity,
      remainingQuantity: row.quantity,
      unitCostBasis: row.unitCostBasis,
      costCurrency: row.costCurrency.toUpperCase(),
      ...(row.acquisitionTxId !== undefined ? { acquisitionTxId: row.acquisitionTxId } : {}),
      acquiredAt: row.acquiredAt,
      status: "open",
      provenance,
      createdAt,
      updatedAt: createdAt,
    }));
  }
}

export const costBasisImportService = new CostBasisImportService();
