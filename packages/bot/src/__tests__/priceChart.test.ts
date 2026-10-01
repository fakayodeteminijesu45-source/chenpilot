import { describe, it, expect, jest } from "@jest/globals";

jest.mock("chartjs-node-canvas", () => ({
  ChartJSNodeCanvas: jest.fn().mockImplementation(() => ({
    renderToBuffer: jest.fn().mockResolvedValue(
      // Return a 1024-byte fake PNG buffer (89 50 4E 47 = PNG signature, padded)
      Buffer.concat([
        Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
          0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
          0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
          0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
          0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
          0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ]),
        Buffer.alloc(1024 - 67, 0),
      ])
    ),
  })),
}));

jest.mock("axios");

import {
  PriceChartService,
  PriceDataPoint,
  TextSummaryOptions,
} from "../priceChart";

function buildDeterministicSeries(
  opts: {
    days?: number;
    startPrice: number;
    endPrice: number;
    volatility?: number;
    seed?: number;
  }
): PriceDataPoint[] {
  const days = opts.days ?? 8;
  const seed = opts.seed ?? 42;
  const volatility = opts.volatility ?? 0.01;
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const points: PriceDataPoint[] = [];

  // Simple seeded pseudo-random walk from startPrice to endPrice
  const driftPerStep = (opts.endPrice - opts.startPrice) / (days - 1);
  let rand = seed;
  const nextRand = () => {
    // Mulberry32-style fast PRNG
    rand = (rand + 0x6d2b79f5) >>> 0;
    let t = rand;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (let i = 0; i < days; i++) {
    const base = opts.startPrice + driftPerStep * i;
    const noise = (nextRand() - 0.5) * 2 * volatility * base;
    points.push({
      timestamp: now - (days - 1 - i) * dayMs,
      price: Math.max(0.000001, base + noise),
    });
  }
  return points;
}

describe("PriceChartService — #881 Text Alternatives / Chart Summaries", () => {
  let service: PriceChartService;

  beforeEach(() => {
    service = new PriceChartService();
  });

  describe("generateTextSummary() — core accessibility coverage", () => {
    it("includes all required fields for a known upward-trending dataset", () => {
      // Strong +8% move over 8 days — should classify as Upward
      const data = buildDeterministicSeries({
        startPrice: 0.2,
        endPrice: 0.216, // exactly +8%
        days: 8,
        volatility: 0,
      });

      const summary = service.generateTextSummary("XLM", data, {
        currency: "USD",
        days: 8,
        platform: "plain",
      });

      // Non-empty and mentions asset + currency
      expect(summary.length).toBeGreaterThan(100);
      expect(summary).toContain("XLM");
      expect(summary).toContain("USD");
      expect(summary).toContain("8 days");

      // Required accessible text alternative fields per issue #881:
      // 1. Current / end price
      const endPriceStr = data[data.length - 1].price.toFixed(6);
      expect(summary).toContain(endPriceStr);
      // 2. Period change % — positive for upward
      expect(summary).toContain("+8.00%");
      // 3. Period high / period low
      const high = Math.max(...data.map((d) => d.price));
      const low = Math.min(...data.map((d) => d.price));
      expect(summary).toContain(high.toFixed(6));
      expect(summary).toContain(low.toFixed(6));
      expect(summary).toMatch(/Period High:/i);
      expect(summary).toMatch(/Period Low:/i);
      // 4. Average price
      const avg =
        data.reduce((s, d) => s + d.price, 0) / data.length;
      expect(summary).toContain(avg.toFixed(6));
      expect(summary).toMatch(/Average/i);
      // 5. Trend label
      expect(summary).toContain("Upward");
      // 6. Key sample points: Start, Mid, End are mentioned
      expect(summary).toMatch(/Key Points/i);
      expect(summary).toMatch(/Start/i);
      expect(summary).toMatch(/Mid/i);
      expect(summary).toMatch(/End/i);
      // 7. Sample point count
      expect(summary).toContain(`${data.length} data points`);
    });

    it("classifies a downward dataset as Downward trend", () => {
      const data = buildDeterministicSeries({
        startPrice: 0.25,
        endPrice: 0.20, // -20%
        days: 8,
        volatility: 0,
        seed: 13,
      });

      const summary = service.generateTextSummary("USDC", data, {
        platform: "plain",
      });

      expect(summary).toContain("Downward");
      expect(summary).toContain("-20.00%");
    });

    it("classifies a small flat move as Sideways", () => {
      // Less than 1% difference — should be Sideways
      const data = buildDeterministicSeries({
        startPrice: 0.2,
        endPrice: 0.201, // +0.5%
        days: 8,
        volatility: 0.001,
        seed: 7,
      });

      const summary = service.generateTextSummary("USDC", data, {
        platform: "plain",
      });

      expect(summary).toContain("Sideways");
    });

    it("handles a single data point gracefully (no divide-by-zero, no crash)", () => {
      const single: PriceDataPoint[] = [
        { timestamp: Date.now(), price: 100 },
      ];

      const plain = service.generateTextSummary("SINGLE", single, {
        platform: "plain",
        currency: "BTC",
      });

      // Must not throw; must return something meaningful
      expect(plain.length).toBeGreaterThan(20);
      expect(plain).toContain("SINGLE");
      expect(plain).toContain("BTC");
      expect(plain).toContain("100");
      // With only one point, high/low/average/current are all same value
      expect(plain).toMatch(/Period High:/i);
      expect(plain).toMatch(/Period Low:/i);
      expect(plain).toMatch(/Average/i);
      expect(plain).toContain("0.00%"); // no possible change
    });

    it("handles empty dataset gracefully with 'no data' message", () => {
      const plain = service.generateTextSummary("EMPTY", [], {
        platform: "plain",
        currency: "XLM",
      });

      expect(plain).toContain("EMPTY");
      expect(plain).toContain("No price data available");
      expect(plain.length).toBeGreaterThan(20);
    });
  });

  describe("generateTextSummary() — platform formatting variants", () => {
    const data = buildDeterministicSeries({
      startPrice: 0.15,
      endPrice: 0.18,
      days: 7,
      volatility: 0.008,
    });
    const base: TextSummaryOptions = { currency: "USD", days: 7 };

    it("Discord variant uses markdown **bold** markers and emojis", () => {
      const discord = service.generateTextSummary("XLM", data, {
        ...base,
        platform: "discord",
      });

      // Discord markdown bold markers
      expect(discord).toContain("**");
      expect(discord).toContain("**Current Price:**");
      expect(discord).toContain("**Period High:**");
      expect(discord).toContain("**Period Low:**");
      expect(discord).toContain("**Average:**");
      // Key Points header bold
      expect(discord).toContain("**Key Points**");
      // Bullet list marker for key points
      expect(discord).toMatch(/• Start \(.*\):/);
      // Emojis expected in Discord output
      expect(discord).toMatch(/📊|📈|📉|➡️/);
      expect(discord).toMatch(/🔺|🔻/);
    });

    it("Telegram variant uses HTML <b> and <code>/<i> tags", () => {
      const tg = service.generateTextSummary("XLM", data, {
        ...base,
        platform: "telegram",
      });

      // HTML parse mode tags
      expect(tg).toContain("<b>");
      expect(tg).toContain("</b>");
      expect(tg).toContain("<b>Current Price:</b>");
      expect(tg).toContain("<b>Period High:</b>");
      expect(tg).toContain("<b>Period Low:</b>");
      expect(tg).toContain("<b>Average:</b>");
      // Italic footer
      expect(tg).toContain("<i>");
      expect(tg).toContain("</i>");
      // No markdown ** bold — Telegram doesn't use it
      expect(tg).not.toContain("**Current Price:**");
      // Emojis still present
      expect(tg).toMatch(/📊|📈|📉|➡️/);
    });

    it("Plain variant contains NO markup tokens (no **, no <b>, no <i>)", () => {
      const plain = service.generateTextSummary("XLM", data, {
        ...base,
        platform: "plain",
      });

      expect(plain).not.toContain("**");
      expect(plain).not.toContain("<b>");
      expect(plain).not.toContain("</b>");
      expect(plain).not.toContain("<i>");
      expect(plain).not.toContain("</i>");
      expect(plain).not.toContain("<code>");
      // But still has human-readable labels
      expect(plain).toMatch(/Current Price:/i);
      expect(plain).toMatch(/Period High:/i);
      expect(plain).toMatch(/Average/i);
    });

    it("defaults to plain formatting when platform not supplied", () => {
      const plain = service.generateTextSummary("XLM", data, {
        ...base,
        platform: undefined,
      });
      const explicitPlain = service.generateTextSummary("XLM", data, {
        ...base,
        platform: "plain",
      });

      // Identical output for default vs explicit plain
      expect(plain).toEqual(explicitPlain);
      expect(plain).not.toContain("**");
      expect(plain).not.toContain("<b>");
    });
  });

  describe("generateTextSummary() — volatility classification", () => {
    it("classifies High volatility when normalized range >= 15%", () => {
      // Build a dataset where max-min is huge relative to average
      const points: PriceDataPoint[] = [];
      const now = Date.now();
      const hourMs = 60 * 60 * 1000;
      const prices = [1, 1.5, 0.8, 1.8, 0.7, 1.3, 0.9, 1.2];
      // avg ≈ 1.15, range = 1.8-0.7 = 1.1, normalized ≈ 0.95 >> 0.15
      for (let i = 0; i < prices.length; i++) {
        points.push({
          timestamp: now - (prices.length - 1 - i) * hourMs,
          price: prices[i],
        });
      }
      const s = service.generateTextSummary("VOL", points, {
        platform: "plain",
      });
      expect(s).toContain("Volatility: High");
    });

    it("classifies Low volatility when normalized range < 5%", () => {
      const data = buildDeterministicSeries({
        startPrice: 1.0,
        endPrice: 1.01, // tiny drift
        days: 8,
        volatility: 0.001, // 0.1% per-step noise
        seed: 99,
      });
      const s = service.generateTextSummary("STABLE", data, {
        platform: "plain",
      });
      expect(s).toContain("Volatility: Low");
    });
  });

  describe("Integration-lite — full pipeline uses mock-data fallback (no network)", () => {
    // The backend price-history URL is mocked by axios errors, which fall back
    // to generateMockPriceData() inside fetchHistoricalPriceData().
    // We call generatePriceChart() which calls both fetch + generateChart,
    // then separately feed the same data through generateTextSummary().
    // This is the end-to-end text-alternative smoke test for #881.

    it("produces a non-empty text summary for any asset via built-in mock fallback", async () => {
      const asset = "MOCKCOIN";
      const currency = "USD";
      const days = 7;

      // Generate the chart image first — this internally fetches data via the
      // fallback mock path, so no backend/network is required.
      const chartBuffer = await service.generatePriceChart(
        asset,
        currency,
        days
      );

      // Buffer should be a valid PNG-ish size (> 1KB)
      expect(Buffer.isBuffer(chartBuffer)).toBe(true);
      expect(chartBuffer.length).toBeGreaterThan(512);

      // Now independently re-fetch using the same call path to get the data
      // for the text summary (this matches how Discord/Telegram refactor it:
      // fetch once, generate chart + summary from the same data).
      const priceData = await service.fetchHistoricalPriceData(
        asset,
        currency,
        days
      );

      expect(priceData.length).toBeGreaterThanOrEqual(days); // fallback generates days+1 points

      const summary = service.generateTextSummary(asset, priceData, {
        currency,
        days,
        platform: "discord",
      });

      // Text alternative is non-empty and carries the identity of what it's about
      expect(summary.length).toBeGreaterThan(200);
      expect(summary).toContain(asset);
      expect(summary).toContain(currency);
      expect(summary).toMatch(/\*\*Current Price:\*\*/);
      expect(summary).toMatch(/\*\*Period High:\*\*/);
      expect(summary).toMatch(/\*\*Period Low:\*\*/);
      expect(summary).toMatch(/\*\*Average:\*\*/);
      expect(summary).toMatch(/\*\*Trend:\*\*/i);
      // It either says data points sampled or references a timeframe
      expect(summary).toMatch(/data points sampled|days/);
    }, 15000);

    it("text summary + chart agree on current price (single source of truth)", async () => {
      const asset = "AGREEMENT";
      const currency = "XLM";
      const days = 5;

      const priceData = await service.fetchHistoricalPriceData(
        asset,
        currency,
        days
      );

      // Summary computed once from exact dataset
      const summary = service.generateTextSummary(asset, priceData, {
        currency,
        days,
        platform: "plain",
      });

      const lastPrice = priceData[priceData.length - 1].price;
      // Either 6-decimal or 4-decimal form of lastPrice must appear
      const forms = [
        lastPrice.toFixed(6),
        lastPrice.toFixed(4),
        lastPrice.toFixed(2),
      ];
      const mention = forms.some((f) => summary.includes(f));
      expect(mention).toBe(true);
    }, 15000);
  });

  describe("Backward compatibility — existing public API unchanged", () => {
    it("generatePriceChart() signature still works and returns a Buffer", async () => {
      const buf = await service.generatePriceChart("XLM", "USD", 3);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBeGreaterThan(512);
    }, 15000);

    it("getCurrentPrice() still throws or returns number (mock path tested)", async () => {
      // The real API isn't present in unit tests, so we expect it to throw
      // a clear "Could not fetch price" error (or fall back if we wired it).
      try {
        const p = await service.getCurrentPrice("NOTREAL");
        // If somehow a backend responded in tests, number is also valid
        expect(typeof p).toBe("number");
      } catch (e) {
        expect((e as Error).message).toContain("Could not fetch price");
      }
    }, 15000);

    it("getPriceChange() still returns a number via mock fallback", async () => {
      // fetchHistoricalPriceData is used internally and falls back to mocks
      const change = await service.getPriceChange("XLM", "USD", 24);
      expect(typeof change).toBe("number");
      expect(Number.isFinite(change)).toBe(true);
    }, 15000);

    it("generateChart() signature accepts same args without options", async () => {
      const data: PriceDataPoint[] = [
        { timestamp: Date.now() - 86400000, price: 1.0 },
        { timestamp: Date.now(), price: 1.1 },
      ];
      const buf = await service.generateChart("FOO", data);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBeGreaterThan(512);
    });
  });
});
