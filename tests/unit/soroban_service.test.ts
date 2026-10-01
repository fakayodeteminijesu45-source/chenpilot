import * as StellarSdk from "@stellar/stellar-sdk";
import {
  assertAuthNotExpired,
  assertAuthScopeMatches,
  prepareSignedTransaction,
} from "../../src/services/soroban/signingPrep";
import {
  AuthExpiredError,
  AuthScopeMismatchError,
} from "../../src/services/soroban/errors";
import { isSimulationRestore } from "../../src/services/soroban/sdkAdapter";
import { simulate } from "../../src/services/soroban/simulator";
import type { SimulationSuccess } from "../../src/services/soroban/sdkAdapter";

const TEST_CONTRACT_ID = "CABC1234567890";

describe("Soroban Service invokeContract", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SOROBAN_RPC_URL_TESTNET;
    delete process.env.SOROBAN_RPC_URL_MAINNET;
  });

  it("uses default testnet RPC URL and passphrase", async () => {
    process.env.SOROBAN_RPC_URL_TESTNET = "https://rpc-testnet.example";
    const { invokeContract } =
      await import("../../src/services/sorobanService");

    await invokeContract({
      network: "testnet",
      contractId: TEST_CONTRACT_ID,
      method: "ping",
      args: [],
    });

    expect(StellarSdk.SorobanRpc.Server).toHaveBeenCalledWith(
      "https://rpc-testnet.example",
      expect.any(Object)
    );

    const builderArgs = (StellarSdk.TransactionBuilder as jest.Mock).mock
      .calls[0][1];
    expect(builderArgs.networkPassphrase).toBe(StellarSdk.Networks.TESTNET);
  });

  it("uses default mainnet RPC URL and passphrase", async () => {
    process.env.SOROBAN_RPC_URL_MAINNET = "https://rpc-mainnet.example";
    const { invokeContract } =
      await import("../../src/services/sorobanService");

    await invokeContract({
      network: "mainnet",
      contractId: TEST_CONTRACT_ID,
      method: "ping",
      args: [],
    });

    expect(StellarSdk.SorobanRpc.Server).toHaveBeenCalledWith(
      "https://rpc-mainnet.example",
      expect.any(Object)
    );

    const builderArgs = (StellarSdk.TransactionBuilder as jest.Mock).mock
      .calls[0][1];
    expect(builderArgs.networkPassphrase).toBe(StellarSdk.Networks.PUBLIC);
  });

  it("rejects missing contractId", async () => {
    const { invokeContract } =
      await import("../../src/services/sorobanService");

    await expect(
      invokeContract({
        network: "testnet",
        contractId: "",
        method: "ping",
      })
    ).rejects.toThrow("contractId");
  });

  it("rejects missing method", async () => {
    const { invokeContract } =
      await import("../../src/services/sorobanService");

    await expect(
      invokeContract({
        network: "testnet",
        contractId: TEST_CONTRACT_ID,
        method: "",
      })
    ).rejects.toThrow("method");
  });

  it("returns expected result shape", async () => {
    const { invokeContract } =
      await import("../../src/services/sorobanService");

    const result = await invokeContract({
      network: "testnet",
      contractId: TEST_CONTRACT_ID,
      method: "ping",
      args: [1, "two"],
    });

    expect(result).toEqual(
      expect.objectContaining({
        network: "testnet",
        contractId: TEST_CONTRACT_ID,
        method: "ping",
        result: "mock_scval",
      })
    );
    expect(result.raw).toBeDefined();
  });

  it("binds simulation result to originating invocation", async () => {
    const { invokeContract } =
      await import("../../src/services/sorobanService");

    const result = await invokeContract({
      network: "mainnet",
      contractId: TEST_CONTRACT_ID,
      method: "execute",
      args: [],
    });

    expect(result.raw).toBeDefined();
    expect((result.raw as any).invocation).toEqual(
      expect.objectContaining({
        contractId: TEST_CONTRACT_ID,
        method: "execute",
        network: "mainnet",
      })
    );
    expect((result.raw as any).invocation.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
    );
  });

  it("preserves invocation binding across multiple calls", async () => {
    const { invokeContract } =
      await import("../../src/services/sorobanService");

    const result1 = await invokeContract({
      network: "testnet",
      contractId: "CCONTRACT1",
      method: "method1",
    });

    const result2 = await invokeContract({
      network: "mainnet",
      contractId: "CCONTRACT2",
      method: "method2",
    });

    expect((result1.raw as any).invocation.contractId).toBe("CCONTRACT1");
    expect((result1.raw as any).invocation.method).toBe("method1");
    expect((result2.raw as any).invocation.contractId).toBe("CCONTRACT2");
    expect((result2.raw as any).invocation.method).toBe("method2");
  });
});

describe("Soroban signingPrep auth expiry", () => {
  // Shape of a simulation result carrying Soroban auth entries. The
  // expiration ledger lives under credentials.sorobanAuthorization.
  const simWith = (auth: unknown[]): SimulationSuccess => ({
    result: { auth },
  });

  const xdrEntry = (expirationLedgerSeq: unknown): unknown => ({
    credentials: { sorobanAuthorization: { expirationLedgerSeq } },
  });

  it("rejects an authorization entry that expired before the current ledger", () => {
    expect(() => assertAuthNotExpired(simWith([xdrEntry(90)]), 100)).toThrow(
      AuthExpiredError
    );
  });

  it("reports the expired ledger and the current ledger in the message", () => {
    expect(() => assertAuthNotExpired(simWith([xdrEntry(90)]), 100)).toThrow(
      /90 < current ledger 100/
    );
  });

  it("rejects when any one of several entries has expired", () => {
    const sim = simWith([xdrEntry(500), xdrEntry(42), xdrEntry(400)]);
    expect(() => assertAuthNotExpired(sim, 100)).toThrow(AuthExpiredError);
  });

  it("accepts entries that expire on or after the current ledger", () => {
    const sim = simWith([xdrEntry(100), xdrEntry(250)]);
    expect(() => assertAuthNotExpired(sim, 100)).not.toThrow();
  });

  it("reads the expiration from the SDK AuthorizationEntry wrapper", () => {
    const entry = { getExpirationLedgerSeq: () => 10 };
    expect(() => assertAuthNotExpired(simWith([entry]), 100)).toThrow(
      AuthExpiredError
    );
  });

  it("unwraps XDR Int32, bigint, and string expirations", () => {
    const int32 = { toNumber: () => 10 };
    expect(() => assertAuthNotExpired(simWith([xdrEntry(int32)]), 100)).toThrow(
      AuthExpiredError
    );
    expect(() =>
      assertAuthNotExpired(simWith([xdrEntry(BigInt(10))]), 100)
    ).toThrow(AuthExpiredError);
    expect(() => assertAuthNotExpired(simWith([xdrEntry("10")]), 100)).toThrow(
      AuthExpiredError
    );
  });

  it("ignores entries without a readable expiration", () => {
    const sim = simWith([
      {},
      { credentials: {} },
      { credentials: { sorobanAuthorization: {} } },
      xdrEntry(undefined),
    ]);
    expect(() => assertAuthNotExpired(sim, 100)).not.toThrow();
  });

  it("skips the check when the current ledger is unknown", () => {
    const sim = simWith([xdrEntry(1)]);
    expect(() => assertAuthNotExpired(sim, 0)).not.toThrow();
    expect(() => assertAuthNotExpired(sim, Number.NaN)).not.toThrow();
  });

  it("is a no-op when the simulation carries no auth entries", () => {
    expect(() => assertAuthNotExpired({ result: {} }, 100)).not.toThrow();
    expect(() =>
      assertAuthNotExpired({ result: { auth: [] } }, 100)
    ).not.toThrow();
  });

  it("throws an AuthExpiredError carrying the AUTH_EXPIRED code", () => {
    try {
      assertAuthNotExpired(simWith([xdrEntry(90)]), 100);
      throw new Error("expected assertAuthNotExpired to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthExpiredError);
      expect((err as AuthExpiredError).code).toBe("AUTH_EXPIRED");
    }
  });

  describe("prepareSignedTransaction", () => {
    const unsignedTx = { type: "mock_tx" } as unknown as StellarSdk.Transaction;
    const context = {
      network: "testnet" as const,
      secretKey: "SABC...MOCKSECRET",
    };

    // The shared stellar mock has no assembleTransaction; install one locally
    // so this describe can assert whether assembly was ever reached.
    const assembleTransaction = jest.fn(() => ({
      sign: jest.fn(),
      toEnvelope: () => ({ toXDR: () => "base64_xdr" }),
    }));

    beforeAll(() => {
      (StellarSdk.SorobanRpc as unknown as Record<string, unknown>)[
        "assembleTransaction"
      ] = assembleTransaction;
    });

    beforeEach(() => {
      assembleTransaction.mockClear();
    });

    it("does not sign when an authorization entry has expired", () => {
      expect(() =>
        prepareSignedTransaction(unsignedTx, simWith([xdrEntry(90)]), {
          ...context,
          currentLedgerSeq: 100,
        })
      ).toThrow(AuthExpiredError);

      expect(assembleTransaction).not.toHaveBeenCalled();
    });

    it("signs when auth entries are still valid", () => {
      const result = prepareSignedTransaction(
        unsignedTx,
        simWith([xdrEntry(250)]),
        { ...context, currentLedgerSeq: 100 }
      );

      expect(assembleTransaction).toHaveBeenCalled();
      expect(result.signedXdr).toBe("base64_xdr");
    });

    it("preserves existing behavior when no current ledger is supplied", () => {
      const result = prepareSignedTransaction(
        unsignedTx,
        simWith([xdrEntry(90)]),
        context
      );

      expect(assembleTransaction).toHaveBeenCalled();
      expect(result.signedXdr).toBe("base64_xdr");
    });
  });
});

describe("Soroban signingPrep auth scope", () => {
  const VAULT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const ROUTER = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBE4PQ";
  const approved = { contractId: VAULT, method: "swap" };

  // Raw XDR simulation shape: an invocation node in the authorization tree.
  const invocationFor = (
    contractId: string,
    method: string,
    subInvocations: unknown[] = []
  ): unknown => ({
    function: { contractAddress: contractId, functionName: method, args: [] },
    subInvocations,
  });

  // One auth entry whose root invocation is `contractId.method`.
  const entryFor = (
    contractId: string,
    method: string,
    subInvocations: unknown[] = []
  ): unknown => ({
    credentials: { sourceAccount: { address: "GUSER" } },
    rootInvocation: invocationFor(contractId, method, subInvocations),
  });

  it("accepts a tree that matches the approved intent", () => {
    const sim: SimulationSuccess = {
      result: { auth: [entryFor(VAULT, "swap")] },
    };
    expect(() => assertAuthScopeMatches(sim, approved)).not.toThrow();
  });

  it("rejects a different contract than the one approved", () => {
    const sim: SimulationSuccess = {
      result: { auth: [entryFor(ROUTER, "swap")] },
    };
    expect(() => assertAuthScopeMatches(sim, approved)).toThrow(
      AuthScopeMismatchError
    );
  });

  it("rejects a different method than the one approved", () => {
    const sim: SimulationSuccess = {
      result: { auth: [entryFor(VAULT, "withdraw_all")] },
    };
    expect(() => assertAuthScopeMatches(sim, approved)).toThrow(
      AuthScopeMismatchError
    );
  });

  it("rejects escalation hidden in a nested sub-invocation", () => {
    // The root looks exactly like the approved call, but it nests a transfer
    // to a different contract — the escalation the check exists to catch.
    const sim: SimulationSuccess = {
      result: {
        auth: [entryFor(VAULT, "swap", [invocationFor(ROUTER, "transfer")])],
      },
    };
    expect(() => assertAuthScopeMatches(sim, approved)).toThrow(
      AuthScopeMismatchError
    );
  });

  it("reports the escalating target in the error", () => {
    const sim: SimulationSuccess = {
      result: {
        auth: [entryFor(VAULT, "swap", [invocationFor(ROUTER, "transfer")])],
      },
    };
    expect(() => assertAuthScopeMatches(sim, approved)).toThrow(
      `${ROUTER}:transfer`
    );
  });

  it("carries the approved and requested scopes on the error", () => {
    const sim: SimulationSuccess = {
      result: { auth: [entryFor(ROUTER, "swap")] },
    };
    try {
      assertAuthScopeMatches(sim, approved);
      throw new Error("expected assertAuthScopeMatches to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthScopeMismatchError);
      const e = err as AuthScopeMismatchError;
      expect(e.code).toBe("AUTH_SCOPE_MISMATCH");
      expect(e.approved).toEqual([`${VAULT}:swap`]);
      expect(e.requested).toEqual([`${ROUTER}:swap`]);
    }
  });

  it("accepts explicitly allowed cross-contract targets", () => {
    const sim: SimulationSuccess = {
      result: {
        auth: [entryFor(VAULT, "swap", [invocationFor(ROUTER, "transfer")])],
      },
    };
    expect(() =>
      assertAuthScopeMatches(sim, {
        ...approved,
        allowedTargets: [`${ROUTER}:transfer`],
      })
    ).not.toThrow();
  });

  it("still rejects an unlisted target when allowlist entries exist", () => {
    const sim: SimulationSuccess = {
      result: {
        auth: [entryFor(VAULT, "swap", [invocationFor(ROUTER, "burn")])],
      },
    };
    expect(() =>
      assertAuthScopeMatches(sim, {
        ...approved,
        allowedTargets: [`${ROUTER}:transfer`],
      })
    ).toThrow(AuthScopeMismatchError);
  });

  it("accepts multiple entries that all match the approved intent", () => {
    const sim: SimulationSuccess = {
      result: { auth: [entryFor(VAULT, "swap"), entryFor(VAULT, "swap")] },
    };
    expect(() => assertAuthScopeMatches(sim, approved)).not.toThrow();
  });

  it("rejects when one of several entries escalates", () => {
    const sim: SimulationSuccess = {
      result: { auth: [entryFor(VAULT, "swap"), entryFor(ROUTER, "drain")] },
    };
    expect(() => assertAuthScopeMatches(sim, approved)).toThrow(
      AuthScopeMismatchError
    );
  });

  it("strips the XDR NUL terminator from function names", () => {
    const sim: SimulationSuccess = {
      result: { auth: [entryFor(VAULT, "swap\0")] },
    };
    expect(() => assertAuthScopeMatches(sim, approved)).not.toThrow();
  });

  it("reads the SDK accessor shape via address().authorization()", () => {
    const root = {
      function: () => ({
        contractAddress: VAULT,
        functionName: "swap",
        args: [],
      }),
      subInvocations: () => [],
    };
    const entry = {
      address: () => ({
        authorization: () => [{ rootInvocation: () => root }],
      }),
    };
    const sim: SimulationSuccess = { result: { auth: [entry] } };
    expect(() => assertAuthScopeMatches(sim, approved)).not.toThrow();
  });

  it("rejects an escalation in the SDK accessor shape", () => {
    const sub = {
      function: () => ({
        contractAddress: ROUTER,
        functionName: "transfer",
        args: [],
      }),
      subInvocations: () => [],
    };
    const root = {
      function: () => ({
        contractAddress: VAULT,
        functionName: "swap",
        args: [],
      }),
      subInvocations: () => [sub],
    };
    const entry = {
      address: () => ({
        authorization: () => [{ rootInvocation: () => root }],
      }),
    };
    const sim: SimulationSuccess = { result: { auth: [entry] } };
    expect(() => assertAuthScopeMatches(sim, approved)).toThrow(
      AuthScopeMismatchError
    );
  });

  it("is a no-op when the simulation carries no auth entries", () => {
    expect(() =>
      assertAuthScopeMatches({ result: { auth: [] } }, approved)
    ).not.toThrow();
    expect(() =>
      assertAuthScopeMatches({ result: {} }, approved)
    ).not.toThrow();
  });

  it("ignores entries whose invocation tree cannot be read", () => {
    const sim: SimulationSuccess = {
      result: { auth: [{}, { rootInvocation: {} }, { rootInvocation: 5 }] },
    };
    expect(() => assertAuthScopeMatches(sim, approved)).not.toThrow();
  });

  it("stops traversing a pathologically deep tree", () => {
    let node: unknown = invocationFor(ROUTER, "transfer");
    for (let i = 0; i < 200; i++) {
      node = invocationFor(VAULT, "swap", [node]);
    }
    const sim: SimulationSuccess = {
      result: { auth: [entryFor(VAULT, "swap", [node])] },
    };
    // The escalation is buried past the traversal bound and is not inspected.
    expect(() => assertAuthScopeMatches(sim, approved)).not.toThrow();
  });

  it("still catches an escalation within the traversal bound", () => {
    let node: unknown = invocationFor(ROUTER, "transfer");
    for (let i = 0; i < 5; i++) {
      node = invocationFor(VAULT, "swap", [node]);
    }
    const sim: SimulationSuccess = {
      result: { auth: [entryFor(VAULT, "swap", [node])] },
    };
    expect(() => assertAuthScopeMatches(sim, approved)).toThrow(
      AuthScopeMismatchError
    );
  });

  describe("prepareSignedTransaction", () => {
    const unsignedTx = { type: "mock_tx" } as unknown as StellarSdk.Transaction;
    const context = {
      network: "testnet" as const,
      secretKey: "SABC...MOCKSECRET",
    };

    const assembleTransaction = jest.fn(() => ({
      sign: jest.fn(),
      toEnvelope: () => ({ toXDR: () => "base64_xdr" }),
    }));

    beforeAll(() => {
      (StellarSdk.SorobanRpc as unknown as Record<string, unknown>)[
        "assembleTransaction"
      ] = assembleTransaction;
    });

    beforeEach(() => {
      assembleTransaction.mockClear();
    });

    it("does not sign when the auth scope exceeds the approved intent", () => {
      expect(() =>
        prepareSignedTransaction(
          unsignedTx,
          { result: { auth: [entryFor(ROUTER, "swap")] } },
          { ...context, approvedIntent: approved }
        )
      ).toThrow(AuthScopeMismatchError);

      expect(assembleTransaction).not.toHaveBeenCalled();
    });

    it("signs when the auth scope matches the approved intent", () => {
      const result = prepareSignedTransaction(
        unsignedTx,
        { result: { auth: [entryFor(VAULT, "swap")] } },
        { ...context, approvedIntent: approved }
      );

      expect(assembleTransaction).toHaveBeenCalled();
      expect(result.signedXdr).toBe("base64_xdr");
    });

    it("preserves existing behavior when no approved intent is supplied", () => {
      const result = prepareSignedTransaction(
        unsignedTx,
        { result: { auth: [entryFor(ROUTER, "swap")] } },
        context
      );

      expect(assembleTransaction).toHaveBeenCalled();
      expect(result.signedXdr).toBe("base64_xdr");
    });
  });
});

describe("Soroban simulator restore-required outcomes", () => {
  // A restore-required response is a success that also carries a preamble:
  // the RPC ran the call "as if" the expired footprint entries existed.
  const restoreResponse = (data: unknown = "restore_xdr") => ({
    result: { retval: "mock_scval" },
    minResourceFee: "100",
    transactionData: "sim_xdr",
    restorePreamble: { minResourceFee: "250", transactionData: data },
  });

  // Drive simulate() by swapping the RPC server's simulation response.
  const withSimResponse = async (
    response: unknown,
    fn: () => Promise<void>
  ): Promise<void> => {
    const Server = (StellarSdk.SorobanRpc as unknown as { Server: jest.Mock })
      .Server;
    const original = Server.getMockImplementation();
    Server.mockImplementation(() => ({
      simulateTransaction: jest.fn().mockResolvedValue(response),
    }));
    try {
      await fn();
    } finally {
      Server.mockImplementation(original as never);
    }
  };

  describe("isSimulationRestore", () => {
    it("detects a response carrying a restore preamble", () => {
      expect(isSimulationRestore(restoreResponse())).toBe(true);
    });

    it("returns false for a plain success", () => {
      expect(isSimulationRestore({ result: { retval: "mock_scval" } })).toBe(
        false
      );
    });

    it("returns false for a simulation error", () => {
      expect(isSimulationRestore({ error: "boom" })).toBe(false);
    });

    it("returns false when the preamble is null", () => {
      expect(
        isSimulationRestore({
          result: {},
          transactionData: "sim_xdr",
          restorePreamble: null,
        })
      ).toBe(false);
    });

    it("returns false when the preamble carries no transaction data", () => {
      expect(
        isSimulationRestore({
          result: {},
          transactionData: "sim_xdr",
          restorePreamble: { minResourceFee: "250" },
        })
      ).toBe(false);
    });
  });

  describe("simulate", () => {
    const params = {
      network: "testnet" as const,
      contractId: TEST_CONTRACT_ID,
      method: "ping",
    };

    it("returns restoreRequired with the preamble when restoration is needed", async () => {
      await withSimResponse(restoreResponse(), async () => {
        const result = await simulate(params);
        expect(result.restoreRequired).toBe(true);
        expect(result.restorePreamble).toEqual({
          minResourceFee: "250",
          transactionDataXdr: "restore_xdr",
        });
      });
    });

    it("serializes a SorobanDataBuilder preamble to XDR", async () => {
      const builder = { toXDR: () => "builder_xdr" };
      await withSimResponse(restoreResponse(builder), async () => {
        const result = await simulate(params);
        expect(result.restorePreamble?.transactionDataXdr).toBe("builder_xdr");
      });
    });

    it("still flags restoreRequired when the preamble cannot be serialized", async () => {
      const builder = {
        toXDR: () => {
          throw new Error("xdr failed");
        },
      };
      await withSimResponse(restoreResponse(builder), async () => {
        const result = await simulate(params);
        expect(result.restoreRequired).toBe(true);
        expect(result.restorePreamble?.transactionDataXdr).toBeUndefined();
        expect(result.restorePreamble?.minResourceFee).toBe("250");
      });
    });

    it("omits restore fields for a plain success", async () => {
      await withSimResponse({ result: { retval: "mock_scval" } }, async () => {
        const result = await simulate(params);
        expect(result.restoreRequired).toBeUndefined();
        expect(result.restorePreamble).toBeUndefined();
      });
    });

    it("still returns the raw result and auth entries alongside the preamble", async () => {
      await withSimResponse(restoreResponse(), async () => {
        const result = await simulate(params);
        expect(result.raw).toBeDefined();
        expect(Array.isArray(result.authEntries)).toBe(true);
        expect(result.invocation.contractId).toBe(TEST_CONTRACT_ID);
      });
    });

    it("does not report restoreRequired for a simulation error", async () => {
      await withSimResponse({ error: "contract panicked" }, async () => {
        await expect(simulate(params)).rejects.toThrow();
      });
    });
  });
});
