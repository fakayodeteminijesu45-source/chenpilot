// ─── Contract-execution subsystem ────────────────────────────────────────────
export type { SorobanNetwork } from "./sdkAdapter";
export {
  DEFAULT_RPC_URLS,
  NETWORK_PASSPHRASES,
  resolveRpcUrl,
  isSimulationRestore,
} from "./sdkAdapter";
export type { SimulationRestore } from "./sdkAdapter";

export type { InvokeContractParams, InvokeContractResult } from "./invoker";
export { invokeContract, estimateContract } from "./invoker";

export type {
  SimulateParams,
  SimulationEstimates,
  SimulationResult,
  SimulationRestorePreamble,
} from "./simulator";
export { simulate } from "./simulator";

export { decodeReturnValue, decodeScVal } from "./decoder";

export {
  requiresSigning,
  assertSigningNotRequired,
  assertAuthNotExpired,
  assertAuthScopeMatches,
  prepareSignedTransaction,
} from "./signingPrep";
export type {
  SigningContext,
  AssembledTransaction,
  ApprovedAuthScope,
} from "./signingPrep";

export {
  SorobanError,
  InvalidParamsError,
  SdkInitError,
  SimulationError,
  SimulationErrorResponse,
  ContractError,
  parseHostError,
  AuthRequiredError,
  AuthExpiredError,
  AuthScopeMismatchError,
  DecodeError,
  SigningError,
  NetworkMismatchError,
  InvocationError,
} from "./errors";
export type {
  SorobanErrorCode,
  SorobanHostErrorType,
  ParsedContractError,
} from "./errors";

// ─── Existing subsystem modules ───────────────────────────────────────────────
export * from "./ttlManager";
export * from "./swapLock";
export * from "./reentrancyGuard";
export * from "./xdrScoping";
