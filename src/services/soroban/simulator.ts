/**
 * Pure simulation layer.
 *
 * Responsible for:
 *  - Building an unsigned transaction envelope from contract call parameters
 *  - Submitting it to the RPC simulateTransaction endpoint
 *  - Returning the raw simulation result (success, error, or restore-required)
 *    without decoding
 *
 * This layer has no knowledge of signing, decoding, or invocation orchestration.
 */

import {
  StellarSdk,
  SorobanNetwork,
  NETWORK_PASSPHRASES,
  buildRpcServer,
  resolveRpcUrl,
  isSimulationError,
  isSimulationSuccess,
  isSimulationRestore,
  nativeToScVal,
  isScVal,
  SimulationSuccess,
} from "./sdkAdapter";
import {
  InvalidParamsError,
  SimulationError,
  SimulationErrorResponse,
} from "./errors";
import {
  CircuitBreaker,
  withRetry,
} from "../../utils/resilience";
import logger from "../../config/logger";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SimulateParams {
  network: SorobanNetwork;
  rpcUrl?: string;
  contractId: string;
  method: string;
  args?: unknown[];
  /** Source account public key; a zero-sequence dummy is used when absent */
  sourcePublicKey?: string;
  /** Transaction timeout in seconds (default: 30) */
  timeoutSeconds?: number;
  /** Base fee in stroops (default: StellarSdk.BASE_FEE) */
  fee?: string;
}

export interface SimulationEstimates {
  minResourceFee: string;
  cpuInstructions: string;
  memoryBytes: string;
  /** XDR-encoded ledger footprint */
  footprintXdr: string;
}

/**
 * The restore transaction a caller must submit before the simulated call can
 * succeed for real. Present only when `restoreRequired` is true.
 */
export interface SimulationRestorePreamble {
  /** Minimum resource fee for the restore transaction, in stroops */
  minResourceFee?: string;
  /** XDR-encoded `SorobanTransactionData` for the restore transaction */
  transactionDataXdr?: string;
}

export interface SimulationResult {
  /** Raw simulation response from the RPC */
  raw: SimulationSuccess;
  /** Gas / resource estimates when available */
  estimates?: SimulationEstimates;
  /** Auth entries required for this call */
  authEntries: unknown[];
  /**
   * True when the RPC executed the call only because it assumed the required
   * ledger entries were present. Their footprint has expired, so the
   * transaction cannot be submitted until a restore is performed first.
   *
   * Absent (undefined) when no restoration is needed.
   */
  restoreRequired?: boolean;
  /** The restore transaction to submit first. Present iff `restoreRequired`. */
  restorePreamble?: SimulationRestorePreamble;
  /** Invocation binding metadata */
  invocation: {
    contractId: string;
    method: string;
    network: SorobanNetwork;
    timestamp: string;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DUMMY_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const sorobanCircuitBreaker = new CircuitBreaker({
  name: "SorobanRPC",
  failureThreshold: 5,
  recoveryTimeout: 30000,
  successThreshold: 2,
  timeoutMs: 30000,
});

export function getSorobanCircuitBreakerMetrics() {
  return sorobanCircuitBreaker.getMetrics();
}

export function resetSorobanCircuitBreaker() {
  sorobanCircuitBreaker.reset();
}

function normalizeArgs(args?: unknown[]): unknown[] {
  if (!args?.length) return [];
  return args.map((arg) => (isScVal(arg) ? arg : nativeToScVal(arg)));
}

function validateSimulateParams(p: SimulateParams): void {
  if (p.network !== "testnet" && p.network !== "mainnet") {
    throw new InvalidParamsError(
      `Invalid network "${p.network}". Must be "testnet" or "mainnet".`
    );
  }
  if (!p.contractId?.startsWith("C")) {
    throw new InvalidParamsError(
      `Invalid contractId "${p.contractId}". Soroban contract IDs start with "C".`
    );
  }
  if (!p.method) {
    throw new InvalidParamsError("method is required");
  }
}

// ─── Core simulation function ─────────────────────────────────────────────────

/**
 * Simulate a Soroban contract call and return the raw RPC result.
 *
 * Does NOT decode the return value or prepare signing data — those are
 * handled by the decoder and signingPrep layers respectively.
 *
 * A simulation whose footprint contains expired ledger entries is returned
 * with `restoreRequired: true` and the `restorePreamble` to act on, rather
 * than being reported as a plain success. The transaction must not be
 * submitted in that state.
 */
export async function simulate(
  params: SimulateParams
): Promise<SimulationResult> {
  validateSimulateParams(params);

  const rpcUrl = resolveRpcUrl(params.network, params.rpcUrl);
  const server = buildRpcServer(rpcUrl);
  const passphrase = NETWORK_PASSPHRASES[params.network];

  const sourceKey = params.sourcePublicKey ?? DUMMY_SOURCE;
  const account = new StellarSdk.Account(sourceKey, "0");
  const contract = new StellarSdk.Contract(params.contractId);

  const normalizedArgs = normalizeArgs(params.args);
  const op = (
    contract as unknown as {
      call(method: string, ...args: unknown[]): unknown;
    }
  ).call(params.method, ...normalizedArgs);

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: params.fee ?? StellarSdk.BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(op as never)
    .setTimeout(params.timeoutSeconds ?? 30)
    .build();

  let raw: unknown;
  try {
    raw = await sorobanCircuitBreaker.execute(() =>
      withRetry(
        async () =>
          server.simulateTransaction(tx as unknown as StellarSdk.Transaction),
        {
          maxAttempts: 3,
          initialDelayMs: 1000,
          maxDelayMs: 5000,
          backoffMultiplier: 2,
        }
      )
    );
  } catch (err) {
    throw new SimulationError(
      `RPC simulateTransaction call failed: ${err instanceof Error ? err.message : String(err)}`,
      err
    );
  }

  if (isSimulationError(raw)) {
    throw new SimulationErrorResponse(raw.error);
  }

  if (!isSimulationSuccess(raw)) {
    throw new SimulationError("Unexpected simulation response shape");
  }

  const success = raw;

  // Extract resource estimates when present
  let estimates: SimulationEstimates | undefined;
  if (success.transactionData && success.minResourceFee) {
    try {
      const resources = success.transactionData.build().resources();
      estimates = {
        minResourceFee: success.minResourceFee,
        cpuInstructions: resources.instructions().toString(),
        memoryBytes: resources.readBytes().toString(),
        footprintXdr: success.transactionData.toXDR(),
      };
    } catch {
      // Resource extraction is best-effort; not all SDK versions expose it
    }
  }

  const authEntries: unknown[] = Array.isArray(success.result?.auth)
    ? (success.result!.auth as unknown[])
    : [];

  // A restore-required response is a success that only holds "as if" the
  // expired entries existed. Surface it structurally so a caller cannot
  // mistake it for a submittable transaction and lose the preamble.
  const restorePreamble = isSimulationRestore(success)
    ? readRestorePreamble(success)
    : undefined;

  return {
    raw: success,
    estimates,
    authEntries,
    ...(restorePreamble ? { restoreRequired: true, restorePreamble } : {}),
    invocation: {
      contractId: params.contractId,
      method: params.method,
      network: params.network,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Read the restore preamble off a restore-required simulation response.
 *
 * `transactionData` is a `SorobanDataBuilder` on the parsed response and a
 * base64 string on the raw one; both are normalized to XDR here so callers
 * do not have to care which shape the SDK handed back.
 */
function readRestorePreamble(
  sim: SimulationSuccess
): SimulationRestorePreamble | undefined {
  const preamble = (sim as { restorePreamble?: unknown }).restorePreamble;
  if (!preamble || typeof preamble !== "object") return undefined;

  const p = preamble as { minResourceFee?: unknown; transactionData?: unknown };

  let transactionDataXdr: string | undefined;
  const data = p.transactionData;
  if (typeof data === "string") {
    transactionDataXdr = data;
  } else if (
    data &&
    typeof (data as { toXDR?: unknown }).toXDR === "function"
  ) {
    try {
      transactionDataXdr = (data as { toXDR: () => string }).toXDR();
    } catch {
      // Best-effort: a preamble we cannot serialize is still surfaced via
      // `restoreRequired`, so the caller blocks on restore rather than
      // submitting a doomed transaction.
      transactionDataXdr = undefined;
    }
  }

  const minResourceFee =
    typeof p.minResourceFee === "string" ? p.minResourceFee : undefined;

  return { minResourceFee, transactionDataXdr };
}
