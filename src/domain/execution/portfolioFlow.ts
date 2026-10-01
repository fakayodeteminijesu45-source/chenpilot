/**
 * Portfolio Net Transfer Flow Reconciliation (#857)
 *
 * Reconciles a portfolio's net transfer flow for a window against the net flow
 * observed on the ledger/statement. Gross inflows and gross outflows are kept
 * separate from each explicitly-tracked fee component — base fee, priority
 * (inclusion-bump) fee, network fee, and contract (Soroban resource) fee — so a
 * fee change that preserves the aggregate total is still individually
 * attributable instead of being collapsed into a single amount.
 *
 * Scope: this module is deliberately limited to *flow accounting*. It does not
 * re-implement the invariant reconciliation engine (`invariantEngine`) nor the
 * execution cost-limit enforcement (`costComponents`); it reuses the canonical
 * fixed-precision arithmetic in `common/fixedPoint` and consumes the existing
 * decomposed execution cost model (`CostComponentValues`) through
 * {@link transferFeesFromCostComponents}.
 *
 * Identity reconciled here:
 *   netFlow = grossInflow - grossOutflow
 *             - (baseFee + priorityFee + networkFee + contractFee)
 */

import {
  addDecimals,
  parseScaled,
  serializeScaled,
  subtractDecimals,
} from '../common/fixedPoint';
import type { CostComponentValues } from '../quotes/costComponents';

/** Default precision (Stellar assets use 7 decimals). */
const DEFAULT_DECIMALS = 7;

/**
 * Explicit, independently-tracked fee buckets for one transfer-flow window.
 *
 * Every component is a non-negative canonical decimal string in the flow
 * asset's units. `baseFee` and `priorityFee` carry the split of the inclusion
 * fee when the caller has it; `networkFee` carries the aggregate network fee
 * when only that is known (leave `baseFee`/`priorityFee` at `"0"` for that
 * portion to avoid double counting). `contractFee` carries the Soroban resource
 * fee. Buckets are summed, never overwritten.
 */
export interface TransferFeeComponents {
  /** Stellar base inclusion fee for the window. */
  baseFee: string;
  /** Priority / fee-bump premium above the base inclusion fee. */
  priorityFee: string;
  /** Aggregate network fee when the base/bump split is unavailable. */
  networkFee: string;
  /** Soroban contract resource fee. */
  contractFee: string;
}

/** Aggregated transfer activity for a single asset over a reconciliation window. */
export interface TransferFlowWindow {
  /** Total value transferred into the portfolio (non-negative). */
  grossInflow: string;
  /** Total value transferred out of the portfolio (non-negative). */
  grossOutflow: string;
  /** Explicit fee buckets charged against the window. */
  fees: TransferFeeComponents;
}

/** Decomposed net-flow result for a window. */
export interface NetTransferFlow {
  grossInflow: string;
  grossOutflow: string;
  feeBreakdown: TransferFeeComponents;
  /** Exact sum of all explicit fee components. */
  totalFees: string;
  /** grossInflow - grossOutflow - totalFees. */
  netFlow: string;
}

/** Reconciliation verdict, mirroring the invariant engine's tri-state result. */
export type FlowReconciliationStatus = 'reconciled' | 'drift' | 'indeterminate';

/** Result of comparing the derived net flow against the observed net flow. */
export interface NetTransferFlowReconciliation {
  status: FlowReconciliationStatus;
  /** Net flow derived from gross flows and explicit fee components. */
  expectedNetFlow: string;
  /** Observed net flow, or null when it was unavailable. */
  reportedNetFlow: string | null;
  /**
   * expectedNetFlow - reportedNetFlow. `"N/A — reported net flow unavailable"`
   * when the observed value is missing (never treat missing data as reconciled).
   */
  attributableDifference: string;
  feeBreakdown: TransferFeeComponents;
  totalFees: string;
  dataAvailable: boolean;
}

export interface ReconcileNetTransferFlowOptions {
  /** Precision used for every amount. Defaults to 7 (Stellar). */
  decimals?: number;
  /** Absolute difference tolerated before reporting drift. Default `"0"`. */
  tolerance?: string;
}

/** Parse an amount and require it to be non-negative at `decimals`. */
function requireNonNegative(value: string, label: string, decimals: number): bigint {
  const units = parseScaled(value, decimals);
  if (units < 0n) {
    throw new Error(`${label} must be non-negative, got "${value}"`);
  }
  return units;
}

/**
 * Sum every explicit fee component exactly. Throws on a negative or
 * over-precision component so a malformed fee can never silently reduce the
 * reconciled net flow.
 */
export function sumFeeComponents(
  fees: TransferFeeComponents,
  decimals: number = DEFAULT_DECIMALS
): string {
  const components: Array<[string, string]> = [
    ['baseFee', fees.baseFee],
    ['priorityFee', fees.priorityFee],
    ['networkFee', fees.networkFee],
    ['contractFee', fees.contractFee],
  ];

  let total = 0n;
  for (const [label, value] of components) {
    const units = requireNonNegative(value ?? '0', `fee component "${label}"`, decimals);
    total = addDecimals(total, decimals, units, decimals, decimals);
  }
  return serializeScaled(total, decimals);
}

/**
 * Derive the decomposed net transfer flow for a window. No amount is ever
 * routed through JavaScript's floating-point `number` type.
 */
export function computeNetTransferFlow(
  window: TransferFlowWindow,
  options: ReconcileNetTransferFlowOptions = {}
): NetTransferFlow {
  const decimals = options.decimals ?? DEFAULT_DECIMALS;

  const grossInflow = serializeScaled(
    requireNonNegative(window.grossInflow, 'grossInflow', decimals),
    decimals
  );
  const grossOutflow = serializeScaled(
    requireNonNegative(window.grossOutflow, 'grossOutflow', decimals),
    decimals
  );
  const totalFees = sumFeeComponents(window.fees, decimals);

  const netFlow = subtractDecimals(
    subtractDecimals(
      parseScaled(grossInflow, decimals),
      decimals,
      parseScaled(grossOutflow, decimals),
      decimals,
      decimals
    ),
    decimals,
    parseScaled(totalFees, decimals),
    decimals,
    decimals
  );

  return {
    grossInflow,
    grossOutflow,
    feeBreakdown: { ...window.fees },
    totalFees,
    netFlow: serializeScaled(netFlow, decimals),
  };
}

/**
 * Reconcile the derived net flow against the observed net flow.
 *
 * - `reconciled`: the difference is within `tolerance` (default exact).
 * - `drift`:      the difference exceeds `tolerance`; the difference is
 *                 attributable to the explicit fee components.
 * - `indeterminate`: the observed net flow was not supplied. Missing data is
 *                 never treated as a pass.
 */
export function reconcileNetTransferFlow(
  window: TransferFlowWindow,
  reportedNetFlow: string | null | undefined,
  options: ReconcileNetTransferFlowOptions = {}
): NetTransferFlowReconciliation {
  const decimals = options.decimals ?? DEFAULT_DECIMALS;
  const flow = computeNetTransferFlow(window, { decimals });

  const unavailable =
    reportedNetFlow === null ||
    reportedNetFlow === undefined ||
    reportedNetFlow.trim() === '';

  if (unavailable) {
    return {
      status: 'indeterminate',
      expectedNetFlow: flow.netFlow,
      reportedNetFlow: null,
      attributableDifference: 'N/A — reported net flow unavailable',
      feeBreakdown: flow.feeBreakdown,
      totalFees: flow.totalFees,
      dataAvailable: false,
    };
  }

  const reported = parseScaled(reportedNetFlow, decimals);
  const expected = parseScaled(flow.netFlow, decimals);
  const difference = subtractDecimals(expected, decimals, reported, decimals, decimals);
  const tolerance = requireNonNegative(
    options.tolerance ?? '0',
    'tolerance',
    decimals
  );
  const absoluteDifference = difference < 0n ? -difference : difference;

  return {
    status: absoluteDifference <= tolerance ? 'reconciled' : 'drift',
    expectedNetFlow: flow.netFlow,
    reportedNetFlow: serializeScaled(reported, decimals),
    attributableDifference: serializeScaled(difference, decimals),
    feeBreakdown: flow.feeBreakdown,
    totalFees: flow.totalFees,
    dataAvailable: true,
  };
}

/**
 * Bridge from the existing decomposed execution cost model (`CostComponentValues`)
 * into the flow fee buckets, so portfolio flow accounting reuses the quote
 * model instead of defining a second one.
 *
 * The quote model's `networkFee` already aggregates base + bump, and its
 * `protocolFee` is the fee retained by the protocol/contract. They map to the
 * aggregate network bucket and the contract bucket respectively; the `baseFee` /
 * `priorityFee` sub-buckets stay `"0"` because the quote model does not carry
 * that split — fabricating it would double count.
 */
export function transferFeesFromCostComponents(
  costs: CostComponentValues
): TransferFeeComponents {
  return {
    baseFee: '0',
    priorityFee: '0',
    networkFee: costs.networkFee || '0',
    contractFee: costs.protocolFee || '0',
  };
}
