/**
 * Tests for the SDK error-code registry (#566).
 */

import {
  ErrorRegistry,
  SdkModule,
  SDK_ERROR_DEFINITIONS,
  contractError,
  contractErrorFromJSON,
  createSdkError,
  parseContractError,
} from "../errorRegistry";
import { ErrorCategory, SdkError } from "../errors";

describe("ErrorRegistry", () => {
  it("exposes every definition and has unique codes", () => {
    const codes = ErrorRegistry.codes();
    expect(codes.length).toBe(SDK_ERROR_DEFINITIONS.length);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("get() returns a definition and require() throws for unknown codes", () => {
    expect(ErrorRegistry.get("TRANSPORT_ERROR")?.category).toBe(
      ErrorCategory.TRANSPORT
    );
    expect(ErrorRegistry.get("NOPE_NOT_A_CODE")).toBeUndefined();
    expect(() => ErrorRegistry.require("NOPE_NOT_A_CODE")).toThrow(
      /Unknown SDK error code/
    );
  });

  it("has() reflects registration", () => {
    expect(ErrorRegistry.has("VALIDATION_ERROR")).toBe(true);
    expect(ErrorRegistry.has("MADE_UP")).toBe(false);
  });

  it("byModule() and byCategory() filter correctly", () => {
    const soroban = ErrorRegistry.byModule(SdkModule.SOROBAN);
    expect(soroban.length).toBeGreaterThan(0);
    expect(soroban.every((d) => d.module === SdkModule.SOROBAN)).toBe(true);

    const transport = ErrorRegistry.byCategory(ErrorCategory.TRANSPORT);
    expect(transport.every((d) => d.category === ErrorCategory.TRANSPORT)).toBe(
      true
    );
  });

  it("createError() builds an SdkError from registry metadata", () => {
    const err = ErrorRegistry.createError("SOROBAN_RPC_ERROR", {
      details: { url: "x" },
    });
    expect(err).toBeInstanceOf(SdkError);
    expect(err.code).toBe("SOROBAN_RPC_ERROR");
    expect(err.category).toBe(ErrorCategory.TRANSPORT);
    expect(err.recoverable).toBe(true);
    expect(err.details).toEqual({ url: "x" });
  });

  it("createError() lets callers override the message and recoverability", () => {
    const err = ErrorRegistry.createError("VALIDATION_ERROR", {
      message: "custom",
      recoverable: true,
    });
    expect(err.message).toBe("custom");
    expect(err.recoverable).toBe(true);
  });

  it("createSdkError() is an alias for ErrorRegistry.createError()", () => {
    const err = createSdkError("UNAUTHORIZED");
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.category).toBe(ErrorCategory.POLICY);
  });

  it("registers CONTRACT_ERROR under the Soroban module", () => {
    const def = ErrorRegistry.get("CONTRACT_ERROR");
    expect(def?.module).toBe(SdkModule.SOROBAN);
    expect(def?.category).toBe(ErrorCategory.SIMULATION);
  });
});

describe("Contract-specific failure arguments (#840)", () => {
  describe("parseContractError", () => {
    it("extracts the contract's own error code", () => {
      expect(parseContractError("Error(Contract, #12)")).toEqual({
        errorType: "Contract",
        contractCode: 12,
        rawDetail: "Error(Contract, #12)",
      });
    });

    it("extracts the contract id when the RPC reports one", () => {
      const parsed = parseContractError(
        "Error(Contract, #3) <contract CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM>"
      );
      expect(parsed?.contractCode).toBe(3);
      expect(parsed?.contractId).toBe(
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM"
      );
    });

    it("treats a non-contract host error's argument as a VM reason", () => {
      const parsed = parseContractError(
        "HostError: Error(WasmVm, InvalidAction)"
      );
      expect(parsed?.errorType).toBe("WasmVm");
      expect(parsed?.vmReason).toBe("InvalidAction");
      expect(parsed?.contractCode).toBeUndefined();
    });

    it("finds the host error inside a longer message", () => {
      expect(
        parseContractError(
          "HostError: Error(Contract, #7) while calling transfer"
        )?.contractCode
      ).toBe(7);
    });

    it("returns undefined for a non-host-error string", () => {
      expect(parseContractError("insufficient balance")).toBeUndefined();
    });

    it("returns undefined for an empty string", () => {
      expect(parseContractError("")).toBeUndefined();
    });
  });

  describe("contractError", () => {
    it("preserves the contract code in details", () => {
      const err = contractError("Error(Contract, #12)");
      expect(err.code).toBe("CONTRACT_ERROR");
      expect(err.category).toBe(ErrorCategory.SIMULATION);
      expect(err.details?.["contractCode"]).toBe(12);
    });

    it("includes the code in the message for humans", () => {
      expect(contractError("Error(Contract, #12)").message).toContain("#12");
    });

    it("accepts a pre-parsed detail", () => {
      const err = contractError("opaque text", {
        errorType: "Contract",
        contractCode: 5,
      });
      expect(err.details?.["contractCode"]).toBe(5);
    });

    it("keeps the raw text for an unparseable failure", () => {
      const err = contractError("something went wrong");
      expect(err.code).toBe("CONTRACT_ERROR");
      expect(err.details?.["rawDetail"]).toBe("something went wrong");
      expect(err.details?.["contractCode"]).toBeUndefined();
    });

    it("survives toJSON so the code crosses the wire", () => {
      const json = contractError("Error(Contract, #12)").toJSON();
      expect(json["code"]).toBe("CONTRACT_ERROR");
      expect((json["details"] as Record<string, unknown>)["contractCode"]).toBe(
        12
      );
    });
  });

  describe("contractErrorFromJSON", () => {
    it("restores the contract code from a serialized backend error", () => {
      const err = contractErrorFromJSON({
        code: "CONTRACT_ERROR",
        category: "SIMULATION",
        message: "Soroban contract failed",
        details: { contractCode: 12, errorType: "Contract" },
      });
      expect(err).toBeInstanceOf(SdkError);
      expect(err?.details?.["contractCode"]).toBe(12);
    });

    it("returns undefined for a non-contract error", () => {
      expect(
        contractErrorFromJSON({ code: "TRANSPORT_ERROR", message: "nope" })
      ).toBeUndefined();
    });

    it("returns undefined for a non-object payload", () => {
      expect(contractErrorFromJSON(null)).toBeUndefined();
      expect(contractErrorFromJSON("boom")).toBeUndefined();
    });

    it("round-trips a contract error through JSON without losing the code", () => {
      const original = contractError("Error(Contract, #42)");
      const restored = contractErrorFromJSON(
        JSON.parse(JSON.stringify(original))
      );
      expect(restored?.details?.["contractCode"]).toBe(42);
    });
  });
});
