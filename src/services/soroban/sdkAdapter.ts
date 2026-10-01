/**
 * SDK compatibility adapter.
 *
 * The @stellar/stellar-sdk has changed its namespace layout across versions.
 * All SDK surface-area access is centralised here so the rest of the subsystem
 * never imports from stellar-sdk directly and never has to deal with version
 * detection logic.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { SdkInitError } from "./errors";

export type SorobanNetwork = "testnet" | "mainnet";

// ─── Network constants ────────────────────────────────────────────────────────

export const DEFAULT_RPC_URLS: Record<SorobanNetwork, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://soroban-mainnet.stellar.org",
};

export const NETWORK_PASSPHRASES: Record<SorobanNetwork, string> = {
  testnet:
    (StellarSdk.Networks as Record<string, string>)?.TESTNET ??
    "Test SDF Network ; September 2015",
  mainnet:
    (StellarSdk.Networks as Record<string, string>)?.PUBLIC ??
    "Public Global Stellar Network ; September 2015",
};

// ─── RPC server factory ───────────────────────────────────────────────────────

export interface RpcServer {
  simulateTransaction(tx: StellarSdk.Transaction): Promise<unknown>;
  getLatestLedger(): Promise<{ sequence: number }>;
  getLedgerEntries(...keys: StellarSdk.xdr.LedgerKey[]): Promise<{
    entries: Array<{ liveUntilLedgerSeq?: number }>;
  }>;
}

/**
 * Build an RPC server instance, trying the current SDK namespace first and
 * falling back to the legacy layout.
 */
export function buildRpcServer(rpcUrl: string): RpcServer {
  const sdk = StellarSdk as unknown as Record<string, unknown>;

  // Current SDK: StellarSdk.SorobanRpc.Server
  if (
    sdk["SorobanRpc"] &&
    typeof (sdk["SorobanRpc"] as Record<string, unknown>)["Server"] ===
      "function"
  ) {
    const Ctor = (sdk["SorobanRpc"] as Record<string, unknown>)[
      "Server"
    ] as new (url: string, opts?: { allowHttp?: boolean }) => RpcServer;
    return new Ctor(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  }

  // Older SDK: StellarSdk.Soroban.Server
  if (
    sdk["Soroban"] &&
    typeof (sdk["Soroban"] as Record<string, unknown>)["Server"] === "function"
  ) {
    const Ctor = (sdk["Soroban"] as Record<string, unknown>)["Server"] as new (
      url: string,
      opts?: { allowHttp?: boolean }
    ) => RpcServer;
    return new Ctor(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  }

  throw new SdkInitError(
    `Cannot locate SorobanRpc.Server in the installed stellar-sdk. ` +
      `Ensure @stellar/stellar-sdk ≥ 11 is installed.`
  );
}

// ─── Simulation result type guards ───────────────────────────────────────────

export interface SimulationSuccess {
  result?: { retval?: unknown; auth?: unknown[] };
  minResourceFee?: string;
  transactionData?: {
    build(): { resources(): { instructions(): bigint; readBytes(): bigint } };
    toXDR(): string;
  };
}

export interface SimulationFailure {
  error: string;
}

/**
 * A simulation that succeeded only because the node assumed the required
 * ledger entries were present. The accompanying `restorePreamble` describes
 * the transaction that must be submitted first to actually restore them.
 */
export interface SimulationRestore {
  restorePreamble: {
    minResourceFee?: string;
    transactionData?: unknown;
  };
}

/**
 * Resolve the SDK's `Api` namespace.
 *
 * The installed SDK exposes it as `rpc.Api`; older layouts used
 * `SorobanRpc.Api`. Both are checked so the type guards below can delegate to
 * the SDK rather than relying only on duck-typing.
 */
function resolveApiNamespace(): Record<string, unknown> | undefined {
  const sdk = StellarSdk as unknown as Record<string, unknown>;
  for (const nsName of ["SorobanRpc", "rpc"]) {
    const ns = sdk[nsName] as Record<string, unknown> | undefined;
    const api = ns?.["Api"] as Record<string, unknown> | undefined;
    if (api) return api;
  }
  return undefined;
}

export function isSimulationError(sim: unknown): sim is SimulationFailure {
  const api = resolveApiNamespace();

  if (api?.["isSimulationError"]) {
    return (api["isSimulationError"] as (s: unknown) => boolean)(sim);
  }
  // Fallback: duck-type
  return typeof (sim as Record<string, unknown>)?.["error"] === "string";
}

export function isSimulationSuccess(sim: unknown): sim is SimulationSuccess {
  const api = resolveApiNamespace();

  if (api?.["isSimulationSuccess"]) {
    return (api["isSimulationSuccess"] as (s: unknown) => boolean)(sim);
  }
  // Fallback: duck-type
  const s = sim as Record<string, unknown>;
  return (
    !s?.["error"] &&
    (s?.["result"] !== undefined || s?.["minResourceFee"] !== undefined)
  );
}

/**
 * Return true when the simulation succeeded but its footprint includes ledger
 * entries that have expired and must be restored before the real transaction
 * can be submitted.
 *
 * This is neither an error nor a plain success: the RPC executed the call "as
 * if" the entries existed. Callers that ignore it will assemble and submit a
 * transaction the network will reject, so it is surfaced as its own outcome
 * rather than folded into the success or error path.
 */
export function isSimulationRestore(
  sim: unknown
): sim is SimulationRestore & SimulationSuccess {
  const api = resolveApiNamespace();

  if (api?.["isSimulationRestore"]) {
    // The SDK's guard dereferences `restorePreamble.transactionData` without
    // a null check and throws on a malformed response. Route a null preamble
    // to the local check rather than propagating that TypeError.
    const preamble = (sim as Record<string, unknown> | undefined)?.[
      "restorePreamble"
    ];
    if (preamble === null || preamble === undefined) return false;
    return (api["isSimulationRestore"] as (s: unknown) => boolean)(sim);
  }
  // Fallback: duck-type, mirroring the SDK's own guard — a success that
  // carries a preamble with its own transactionData. Requiring the preamble's
  // transactionData matters: a response with a preamble but no restore
  // payload carries nothing actionable and is not a restore case.
  const s = sim as Record<string, unknown>;
  const preamble = s?.["restorePreamble"] as
    | Record<string, unknown>
    | undefined;
  return (
    isSimulationSuccess(sim) &&
    !!preamble &&
    typeof preamble === "object" &&
    !!preamble["transactionData"]
  );
}

// ─── ScVal helpers ────────────────────────────────────────────────────────────

/**
 * Convert a native JS value to an ScVal, using the SDK helper when available.
 */
export function nativeToScVal(value: unknown): unknown {
  if (typeof StellarSdk.nativeToScVal === "function") {
    return StellarSdk.nativeToScVal(value as never);
  }
  return value;
}

/**
 * Convert an ScVal to a native JS value.
 */
export function scValToNative(scVal: unknown): unknown {
  if (typeof StellarSdk.scValToNative === "function") {
    return StellarSdk.scValToNative(scVal as never);
  }
  return scVal;
}

/**
 * Return true if the value looks like an already-constructed ScVal.
 */
export function isScVal(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return "switch" in (value as Record<string, unknown>);
}

// ─── Misc re-exports ──────────────────────────────────────────────────────────

export { StellarSdk };

export function resolveRpcUrl(
  network: SorobanNetwork,
  override?: string
): string {
  if (override) return override;
  if (network === "testnet") {
    return process.env.SOROBAN_RPC_URL_TESTNET ?? DEFAULT_RPC_URLS.testnet;
  }
  return process.env.SOROBAN_RPC_URL_MAINNET ?? DEFAULT_RPC_URLS.mainnet;
}
