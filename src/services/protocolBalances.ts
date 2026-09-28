/**
 * Withdrawable protocol balance accounting (Issue #853).
 *
 * The Stellar protocol holds back part of an account's balance:
 *
 *  - the minimum XLM reserve for the account itself and for every subentry
 *    (trustline, offer, data entry, signer, ...),
 *  - `selling_liabilities` already committed to open offers,
 *  - and issued-asset trustlines the issuer has not authorised.
 *
 * Those amounts are part of the account's gross deposits but cannot be
 * withdrawn until the protocol releases them, so portfolio reporting must keep
 * them out of the withdrawable total. This module is intentionally free of
 * runtime dependencies so the accounting can be unit-tested in isolation.
 */

/** Base reserve in XLM. 0.5 XLM on both testnet and public at the time of writing. */
export const DEFAULT_BASE_RESERVE_XLM = 0.5;

/** Reason a balance (or part of it) is not withdrawable. */
export type LockReason =
  | "minimum-reserve"
  | "selling-liabilities"
  | "trustline-frozen";

/** Account-level data needed to derive the minimum reserve. */
export interface ProtocolAccountContext {
  /** Base reserve of the network, in XLM. Defaults to DEFAULT_BASE_RESERVE_XLM. */
  baseReserveXlm?: number;
  /** Number of subentries (trustlines, offers, data entries, ...) on the account. */
  subentryCount?: number;
  /** Subentries this account sponsors — each adds one base reserve. */
  numSponsoring?: number;
  /** Subentries sponsored by someone else — each removes one base reserve. */
  numSponsored?: number;
}

/** A single Horizon balance line, reduced to the fields the accounting needs. */
export interface ProtocolBalanceInput {
  code: string;
  issuer: string;
  /** Gross balance in the asset's own units. */
  amount: number;
  isNative: boolean;
  /** Amount committed to open offers, in the asset's own units. */
  sellingLiabilities?: number;
  /** Issued assets only: `false` when the trustline is frozen. Undefined means authorised. */
  authorized?: boolean;
}

/** Gross / locked / withdrawable split for a single asset. */
export interface ProtocolBalanceBreakdown {
  code: string;
  issuer: string;
  /** Gross amount held on the account. */
  total: number;
  /** Amount the protocol will not release right now. */
  locked: number;
  /** Amount withdrawable right now. Always `total - locked`. */
  withdrawable: number;
  lockedReasons: LockReason[];
}

/** A priced balance used to aggregate portfolio-level totals. */
export interface PricedWithdrawableInput {
  /** Gross amount in the asset's own units. */
  total: number;
  /** Withdrawable amount in the asset's own units. */
  withdrawable: number;
  /** Value of the gross amount in the target currency, or null when unpriced. */
  valueInCurrency: number | null;
}

/** Portfolio-level split between total deposits and withdrawable value. */
export interface WithdrawableTotals {
  /** Gross value of every priced balance (the total deposits). */
  totalDeposits: number | null;
  /** Value that can be withdrawn right now. */
  withdrawable: number | null;
  /** Value held back by protocol locks. */
  locked: number | null;
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const parsed =
    typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNonNegativeInt(value: unknown): number {
  return Math.max(0, Math.trunc(toFiniteNumber(value)));
}

/**
 * Minimum XLM reserve for an account: two base reserves for the account itself
 * plus one base reserve per subentry, adjusted for sponsorships.
 */
export function minimumReserveXlm(
  context: ProtocolAccountContext = {}
): number {
  const baseReserve = toFiniteNumber(
    context.baseReserveXlm,
    DEFAULT_BASE_RESERVE_XLM
  );
  const reserveUnits =
    2 +
    toNonNegativeInt(context.subentryCount) +
    toNonNegativeInt(context.numSponsoring) -
    toNonNegativeInt(context.numSponsored);

  return Math.max(0, reserveUnits) * baseReserve;
}

/**
 * Split a single balance into its locked and withdrawable parts. The amount is
 * never double counted: `locked + withdrawable === total`.
 */
export function computeProtocolBalance(
  input: ProtocolBalanceInput,
  context: ProtocolAccountContext = {}
): ProtocolBalanceBreakdown {
  const total = Math.max(0, toFiniteNumber(input.amount));

  if (total === 0) {
    return {
      code: input.code,
      issuer: input.issuer,
      total: 0,
      locked: 0,
      withdrawable: 0,
      lockedReasons: [],
    };
  }

  if (!input.isNative && input.authorized === false) {
    // A frozen trustline cannot move the asset at all.
    return {
      code: input.code,
      issuer: input.issuer,
      total,
      locked: total,
      withdrawable: 0,
      lockedReasons: ["trustline-frozen"],
    };
  }

  const lockedReasons: LockReason[] = [];
  let locked = 0;

  if (input.isNative) {
    const reserve = minimumReserveXlm(context);
    if (reserve > 0) {
      locked += reserve;
      lockedReasons.push("minimum-reserve");
    }
  }

  const sellingLiabilities = Math.max(
    0,
    toFiniteNumber(input.sellingLiabilities)
  );
  if (sellingLiabilities > 0) {
    locked += sellingLiabilities;
    lockedReasons.push("selling-liabilities");
  }

  locked = Math.min(total, locked);

  return {
    code: input.code,
    issuer: input.issuer,
    total,
    locked,
    withdrawable: total - locked,
    lockedReasons,
  };
}

/**
 * Aggregate per-asset breakdowns into portfolio-level totals. Assets without a
 * resolved price are ignored, matching the existing `totalValue` semantics; the
 * withdrawable share of a priced asset scales with the withdrawable ratio.
 */
export function aggregateWithdrawableTotals(
  assets: PricedWithdrawableInput[]
): WithdrawableTotals {
  const priced = assets.filter((asset) => asset.valueInCurrency !== null);

  if (priced.length === 0) {
    return { totalDeposits: null, withdrawable: null, locked: null };
  }

  let totalDeposits = 0;
  let withdrawable = 0;

  for (const asset of priced) {
    const value = asset.valueInCurrency as number;
    const ratio = asset.total > 0 ? asset.withdrawable / asset.total : 0;
    totalDeposits += value;
    withdrawable += value * ratio;
  }

  return {
    totalDeposits,
    withdrawable,
    locked: totalDeposits - withdrawable,
  };
}
