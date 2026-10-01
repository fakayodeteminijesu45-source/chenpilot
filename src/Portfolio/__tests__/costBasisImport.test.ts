/**
 * Regression tests for CostBasisImportService — Issue #862
 *
 * Covers:
 *  - Happy-path: provenance is stamped on every lot
 *  - Content checksum is computed from raw payload bytes
 *  - Lot fields are normalised (asset code uppercased, whitespace trimmed)
 *  - remainingQuantity is initialised to quantity
 *  - status is initialised to "open"
 *  - All lots in a batch share the same provenance
 *  - Validation rejects non-positive quantity
 *  - Validation rejects negative unit cost
 *  - Validation rejects unsupported currency
 *  - Validation rejects future acquisition dates
 *  - Validation rejects missing accountId
 *  - Empty array is rejected
 *  - Validation is all-or-nothing: no lots are returned if any row is invalid
 *  - acquisitionTxId is preserved when provided and absent when not
 *  - Deterministic IDs via idFactory override
 */

import { CostBasisImportService, CostBasisImportValidationError, ImportOptions } from "../costBasisImport.service";
import { CostBasisImportRow } from "../costBasis";
import * as crypto from "crypto";

// ── Helpers ───────────────────────────────────────────────────────────────────

const PAST_DATE = "2024-01-15T10:00:00.000Z";
const FUTURE_DATE = "2099-01-01T00:00:00.000Z";

function makeRow(overrides: Partial<CostBasisImportRow> = {}): CostBasisImportRow {
  return {
    accountId: "GABC1234",
    assetCode: "usdc",
    assetIssuer: "GCBC...ISSUER",
    quantity: "100.0000000",
    unitCostBasis: "1.0000000",
    costCurrency: "USD",
    acquiredAt: PAST_DATE,
    ...overrides,
  };
}

function makeOptions(overrides: Partial<ImportOptions> = {}): ImportOptions {
  return {
    sourceSystem: "csv_upload",
    sourceRef: "s3://imports/2024/q1.csv",
    importedBy: "user-42",
    note: "Q1 reconciliation",
    // Pin the clock and IDs so assertions are deterministic
    now: new Date("2025-03-01T12:00:00.000Z"),
    idFactory: (() => {
      let n = 0;
      return () => `lot-${++n}`;
    })(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CostBasisImportService", () => {
  let service: CostBasisImportService;

  beforeEach(() => {
    service = new CostBasisImportService();
  });

  describe("happy path — single lot", () => {
    it("returns a lot with all provenance fields populated", () => {
      const [lot] = service.importLots([makeRow()], makeOptions());

      expect(lot.provenance).toEqual({
        sourceSystem: "csv_upload",
        sourceRef: "s3://imports/2024/q1.csv",
        importedBy: "user-42",
        importedAt: "2025-03-01T12:00:00.000Z",
        note: "Q1 reconciliation",
      });
    });

    it("initialises remainingQuantity equal to quantity", () => {
      const [lot] = service.importLots([makeRow({ quantity: "250.5000000" })], makeOptions());
      expect(lot.remainingQuantity).toBe("250.5000000");
      expect(lot.quantity).toBe("250.5000000");
    });

    it("initialises status to 'open'", () => {
      const [lot] = service.importLots([makeRow()], makeOptions());
      expect(lot.status).toBe("open");
    });

    it("normalises assetCode to uppercase and trims whitespace", () => {
      const [lot] = service.importLots([makeRow({ assetCode: "  usdc  " })], makeOptions());
      expect(lot.assetCode).toBe("USDC");
    });

    it("normalises costCurrency to uppercase", () => {
      const [lot] = service.importLots([makeRow({ costCurrency: "usd" })], makeOptions());
      expect(lot.costCurrency).toBe("USD");
    });

    it("preserves acquisitionTxId when present", () => {
      const [lot] = service.importLots(
        [makeRow({ acquisitionTxId: "abc123txhash" })],
        makeOptions(),
      );
      expect(lot.acquisitionTxId).toBe("abc123txhash");
    });

    it("omits acquisitionTxId when not provided", () => {
      const [lot] = service.importLots([makeRow()], makeOptions());
      expect("acquisitionTxId" in lot).toBe(false);
    });

    it("uses the id factory to assign stable lot IDs", () => {
      let counter = 0;
      const options = makeOptions({ idFactory: () => `fixed-${++counter}` });
      const [lot] = service.importLots([makeRow()], options);
      expect(lot.id).toBe("fixed-1");
    });
  });

  describe("batch — multiple lots share provenance", () => {
    it("all lots in one import share the same provenance object values", () => {
      const rows = [makeRow(), makeRow({ assetCode: "XLM", assetIssuer: "" })];
      const lots = service.importLots(rows, makeOptions());
      expect(lots).toHaveLength(2);
      // Provenance must be identical across the batch
      expect(lots[0].provenance).toEqual(lots[1].provenance);
    });

    it("assigns a unique ID to each lot", () => {
      const rows = [makeRow(), makeRow(), makeRow()];
      const lots = service.importLots(rows, makeOptions());
      const ids = lots.map((l) => l.id);
      expect(new Set(ids).size).toBe(3);
    });
  });

  describe("content checksum", () => {
    it("computes SHA-256 of rawPayload and records it in provenance", () => {
      const payload = "assetCode,quantity\nUSDC,100";
      const expected = crypto.createHash("sha256").update(payload, "utf8").digest("hex");
      const options = makeOptions({ rawPayload: payload });
      const [lot] = service.importLots([makeRow()], options);
      expect(lot.provenance.contentChecksum).toBe(expected);
    });

    it("accepts a Buffer rawPayload", () => {
      const buf = Buffer.from("USDC,100", "utf8");
      const expected = crypto.createHash("sha256").update(buf).digest("hex");
      const options = makeOptions({ rawPayload: buf });
      const [lot] = service.importLots([makeRow()], options);
      expect(lot.provenance.contentChecksum).toBe(expected);
    });

    it("omits contentChecksum when rawPayload is not provided", () => {
      const [lot] = service.importLots([makeRow()], makeOptions());
      expect("contentChecksum" in lot.provenance).toBe(false);
    });
  });

  describe("sourceRef is optional", () => {
    it("omits sourceRef from provenance when not provided", () => {
      const options = makeOptions({ sourceRef: undefined });
      const [lot] = service.importLots([makeRow()], options);
      expect("sourceRef" in lot.provenance).toBe(false);
    });
  });

  describe("validation — rejection cases", () => {
    it("rejects an empty array", () => {
      expect(() => service.importLots([], makeOptions())).toThrow(
        "non-empty array",
      );
    });

    it("rejects a non-positive quantity", () => {
      expect(() =>
        service.importLots([makeRow({ quantity: "0" })], makeOptions()),
      ).toThrow(CostBasisImportValidationError);
    });

    it("rejects a negative quantity string", () => {
      expect(() =>
        service.importLots([makeRow({ quantity: "-10" })], makeOptions()),
      ).toThrow(CostBasisImportValidationError);
    });

    it("rejects a negative unit cost", () => {
      expect(() =>
        service.importLots([makeRow({ unitCostBasis: "-0.01" })], makeOptions()),
      ).toThrow(CostBasisImportValidationError);
    });

    it("allows zero unit cost (e.g. airdrop with $0 basis)", () => {
      const lots = service.importLots([makeRow({ unitCostBasis: "0" })], makeOptions());
      expect(lots).toHaveLength(1);
    });

    it("rejects an unsupported cost currency", () => {
      expect(() =>
        service.importLots([makeRow({ costCurrency: "DOGE" })], makeOptions()),
      ).toThrow(CostBasisImportValidationError);
    });

    it("rejects a future acquisition date", () => {
      expect(() =>
        service.importLots([makeRow({ acquiredAt: FUTURE_DATE })], makeOptions()),
      ).toThrow(CostBasisImportValidationError);
    });

    it("rejects an empty accountId", () => {
      expect(() =>
        service.importLots([makeRow({ accountId: "   " })], makeOptions()),
      ).toThrow(CostBasisImportValidationError);
    });

    it("rejects a malformed acquiredAt", () => {
      expect(() =>
        service.importLots([makeRow({ acquiredAt: "15/01/2024" })], makeOptions()),
      ).toThrow(CostBasisImportValidationError);
    });

    it("reports the row index in the error message", () => {
      // First row is valid; second row has a bad quantity.
      const rows = [makeRow(), makeRow({ quantity: "-5" })];
      expect(() => service.importLots(rows, makeOptions())).toThrow(/Row 1/);
    });
  });

  describe("all-or-nothing validation", () => {
    it("returns no lots when any row is invalid", () => {
      const rows = [makeRow(), makeRow({ quantity: "0" }), makeRow()];
      expect(() => service.importLots(rows, makeOptions())).toThrow(
        CostBasisImportValidationError,
      );
    });
  });

  describe("exchange_api source system", () => {
    it("records sourceSystem as exchange_api", () => {
      const options = makeOptions({ sourceSystem: "exchange_api", sourceRef: "job-789" });
      const [lot] = service.importLots([makeRow()], options);
      expect(lot.provenance.sourceSystem).toBe("exchange_api");
      expect(lot.provenance.sourceRef).toBe("job-789");
    });
  });

  describe("manual_entry source system", () => {
    it("allows manual entry without sourceRef", () => {
      const options = makeOptions({ sourceSystem: "manual_entry", sourceRef: undefined, note: "typo fix" });
      const [lot] = service.importLots([makeRow()], options);
      expect(lot.provenance.sourceSystem).toBe("manual_entry");
      expect("sourceRef" in lot.provenance).toBe(false);
      expect(lot.provenance.note).toBe("typo fix");
    });
  });

  describe("createdAt and updatedAt", () => {
    it("sets createdAt and updatedAt to the import timestamp", () => {
      const options = makeOptions({ now: new Date("2025-06-01T09:00:00.000Z") });
      const [lot] = service.importLots([makeRow()], options);
      expect(lot.createdAt).toBe("2025-06-01T09:00:00.000Z");
      expect(lot.updatedAt).toBe("2025-06-01T09:00:00.000Z");
    });
  });
});
