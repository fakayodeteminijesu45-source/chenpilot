/**
 * Typed error hierarchy for the Soroban contract-execution subsystem.
 * Every error carries a machine-readable `code` so callers can branch
 * without string-matching error messages.
 */

export type SorobanErrorCode =
  | "INVALID_PARAMS"
  | "SDK_INIT_FAILED"
  | "SIMULATION_FAILED"
  | "SIMULATION_ERROR_RESPONSE"
  | "CONTRACT_ERROR"
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "AUTH_SCOPE_MISMATCH"
  | "DECODE_FAILED"
  | "SIGNING_FAILED"
  | "NETWORK_MISMATCH"
  | "INVOCATION_FAILED"
  | "TTL_EXTENSION_FAILED"
  | "UNKNOWN";

/**
 * Top-level error categories shared with the SDK taxonomy.
 */
export type ErrorCategory =
  | "TRANSPORT"
  | "VALIDATION"
  | "SIMULATION"
  | "POLICY"
  | "COMPATIBILITY"
  | "EXECUTION"
  | "UNKNOWN";

/**
 * Maps a SorobanErrorCode to its top-level ErrorCategory.
 */
export function sorobanCodeToCategory(code: SorobanErrorCode): ErrorCategory {
  switch (code) {
    case "INVALID_PARAMS":
      return "VALIDATION";
    case "SDK_INIT_FAILED":
      return "COMPATIBILITY";
    case "SIMULATION_FAILED":
    case "SIMULATION_ERROR_RESPONSE":
    case "CONTRACT_ERROR":
      return "SIMULATION";
    case "AUTH_REQUIRED":
      return "POLICY";
    case "DECODE_FAILED":
      return "VALIDATION";
    case "SIGNING_FAILED":
      return "EXECUTION";
    case "NETWORK_MISMATCH":
      return "POLICY";
    case "INVOCATION_FAILED":
      return "EXECUTION";
    case "TTL_EXTENSION_FAILED":
      return "EXECUTION";
    case "UNKNOWN":
      return "UNKNOWN";
  }
}

const categoryByCode: Record<SorobanErrorCode, ErrorCategory> = {
  INVALID_PARAMS: "VALIDATION",
  SDK_INIT_FAILED: "COMPATIBILITY",
  SIMULATION_FAILED: "SIMULATION",
  SIMULATION_ERROR_RESPONSE: "SIMULATION",
  CONTRACT_ERROR: "SIMULATION",
  AUTH_REQUIRED: "POLICY",
  DECODE_FAILED: "VALIDATION",
  SIGNING_FAILED: "EXECUTION",
  NETWORK_MISMATCH: "POLICY",
  INVOCATION_FAILED: "EXECUTION",
  TTL_EXTENSION_FAILED: "EXECUTION",
  UNKNOWN: "UNKNOWN",
};

export function getSorobanCategory(code: SorobanErrorCode): ErrorCategory {
  return categoryByCode[code] ?? "UNKNOWN";
}

export class SorobanError extends Error {
  readonly code: SorobanErrorCode;
  readonly errorCategory: ErrorCategory;
  readonly cause?: unknown;
  /**
   * Structured, machine-readable context for this failure.
   *
   * Carried so contract-specific detail — most importantly the numeric code a
   * contract's `#[contracterror]` enum raised — survives as data instead of
   * only as prose inside `message`.
   */
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: SorobanErrorCode,
    cause?: unknown,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "SorobanError";
    this.code = code;
    this.errorCategory = categoryByCode[code] ?? "UNKNOWN";
    this.cause = cause;
    this.details = details;
  }

  /**
   * Serializable form used when an error crosses the backend/SDK boundary.
   * `details` carries the contract-specific arguments, so a consumer can
   * branch on `contractCode` without parsing `message`.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      category: this.errorCategory,
      message: this.message,
      details: this.details,
    };
  }
}

export class InvalidParamsError extends SorobanError {
  constructor(message: string) {
    super(message, "INVALID_PARAMS");
    this.name = "InvalidParamsError";
  }
}

export class SdkInitError extends SorobanError {
  constructor(message: string, cause?: unknown) {
    super(message, "SDK_INIT_FAILED", cause);
    this.name = "SdkInitError";
  }
}

export class SimulationError extends SorobanError {
  constructor(message: string, cause?: unknown) {
    super(message, "SIMULATION_FAILED", cause);
    this.name = "SimulationError";
  }
}

/**
 * The host-level failure classes a Soroban VM can report.
 *
 * Only `Contract` carries a contract-defined code; the rest are host/VM
 * conditions with no contract-specific argument.
 */
export type SorobanHostErrorType =
  | "Contract"
  | "WasmVm"
  | "Context"
  | "Storage"
  | "Object"
  | "Crypto"
  | "Events"
  | "Budget"
  | "Value"
  | "Auth"
  | "Value ";

export interface ParsedContractError {
  /** Host error class, e.g. `Contract` or `WasmVm`. */
  errorType: SorobanHostErrorType;
  /**
   * The contract's `#[contracterror]` code, when `errorType` is `Contract`.
   * This is the argument that makes a contract failure specific.
   */
  contractCode?: number;
  /** The VM-level reason for non-contract host errors, when present. */
  vmReason?: string;
  /** The contract that raised the error, when the RPC reported one. */
  contractId?: string;
}

const HOST_ERROR_TYPES: readonly SorobanHostErrorType[] = [
  "Contract",
  "WasmVm",
  "Context",
  "Storage",
  "Object",
  "Crypto",
  "Events",
  "Budget",
  "Value",
  "Auth",
];

/**
 * Matches the two forms the Soroban RPC and host emit:
 *   Error(Contract, #12)
 *   HostError: Error(WasmVm, InvalidAction)
 *   Error(Contract, #12) <contract CABC…>
 */
const HOST_ERROR_RE =
  /Error\(\s*(\w+)\s*,\s*(#\d+|[A-Za-z][\w ]*?)\s*\)(?:\s*<contract\s+([A-Za-z0-9]+)>)?/;

/**
 * Extract the host error class and contract-specific code from an RPC error
 * string.
 *
 * Returns undefined when the string is not a recognizable host error, so
 * callers can fall back to treating it as an opaque message rather than
 * inventing a code.
 */
export function parseHostError(
  detail: string
): ParsedContractError | undefined {
  if (typeof detail !== "string" || detail.length === 0) return undefined;

  const match = HOST_ERROR_RE.exec(detail);
  if (!match) return undefined;

  const [, rawType, rawArg, rawContractId] = match;
  const errorType = HOST_ERROR_TYPES.find((t) => t === rawType);
  if (!errorType) return undefined;

  // A contract error's argument is `#<u32>`; anything else is a VM reason.
  if (errorType === "Contract" && rawArg.startsWith("#")) {
    const code = Number(rawArg.slice(1));
    if (!Number.isSafeInteger(code)) return undefined;
    return {
      errorType,
      contractCode: code,
      ...(rawContractId ? { contractId: rawContractId } : {}),
    };
  }

  return {
    errorType,
    vmReason: rawArg.trim(),
    ...(rawContractId ? { contractId: rawContractId } : {}),
  };
}

/**
 * Raised when a contract invocation fails with a host error the RPC reported.
 *
 * The contract's own error code — the `#[contracterror]` discriminant — is
 * preserved on `details.contractCode` and as the `contractCode` field, so a
 * caller can branch on the specific failure without re-parsing the message.
 * The raw RPC text is kept in `details.rawDetail`.
 */
export class ContractError extends SorobanError {
  readonly contractCode?: number;
  readonly errorType?: SorobanHostErrorType;

  constructor(detail: string, parsed?: ParsedContractError) {
    const info = parsed ?? parseHostError(detail);
    super(
      info?.contractCode !== undefined
        ? `Soroban contract failed: ${info.errorType} error #${info.contractCode}` +
            (info.contractId ? ` in contract ${info.contractId}` : "") +
            ` (${detail})`
        : `Soroban contract failed: ${detail}`,
      "CONTRACT_ERROR",
      undefined,
      {
        rawDetail: detail,
        ...(info?.errorType ? { errorType: info.errorType } : {}),
        ...(info?.contractCode !== undefined
          ? { contractCode: info.contractCode }
          : {}),
        ...(info?.vmReason ? { vmReason: info.vmReason } : {}),
        ...(info?.contractId ? { contractId: info.contractId } : {}),
      }
    );
    this.name = "ContractError";
    this.contractCode = info?.contractCode;
    this.errorType = info?.errorType;
  }
}

export class SimulationErrorResponse extends SorobanError {
  /**
   * The contract's own error code, when the RPC error was a contract host
   * error. Undefined for non-contract failures.
   */
  readonly contractCode?: number;
  readonly errorType?: SorobanHostErrorType;

  constructor(detail: string) {
    const info = parseHostError(detail);
    super(
      `Soroban simulation returned error: ${detail}`,
      "SIMULATION_ERROR_RESPONSE",
      undefined,
      {
        rawDetail: detail,
        ...(info?.errorType ? { errorType: info.errorType } : {}),
        ...(info?.contractCode !== undefined
          ? { contractCode: info.contractCode }
          : {}),
        ...(info?.vmReason ? { vmReason: info.vmReason } : {}),
        ...(info?.contractId ? { contractId: info.contractId } : {}),
      }
    );
    this.name = "SimulationErrorResponse";
    this.contractCode = info?.contractCode;
    this.errorType = info?.errorType;
  }
}

export class AuthRequiredError extends SorobanError {
  constructor() {
    super(
      "Soroban invocation requires authorization; provide a secretKey to sign",
      "AUTH_REQUIRED"
    );
    this.name = "AuthRequiredError";
  }
}

export class AuthExpiredError extends SorobanError {
  constructor(message: string) {
    super(message, "AUTH_EXPIRED");
    this.name = "AuthExpiredError";
  }
}

export class DecodeError extends SorobanError {
  constructor(message: string, cause?: unknown) {
    super(message, "DECODE_FAILED", cause);
    this.name = "DecodeError";
  }
}

export class SigningError extends SorobanError {
  constructor(message: string, cause?: unknown) {
    super(message, "SIGNING_FAILED", cause);
    this.name = "SigningError";
  }
}

/**
 * Raised when a transaction was assembled with a network passphrase that does
 * not match the network the client is configured/verified for. This guard
 * sits between "assemble with a passphrase" and "sign the envelope", because
 * signing for the wrong network is irreversible.
 */
export class NetworkMismatchError extends SorobanError {
  readonly expectedNetwork?: string;
  readonly transactionNetwork?: string;

  constructor(opts?: {
    expectedNetwork?: string;
    transactionNetwork?: string;
  }) {
    const expected = opts?.expectedNetwork ?? "unknown";
    const transaction = opts?.transactionNetwork ?? "unknown";
    super(
      `Refusing to sign: the transaction network ("${transaction}") does not match ` +
        `the client network ("${expected}"). No signature was produced.`,
      "NETWORK_MISMATCH"
    );
    this.name = "NetworkMismatchError";
    this.expectedNetwork = opts?.expectedNetwork;
    this.transactionNetwork = opts?.transactionNetwork;
  }
}

/**
 * Raised when the authorization scope a simulation asks the signer to approve
 * is broader than the call the user actually intended. A contract can call
 * `require_auth` for a different contract, method, or account than the one
 * being invoked, which would let a signature authorize an action the user
 * never saw. This guard compares the simulated auth tree against the approved
 * intent before any signature is produced.
 */
export class AuthScopeMismatchError extends SorobanError {
  readonly approved: string[];
  readonly requested: string[];

  constructor(opts: { approved: string[]; requested: string[] }) {
    const approved = opts.approved.join(", ") || "none";
    const requested = opts.requested.join(", ") || "none";
    super(
      `Refusing to sign: the simulated authorization scope does not match the ` +
        `approved intent. Approved: [${approved}]. Requested: [${requested}]. ` +
        `No signature was produced.`,
      "AUTH_SCOPE_MISMATCH"
    );
    this.name = "AuthScopeMismatchError";
    this.approved = opts.approved;
    this.requested = opts.requested;
  }
}

export class InvocationError extends SorobanError {
  constructor(message: string, cause?: unknown) {
    super(message, "INVOCATION_FAILED", cause);
    this.name = "InvocationError";
  }
}
