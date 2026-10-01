/**
 * DeFi Adapters Module
 *
 * This module provides centralized access to DeFi protocol adapters
 * for the Stellar ecosystem.
 *
 * Supported Protocols:
 * - Equilibre: DEX with swap and liquidity capabilities
 * - YieldBlox: Lending protocol with lending and borrowing capabilities
 */

export {
  DeFiAdapter,
  DeFiAdapterFactory,
  DeFiAdapterConfig,
  AdapterCapabilities,
  AdapterResult,
  QuoteResult,
  PositionResult,
  TransactionRequest,
} from "./DeFiAdapter";

export { EquilibreAdapter, equilibreAdapter } from "./EquilibreAdapter";
export { YieldBloxAdapter, yieldBloxAdapter } from "./YieldBloxAdapter";

// Capability advertisement revisions (Issue #855)
export {
  CapabilityAdvertisementManager,
  fingerprintConfig,
  stableStringify,
} from "./CapabilityRevision";
export type {
  CapabilityAdvertisement,
  CapabilityInvalidation,
  CapabilityInvalidationListener,
  CapabilityFlags,
} from "./CapabilityRevision";

// Export resilience and capability contracts
export * from "./CapabilityContract";
export { CircuitBreaker, CircuitState, CircuitBreakerConfig } from "./resilience/CircuitBreaker";
export { FallbackProvider, IFallbackProvider } from "./resilience/FallbackProvider";
export { ResilienceEngine, resilienceEngine, ResilienceConfig } from "./resilience/ResilienceEngine";
export { executeWithRetry, RetryConfig } from "./resilience/Retry";
export * from "./resilience/Schemas";

// Re-export configuration utilities
export {
  generateDeFiAdapterConfigs,
  getAdapterConfig,
  getEnabledAdapters,
  getAdaptersByCapability,
  getContractAddress,
  DeFiProtocol,
  DEFAULT_CAPABILITIES,
} from "../../../config/defiAdapters";
