/**
 * Portfolio Reconciliation View — Issue #863
 *
 * Projects a `ReconciliationReport` (from `reconciliation.service.ts`) into a
 * portfolio-facing presentation that surfaces balance discrepancies alongside
 * their human-readable explanations, values, and suggested repair actions.
 *
 * Motivation
 * ──────────
 * `ReconciliationReport.driftItems` already carries `description`,
 * `repairAction`, `backendValue`, and `onChainValue` for every discrepancy,
 * and `invariantResults` carries per-invariant `expectedValue`, `actualValue`,
 * `attributableDifference`, and `driftSources`.  However, a portfolio consumer
 * must currently understand the internal `DriftItem` / `InvariantResult` types
 * to extract that context.  This module flattens both sources into a
 * presentation-ready shape without duplicating any engine logic.
 *
 * Public API
 * ──────────
 * `buildPortfolioReconciliationView(report)` — the single entry point.
 * All other exports are the types that make up the view.
 */

import {
  ReconciliationReport,
  DriftItem,
  DriftSeverity,
} from "../services/reconciliation.service";
import { InvariantResult } from "../services/invariantEngine";

// ── Presentation types ────────────────────────────────────────────────────────

/**
 * A single balance discrepancy enriched with an explanation and optional
 * repair hint, ready for display in a portfolio UI or API response.
 */
export interface BalanceDiscrepancy {
  /** Stable identifier for the discrepancy (entityId from the source record). */
  entityId: string;
  /**
   * Asset code involved, e.g. "XLM", "USDC".
   * Derived from the entityId or drift source when available.
   */
  assetCode: string | null;
  /** Severity of the discrepancy. */
  severity: DriftSeverity;
  /** Value recorded in the backend (DB cache). */
  backendValue: string;
  /** Value observed on-chain (authoritative source). */
  onChainValue: string;
  /**
   * Human-readable explanation of what differs and why it matters.
   * Sourced from `DriftItem.description` or the invariant's
   * `expectedValue` / `actualValue` / `attributableDifference` fields.
   */
  explanation: string;
  /**
   * The minimal numeric or descriptive delta that explains the breach,
   * e.g. "3.00000000 total across 1 asset(s)".
   * null when the discrepancy originates from a drift item without a
   * structured delta (e.g. transaction status mismatches).
   */
  attributableDifference: string | null;
  /**
   * Specific entities contributing to the discrepancy — asset codes,
   * transaction hashes, operation IDs, etc.
   */
  driftSources: string[];
  /**
   * Suggested repair action, if one is known and safe to suggest.
   * null when the repair classification is UNSAFE or no action is known.
   */
  repairHint: string | null;
  /**
   * Whether data lag contributed to or caused this discrepancy.
   * When true, the data may be stale rather than genuinely inconsistent.
   */
  lagExceeded: boolean;
  /** ISO-8601 timestamp when the discrepancy was detected. */
  detectedAt: string;
}

/**
 * Portfolio-facing reconciliation view.  Combines balance discrepancies,
 * explanations, and an aggregate summary into a single coherent shape.
 */
export interface PortfolioReconciliationView {
  /** Report ID from the underlying `ReconciliationReport`. */
  reportId: string;
  /** User this view belongs to. */
  userId: string;
  /** ISO-8601 timestamp when the reconciliation ran. */
  reconciledAt: string;
  /** Overall status of this reconciliation run. */
  status: ReconciliationReport["status"];
  /** If the reconciliation itself errored, the error message. */
  errorMessage: string | undefined;
  /**
   * Balance discrepancies, sorted by severity (critical → major → minor → none)
   * then by entityId for stable ordering.
   */
  discrepancies: BalanceDiscrepancy[];
  /** Aggregate counts for quick summary display. */
  summary: {
    total: number;
    critical: number;
    major: number;
    minor: number;
    /** Number of discrepancies that may be explained by data lag. */
    lagRelated: number;
    /** Number of discrepancies with a safe repair hint. */
    withRepairHint: number;
  };
}

// ── Severity ordering ────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<DriftSeverity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  none: 3,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Extract a likely asset code from an entityId.
 *
 * Common formats produced by the reconciliation engine:
 *   - "<userId>:<token>"  → "token"
 *   - "invariant:<invariantId>" → null (not an asset)
 *   - bare asset code   → returned as-is
 */
function extractAssetCode(entityId: string, driftSources: string[]): string | null {
  if (driftSources.length > 0) {
    // If all drift sources look like asset codes (short, uppercase), use the first.
    const first = driftSources[0];
    if (/^[A-Z0-9]{1,12}$/.test(first)) return first;
  }

  // entityId format "<userId>:<token>"
  const colonIdx = entityId.indexOf(":");
  if (colonIdx !== -1) {
    const tail = entityId.slice(colonIdx + 1);
    // Exclude invariant pseudo-IDs
    if (!tail.startsWith("invariant:") && /^[A-Z0-9_]{1,50}$/.test(tail.toUpperCase())) {
      return tail;
    }
  }

  return null;
}

/**
 * Build a `BalanceDiscrepancy` from a plain `DriftItem`.
 *
 * Drift items do not carry `attributableDifference` or `driftSources`
 * directly — those live on `InvariantResult` when the item was promoted
 * from an invariant evaluation.  For non-invariant drift items we derive
 * what we can from the description and entity ID.
 */
function discrepancyFromDriftItem(item: DriftItem): BalanceDiscrepancy {
  const entityId = item.entityId;
  const isInvariantItem = entityId.startsWith("invariant:");

  let explanation = item.description;
  let attributableDifference: string | null = null;
  let driftSources: string[] = [];
  let assetCode: string | null = null;

  if (!isInvariantItem) {
    // For balance_mismatch items the entityId is "<userId>:<token>"
    assetCode = extractAssetCode(entityId, []);
  }

  // repairAction is UNSAFE for balance non-negativity and coverage items;
  // only surface it when the item has an explicit SQL-style repair action
  // (i.e. comes from a PROVABLY_SAFE or CONDITIONALLY_SAFE check).
  const repairHint = item.repairAction ?? null;

  return {
    entityId,
    assetCode,
    severity: item.severity,
    backendValue: stringify(item.backendValue),
    onChainValue: stringify(item.onChainValue),
    explanation,
    attributableDifference,
    driftSources,
    repairHint,
    lagExceeded: false,
    detectedAt: item.detectedAt,
  };
}

/**
 * Merge richer invariant-result data into an already-constructed
 * `BalanceDiscrepancy`.  When an invariant evaluation is available for
 * the same entity, it fills in `attributableDifference`, `driftSources`,
 * `lagExceeded`, and a richer `explanation`.
 */
function mergeInvariantResult(
  disc: BalanceDiscrepancy,
  ir: InvariantResult,
): BalanceDiscrepancy {
  const explanation =
    `[${ir.invariantName}] ` +
    `Expected: ${ir.expectedValue}. ` +
    `Actual: ${ir.actualValue}. ` +
    (ir.attributableDifference !== "0"
      ? `Difference: ${ir.attributableDifference}.`
      : "No numeric difference.");

  const assetCode =
    ir.driftSources.length > 0
      ? extractAssetCode(disc.entityId, ir.driftSources)
      : disc.assetCode;

  // Only surface a repair hint for safe classifications
  const repairHint =
    ir.repairSafety === "PROVABLY_SAFE" || ir.repairSafety === "CONDITIONALLY_SAFE"
      ? (disc.repairHint ?? `Review ${ir.invariantName} for entities: ${ir.driftSources.join(", ")}`)
      : null;

  return {
    ...disc,
    assetCode,
    explanation,
    attributableDifference:
      ir.attributableDifference !== "0" ? ir.attributableDifference : null,
    driftSources: ir.driftSources,
    lagExceeded: ir.lagExceeded,
    repairHint,
  };
}

// ── Main presenter ────────────────────────────────────────────────────────────

/**
 * Build a portfolio-facing reconciliation view from a `ReconciliationReport`.
 *
 * Behaviour
 * ─────────
 * 1. Every `DriftItem` in `report.driftItems` becomes a `BalanceDiscrepancy`.
 * 2. When `report.invariantResults` are present, invariant-promoted drift items
 *    (`entityId` starts with `"invariant:"`) are enriched with the matching
 *    `InvariantResult`'s explanation fields.
 * 3. The result is sorted by severity then entityId.
 * 4. No data is fabricated — all values come directly from the report.
 */
export function buildPortfolioReconciliationView(
  report: ReconciliationReport,
): PortfolioReconciliationView {
  // Build a lookup from invariant ID → InvariantResult for O(1) merge
  const invariantById = new Map<string, InvariantResult>();
  if (report.invariantResults) {
    for (const ir of report.invariantResults) {
      invariantById.set(ir.invariantId, ir);
    }
  }

  const discrepancies: BalanceDiscrepancy[] = report.driftItems.map((item) => {
    const disc = discrepancyFromDriftItem(item);

    // Invariant-promoted items have entityId "invariant:<invariantId>"
    if (item.entityId.startsWith("invariant:")) {
      const invariantId = item.entityId.slice("invariant:".length);
      const ir = invariantById.get(invariantId);
      if (ir) {
        return mergeInvariantResult(disc, ir);
      }
    }

    return disc;
  });

  // Stable sort: severity DESC, then entityId ASC
  discrepancies.sort((a, b) => {
    const severityDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severityDiff !== 0) return severityDiff;
    return a.entityId.localeCompare(b.entityId);
  });

  const lagRelated = discrepancies.filter((d) => d.lagExceeded).length;
  const withRepairHint = discrepancies.filter((d) => d.repairHint !== null).length;

  return {
    reportId: report.id,
    userId: report.userId,
    reconciledAt: report.completedAt,
    status: report.status,
    errorMessage: report.errorMessage,
    discrepancies,
    summary: {
      total: discrepancies.length,
      critical: discrepancies.filter((d) => d.severity === "critical").length,
      major: discrepancies.filter((d) => d.severity === "major").length,
      minor: discrepancies.filter((d) => d.severity === "minor").length,
      lagRelated,
      withRepairHint,
    },
  };
}
