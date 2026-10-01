/**
 * Regression tests for capital-vs-return attribution in PortfolioService.
 *
 * Before this change `PortfolioService` could only report `totalValue`, which
 * conflates money the user contributed with money the portfolio earned. These
 * tests pin the new attribution contract (contributed capital vs investment
 * return) and its boundaries: unpriced portfolios, zero contributed capital,
 * malformed flow amounts, and net withdrawals that exceed deposits.
 *
 * `stellarPrice.service` is mocked so the suite never reaches Horizon or Redis;
 * the attribution under test is pure arithmetic over `getPortfolio`'s value.
 */

import {
  computeReturnAttribution,
  summarizeContributedCapital,
  PortfolioService,
} from "../portfolioService";

jest.mock("../stellarPrice.service", () => ({
  __esModule: true,
  default: { getPrice: jest.fn() },
}));

const ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const FETCHED_AT = "2026-09-28T00:00:00.000Z";

describe("summarizeContributedCapital", () => {
  it("should net withdrawals out of deposits", () => {
    const summary = summarizeContributedCapital([
      { id: "d1", type: "deposit", amount: 1000, occurredAt: "2026-01-01T00:00:00.000Z" },
      { id: "d2", type: "deposit", amount: 500, occurredAt: "2026-02-01T00:00:00.000Z" },
      { id: "w1", type: "withdrawal", amount: 200, occurredAt: "2026-03-01T00:00:00.000Z" },
    ]);

    expect(summary).toEqual({
      contributedCapital: 1300,
      totalDeposits: 1500,
      totalWithdrawals: 200,
      flowCount: 3,
    });
  });

  it("should return zero for an empty flow list", () => {
    expect(summarizeContributedCapital([])).toEqual({
      contributedCapital: 0,
      totalDeposits: 0,
      totalWithdrawals: 0,
      flowCount: 0,
    });
  });

  it("should ignore malformed amounts instead of letting them distort attribution", () => {
    const summary = summarizeContributedCapital([
      { type: "deposit", amount: 100, occurredAt: "2026-01-01T00:00:00.000Z" },
      { type: "deposit", amount: -50, occurredAt: "2026-01-02T00:00:00.000Z" },
      { type: "deposit", amount: Number.NaN, occurredAt: "2026-01-03T00:00:00.000Z" },
      { type: "withdrawal", amount: 25, occurredAt: "2026-01-04T00:00:00.000Z" },
    ]);

    expect(summary).toEqual({
      contributedCapital: 75,
      totalDeposits: 100,
      totalWithdrawals: 25,
      flowCount: 2,
    });
  });
});

describe("computeReturnAttribution", () => {
  it("should separate contributed capital from investment return", () => {
    const attribution = computeReturnAttribution(
      1600,
      [
        { type: "deposit", amount: 1000, occurredAt: "2026-01-01T00:00:00.000Z" },
        { type: "deposit", amount: 500, occurredAt: "2026-02-01T00:00:00.000Z" },
        { type: "withdrawal", amount: 100, occurredAt: "2026-03-01T00:00:00.000Z" },
      ],
      "usd"
    );

    expect(attribution.currentValue).toBe(1600);
    expect(attribution.contributedCapital).toBe(1400);
    expect(attribution.investmentReturn).toBe(200);
    expect(attribution.returnOnCapital).toBeCloseTo(200 / 1400);
    expect(attribution.currency).toBe("USD");
  });

  it("should report a negative return when the portfolio is under water", () => {
    const attribution = computeReturnAttribution(900, [
      { type: "deposit", amount: 1200, occurredAt: "2026-01-01T00:00:00.000Z" },
    ]);

    expect(attribution.investmentReturn).toBe(-300);
    expect(attribution.returnOnCapital).toBeCloseTo(-0.25);
  });

  it("should attribute correctly when net withdrawals exceed deposits", () => {
    const attribution = computeReturnAttribution(30, [
      { type: "deposit", amount: 100, occurredAt: "2026-01-01T00:00:00.000Z" },
      { type: "withdrawal", amount: 120, occurredAt: "2026-02-01T00:00:00.000Z" },
    ]);

    expect(attribution.contributedCapital).toBe(-20);
    expect(attribution.investmentReturn).toBe(50);
    expect(attribution.returnOnCapital).toBeNull();
  });

  it("should return a null return when the portfolio could not be priced", () => {
    const attribution = computeReturnAttribution(null, [
      { type: "deposit", amount: 500, occurredAt: "2026-01-01T00:00:00.000Z" },
    ]);

    expect(attribution.currentValue).toBeNull();
    expect(attribution.contributedCapital).toBe(500);
    expect(attribution.investmentReturn).toBeNull();
    expect(attribution.returnOnCapital).toBeNull();
  });

  it("should not divide by zero when there is no contributed capital", () => {
    const attribution = computeReturnAttribution(100, []);

    expect(attribution.contributedCapital).toBe(0);
    expect(attribution.investmentReturn).toBe(100);
    expect(attribution.returnOnCapital).toBeNull();
  });

  it("should not mutate the caller's flow list", () => {
    const flows = [
      { type: "deposit" as const, amount: 10, occurredAt: "2026-01-01T00:00:00.000Z" },
    ];
    const attribution = computeReturnAttribution(12, flows);

    attribution.flows.push({
      type: "deposit",
      amount: 1,
      occurredAt: "2026-01-02T00:00:00.000Z",
    });

    expect(flows).toHaveLength(1);
  });
});

describe("PortfolioService.getPortfolioReturnAttribution", () => {
  it("should reuse getPortfolio and attribute its total value", async () => {
    const service = new PortfolioService();
    const getPortfolioSpy = jest.spyOn(service, "getPortfolio").mockResolvedValue({
      address: ADDRESS,
      currency: "USD",
      assets: [],
      totalValue: 2500,
      fetchedAt: FETCHED_AT,
    });

    const attribution = await service.getPortfolioReturnAttribution(
      ADDRESS,
      [{ type: "deposit", amount: 2000, occurredAt: "2026-01-01T00:00:00.000Z" }],
      "USD"
    );

    expect(getPortfolioSpy).toHaveBeenCalledWith(ADDRESS, "USD");
    expect(attribution).toMatchObject({
      address: ADDRESS,
      fetchedAt: FETCHED_AT,
      currency: "USD",
      currentValue: 2500,
      contributedCapital: 2000,
      investmentReturn: 500,
      returnOnCapital: 0.25,
      flowCount: 1,
    });
  });

  it("should propagate an unpriced portfolio as a null investment return", async () => {
    const service = new PortfolioService();
    jest.spyOn(service, "getPortfolio").mockResolvedValue({
      address: ADDRESS,
      currency: "USD",
      assets: [],
      totalValue: null,
      fetchedAt: FETCHED_AT,
    });

    const attribution = await service.getPortfolioReturnAttribution(ADDRESS, [
      { type: "deposit", amount: 200, occurredAt: "2026-01-01T00:00:00.000Z" },
    ]);

    expect(attribution.investmentReturn).toBeNull();
    expect(attribution.returnOnCapital).toBeNull();
  });
});
