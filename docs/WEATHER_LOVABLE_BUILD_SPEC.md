# Weather Lab — Lovable Build Spec

Deterministic specification for the Weather Lab dashboard. Everything below is
implementable without further design decisions. The backend contract is stable
and already exists on branch `weather-us-translation-research`.

## 0. Architecture decision, and why

**Reuse the existing Lovable project. Do not create a second one.**

The recommendation was requested, so here is the reasoning rather than just the
answer. A separate Lovable project would need its own Supabase, which would
either duplicate the market collector or read across projects — and the collector
is the expensive, rate-limited part. Isolation is already achievable inside the
existing project without touching Sports Shadow:

- **Database isolation.** Every Weather Lab table is prefixed `weather_lab_` and
  shares no table, function, trigger or cron job with Sports Shadow. See
  `supabase/migrations/20260826180000_weather_lab_research_schema.sql`.
- **Route isolation.** The dashboard is a new route, `/weather-lab`. No existing
  route, component or server function is modified.
- **Read isolation.** The page calls only the new server functions listed in
  section 3. It must not import anything from `src/lib/sports-shadow/`.

The one genuine risk of sharing a project is an accidental edit to Sports Shadow
during a Lovable session. Mitigate by scoping every prompt to `/weather-lab` and
`weather_lab_*`, and by treating any diff touching `src/lib/sports-shadow/`,
`src/routes/sports-shadow.tsx` or a `sports_shadow_*` table as a defect.

## 1. Hard safety requirements

These are not styling preferences. A build that violates any of them is wrong.

- The page renders the badge **`PAPER / RESEARCH ONLY`** in the header, always
  visible, never behind a tab or scroll.
- The page displays **`LIVE_EXECUTION_IMPLEMENTED=false`** in the header.
- **No control may place, cancel, size or authorise a real order.** Do not build:
  a buy/sell button, an order form, an "enable live" toggle, a venue credential
  field, an API-key input, or a "go live" affordance of any kind.
- Permitted controls are read-only view state only: experiment selector,
  scenario selector, city filter, date-range filter, refresh.
- No component may accept or display a credential, private key or API key.

## 2. Route and file layout

| Path | Purpose |
|---|---|
| `src/routes/weather-lab.tsx` | The dashboard route. |
| `src/lib/weather-lab/dashboard.server.ts` | Server functions in section 3. |
| `src/components/weather-lab/*` | Presentational components. |

Match the existing app conventions: TanStack Start `createServerFn` on the
server, `useServerFn` + `@tanstack/react-query` `useQuery` on the client, and
the shared `src/components/ui` primitives. Use the same page shell as
`src/routes/sports-shadow.tsx` (max-width container, back link, header,
`refetchInterval: 30_000`) so the two research pages feel like one product.

## 3. Server function contract

Five server functions. All are read-only `SELECT`s through the service-role
client. None accepts a write, and none takes a parameter that could widen access
beyond an experiment id.

### 3.1 `getWeatherLabOverview({ experimentId? })`

```ts
{
  experiment: {
    experimentKey: string; strategyVersion: string; configHash: string;
    mode: "PAPER"; status: "COLLECTING" | "FROZEN" | "CLOSED" | "ABANDONED";
    frozenAt: string; startedAt: string | null; daysRunning: number;
  };
  liveExecutionImplemented: false;
  counts: {
    independentStationDays: number; signals: number; paperEntries: number;
    paperFills: number; noFills: number; settledTrades: number;
  };
  performance: {                       // BASE scenario
    netPnlUsd: number | null; costUsd: number | null; roi: number | null;
    winRate: number | null; profitFactor: number | null; maxDrawdownUsd: number | null;
  };
  acceptance: {
    verdict: "PASS" | "FAIL" | "INSUFFICIENT_SAMPLE" | null;
    failures: string[];
    sampleStrength: "INSUFFICIENT" | "MINIMUM" | "PREFERRED" | "STRONG" | null;
    stationDaysToMinimum: number;      // max(0, 50 - independentStationDays)
  };
}
```

### 3.2 `getWeatherLabModelVsMarket({ experimentId, limit? })`

One row per priced contract from the most recent model run per event.

```ts
Array<{
  city: string; station: string; weatherDate: string;
  eventTicker: string; ticker: string; bucketLabel: string;
  modelProbability: number;            // 0..1
  marketYesAsk: number | null; executablePrice: number | null;
  feePerContract: number | null; slippageBuffer: number;
  netEdge: number | null; confidence: number; modelDispersionF: number;
  decision: "ENTER" | "REJECT"; rejectReasons: string[];
  strategyClass: string | null; settlementStatus: string;
  fillStatus: "FILLED" | "PARTIAL" | "NO_FILL";
}>
```

### 3.3 `getWeatherLabPositions({ experimentId, scenario })`

```ts
Array<{
  positionId: string; city: string; weatherDate: string; bucketLabel: string;
  scenario: "BASE" | "PLUS_1C" | "PLUS_2C" | "PLUS_3C";
  entryPrice: number; contracts: number; costBasisUsd: number;
  currentQuote: number | null;
  status: "OPEN" | "SETTLED";
  settledResult: "WIN" | "LOSS" | "VOID" | null;
  settledTemperatureF: number | null;
  netPnlUsd: number | null;
  settlementRuleChanged: boolean;      // render a warning chip when true
}>
```

### 3.4 `getWeatherLabModelDetail({ modelRunId })`

```ts
{
  eventTicker: string; city: string; weatherDate: string; decisionAt: string;
  consensusMeanF: number; modelDispersionF: number; confidence: number;
  observationFloorF: number | null; sigmaF: number;
  sigmaBasis: "ENSEMBLE_SPREAD" | "LEAD_TIME_FALLBACK";
  contributingSources: string[];
  rejectedSources: Array<{ sourceId: string; reason: string }>;
  buckets: Array<{
    ticker: string; label: string; probability: number;
    byModel: Array<{ sourceId: string; source: string; probability: number }>;
  }>;
}
```

### 3.5 `getWeatherLabPerformance({ experimentId })`

```ts
{
  byScenario: Array<{ scenario: string; netPnlUsd: number | null; roi: number | null;
                      winRate: number | null; profitFactor: number | null;
                      settledTrades: number }>;
  breakdowns: {
    byCity: Breakdown[]; byPriceBand: Breakdown[]; byEdgeBand: Breakdown[];
    byTimeOfDay: Breakdown[]; byConfidence: Breakdown[];
  };
  robustness: {
    bootstrapNetPnl95: [number, number] | null;
    bootstrapWinRate95: [number, number] | null;
    trimmedTop1Pct: { netPnlUsd: number; events: number } | null;
    trimmedTop5Pct: { netPnlUsd: number; events: number } | null;
    largestSingleEventShare: number | null;
  };
}
// Breakdown = { group: string; events: number; netPnlUsd: number;
//               roi: number | null; winRate: number | null; profitFactor: number | null }
```

## 4. Pages and sections

Single route, five stacked sections, in this order.

### 4.1 Header

- Title **Weather Lab**, subtitle "Independent US intraday weather value —
  forward paper research".
- Badge `PAPER / RESEARCH ONLY` (destructive/amber variant, high contrast).
- Monospace line: `LIVE_EXECUTION_IMPLEMENTED=false`.
- Experiment selector (`experimentKey` + short `configHash`), and a note that a
  different config hash is a different experiment and is never blended.
- Back link to `/`, matching the Sports Shadow page.

### 4.2 Summary tiles

From `getWeatherLabOverview`. One row of tiles: Status · Days running ·
Independent station-days · Signals · Paper entries · No-fills · Settled trades ·
Net P/L · ROI · Win rate · Profit factor · Max drawdown.

**Sample-progress rule.** When `sampleStrength` is `INSUFFICIENT`, render every
performance tile with a muted style and attach the caption
*"Below the 50 station-day minimum — not yet evidence."* Do not hide the numbers,
and do not present them as a result. Show a progress indicator toward 50.

**Acceptance chip.** `PASS` (positive), `FAIL` (destructive), or
`INSUFFICIENT_SAMPLE` (neutral). When `FAIL`, list `failures` verbatim.

### 4.3 Model vs market

Table from `getWeatherLabModelVsMarket`. Columns: City · Date · Bucket · Model %
· YES ask · Executable · Fee/ct · Slippage · **Net edge** · Confidence ·
Dispersion · Fill · Decision.

- Sort by `netEdge` descending by default.
- Colour `netEdge` divergently: positive positive-tone, negative muted. Never use
  red/green alone to carry meaning — pair with a sign and a label.
- `decision = REJECT` renders the first `rejectReasons` entry as a chip; the full
  list appears in a tooltip. Reasons are a fixed vocabulary:
  `SETTLEMENT_UNVERIFIED`, `NOT_FILLABLE:*`, `NET_EDGE_BELOW_THRESHOLD`,
  `PRICE_ABOVE_MAX`, `PRICE_BELOW_MIN`, `CONFIDENCE_BELOW_THRESHOLD`,
  `MODEL_DISPERSION_ABOVE_MAX`, `NO_ENABLED_STRATEGY_CLASS`.
- `settlementStatus = SETTLEMENT_UNVERIFIED` renders a warning chip on the row.
- Clicking a row opens the model detail panel (4.5).

### 4.4 Positions

Table from `getWeatherLabPositions`, with the scenario selector above it
(`BASE` default). Columns: City · Date · Bucket · Scenario · Entry · Contracts ·
Cost · Current quote · Status · Settled result · Settled °F · Net P/L.

`settlementRuleChanged = true` renders a prominent warning chip reading
*"Settlement rule changed mid-experiment — excluded from aggregates."*

### 4.5 Model detail panel

Opens from a Model-vs-market row. Shows the bucket distribution as a horizontal
bar per bucket, the market's implied price on the same axis for comparison, and a
small table of per-model probabilities so disagreement is visible.

Also show: consensus mean, dispersion, confidence, observation floor (or
"not applicable — next-day event"), sigma and `sigmaBasis`, contributing sources,
and **rejected sources with reasons**. Rejected sources must never be hidden: a
model run built on two feeds instead of four has to look thinner than one built
on four.

### 4.6 Performance and stress

From `getWeatherLabPerformance`.

- **Scenario stress table**: one row per `BASE / PLUS_1C / PLUS_2C / PLUS_3C`
  with net P/L, ROI, win rate, profit factor, settled trades. This is the headline
  robustness view — an edge that only exists at `BASE` is not an edge.
- **Breakdown tabs**: by city, price band, edge band, time of day, confidence.
- **Robustness panel**: bootstrap 95% intervals, results after removing the top
  1% and top 5% of winning events, and largest single-event share. Render the
  trimmed figures beside the headline, never behind a toggle.

## 5. Charts

Load the `dataviz` skill before writing any chart code.

Only three charts earn their place:

1. **Bucket distribution vs market price** (model detail) — grouped horizontal
   bars, model probability against market implied probability, per bucket.
2. **Cumulative net P/L by scenario** (performance) — one line per scenario,
   x-axis settlement date. Makes scenario divergence immediately readable.
3. **Net edge distribution** (model vs market) — histogram of `netEdge` with the
   frozen `minNetEdge` threshold marked.

Everything else is a table. Wide tables scroll inside their own
`overflow-x: auto` container; the page body never scrolls horizontally.

## 6. States

Every section implements all four.

- **Loading**: skeleton rows matching the final table shape. No spinners on tiles.
- **Error**: inline alert with the failed section name and a retry button. One
  section failing must not blank the page.
- **Empty (no experiment)**: "No experiment has been frozen yet." with a short
  explanation that an experiment must be frozen before collection begins.
- **Empty (experiment running, no data)**: "Collection has started. No settled
  station-days yet." plus the progress indicator toward the 50-station-day
  minimum. This is the expected state for the first weeks and must look
  deliberate, not broken.

## 7. Formatting

- Probabilities and win rates: one decimal percent (`27.6%`).
- Prices, fees and edges: cents to two decimals (`12.60c`), or dollars to four
  for per-contract fees (`$0.0052`).
- Money: `$1,234.56`, negatives parenthesised or signed consistently.
- Temperatures: whole degrees with `°F`.
- Timestamps: site-local with an explicit timezone label. Weather dates are
  station-local calendar dates and must never be rendered in UTC.
- Never render `null` as `0`. Use `—` and keep the distinction between "no data"
  and "zero" visible, because they mean different things here.

## 8. Explicitly out of scope

Do not build: order entry, position sizing controls, strategy-parameter editors,
threshold sliders, backtest triggers, model-weight editors, or anything that
mutates `weather_lab_experiments`. Thresholds are frozen by design — a UI that
can edit them would destroy the experiment's validity.
