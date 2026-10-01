/**
 * sorobanService.ts — public facade for the Soroban contract-execution subsystem.
 *
 * This file is the only entry point the rest of the platform should import.
 * It re-exports the stable public types and delegates all work to the
 * subsystem layers in src/services/soroban/.
 *
 * Architecture:
 *   sorobanService  (this file — facade)
 *     └─ invoker    (orchestration)
 *          ├─ simulator    (RPC simulation)
 *          ├─ decoder      (XDR → native)
 *          └─ signingPrep  (auth / assembly)
 *               └─ sdkAdapter  (stellar-sdk compatibility)
 *                    └─ errors  (typed error hierarchy)
 */

export type { SorobanNetwork } from "./soroban/sdkAdapter";
export type {
  InvokeContractParams,
  InvokeContractResult,
} from "./soroban/invoker";
export type { SimulationEstimates } from "./soroban/simulator";
export { invokeContract, estimateContract } from "./soroban/invoker";
export {
  contractMetadataRegistry,
  ContractMetadataRegistry,
} from "./contracts";
export type {
  ContractBinding,
  ContractCapability,
  ContractEnvironment,
  ContractMetadata,
  ContractRegistrySnapshot,
} from "./contracts";

// Re-export error types so callers can do `instanceof` checks
export {
  SorobanError,
  InvalidParamsError,
  SdkInitError,
  SimulationError,
  SimulationErrorResponse,
  ContractError,
  parseHostError,
  AuthRequiredError,
  DecodeError,
  SigningError,
  NetworkMismatchError,
  InvocationError,
} from "./soroban/errors";

// ─── Legacy class wrapper ─────────────────────────────────────────────────────
// Kept for backward compatibility with code that instantiates `SorobanService`.

import {
  invokeContract,
  estimateContract,
  InvokeContractParams,
  InvokeContractResult,
} from "./soroban/invoker";
import { SimulationEstimates } from "./soroban/simulator";

export class SorobanService {
  invokeContract(params: InvokeContractParams): Promise<InvokeContractResult> {
    return invokeContract(params);
  }

  simulateContractCall(
    params: InvokeContractParams
  ): Promise<SimulationEstimates> {
    return estimateContract(params);
  }
}

export const sorobanService = new SorobanService();
