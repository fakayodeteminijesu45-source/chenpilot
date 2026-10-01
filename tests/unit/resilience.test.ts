import {
  CircuitBreaker,
  executeWithRetry,
  FallbackProvider,
  resilienceEngine,
  QuoteResultSchema,
  PositionResultSchema,
  EquilibreSwapQuoteResponseSchema,
  EquilibreAdapter
} from "../../src/Agents/tools/defi";
import { z } from "zod";

describe("DeFi Integration Resilience Layer", () => {
  
  describe("Circuit Breaker State Machine", () => {
    it("should start in CLOSED state and transition to OPEN after threshold failures", async () => {
      const cb = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 50,
        successThreshold: 2,
      });

      expect(cb.getState()).toBe("CLOSED");

      // First failure
      await expect(cb.execute(async () => { throw new Error("Fail 1"); })).rejects.toThrow("Fail 1");
      expect(cb.getState()).toBe("CLOSED");

      // Second failure - trips circuit
      await expect(cb.execute(async () => { throw new Error("Fail 2"); })).rejects.toThrow("Fail 2");
      expect(cb.getState()).toBe("OPEN");

      // Call when OPEN should reject immediately
      await expect(cb.execute(async () => "success")).rejects.toThrow("Circuit breaker is OPEN. Call rejected.");
    });

    it("should transition OPEN -> HALF-OPEN after reset timeout, and HALF-OPEN -> CLOSED on consecutive successes", async () => {
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 30,
        successThreshold: 2,
      });

      // Trip circuit
      await expect(cb.execute(async () => { throw new Error("Trip"); })).rejects.toThrow("Trip");
      expect(cb.getState()).toBe("OPEN");

      // Wait for reset timeout
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(cb.getState()).toBe("HALF-OPEN");

      // First success in HALF-OPEN
      const res1 = await cb.execute(async () => "success 1");
      expect(res1).toBe("success 1");
      expect(cb.getState()).toBe("HALF-OPEN");

      // Second success in HALF-OPEN closes circuit
      const res2 = await cb.execute(async () => "success 2");
      expect(res2).toBe("success 2");
      expect(cb.getState()).toBe("CLOSED");
    });

    it("should transition HALF-OPEN -> OPEN on a single failure", async () => {
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 10,
        successThreshold: 2,
      });

      // Trip circuit
      await expect(cb.execute(async () => { throw new Error("Trip"); })).rejects.toThrow("Trip");
      expect(cb.getState()).toBe("OPEN");

      // Wait for reset timeout
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(cb.getState()).toBe("HALF-OPEN");

      // Failure in HALF-OPEN immediately trips circuit back to OPEN
      await expect(cb.execute(async () => { throw new Error("Failed probe"); })).rejects.toThrow("Failed probe");
      expect(cb.getState()).toBe("OPEN");
    });
  });

  describe("Retry & Backoff with Jitter", () => {
    it("should retry up to maxAttempts and fail", async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        throw new Error("Transient error");
      };

      const config = {
        maxAttempts: 3,
        baseDelayMs: 2,
        maxDelayMs: 10,
        jitterRangeMs: 1,
      };

      await expect(executeWithRetry(fn, config)).rejects.toThrow("Transient error");
      expect(attempts).toBe(3);
    });

    it("should succeed if a retry attempt succeeds", async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 2) {
          throw new Error("Temp error");
        }
        return "success";
      };

      const config = {
        maxAttempts: 3,
        baseDelayMs: 2,
        maxDelayMs: 10,
        jitterRangeMs: 1,
      };

      const result = await executeWithRetry(fn, config);
      expect(result).toBe("success");
      expect(attempts).toBe(2);
    });
  });

  describe("Zod Schema Validation Boundaries", () => {
    it("should validate a positive schema contract and pass", () => {
      const validQuote = {
        fromToken: "XLM",
        toToken: "USDC",
        fromAmount: "100.0",
        toAmount: "12.5",
        priceImpact: 0.01,
        route: ["XLM", "USDC"],
        estimatedGas: "0.005",
      };

      const parsed = QuoteResultSchema.safeParse(validQuote);
      expect(parsed.success).toBe(true);
    });

    it("should fail validation on malformed schemas (negative scenario)", () => {
      const invalidQuote = {
        fromToken: "XLM",
        toToken: "USDC",
        // toAmount is missing (required)
        priceImpact: "high", // should be number
      };

      const parsed = QuoteResultSchema.safeParse(invalidQuote);
      expect(parsed.success).toBe(false);
    });

    it("should validate raw oracle responses accurately", () => {
      const rawOracleQuote = {
        toAmount: "95.5", // minimum required for EquilibreSwapQuoteResponseSchema
        route: ["XLM", "USDC"],
      };

      const parsed = EquilibreSwapQuoteResponseSchema.safeParse(rawOracleQuote);
      expect(parsed.success).toBe(true);
    });
  });

  describe("Fallback Provider & Failover Logic", () => {
    const mockPrimary = {
      getConfig: () => ({ name: "PrimaryAdapter" }),
      getSwapQuote: async () => ({
        success: false,
        error: "Primary down",
        timestamp: new Date().toISOString(),
      }),
    };

    const mockSecondary = {
      getConfig: () => ({ name: "SecondaryAdapter" }),
      getSwapQuote: async () => ({
        success: true,
        data: {
          fromToken: "XLM",
          toToken: "USDC",
          fromAmount: "10",
          toAmount: "1.2",
          priceImpact: 0,
          route: [],
          estimatedGas: "0",
        },
        timestamp: new Date().toISOString(),
      }),
    };

    it("should failover to secondary when primary fails", async () => {
      const fallback = new FallbackProvider(mockPrimary as any, mockSecondary as any);
      
      const result = await fallback.executeWithFallback(async (provider) => {
        return provider.getSwapQuote();
      });

      expect(result.success).toBe(true);
      expect(result.data?.toAmount).toBe("1.2");
    });

    it("should return failure if both primary and secondary fail", async () => {
      const failingSecondary = {
        getConfig: () => ({ name: "SecondaryAdapter" }),
        getSwapQuote: async () => {
          throw new Error("Secondary crashed");
        },
      };

      const fallback = new FallbackProvider(mockPrimary as any, failingSecondary as any);

      const result = await fallback.executeWithFallback(async (provider) => {
        return provider.getSwapQuote();
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Both primary and secondary providers failed");
    });
  });

  describe("ResilienceEngine integration", () => {
    beforeEach(() => {
      resilienceEngine.clearCircuitBreakers();
    });

    it("should run successfully and validate schema", async () => {
      const fn = async () => ({
        token: "USDC",
        amount: "500",
        valueUSD: 500,
        APY: 0.05,
      });

      const result = await resilienceEngine.execute(
        "test-engine-success",
        fn,
        PositionResultSchema,
        {
          retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2, jitterRangeMs: 1 },
        }
      );

      expect(result).toBeDefined();
      expect(result.token).toBe("USDC");
    });

    it("should trigger circuit breaker on consecutive errors", async () => {
      const fn = async () => {
        throw new Error("API Outage");
      };

      const config = {
        retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2, jitterRangeMs: 1 },
        circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 100, successThreshold: 1 },
      };

      // Attempt 1: fails
      await expect(resilienceEngine.execute("test-cb-trigger", fn, undefined, config)).rejects.toThrow("API Outage");
      
      // Attempt 2: fails, trips circuit breaker
      await expect(resilienceEngine.execute("test-cb-trigger", fn, undefined, config)).rejects.toThrow("API Outage");

      // Attempt 3: rejected by circuit breaker immediately
      await expect(resilienceEngine.execute("test-cb-trigger", fn, undefined, config)).rejects.toThrow("Circuit breaker is OPEN");
    });
  });

  describe("Issue #855: adapter capability advertisement invalidation", () => {
    it("advertises the configured capabilities with a revision stamp", () => {
      const adapter = new EquilibreAdapter();

      const advertisement = adapter.getCapabilityAdvertisement();

      expect(advertisement.revision).toBe(adapter.getCapabilityRevision());
      expect(advertisement.configFingerprint).toEqual(expect.any(String));
      expect(advertisement.capabilities).toEqual(adapter.getConfig().capabilities);
      expect(adapter.hasCapability("swap")).toBe(advertisement.capabilities.swap);
      expect(adapter.hasValidCapabilityAdvertisement()).toBe(true);
    });

    it("invalidates the previous advertisement when the adapter configuration changes", () => {
      const adapter = new EquilibreAdapter();
      const before = adapter.getCapabilityAdvertisement();
      const invalidations: Array<{
        reason: string;
        previousRevision: number | null;
        revision: number;
      }> = [];

      adapter.onCapabilitiesInvalidated((event) => {
        invalidations.push({
          reason: event.reason,
          previousRevision: event.previous ? event.previous.revision : null,
          revision: event.revision,
        });
      });

      adapter.updateConfig({
        capabilities: {
          ...adapter.getConfig().capabilities,
          swap: !before.capabilities.swap,
        },
      });

      const after = adapter.getCapabilityAdvertisement();

      expect(after.capabilities.swap).toBe(!before.capabilities.swap);
      expect(adapter.hasCapability("swap")).toBe(!before.capabilities.swap);
      expect(after.configFingerprint).not.toBe(before.configFingerprint);
      expect(after.revision).toBe(before.revision + 1);
      expect(invalidations).toEqual([
        {
          reason: "config-change",
          previousRevision: before.revision,
          revision: before.revision + 1,
        },
      ]);
    });

    it("detects a capability change made directly on the config object", () => {
      const adapter = new EquilibreAdapter();
      const before = adapter.getCapabilityAdvertisement();
      const config = adapter.getConfig();

      config.capabilities.lending = !before.capabilities.lending;

      const after = adapter.getCapabilityAdvertisement();

      expect(after.capabilities.lending).toBe(!before.capabilities.lending);
      expect(after.configFingerprint).not.toBe(before.configFingerprint);
      expect(after.revision).toBe(before.revision + 1);
    });

    it("drops the live advertisement on an explicit invalidation and re-advertises on next read", () => {
      const adapter = new EquilibreAdapter();
      adapter.getCapabilityAdvertisement();
      const revision = adapter.getCapabilityRevision();

      const event = adapter.invalidateCapabilities("manual");

      expect(event.reason).toBe("manual");
      expect(event.revision).toBe(revision + 1);
      expect(adapter.getCapabilityRevision()).toBe(revision + 1);
      expect(adapter.hasValidCapabilityAdvertisement()).toBe(false);

      // Reading a capability derives a fresh advertisement for the current config.
      expect(adapter.hasCapability("swap")).toBe(adapter.getConfig().capabilities.swap);
      expect(adapter.hasValidCapabilityAdvertisement()).toBe(true);
      expect(adapter.getCapabilityRevision()).toBe(revision + 1);
    });

    it("replaces the whole configuration through applyConfig and keeps the advertisement in sync", () => {
      const adapter = new EquilibreAdapter();
      const before = adapter.getCapabilityAdvertisement();
      const replacement = {
        ...adapter.getConfig(),
        apiUrl: "https://api.equilibre.example",
        capabilities: {
          ...adapter.getConfig().capabilities,
          swap: true,
          liquidity: false,
        },
      };

      adapter.applyConfig(replacement);

      const after = adapter.getCapabilityAdvertisement();

      expect(adapter.getConfig().apiUrl).toBe("https://api.equilibre.example");
      expect(after.capabilities).toEqual(replacement.capabilities);
      expect(adapter.hasCapability("liquidity")).toBe(false);
      expect(after.configFingerprint).not.toBe(before.configFingerprint);
      expect(after.revision).toBe(before.revision + 1);
    });
  });
});
