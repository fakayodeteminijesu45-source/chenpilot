/**
 * Formal, stable error-code registry for the Chen Pilot SDK (#566).
 *
 * The existing {@link ./errors} module defines the {@link SdkError} class and a
 * handful of convenience factories. This module layers a *registry* on top so
 * that every error code the SDK can produce is:
 *
 *  - Enumerated in one place, spanning all SDK modules (agent client, metadata,
 *    wallet providers, trustline helpers, Soroban helpers, transaction utils …).
 *  - Typed: {@link SdkErrorCode} is a string-literal union of every known code,
 *    so consumers can `switch` on codes without magic strings.
 *  - Self-describing: each code carries its owning module, error category,
 *    default message, recoverability, and a human description.
 *
 * Codes are treated as a public API surface — do not rename or repurpose an
 * existing code. Add new codes instead.
 */

import { ErrorCategory, SdkError } from "./errors";

// ─── Modules that can raise errors ────────────────────────────────────────────

export enum SdkModule {
  /** Cross-cutting / core errors shared by every module. */
  CORE = "core",
  /** High-level agent client (agentClient.ts). */
  AGENT_CLIENT = "agent-client",
  /** Asset & network metadata (metadata.ts). */
  METADATA = "metadata",
  /** Wallet / signature providers (signature-providers/*). */
  WALLET_PROVIDER = "wallet-provider",
  /** Trustline helpers (trustline.ts). */
  TRUSTLINE = "trustline",
  /** Soroban RPC helpers (soroban.ts). */
  SOROBAN = "soroban",
  /** Transaction building / simulation / submission utilities. */
  TRANSACTION = "transaction",
  /** Contract compatibility registry (contractRegistry.ts). */
  CONTRACT_REGISTRY = "contract-registry",
  /** Soroban event subscription & decoding (events.ts, eventDecoding.ts). */
  EVENTS = "events",
}

// ─── Definition of a single error code ────────────────────────────────────────

export interface ErrorCodeDefinition {
  /** Stable machine-readable code. Unique across the whole SDK. */
  readonly code: string;
  /** Module that owns / raises this code. */
  readonly module: SdkModule;
  /** Top-level category clients can switch on. */
  readonly category: ErrorCategory;
  /** Default human-readable message. */
  readonly message: string;
  /** Whether the operation can normally be retried. */
  readonly recoverable: boolean;
  /** Longer description of when this code is emitted. */
  readonly description: string;
}

// ─── The registry data ────────────────────────────────────────────────────────

const C = ErrorCategory;
const M = SdkModule;

/**
 * Canonical list of every error code the SDK can emit. `as const` makes the
 * `code` fields literal types, which powers the {@link SdkErrorCode} union.
 */
export const SDK_ERROR_DEFINITIONS = [
  // ── Core / transport (kept in sync with legacy errors.ts factories) ─────────
  {
    code: "TRANSPORT_ERROR",
    module: M.CORE,
    category: C.TRANSPORT,
    recoverable: true,
    message: "Transport error",
    description: "Generic network/transport failure.",
  },
  {
    code: "CONNECTION_TIMEOUT",
    module: M.CORE,
    category: C.TRANSPORT,
    recoverable: true,
    message: "Connection timed out",
    description: "A request did not complete within its deadline.",
  },
  {
    code: "NETWORK_ERROR",
    module: M.CORE,
    category: C.TRANSPORT,
    recoverable: true,
    message: "Network error",
    description:
      "DNS/socket/connection reset or similar low-level network failure.",
  },
  {
    code: "VALIDATION_ERROR",
    module: M.CORE,
    category: C.VALIDATION,
    recoverable: false,
    message: "Validation error",
    description: "Generic input validation failure.",
  },
  {
    code: "INVALID_INPUT",
    module: M.CORE,
    category: C.VALIDATION,
    recoverable: false,
    message: "Invalid input",
    description: "A field failed a type or constraint check.",
  },
  {
    code: "MISSING_FIELD",
    module: M.CORE,
    category: C.VALIDATION,
    recoverable: false,
    message: "Missing required field",
    description: "A required field was absent.",
  },
  {
    code: "SIMULATION_ERROR",
    module: M.CORE,
    category: C.SIMULATION,
    recoverable: false,
    message: "Simulation error",
    description: "Off-chain simulation failed.",
  },
  {
    code: "POLICY_VIOLATION",
    module: M.CORE,
    category: C.POLICY,
    recoverable: false,
    message: "Policy violation",
    description: "A permission, KYC, or governance rule blocked the operation.",
  },
  {
    code: "RATE_LIMITED",
    module: M.CORE,
    category: C.POLICY,
    recoverable: true,
    message: "Rate limited",
    description: "The caller exceeded an allowed request rate.",
  },
  {
    code: "UNAUTHORIZED",
    module: M.CORE,
    category: C.POLICY,
    recoverable: false,
    message: "Unauthorized",
    description: "The caller is not authorized for this operation.",
  },
  {
    code: "COMPATIBILITY_ERROR",
    module: M.CORE,
    category: C.COMPATIBILITY,
    recoverable: false,
    message: "Compatibility error",
    description: "Generic chain/contract incompatibility.",
  },
  {
    code: "UNSUPPORTED_CHAIN",
    module: M.CORE,
    category: C.COMPATIBILITY,
    recoverable: false,
    message: "Unsupported chain",
    description: "The requested chain is not supported.",
  },
  {
    code: "UNSUPPORTED_OPERATION",
    module: M.CORE,
    category: C.COMPATIBILITY,
    recoverable: false,
    message: "Unsupported operation",
    description: "The requested operation is not supported.",
  },
  {
    code: "EXECUTION_ERROR",
    module: M.CORE,
    category: C.EXECUTION,
    recoverable: false,
    message: "Execution error",
    description: "Generic transaction execution failure.",
  },
  {
    code: "SIGNING_ERROR",
    module: M.CORE,
    category: C.EXECUTION,
    recoverable: false,
    message: "Signing failed",
    description: "A signature could not be produced.",
  },
  {
    code: "INSUFFICIENT_FUNDS",
    module: M.CORE,
    category: C.EXECUTION,
    recoverable: false,
    message: "Insufficient funds",
    description: "The source account lacks the funds to execute.",
  },

  // ── Agent client ────────────────────────────────────────────────────────────
  {
    code: "AGENT_SESSION_EXPIRED",
    module: M.AGENT_CLIENT,
    category: C.POLICY,
    recoverable: true,
    message: "Agent session expired",
    description: "The agent session token has expired and must be refreshed.",
  },
  {
    code: "AGENT_REQUEST_ABORTED",
    module: M.AGENT_CLIENT,
    category: C.TRANSPORT,
    recoverable: true,
    message: "Agent request aborted",
    description: "The request was aborted by the caller or a timeout.",
  },
  {
    code: "AGENT_BAD_RESPONSE",
    module: M.AGENT_CLIENT,
    category: C.TRANSPORT,
    recoverable: true,
    message: "Malformed agent response",
    description: "The agent returned a response that could not be parsed.",
  },

  // ── Metadata ─────────────────────────────────────────────────────────────────
  {
    code: "METADATA_FETCH_FAILED",
    module: M.METADATA,
    category: C.TRANSPORT,
    recoverable: true,
    message: "Failed to fetch metadata",
    description: "Asset/network metadata could not be retrieved.",
  },
  {
    code: "METADATA_NOT_FOUND",
    module: M.METADATA,
    category: C.VALIDATION,
    recoverable: false,
    message: "Metadata not found",
    description: "No metadata is registered for the requested asset/network.",
  },

  // ── Wallet / signature providers ─────────────────────────────────────────────
  {
    code: "WALLET_PROVIDER_UNAVAILABLE",
    module: M.WALLET_PROVIDER,
    category: C.EXECUTION,
    recoverable: true,
    message: "Wallet provider unavailable",
    description: "The wallet/signature provider is not connected or reachable.",
  },
  {
    code: "WALLET_USER_REJECTED",
    module: M.WALLET_PROVIDER,
    category: C.POLICY,
    recoverable: false,
    message: "User rejected the request",
    description: "The user declined to sign or approve.",
  },
  {
    code: "WALLET_SIGNATURE_INVALID",
    module: M.WALLET_PROVIDER,
    category: C.EXECUTION,
    recoverable: false,
    message: "Invalid signature",
    description: "A produced signature failed verification.",
  },

  // ── Trustline helpers ────────────────────────────────────────────────────────
  {
    code: "TRUSTLINE_NOT_FOUND",
    module: M.TRUSTLINE,
    category: C.VALIDATION,
    recoverable: false,
    message: "Trustline not found",
    description: "The account has no trustline for the requested asset.",
  },
  {
    code: "TRUSTLINE_NONZERO_BALANCE",
    module: M.TRUSTLINE,
    category: C.POLICY,
    recoverable: false,
    message: "Trustline has a non-zero balance",
    description: "A trustline cannot be removed while it holds a balance.",
  },

  // ── Soroban helpers ──────────────────────────────────────────────────────────
  {
    code: "SOROBAN_RPC_ERROR",
    module: M.SOROBAN,
    category: C.TRANSPORT,
    recoverable: true,
    message: "Soroban RPC error",
    description: "The Soroban RPC endpoint returned an error.",
  },
  {
    code: "SOROBAN_TX_NOT_FOUND",
    module: M.SOROBAN,
    category: C.VALIDATION,
    recoverable: true,
    message: "Transaction not found",
    description: "The requested transaction is not (yet) known to the RPC.",
  },
  {
    code: "SOROBAN_DECODE_ERROR",
    module: M.SOROBAN,
    category: C.VALIDATION,
    recoverable: false,
    message: "Failed to decode Soroban payload",
    description: "An XDR/ScVal payload could not be decoded.",
  },
  {
    code: "CONTRACT_ERROR",
    module: M.SOROBAN,
    category: C.SIMULATION,
    recoverable: false,
    message: "Contract execution failed",
    description:
      "A contract invocation failed with a host error. The contract's own " +
      "#[contracterror] code is preserved in details.contractCode.",
  },

  // ── Transaction utilities ────────────────────────────────────────────────────
  {
    code: "TX_BUILD_FAILED",
    module: M.TRANSACTION,
    category: C.VALIDATION,
    recoverable: false,
    message: "Failed to build transaction",
    description:
      "The transaction could not be assembled from the given inputs.",
  },
  {
    code: "TX_SIMULATION_FAILED",
    module: M.TRANSACTION,
    category: C.SIMULATION,
    recoverable: false,
    message: "Transaction simulation failed",
    description: "Simulating the transaction returned an error.",
  },
  {
    code: "TX_SUBMISSION_FAILED",
    module: M.TRANSACTION,
    category: C.EXECUTION,
    recoverable: true,
    message: "Transaction submission failed",
    description: "The network rejected or dropped the submitted transaction.",
  },
  {
    code: "TX_FEE_TOO_LOW",
    module: M.TRANSACTION,
    category: C.EXECUTION,
    recoverable: true,
    message: "Transaction fee too low",
    description: "The offered fee was below the network minimum.",
  },

  // ── Contract registry ────────────────────────────────────────────────────────
  {
    code: "CONTRACT_NOT_REGISTERED",
    module: M.CONTRACT_REGISTRY,
    category: C.COMPATIBILITY,
    recoverable: false,
    message: "Contract not registered",
    description: "No compatibility metadata is registered for the contract.",
  },
  {
    code: "CONTRACT_VERSION_UNSUPPORTED",
    module: M.CONTRACT_REGISTRY,
    category: C.COMPATIBILITY,
    recoverable: false,
    message: "Contract version unsupported",
    description: "The requested contract version is not registered.",
  },
  {
    code: "CAPABILITY_UNSUPPORTED",
    module: M.CONTRACT_REGISTRY,
    category: C.COMPATIBILITY,
    recoverable: false,
    message: "Capability unsupported",
    description: "The contract version does not expose a required capability.",
  },

  // ── Events ───────────────────────────────────────────────────────────────────
  {
    code: "EVENT_DECODER_NOT_FOUND",
    module: M.EVENTS,
    category: C.VALIDATION,
    recoverable: false,
    message: "No decoder registered for event",
    description: "No event decoder matched the event topic/contract.",
  },
  {
    code: "EVENT_DECODE_FAILED",
    module: M.EVENTS,
    category: C.VALIDATION,
    recoverable: false,
    message: "Failed to decode event",
    description: "A registered decoder threw while decoding the event.",
  },
] as const satisfies readonly ErrorCodeDefinition[];

/** String-literal union of every known SDK error code. */
export type SdkErrorCode = (typeof SDK_ERROR_DEFINITIONS)[number]["code"];

// ─── Registry lookups ─────────────────────────────────────────────────────────

const BY_CODE: ReadonlyMap<string, ErrorCodeDefinition> = new Map(
  SDK_ERROR_DEFINITIONS.map((d) => [d.code, d])
);

/**
 * Options for {@link ErrorRegistry.createError}. Anything omitted falls back to
 * the registered definition.
 */
export interface CreateErrorOptions {
  /** Override the default message. */
  message?: string;
  /** Structured metadata attached to the error. */
  details?: Record<string, unknown>;
  /** Underlying cause. */
  cause?: unknown;
  /** Override the registered `recoverable` flag. */
  recoverable?: boolean;
}

/**
 * Central registry of SDK error codes. All methods are static; the registry is
 * immutable and seeded from {@link SDK_ERROR_DEFINITIONS}.
 */
export class ErrorRegistry {
  /** Look up a code definition, or `undefined` if unknown. */
  static get(code: string): ErrorCodeDefinition | undefined {
    return BY_CODE.get(code);
  }

  /** Look up a code definition, throwing if it is not registered. */
  static require(code: string): ErrorCodeDefinition {
    const def = BY_CODE.get(code);
    if (!def) {
      throw new SdkError({
        category: ErrorCategory.VALIDATION,
        code: "INVALID_INPUT",
        message: `Unknown SDK error code: '${code}'`,
        details: { code },
      });
    }
    return def;
  }

  /** Whether a code is registered. */
  static has(code: string): boolean {
    return BY_CODE.has(code);
  }

  /** All registered definitions. */
  static all(): ErrorCodeDefinition[] {
    return [...SDK_ERROR_DEFINITIONS];
  }

  /** All registered codes. */
  static codes(): string[] {
    return SDK_ERROR_DEFINITIONS.map((d) => d.code);
  }

  /** Definitions owned by a module. */
  static byModule(module: SdkModule): ErrorCodeDefinition[] {
    return SDK_ERROR_DEFINITIONS.filter((d) => d.module === module);
  }

  /** Definitions in a category. */
  static byCategory(category: ErrorCategory): ErrorCodeDefinition[] {
    return SDK_ERROR_DEFINITIONS.filter((d) => d.category === category);
  }

  /**
   * Construct a fully-formed {@link SdkError} from a registered code. The
   * category and recoverability come from the registry, so callers only pass a
   * code (and optionally richer details).
   */
  static createError(
    code: SdkErrorCode | string,
    options: CreateErrorOptions = {}
  ): SdkError {
    const def = ErrorRegistry.require(code);
    return new SdkError({
      category: def.category,
      code: def.code,
      message: options.message ?? def.message,
      recoverable: options.recoverable ?? def.recoverable,
      details: options.details,
      cause: options.cause,
    });
  }
}

/** Convenience alias mirroring the factory style of {@link ./errors}. */
export function createSdkError(
  code: SdkErrorCode | string,
  options?: CreateErrorOptions
): SdkError {
  return ErrorRegistry.createError(code, options);
}

// ─── Contract-specific failure arguments (#840) ───────────────────────────────

/**
 * The structured failure detail a contract invocation can carry.
 *
 * A Soroban contract that fails does so with a host error whose argument is
 * the contract's own `#[contracterror]` discriminant — `Error(Contract, #12)`.
 * That code is the only way to tell "insufficient balance" from "not
 * authorized", and it is what a caller must branch on. Flattening it into a
 * message string loses it, so it is carried as data instead.
 */
export interface ContractErrorDetail {
  /** The `#[contracterror]` code the contract raised. */
  contractCode?: number;
  /** Host error class, e.g. `Contract`, `WasmVm`, `Storage`. */
  errorType?: string;
  /** The contract that raised the error, when the source reported one. */
  contractId?: string;
  /** VM-level reason for non-contract host errors. */
  vmReason?: string;
  /** The original text, kept verbatim. */
  rawDetail?: string;
}

/**
 * Matches the host-error forms the Soroban RPC and VM emit, e.g.
 * `Error(Contract, #12)`, `HostError: Error(WasmVm, InvalidAction)`, and
 * `Error(Contract, #12) <contract CABC…>`.
 */
const HOST_ERROR_RE =
  /Error\(\s*(\w+)\s*,\s*(#\d+|[A-Za-z][\w ]*?)\s*\)(?:\s*<contract\s+([A-Za-z0-9]+)>)?/;

/**
 * Parse the host error class and contract-specific code out of an RPC error
 * string.
 *
 * Returns undefined when the string is not a recognizable host error, so a
 * caller can fall back to the opaque text rather than inventing a code.
 */
export function parseContractError(
  detail: string
): ContractErrorDetail | undefined {
  if (typeof detail !== "string" || detail.length === 0) return undefined;

  const match = HOST_ERROR_RE.exec(detail);
  if (!match) return undefined;

  const [, errorType, rawArg, contractId] = match;

  // Only a Contract host error carries a contract-defined numeric code; any
  // other argument is a VM-level reason string.
  if (errorType === "Contract" && rawArg.startsWith("#")) {
    const contractCode = Number(rawArg.slice(1));
    if (!Number.isSafeInteger(contractCode)) return undefined;
    return {
      errorType,
      contractCode,
      ...(contractId ? { contractId } : {}),
      rawDetail: detail,
    };
  }

  return {
    errorType,
    vmReason: rawArg.trim(),
    ...(contractId ? { contractId } : {}),
    rawDetail: detail,
  };
}

/**
 * Build a `CONTRACT_ERROR` that preserves the contract's own failure code.
 *
 * Prefer this over `ErrorRegistry.createError("CONTRACT_ERROR", …)` so the
 * `#[contracterror]` discriminant survives into `err.details.contractCode`
 * and through `toJSON()`. The detail is parsed from `detail` when not given.
 */
export function contractError(
  detail: string,
  parsed?: ContractErrorDetail
): SdkError {
  const info = parsed ?? parseContractError(detail);
  return ErrorRegistry.createError("CONTRACT_ERROR", {
    message:
      info?.contractCode !== undefined
        ? `Contract failed: ${info.errorType} error #${info.contractCode}` +
          (info.contractId ? ` in contract ${info.contractId}` : "")
        : `Contract failed: ${detail}`,
    details: { ...(info ?? {}), rawDetail: detail },
  });
}

/**
 * Rebuild a `CONTRACT_ERROR` from a serialized backend error, so a contract
 * code that crossed the backend/SDK boundary is not discarded on arrival.
 *
 * Returns undefined when `payload` is not a contract failure, letting the
 * caller fall back to its normal error handling.
 */
export function contractErrorFromJSON(payload: unknown): SdkError | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as { code?: unknown; details?: unknown };
  if (p.code !== "CONTRACT_ERROR") return undefined;

  const details =
    p.details && typeof p.details === "object"
      ? ({ ...(p.details as ContractErrorDetail) } as ContractErrorDetail)
      : undefined;

  const raw =
    details?.rawDetail ??
    (typeof (payload as { message?: unknown }).message === "string"
      ? ((payload as { message: string }).message satisfies string)
      : "Unknown contract failure");

  return contractError(raw, details);
}
