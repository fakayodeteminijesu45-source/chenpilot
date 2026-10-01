# Chart Text Alternatives Implementation Plan (Issue #881)

## Repository Research

### Current Behavior

**Price Chart Service** (`packages/bot/src/priceChart.ts`):
- `PriceChartService` generates static chart images using `chartjs-node-canvas`
- Has methods: `fetchHistoricalPriceData()`, `generateChart()`, `generatePriceChart()`, `getCurrentPrice()`, `getPriceChange()`
- **No dedicated text alternative generation method exists** - all output is chart-focused
- Data model: `PriceDataPoint[]` with `{ timestamp, price }`

**Discord Integration** (`packages/bot/src/adapters/discord.ts`, lines ~1147-1204):
- Legacy `!price` command exists and sends:
  - A text header with: Current Price (6 decimals), 24h Change %, Period (days)
  - A PNG chart image as attachment
- **Missing**: No detailed text alternative describing chart content (high/low/average, trend direction, key pivot points)
- **Missing**: No `/price` slash command definition or handler in `slashCommands.ts`
- **Missing**: `handleSlashCommand()` is referenced at line 391 but not defined in the file

**Telegram Integration** (`packages/bot/src/adapters/telegram.ts`):
- **Missing**: No price chart command at all
- No chart generation or price history functionality

**Market Overview Service** (`packages/bot/src/marketOverview.ts`):
- Good pattern to follow: has separate `formatForDiscord()` and `formatForTelegram()` methods
- Produces rich, structured text summaries of market data

**Test Infrastructure**:
- Root `jest.config.js` configured for `**/*.test.ts` with ts-jest
- Existing bot tests in `packages/bot/src/__tests__/` (swapWizard, callbackUtils) use Jest with `@jest/globals`
- Bot `package.json` test script is a placeholder (`echo "Error: no test specified"`) — root-level `npm test` will pick up bot tests via glob

### Constraints and Considerations
- The `!price` command already has minimal text (price + 24h change + period); it needs to be expanded to a full accessible text alternative
- Text alternative should work alongside the chart (not replace it) for visual users
- Text alternative must be comprehensive enough to stand alone (for screen readers, users with images disabled, or accessibility requirements)
- Follow the existing platform-specific formatting pattern (Discord markdown vs Telegram HTML)
- Preserve existing public API: `generateChart`, `generatePriceChart`, `getCurrentPrice`, `getPriceChange` signatures unchanged

---

## Files and Modules

| File | Expected Change |
|------|-----------------|
| `packages/bot/src/priceChart.ts` | Add `generateTextSummary(assetCode, priceData, currency, days)` method and platform-specific formatters |
| `packages/bot/src/adapters/discord.ts` | Expand `!price` command text content using new text summary method; add `handleSlashCommand` with `/price` handler if referenced |
| `packages/bot/src/adapters/telegram.ts` | Add `/price` bot command with chart + text alternative |
| `packages/bot/src/slashCommands.ts` | Add `/price` slash command definition |
| `packages/bot/src/__tests__/priceChart.test.ts` | New file: focused regression/integration tests for text alternative |
| `packages/bot/package.json` | Update test script placeholder to `jest` (optional, for consistency) |

---

## Implementation Steps

### Step 1: Add Text Summary Generation to `PriceChartService`
1.1. Add interface `TextSummaryOptions { currency?: string; days?: number; platform?: 'discord' | 'telegram' | 'plain' }`

1.2. Add public method `generateTextSummary(assetCode: string, priceData: PriceDataPoint[], options?: TextSummaryOptions): string` that computes and formats:
   - **Period header**: Asset code, date range, currency, number of days
   - **Current price**: Latest data point (matches `getCurrentPrice`)
   - **24h / period change**: % change from first → last data point
   - **Period high/low**: Max/min price in the dataset with timestamps
   - **Average price**: Mean of all prices
   - **Trend description**: "Upward", "Downward", or "Sideways" based on linear regression or simple start/end + volatility heuristic
   - **Volatility indicator**: High/Medium/Low based on normalized range
   - **Key sample points**: Start, midpoint, end prices (for narrative flow)

1.3. Add three private formatting helpers:
   - `formatForDiscord(summaryData)`: Bold `**`, markdown bullets, emojis 📊📈📉🔺🔻
   - `formatForTelegram(summaryData)`: HTML `<b>`, `<code>` tags, same emojis
   - `formatPlain(summaryData)`: No formatting tokens (fallback)

1.4. Keep all existing public methods (`generateChart`, `generatePriceChart`, `getCurrentPrice`, `getPriceChange`) unchanged — no breaking API changes.

### Step 2: Enhance Discord `!price` Command
2.1. Replace the current 3-line text block with the full output of `generateTextSummary(..., { platform: 'discord', currency, days })`

2.2. Keep the chart attachment — text alternative supplements (not replaces) the visual chart.

2.3. Add the missing `handleSlashCommand` method referenced at line 391. Implement it as a `switch`/lookup over `interaction.commandName`, routing each existing slash command to the same logic as its legacy counterpart. For `/price`, replicate the `!price` logic using the new text summary.

### Step 3: Add Telegram Price Chart Command
3.1. Import `PriceChartService` and instantiate in the `TelegramAdapter` constructor (pattern matching Discord adapter).

3.2. Register a `bot.command('price', ...)` handler that:
   - Parses args: `<assetCode> [currency] [days]`
   - Validates currency against `SUPPORTED_CURRENCIES` (or define locally)
   - Fetches data via `priceChartService.generatePriceChart()` and `getCurrentPrice()`, `getPriceChange()`
   - Calls `generateTextSummary(..., { platform: 'telegram' })` for the text body
   - Sends: text message with `parse_mode: 'HTML'` + `document` / `photo` attachment of the chart buffer

### Step 4: Add `/price` Slash Command Definition
4.1. Append to `slashCommandDefinitions` in `slashCommands.ts`:
   - Name: `price`, Description: "View price chart and historical data for an asset"
   - Required string option `asset`
   - Optional string `currency` with 3 choices
   - Optional integer `days` min 1 max 90 default 7

### Step 5: Create Focused Regression Tests
5.1. New file `packages/bot/src/__tests__/priceChart.test.ts`

5.2. Test suite:
   - Unit: `generateTextSummary` with deterministic mock `PriceDataPoint[]`
     - **Must include**: Assert presence of current price, period high, period low, average, change %, trend label — the "text alternative" coverage
     - Assert platform variants: Discord contains `**`, Telegram contains `<b>`, plain contains neither
     - Assert trend classification (upward data → "Upward", etc.)
     - Assert single-point edge case gracefully handled
   - Unit: `formatNumber` style helpers if extracted
   - Integration-lite: `generateTextSummary + generatePriceChart` end-to-end using the built-in mock-data fallback (no network), confirming text summary is non-empty and contains asset code + currency

5.3. Tests use `@jest/globals` `{ describe, it, expect }` to match existing bot test style.

### Step 6: Validation
6.1. Run root `npm test -- packages/bot/src/__tests__/priceChart.test.ts` — all new tests green.
6.2. Run existing bot tests: `npm test -- packages/bot/src/__tests__/` — no regressions.
6.3. Run `npm run build:check` (tsc --noEmit) — no TypeScript errors in modified files.

---

## Dependencies and Considerations
- **chartjs-node-canvas**: Already in bot `package.json`. Reuse; no new runtime dependencies.
- **axios**: Already used for price fetching. New text summary operates on already-fetched data.
- **Platform formatting consistency**: Follow `MarketOverviewService` conventions exactly (Discord `**bold**`, Telegram `<b>bold</b>`).
- **Accessibility requirement**: The text summary is a *functional equivalent* of the chart — a user relying on text alone should be able to grasp the period's price action.
- **Backward compatibility**: All existing public methods on `PriceChartService` keep their signatures; callers not using the new method see no behavior change.

---

## Validation
- **New test file**: `packages/bot/src/__tests__/priceChart.test.ts` passes all assertions
- **Existing tests**: `swapWizard.test.ts`, `callbackUtils.test.ts`, `botContext.test.ts` still pass
- **TypeScript**: `tsc --noEmit` succeeds on `packages/bot`
- **Spot checks** (non-automated, pre-approval documented intent):
  - `generateTextSummary` output for a known upward-trending mock contains "Upward" + high/low + average
  - Discord output includes `**High:**`, `**Low:**`, `**Average:**` markers
  - Telegram output includes `<b>High:</b>`, `<b>Low:</b>`, `<b>Average:</b>` markers

---

## Risks
| Risk | Handling / Fallback |
|------|---------------------|
| Trend / volatility heuristics misclassified on edge-case data | Use conservative thresholds; label ambiguous cases "Sideways". Tests include edge-case fixtures. |
| Chart buffer fetch fails but text summary is ready | Always send text summary first; attach chart only if buffer successfully generated. Error path already exists in Discord. |
| Telegram photo/document API limits PNG size | Use `chartjs-node-canvas` default (800×400) which is well under Telegram limits. Mirror Discord's chart buffer size. |
| `handleSlashCommand` missing definition breaks slash commands | Add the method with all existing commands routed, matching legacy logic exactly — only `/price` is new behavior. |
| Bot package.json test placeholder causes `npm test` to skip bot tests | Root-level jest config already matches `**/*.test.ts` from `<rootDir>`, so new file will be picked up without bot-level script change. |
