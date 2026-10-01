import {
  DeFiAdapterConfig,
  AdapterCapabilities,
  getAdapterConfig,
} from "../../../config/defiAdapters";
import { resilienceEngine } from "./resilience/ResilienceEngine";
import { createBudget, budgetedFetch, BudgetExhaustedError, type RequestBudget } from "../../../utils/budget";
import {
  CircuitBreaker,
  type CircuitBreakerOptions,
  type RetryOptions,
} from "../../../utils/resilience";
import {
  CapabilityAdvertisementManager,
  fingerprintConfig,
  type CapabilityAdvertisement,
  type CapabilityInvalidation,
  type CapabilityInvalidationListener,
} from "./CapabilityRevision";
import { z } from "zod";

/**
 * Result returned by DeFi adapter operations
 */
export interface AdapterResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

/**
 * Quote result for swap/liquidity operations
 */
export interface QuoteResult {
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmount: string;
  priceImpact: number;
  route: string[];
  estimatedGas: string;
}

/**
 * Position result for lending/borrowing positions
 */
export interface PositionResult {
  token: string;
  amount: string;
  valueUSD: number;
  APY: number;
  /** Collateral backing this position (lending: the supplied asset acts as collateral; borrowing: the locked collateral asset). */
  collateral?: string;
  /** Interest accrued on this position so far, in the position's token units. */
  accruedInterest?: string;
  /**
   * USD value of accrued borrowing costs. Only present on borrowing positions.
   * Populated when the protocol returns an accruedInterestUSD figure.
   */
  accruedCostUSD?: number;
  /**
   * Net position value in USD: valueUSD minus accruedCostUSD.
   * Only present on borrowing positions when accruedCostUSD is known.
   */
  netValueUSD?: number;
}

/**
 * Transaction request for executing DeFi operations
 */
export interface TransactionRequest {
  to: string;
  data: string;
  value?: string;
  gasLimit?: string;
}

/**
 * Base class for DeFi protocol adapters
 */
export abstract class DeFiAdapter {
  protected config: DeFiAdapterConfig;
  protected circuitBreaker: CircuitBreaker;
  protected retryOptions: RetryOptions;

  /**
   * Capability advertisement derived from the current configuration. The
   * advertisement is invalidated whenever the configuration changes so a stale
   * capability set can never be served (Issue #855).
   */
  private readonly capabilityAdvertisements =
    new CapabilityAdvertisementManager<AdapterCapabilities>();

  constructor(protocol: "equilibre" | "yieldblox") {
    this.config = getAdapterConfig(protocol);

    if (!this.config.enabled) {
      console.warn(`[DeFiAdapter] ${this.config.name} adapter is disabled`);
    }

    const circuitBreakerOptions: CircuitBreakerOptions = {
      name: `DeFiAdapter-${this.config.name}`,
      failureThreshold: 5,
      recoveryTimeout: 30000,
      successThreshold: 2,
      timeoutMs: this.config.timeout,
    };
    this.circuitBreaker = new CircuitBreaker(circuitBreakerOptions);

    this.retryOptions = {
      maxAttempts: this.config.retry.maxAttempts,
      initialDelayMs: this.config.retry.backoffMs,
      maxDelayMs: 30000,
      backoffMultiplier: 2,
    };
  }

  /**
   * Get the adapter configuration
   */
  getConfig(): DeFiAdapterConfig {
    return this.config;
  }

  /**
   * Fingerprint of the configuration the capability advertisement belongs to.
   */
  protected capabilityConfigFingerprint(): string {
    return fingerprintConfig(this.config);
  }

  /**
   * The advertised capabilities for the current configuration. When the
   * configuration changed since the last advertisement, the previous one is
   * invalidated (revision bumped, listeners notified) and re-derived.
   */
  getCapabilityAdvertisement(): CapabilityAdvertisement<AdapterCapabilities> {
    return this.capabilityAdvertisements.get(
      this.capabilityConfigFingerprint(),
      () => this.config.capabilities
    );
  }

  /**
   * Check if a specific capability is enabled. Reads from the current
   * advertisement, so a configuration change is reflected immediately and the
   * stale advertisement is invalidated first.
   */
  hasCapability(capability: keyof AdapterCapabilities): boolean {
    return this.getCapabilityAdvertisement().capabilities[capability];
  }

  /**
   * Current capability revision. Advances every time an advertisement is
   * invalidated, letting consumers detect that an advertisement they hold is
   * stale.
   */
  getCapabilityRevision(): number {
    return this.capabilityAdvertisements.getRevision();
  }

  /**
   * True when a live capability advertisement matches the current
   * configuration. Returns false once the advertisement was invalidated.
   */
  hasValidCapabilityAdvertisement(): boolean {
    const advertisement = this.capabilityAdvertisements.peek();
    return (
      advertisement !== null &&
      advertisement.configFingerprint === this.capabilityConfigFingerprint()
    );
  }

  /**
   * Replace the adapter configuration and invalidate the previously advertised
   * capabilities. Intentional API change introduced for Issue #855: adapters
   * that mutate their configuration at runtime must go through this method (or
   * {@link updateConfig}) so consumers never see a stale capability set.
   */
  applyConfig(config: DeFiAdapterConfig, reason = "config-change"): void {
    this.config = config;
    this.capabilityAdvertisements.invalidate(reason);
  }

  /**
   * Merge a partial configuration change and invalidate the previously
   * advertised capabilities.
   */
  updateConfig(patch: Partial<DeFiAdapterConfig>, reason = "config-change"): void {
    this.applyConfig({ ...this.config, ...patch }, reason);
  }

  /**
   * Explicitly drop the live capability advertisement without changing the
   * configuration, e.g. after an out-of-band change.
   */
  invalidateCapabilities(reason = "manual"): CapabilityInvalidation<AdapterCapabilities> {
    return this.capabilityAdvertisements.invalidate(reason);
  }

  /**
   * Observe capability invalidations. Returns an unsubscribe function.
   */
  onCapabilitiesInvalidated(
    listener: CapabilityInvalidationListener<AdapterCapabilities>
  ): () => void {
    return this.capabilityAdvertisements.onInvalidate(listener);
  }

  /**
   * Get the API URL for this adapter
   */
  getApiUrl(): string {
    return this.config.apiUrl;
  }

  /**
   * Get a contract address for the current network
   */
  getContractAddress(contractName: string): string | undefined {
    const network =
      (process.env.STELLAR_NETWORK as "testnet" | "public") || "testnet";
    return this.config.contracts[network]?.[contractName];
  }

  /**
   * Execute an API request with retry logic and circuit breaker
   */
  /**
   * Execute an API request with strict schema validation and full resilience wrapping.
   */
  protected async fetchWithSchema<T>(
    endpoint: string,
    schema?: z.ZodTypeAny,
    options: RequestInit = {},
    budget?: RequestBudget
  ): Promise<T> {
    const { timeout, retry } = this.config;
    const requestBudget = budget ?? createBudget({
      deadlineMs: timeout,
      attempts: retry.maxAttempts,
      bytes: 5 * 1024 * 1024,
      downstreamCalls: 10,
      path: `defi.${this.config.id}.${endpoint.split("?")[0]}`,
    });

    const key = `${this.config.id}:${endpoint.split("?")[0]}`;

    return resilienceEngine.execute(
      key,
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
          const response = budget
            ? await budgetedFetch(requestBudget, `${this.config.apiUrl}${endpoint}`, {
                ...options,
                signal: controller.signal,
                headers: {
                  "Content-Type": "application/json",
                  ...options.headers,
                },
              })
            : await fetch(`${this.config.apiUrl}${endpoint}`, {
                ...options,
                signal: controller.signal,
                headers: {
                  "Content-Type": "application/json",
                  ...options.headers,
                },
              });

          clearTimeout(timeoutId);

          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }

          return await response.json();
        } catch (error) {
          clearTimeout(timeoutId);
          throw error;
        }
      },
      schema,
      {
        retry: {
          maxAttempts: retry.maxAttempts,
          baseDelayMs: retry.backoffMs,
        },
      }
    ) as Promise<T>;
  }

  /**
   * Execute an API request with retry logic (backwards compatible, without schema validation).
   */
  protected async fetchWithRetry<T>(
    endpoint: string,
    options: RequestInit = {},
    budget?: RequestBudget
  ): Promise<T> {
    return this.fetchWithSchema<T>(endpoint, undefined, options, budget);
  }

  /**
   * Get a quote for a swap operation
   * Must be implemented by subclasses
   */
  abstract getSwapQuote(
    fromToken: string,
    toToken: string,
    amount: string
  ): Promise<AdapterResult<QuoteResult>>;

  /**
   * Execute a swap transaction
   * Must be implemented by subclasses
   */
  abstract executeSwap(
    fromToken: string,
    toToken: string,
    amount: string,
    minReceived?: string
  ): Promise<AdapterResult<TransactionRequest>>;

  /**
   * Get liquidity positions for an address
   * Must be implemented by subclasses
   */
  abstract getLiquidityPositions(
    address: string
  ): Promise<AdapterResult<PositionResult[]>>;

  /**
   * Get lending positions for an address
   * Must be implemented by subclasses
   */
  abstract getLendingPositions(
    address: string
  ): Promise<AdapterResult<PositionResult[]>>;

  /**
   * Get borrowing positions for an address
   * Must be implemented by subclasses
   */
  abstract getBorrowingPositions(
    address: string
  ): Promise<AdapterResult<PositionResult[]>>;

  /**
   * Health check for the adapter
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.fetchWithRetry("/health", { method: "GET" });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Factory for creating DeFi adapters
 */
export class DeFiAdapterFactory {
  private static adapters: Map<string, DeFiAdapter> = new Map();

  /**
   * Create or get an adapter instance
   */
  static getAdapter<T extends DeFiAdapter>(
    protocol: "equilibre" | "yieldblox",
    adapterClass: new (protocol: "equilibre" | "yieldblox") => T
  ): T {
    const key = protocol;

    if (!this.adapters.has(key)) {
      this.adapters.set(key, new adapterClass(protocol));
    }

    return this.adapters.get(key) as T;
  }

  /**
   * Clear all cached adapters
   */
  static clearCache(): void {
    this.adapters.clear();
  }
}

export { DeFiAdapterConfig, AdapterCapabilities };
export type {
  DeFiAdapterConfig,
  AdapterCapabilities,
};
