import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import axios from 'axios';

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3000";

/**
 * Price data point for chart generation
 */
export interface PriceDataPoint {
  timestamp: number;
  price: number;
}

/**
 * Chart generation options
 */
export interface ChartOptions {
  width?: number;
  height?: number;
  backgroundColor?: string;
  lineColor?: string;
  showGrid?: boolean;
  showPoints?: boolean;
}

/**
 * Options for generating a text summary of price data
 */
export interface TextSummaryOptions {
  currency?: string;
  days?: number;
  platform?: 'discord' | 'telegram' | 'plain';
}

/**
 * Computed summary data derived from price data points
 */
interface PriceSummaryData {
  assetCode: string;
  currency: string;
  days: number;
  startDate: string;
  endDate: string;
  currentPrice: number;
  startPrice: number;
  periodChangePct: number;
  periodHigh: { price: number; date: string };
  periodLow: { price: number; date: string };
  averagePrice: number;
  trend: 'Upward' | 'Downward' | 'Sideways';
  volatility: 'High' | 'Medium' | 'Low';
  midPrice: number;
  midDate: string;
  numPoints: number;
}

/**
 * Service for generating static price charts for assets
 */
export class PriceChartService {
  private chartRenderer: ChartJSNodeCanvas;
  private defaultWidth: number = 800;
  private defaultHeight: number = 400;

  constructor() {
    this.chartRenderer = new ChartJSNodeCanvas({
      width: this.defaultWidth,
      height: this.defaultHeight,
      chartCallback: (ChartJS: { defaults: { font: { family: string }; color: string } }) => {
        // Custom chart configuration if needed
        ChartJS.defaults.font.family = 'Arial, sans-serif';
        ChartJS.defaults.color = '#ffffff';
      },
    });
  }

  /**
   * Fetch historical price data for an asset
   * @param assetCode - The asset code (e.g., XLM, USDC)
   * @param currency - The currency to quote in (default: USD)
   * @param days - Number of days of historical data (default: 7)
   * @returns Array of price data points
   */
  async fetchHistoricalPriceData(
    assetCode: string,
    currency: string = 'USD',
    days: number = 7
  ): Promise<PriceDataPoint[]> {
    try {
      const response = await axios.get(
        `${BACKEND_URL}/api/price/${assetCode}/history?currency=${currency}&days=${days}`
      );

      if (!response.data || !Array.isArray(response.data.data)) {
        // Fallback: generate mock data if API doesn't support history endpoint
        return this.generateMockPriceData(days);
      }

      return response.data.data.map((point: { timestamp: string; price: number }) => ({
        timestamp: new Date(point.timestamp).getTime(),
        price: point.price,
      }));
    } catch (error) {
      console.error(`Failed to fetch historical price data for ${assetCode}:`, error);
      // Fallback to mock data
      return this.generateMockPriceData(days);
    }
  }

  /**
   * Generate mock price data for testing/fallback
   * @param days - Number of days of data to generate
   * @returns Array of mock price data points
   */
  private generateMockPriceData(days: number): PriceDataPoint[] {
    const data: PriceDataPoint[] = [];
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    
    // Start with a base price and generate random walk
    let basePrice = 0.15 + Math.random() * 0.1;
    
    for (let i = days; i >= 0; i--) {
      const timestamp = now - (i * dayMs);
      // Random walk with some volatility
      const change = (Math.random() - 0.5) * 0.02;
      basePrice = Math.max(0.01, basePrice + change);
      
      data.push({
        timestamp,
        price: basePrice,
      });
    }
    
    return data;
  }

  /**
   * Generate a static price chart image
   * @param assetCode - The asset code
   * @param priceData - Array of price data points
   * @param options - Chart generation options
   * @returns Buffer containing the chart image
   */
  async generateChart(
    assetCode: string,
    priceData: PriceDataPoint[],
    options: ChartOptions = {}
  ): Promise<Buffer> {
    const {
      width = this.defaultWidth,
      height = this.defaultHeight,
      lineColor = '#00d4ff',
      showGrid = true,
      showPoints = true,
    } = options;

    // Update renderer dimensions if custom size provided
    if (width !== this.defaultWidth || height !== this.defaultHeight) {
      this.chartRenderer = new ChartJSNodeCanvas({ width, height });
    }

    const labels = priceData.map(point => 
      new Date(point.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    );
    const prices = priceData.map(point => point.price);

    // Calculate price range for better visualization
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const priceRange = maxPrice - minPrice;
    const padding = priceRange * 0.1;

    const configuration = {
      type: 'line' as const,
      data: {
        labels,
        datasets: [
          {
            label: `${assetCode} Price`,
            data: prices,
            borderColor: lineColor,
            backgroundColor: lineColor + '20', // Add transparency
            borderWidth: 3,
            fill: true,
            tension: 0.4, // Smooth curves
            pointRadius: showPoints ? 4 : 0,
            pointBackgroundColor: lineColor,
            pointBorderColor: '#ffffff',
            pointBorderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            labels: {
              color: '#ffffff',
              font: {
                size: 14,
                weight: 'bold' as const,
              },
            },
          },
          title: {
            display: true,
            text: `${assetCode} Price Chart`,
            color: '#ffffff',
            font: {
              size: 18,
              weight: 'bold' as const,
            },
          },
          tooltip: {
            mode: 'index' as const,
            intersect: false,
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            titleColor: '#ffffff',
            bodyColor: '#ffffff',
            borderColor: lineColor,
            borderWidth: 1,
          },
        },
        scales: {
          x: {
            display: true,
            grid: {
              display: showGrid,
              color: 'rgba(255, 255, 255, 0.1)',
            },
            ticks: {
              color: '#ffffff',
              maxRotation: 45,
              minRotation: 45,
            },
          },
          y: {
            display: true,
            grid: {
              display: showGrid,
              color: 'rgba(255, 255, 255, 0.1)',
            },
            ticks: {
              color: '#ffffff',
              callback: (value: string | number) => typeof value === 'number' ? `$${value.toFixed(4)}` : value,
            },
            min: minPrice - padding,
            max: maxPrice + padding,
          },
        },
        layout: {
          padding: {
            top: 20,
            right: 20,
            bottom: 20,
            left: 20,
          },
        },
      },
    };

    const imageBuffer = await this.chartRenderer.renderToBuffer(configuration);
    return imageBuffer;
  }

  /**
   * Generate a price chart with automatic data fetching
   * @param assetCode - The asset code
   * @param currency - The currency to quote in (default: USD)
   * @param days - Number of days of historical data (default: 7)
   * @param options - Chart generation options
   * @returns Buffer containing the chart image
   */
  async generatePriceChart(
    assetCode: string,
    currency: string = 'USD',
    days: number = 7,
    options: ChartOptions = {}
  ): Promise<Buffer> {
    const priceData = await this.fetchHistoricalPriceData(assetCode, currency, days);
    return this.generateChart(assetCode, priceData, options);
  }

  /**
   * Get current price for an asset
   * @param assetCode - The asset code
   * @param currency - The currency to quote in (default: USD)
   * @returns Current price
   */
  async getCurrentPrice(assetCode: string, currency: string = 'USD'): Promise<number> {
    try {
      const response = await axios.get(
        `${BACKEND_URL}/api/price/${assetCode}?currency=${currency}`
      );
      return response.data.price;
    } catch (error) {
      console.error(`Failed to fetch current price for ${assetCode}:`, error);
      throw new Error(`Could not fetch price for ${assetCode}`);
    }
  }

  /**
   * Get price change percentage over a period
   * @param assetCode - The asset code
   * @param currency - The currency to quote in (default: USD)
   * @param hours - Number of hours to calculate change over (default: 24)
   * @returns Price change percentage
   */
  async getPriceChange(
    assetCode: string,
    currency: string = 'USD',
    hours: number = 24
  ): Promise<number> {
    try {
      const priceData = await this.fetchHistoricalPriceData(assetCode, currency, Math.ceil(hours / 24));
      
      if (priceData.length < 2) {
        return 0;
      }

      const oldestPrice = priceData[0].price;
      const newestPrice = priceData[priceData.length - 1].price;
      
      return ((newestPrice - oldestPrice) / oldestPrice) * 100;
    } catch (error) {
      console.error(`Failed to calculate price change for ${assetCode}:`, error);
      return 0;
    }
  }

  /**
   * Generate a comprehensive text alternative / summary for price chart data.
   * Provides a functional equivalent of the chart for accessibility contexts.
   * @param assetCode - The asset code (e.g., XLM, USDC)
   * @param priceData - Array of price data points
   * @param options - Summary options (currency, days, platform formatting)
   * @returns Formatted text summary
   */
  generateTextSummary(
    assetCode: string,
    priceData: PriceDataPoint[],
    options: TextSummaryOptions = {}
  ): string {
    const summary = this.computeSummaryData(assetCode, priceData, options);

    switch (summary.platform) {
      case 'discord':
        return this.formatSummaryForDiscord(summary);
      case 'telegram':
        return this.formatSummaryForTelegram(summary);
      case 'plain':
      default:
        return this.formatSummaryPlain(summary);
    }
  }

  /**
   * Compute numeric summary statistics from raw price data.
   */
  private computeSummaryData(
    assetCode: string,
    priceData: PriceDataPoint[],
    options: TextSummaryOptions
  ): PriceSummaryData & { platform: NonNullable<TextSummaryOptions['platform']> | 'plain' } {
    const currency = options.currency ?? 'USD';
    const platform = options.platform ?? 'plain';
    const numPoints = priceData.length;

    if (numPoints === 0) {
      const now = new Date();
      const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return {
        assetCode,
        currency,
        days: options.days ?? 0,
        startDate: dateStr,
        endDate: dateStr,
        currentPrice: 0,
        startPrice: 0,
        periodChangePct: 0,
        periodHigh: { price: 0, date: dateStr },
        periodLow: { price: 0, date: dateStr },
        averagePrice: 0,
        trend: 'Sideways',
        volatility: 'Low',
        midPrice: 0,
        midDate: dateStr,
        numPoints: 0,
        platform,
      };
    }

    const fmtDate = (ts: number) =>
      new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const startPoint = priceData[0];
    const endPoint = priceData[numPoints - 1];
    const midIndex = Math.floor(numPoints / 2);
    const midPoint = priceData[midIndex];

    const startPrice = startPoint.price;
    const currentPrice = endPoint.price;
    const prices = priceData.map((p) => p.price);
    const maxPrice = Math.max(...prices);
    const minPrice = Math.min(...prices);
    const avgPrice = prices.reduce((a, b) => a + b, 0) / numPoints;

    const highPoint = priceData.find((p) => p.price === maxPrice) ?? endPoint;
    const lowPoint = priceData.find((p) => p.price === minPrice) ?? startPoint;

    const periodChangePct =
      startPrice > 0 ? ((currentPrice - startPrice) / startPrice) * 100 : 0;

    // Trend: direction + magnitude check against noise
    let trend: PriceSummaryData['trend'] = 'Sideways';
    const absChange = Math.abs(periodChangePct);
    if (absChange >= 3) {
      trend = periodChangePct >= 0 ? 'Upward' : 'Downward';
    } else if (absChange >= 1) {
      // Use midpoint as a tie-breaker for mild moves
      if (currentPrice > startPrice && currentPrice > midPoint.price) trend = 'Upward';
      else if (currentPrice < startPrice && currentPrice < midPoint.price) trend = 'Downward';
    }

    // Volatility: normalized range over average
    const normalizedRange = avgPrice > 0 ? (maxPrice - minPrice) / avgPrice : 0;
    let volatility: PriceSummaryData['volatility'] = 'Low';
    if (normalizedRange >= 0.15) volatility = 'High';
    else if (normalizedRange >= 0.05) volatility = 'Medium';

    return {
      assetCode,
      currency,
      days: options.days ?? this.estimateDays(priceData),
      startDate: fmtDate(startPoint.timestamp),
      endDate: fmtDate(endPoint.timestamp),
      currentPrice,
      startPrice,
      periodChangePct,
      periodHigh: { price: maxPrice, date: fmtDate(highPoint.timestamp) },
      periodLow: { price: minPrice, date: fmtDate(lowPoint.timestamp) },
      averagePrice: avgPrice,
      trend,
      volatility,
      midPrice: midPoint.price,
      midDate: fmtDate(midPoint.timestamp),
      numPoints,
      platform,
    };
  }

  /**
   * Best-effort estimate of days covered by the dataset (used when caller omits days).
   */
  private estimateDays(priceData: PriceDataPoint[]): number {
    if (priceData.length < 2) return 0;
    const ms = priceData[priceData.length - 1].timestamp - priceData[0].timestamp;
    return Math.max(1, Math.round(ms / (24 * 60 * 60 * 1000)));
  }

  /**
   * Format price value with consistent decimal precision.
   */
  private fmtPrice(n: number): string {
    if (n >= 1000) return n.toFixed(2);
    if (n >= 1) return n.toFixed(4);
    return n.toFixed(6);
  }

  /**
   * Format percentage with sign.
   */
  private fmtPct(n: number): string {
    const s = n.toFixed(2);
    return n >= 0 ? `+${s}%` : `${s}%`;
  }

  /**
   * Trend emoji helper.
   */
  private trendEmoji(trend: PriceSummaryData['trend']): string {
    if (trend === 'Upward') return '📈';
    if (trend === 'Downward') return '📉';
    return '➡️';
  }

  /**
   * Discord-formatted summary using markdown bold and emojis.
   */
  private formatSummaryForDiscord(s: ReturnType<typeof this.computeSummaryData>): string {
    if (s.numPoints === 0) {
      return `📊 **${s.assetCode} Price Summary**\n\n⚠️ No price data available for the requested period.`;
    }

    const changeEmoji = s.periodChangePct >= 0 ? '🔺' : '🔻';

    let msg = `📊 **${s.assetCode} Price Summary** — ${s.days} day${s.days === 1 ? '' : 's'} (${s.startDate} → ${s.endDate})\n\n`;

    msg += `${this.trendEmoji(s.trend)} **Trend:** ${s.trend} | Volatility: **${s.volatility}**\n\n`;

    msg += `${changeEmoji} **Current Price:** ${this.fmtPrice(s.currentPrice)} ${s.currency}\n`;
    msg += `   **Period Change:** ${this.fmtPct(s.periodChangePct)}\n\n`;

    msg += `🔼 **Period High:** ${this.fmtPrice(s.periodHigh.price)} ${s.currency} (${s.periodHigh.date})\n`;
    msg += `🔽 **Period Low:**  ${this.fmtPrice(s.periodLow.price)} ${s.currency} (${s.periodLow.date})\n`;
    msg += `📏 **Average:**      ${this.fmtPrice(s.averagePrice)} ${s.currency}\n\n`;

    msg += `**Key Points**\n`;
    msg += `• Start (${s.startDate}): ${this.fmtPrice(s.startPrice)} ${s.currency}\n`;
    msg += `• Mid   (${s.midDate}): ${this.fmtPrice(s.midPrice)} ${s.currency}\n`;
    msg += `• End   (${s.endDate}): ${this.fmtPrice(s.currentPrice)} ${s.currency}\n\n`;

    msg += `*${s.numPoints} data points sampled • Data from Chen Pilot*`;

    return msg;
  }

  /**
   * Telegram-formatted summary using HTML parse mode tags and emojis.
   */
  private formatSummaryForTelegram(s: ReturnType<typeof this.computeSummaryData>): string {
    if (s.numPoints === 0) {
      return `📊 <b>${s.assetCode} Price Summary</b>\n\n⚠️ No price data available for the requested period.`;
    }

    const changeEmoji = s.periodChangePct >= 0 ? '🔺' : '🔻';

    let msg = `📊 <b>${s.assetCode} Price Summary</b> — ${s.days} day${s.days === 1 ? '' : 's'} (${s.startDate} → ${s.endDate})\n\n`;

    msg += `${this.trendEmoji(s.trend)} <b>Trend:</b> ${s.trend} | Volatility: <b>${s.volatility}</b>\n\n`;

    msg += `${changeEmoji} <b>Current Price:</b> ${this.fmtPrice(s.currentPrice)} ${s.currency}\n`;
    msg += `   <b>Period Change:</b> ${this.fmtPct(s.periodChangePct)}\n\n`;

    msg += `🔼 <b>Period High:</b> ${this.fmtPrice(s.periodHigh.price)} ${s.currency} (${s.periodHigh.date})\n`;
    msg += `🔽 <b>Period Low:</b>  ${this.fmtPrice(s.periodLow.price)} ${s.currency} (${s.periodLow.date})\n`;
    msg += `📏 <b>Average:</b>      ${this.fmtPrice(s.averagePrice)} ${s.currency}\n\n`;

    msg += `<b>Key Points</b>\n`;
    msg += `• Start (${s.startDate}): ${this.fmtPrice(s.startPrice)} ${s.currency}\n`;
    msg += `• Mid   (${s.midDate}): ${this.fmtPrice(s.midPrice)} ${s.currency}\n`;
    msg += `• End   (${s.endDate}): ${this.fmtPrice(s.currentPrice)} ${s.currency}\n\n`;

    msg += `<i>${s.numPoints} data points sampled • Data from Chen Pilot</i>`;

    return msg;
  }

  /**
   * Plain-text formatted summary with no markup tokens (fallback).
   */
  private formatSummaryPlain(s: ReturnType<typeof this.computeSummaryData>): string {
    if (s.numPoints === 0) {
      return `${s.assetCode} Price Summary\n\nNo price data available for the requested period.`;
    }

    const changeEmoji = s.periodChangePct >= 0 ? '+' : '-';

    let msg = `${s.assetCode} Price Summary — ${s.days} day${s.days === 1 ? '' : 's'} (${s.startDate} -> ${s.endDate})\n\n`;

    msg += `Trend: ${s.trend} | Volatility: ${s.volatility}\n\n`;

    msg += `${changeEmoji} Current Price: ${this.fmtPrice(s.currentPrice)} ${s.currency}\n`;
    msg += `   Period Change: ${this.fmtPct(s.periodChangePct)}\n\n`;

    msg += `Period High: ${this.fmtPrice(s.periodHigh.price)} ${s.currency} (${s.periodHigh.date})\n`;
    msg += `Period Low:  ${this.fmtPrice(s.periodLow.price)} ${s.currency} (${s.periodLow.date})\n`;
    msg += `Average:      ${this.fmtPrice(s.averagePrice)} ${s.currency}\n\n`;

    msg += `Key Points\n`;
    msg += `- Start (${s.startDate}): ${this.fmtPrice(s.startPrice)} ${s.currency}\n`;
    msg += `- Mid   (${s.midDate}): ${this.fmtPrice(s.midPrice)} ${s.currency}\n`;
    msg += `- End   (${s.endDate}): ${this.fmtPrice(s.currentPrice)} ${s.currency}\n\n`;

    msg += `${s.numPoints} data points sampled • Data from Chen Pilot`;

    return msg;
  }
}
