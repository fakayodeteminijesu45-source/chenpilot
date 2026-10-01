/**
 * Regression tests for portfolioReconciliation — Issue #863
 *
 * Covers:
 *  - Clean report → empty discrepancies
 *  - Balance mismatch DriftItem → discrepancy with explanation, values, repairHint
 *  - Transaction-missing DriftItem → discrepancy with explanation, no assetCode
 *  - Invariant-promoted drift items → enriched explanation from InvariantResult
 *  - attributableDifference and driftSources populated from InvariantResult
 *  - lagExceeded flag propagated from InvariantResult
 *  - repairHint surfaced only for PROVABLY_SAFE / CONDITIONALLY_SAFE
 *  - UNSAFE repair classification → repairHint is null
 *  - Severity sort order: critical → major → minor → none
 *  - Secondary sort by entityId when severity ties
 *  - Summary counts are accurate
 *  - lagRelated and withRepairHint counts
 *  - Error-status report preserved in view
 *  - Invariant result present but no matching drift item → not in discrepancies
 *  - DriftItem without invariantResults → explanation comes from description
 */

import {
  buildPortfolioReconciliationView,
  BalanceDiscrepancy,
  PortfolioReconciliationView,
} from "../portfolioReconciliation";
import {
  ReconciliationReport,
  DriftItem,
  ReconciliationScope,
} from "../../services/reconciliation.service";
import { InvariantResult } from "../../services/invariantEngine";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SCOPE: ReconciliationScope = { balances: true, walletAddress: "GABC1234" };
const NOW = "2025-06-01T12:00:00.000Z";

function makeReport(
  overrides: Partial<ReconciliationReport> = {},
): ReconciliationReport {
  return {
    id: "report-1",
    userId: "user-42",
    scope: SCOPE,
    startedAt: NOW,
    completedAt: NOW,
    driftItems: [],
    summary: { total: 0, critical: 0, major: 0, minor: 0, none: 0 },
    status: "clean",
    ...overrides,
  };
}

function makeDriftItem(overrides: Partial<DriftItem> = {}): DriftItem {
  return {
    type: "balance_mismatch",
    severity: "minor",
    entityId: "user-42:USDC",
    backendValue: "1000.000000",
    onChainValue: "997.000000",
    description: "Balance for USDC differs: DB=1000.000000, on-chain=997.000000 (diff=3.000000)",
    repairAction: "UPDATE wallet_balances SET balance = '997.000000' WHERE user_id = 'user-42' AND token = 'USDC'",
    detectedAt: NOW,
    ...overrides,
  };
}

function makeInvariantResult(overrides: Partial<InvariantResult> = {}): InvariantResult {
  return {
    invariantId: "ASSET_BALANCE_MATCH",
    invariantName: "Per-Asset Balance Match",
    category: "balance_integrity",
    holds: false,
    status: "failing",
    dataAvailable: true,
    expectedValue: "All 1 comparable asset balance(s) match on-chain",
    actualValue: "1 of 1 differ by 3.00000000",
    attributableDifference: "3.00000000 total across 1 asset(s)",
    lagExceeded: false,
    driftSources: ["USDC"],
    evaluatedAt: NOW,
    repairSafety: "CONDITIONALLY_SAFE",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildPortfolioReconciliationView", () => {
  describe("clean report", () => {
    it("returns empty discrepancies and zero summary counts", () => {
      const view = buildPortfolioReconciliationView(makeReport());
      expect(view.discrepancies).toHaveLength(0);
      expect(view.summary.total).toBe(0);
      expect(view.summary.critical).toBe(0);
      expect(view.summary.lagRelated).toBe(0);
      expect(view.summary.withRepairHint).toBe(0);
      expect(view.status).toBe("clean");
    });

    it("preserves reportId, userId, reconciledAt", () => {
      const view = buildPortfolioReconciliationView(makeReport());
      expect(view.reportId).toBe("report-1");
      expect(view.userId).toBe("user-42");
      expect(view.reconciledAt).toBe(NOW);
    });
  });

  describe("plain DriftItem — no invariantResults", () => {
    it("creates a discrepancy with explanation from description", () => {
      const report = makeReport({
        driftItems: [makeDriftItem()],
        status: "drifted",
      });
      const view = buildPortfolioReconciliationView(report);
      expect(view.discrepancies).toHaveLength(1);
      const d = view.discrepancies[0];
      expect(d.explanation).toBe(
        "Balance for USDC differs: DB=1000.000000, on-chain=997.000000 (diff=3.000000)",
      );
    });

    it("surfaces backendValue and onChainValue as strings", () => {
      const report = makeReport({ driftItems: [makeDriftItem()] });
      const d = view(report).discrepancies[0];
      expect(d.backendValue).toBe("1000.000000");
      expect(d.onChainValue).toBe("997.000000");
    });

    it("populates repairHint from repairAction", () => {
      const report = makeReport({ driftItems: [makeDriftItem()] });
      const d = view(report).discrepancies[0];
      expect(d.repairHint).toContain("UPDATE wallet_balances");
    });

    it("sets attributableDifference to null for plain drift items", () => {
      const report = makeReport({ driftItems: [makeDriftItem()] });
      const d = view(report).discrepancies[0];
      expect(d.attributableDifference).toBeNull();
    });

    it("driftSources is empty for plain drift items", () => {
      const report = makeReport({ driftItems: [makeDriftItem()] });
      const d = view(report).discrepancies[0];
      expect(d.driftSources).toHaveLength(0);
    });

    it("lagExceeded is false for plain drift items", () => {
      const report = makeReport({ driftItems: [makeDriftItem()] });
      const d = view(report).discrepancies[0];
      expect(d.lagExceeded).toBe(false);
    });

    it("transaction_missing item has null assetCode", () => {
      const item = makeDriftItem({
        type: "transaction_missing",
        entityId: "abcdef123456",
        description: "Transaction abcdef123456 not found on-chain",
        repairAction: undefined,
      });
      const report = makeReport({ driftItems: [item] });
      const d = view(report).discrepancies[0];
      // entityId has no colon separator, no drift sources → assetCode is null
      expect(d.assetCode).toBeNull();
    });

    it("null backendValue renders as dash", () => {
      const item = makeDriftItem({ backendValue: null });
      const report = makeReport({ driftItems: [item] });
      const d = view(report).discrepancies[0];
      expect(d.backendValue).toBe("—");
    });
  });

  describe("invariant-promoted DriftItem", () => {
    it("enriches explanation with invariant expected/actual/difference", () => {
      const driftItem = makeDriftItem({
        type: "balance_mismatch",
        severity: "major",
        entityId: "invariant:ASSET_BALANCE_MATCH",
        description: "[Invariant ASSET_BALANCE_MATCH] Per-Asset Balance Match: 3.00000000 total across 1 asset(s)",
        repairAction: undefined,
      });
      const ir = makeInvariantResult();
      const report = makeReport({
        driftItems: [driftItem],
        invariantResults: [ir],
        status: "drifted",
      });

      const d = view(report).discrepancies[0];
      expect(d.explanation).toContain("[Per-Asset Balance Match]");
      expect(d.explanation).toContain("Expected:");
      expect(d.explanation).toContain("Actual:");
      expect(d.explanation).toContain("Difference:");
    });

    it("populates attributableDifference from InvariantResult", () => {
      const driftItem = makeDriftItem({
        entityId: "invariant:ASSET_BALANCE_MATCH",
        repairAction: undefined,
      });
      const ir = makeInvariantResult();
      const report = makeReport({ driftItems: [driftItem], invariantResults: [ir] });
      const d = view(report).discrepancies[0];
      expect(d.attributableDifference).toBe("3.00000000 total across 1 asset(s)");
    });

    it("populates driftSources from InvariantResult", () => {
      const driftItem = makeDriftItem({ entityId: "invariant:ASSET_BALANCE_MATCH" });
      const ir = makeInvariantResult({ driftSources: ["USDC", "XLM"] });
      const report = makeReport({ driftItems: [driftItem], invariantResults: [ir] });
      const d = view(report).discrepancies[0];
      expect(d.driftSources).toEqual(["USDC", "XLM"]);
    });

    it("propagates lagExceeded from InvariantResult", () => {
      const driftItem = makeDriftItem({ entityId: "invariant:TX_COMPLETENESS" });
      const ir = makeInvariantResult({ invariantId: "TX_COMPLETENESS", lagExceeded: true });
      const report = makeReport({ driftItems: [driftItem], invariantResults: [ir] });
      const d = view(report).discrepancies[0];
      expect(d.lagExceeded).toBe(true);
    });

    it("CONDITIONALLY_SAFE repair → repairHint is populated", () => {
      const driftItem = makeDriftItem({
        entityId: "invariant:ASSET_BALANCE_MATCH",
        repairAction: undefined,
      });
      const ir = makeInvariantResult({ repairSafety: "CONDITIONALLY_SAFE" });
      const report = makeReport({ driftItems: [driftItem], invariantResults: [ir] });
      const d = view(report).discrepancies[0];
      expect(d.repairHint).not.toBeNull();
      expect(d.repairHint).toContain("USDC");
    });

    it("PROVABLY_SAFE repair → repairHint is populated", () => {
      const driftItem = makeDriftItem({
        entityId: "invariant:TX_COMPLETENESS",
        repairAction: undefined,
      });
      const ir = makeInvariantResult({
        invariantId: "TX_COMPLETENESS",
        invariantName: "Transaction Completeness",
        driftSources: ["tx-abc"],
        repairSafety: "PROVABLY_SAFE",
        attributableDifference: "1 missing + 0 status mismatch = 1",
      });
      const report = makeReport({ driftItems: [driftItem], invariantResults: [ir] });
      const d = view(report).discrepancies[0];
      expect(d.repairHint).not.toBeNull();
    });

    it("UNSAFE repair classification → repairHint is null", () => {
      const driftItem = makeDriftItem({
        entityId: "invariant:BALANCE_NON_NEGATIVITY",
        repairAction: undefined,
      });
      const ir = makeInvariantResult({
        invariantId: "BALANCE_NON_NEGATIVITY",
        repairSafety: "UNSAFE",
        driftSources: ["USDC"],
      });
      const report = makeReport({ driftItems: [driftItem], invariantResults: [ir] });
      const d = view(report).discrepancies[0];
      expect(d.repairHint).toBeNull();
    });

    it("attributableDifference is null when invariant reports '0'", () => {
      const driftItem = makeDriftItem({ entityId: "invariant:ASSET_BALANCE_MATCH" });
      const ir = makeInvariantResult({ attributableDifference: "0" });
      const report = makeReport({ driftItems: [driftItem], invariantResults: [ir] });
      const d = view(report).discrepancies[0];
      expect(d.attributableDifference).toBeNull();
    });

    it("unmatched invariant-prefixed entityId uses description as explanation", () => {
      // DriftItem with "invariant:" entityId but no matching InvariantResult
      const driftItem = makeDriftItem({
        entityId: "invariant:UNKNOWN_INVARIANT",
        description: "Fallback description",
      });
      const report = makeReport({ driftItems: [driftItem], invariantResults: [] });
      const d = view(report).discrepancies[0];
      expect(d.explanation).toBe("Fallback description");
    });
  });

  describe("sort order", () => {
    it("sorts critical before major before minor", () => {
      const report = makeReport({
        driftItems: [
          makeDriftItem({ severity: "minor", entityId: "A" }),
          makeDriftItem({ severity: "critical", entityId: "B" }),
          makeDriftItem({ severity: "major", entityId: "C" }),
        ],
      });
      const severities = view(report).discrepancies.map((d) => d.severity);
      expect(severities).toEqual(["critical", "major", "minor"]);
    });

    it("sorts alphabetically by entityId within same severity", () => {
      const report = makeReport({
        driftItems: [
          makeDriftItem({ severity: "major", entityId: "user-42:XLM" }),
          makeDriftItem({ severity: "major", entityId: "user-42:BTC" }),
          makeDriftItem({ severity: "major", entityId: "user-42:USDC" }),
        ],
      });
      const ids = view(report).discrepancies.map((d) => d.entityId);
      expect(ids).toEqual(["user-42:BTC", "user-42:USDC", "user-42:XLM"]);
    });
  });

  describe("summary counts", () => {
    it("counts by severity correctly", () => {
      const report = makeReport({
        driftItems: [
          makeDriftItem({ severity: "critical" }),
          makeDriftItem({ severity: "critical" }),
          makeDriftItem({ severity: "major" }),
          makeDriftItem({ severity: "minor" }),
        ],
      });
      const s = view(report).summary;
      expect(s.total).toBe(4);
      expect(s.critical).toBe(2);
      expect(s.major).toBe(1);
      expect(s.minor).toBe(1);
    });

    it("lagRelated counts discrepancies where lagExceeded is true", () => {
      const driftItem = makeDriftItem({ entityId: "invariant:TX_COMPLETENESS" });
      const ir = makeInvariantResult({
        invariantId: "TX_COMPLETENESS",
        lagExceeded: true,
      });
      const report = makeReport({
        driftItems: [driftItem, makeDriftItem({ entityId: "user-42:XLM" })],
        invariantResults: [ir],
      });
      expect(view(report).summary.lagRelated).toBe(1);
    });

    it("withRepairHint counts discrepancies where repairHint is not null", () => {
      const report = makeReport({
        driftItems: [
          makeDriftItem({ repairAction: "UPDATE ..." }),
          makeDriftItem({ repairAction: undefined }),
        ],
      });
      expect(view(report).summary.withRepairHint).toBe(1);
    });
  });

  describe("error-status report", () => {
    it("preserves error status and errorMessage in view", () => {
      const report = makeReport({
        status: "error",
        errorMessage: "Horizon unreachable",
        driftItems: [],
      });
      const v = view(report);
      expect(v.status).toBe("error");
      expect(v.errorMessage).toBe("Horizon unreachable");
      expect(v.discrepancies).toHaveLength(0);
    });
  });

  describe("invariantResults present but no matching drift items", () => {
    it("passing invariant results do not produce discrepancies", () => {
      const ir = makeInvariantResult({ status: "passing", holds: true });
      const report = makeReport({ driftItems: [], invariantResults: [ir] });
      expect(view(report).discrepancies).toHaveLength(0);
    });
  });

  describe("multiple concurrent discrepancies", () => {
    it("handles a mix of plain and invariant-promoted items", () => {
      const plainItem = makeDriftItem({
        entityId: "user-42:XLM",
        severity: "minor",
      });
      const invItem = makeDriftItem({
        entityId: "invariant:ASSET_BALANCE_MATCH",
        severity: "major",
        repairAction: undefined,
      });
      const ir = makeInvariantResult({ driftSources: ["USDC"] });
      const report = makeReport({
        driftItems: [plainItem, invItem],
        invariantResults: [ir],
        status: "drifted",
      });
      const v = view(report);
      expect(v.discrepancies).toHaveLength(2);
      // invariant item is major → comes first
      expect(v.discrepancies[0].entityId).toBe("invariant:ASSET_BALANCE_MATCH");
      expect(v.discrepancies[0].driftSources).toEqual(["USDC"]);
      expect(v.discrepancies[1].entityId).toBe("user-42:XLM");
    });
  });
});

// ── Convenience wrapper ───────────────────────────────────────────────────────

function view(report: ReconciliationReport): PortfolioReconciliationView {
  return buildPortfolioReconciliationView(report);
}
