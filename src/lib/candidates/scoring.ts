/**
 * Pure, deterministic candidate research scoring.
 *
 * RESEARCH ONLY. Nothing in this module trades, follows or mutates any
 * experiment. Missing inputs stay null — they are never coerced to 0, and
 * unavailable score components are transparently renormalized away instead of
 * being scored as failures.
 */

export type Side = "BUY" | "SELL";

export type CandidateTrade = {
  asset: string;
  side: Side;
  size: number;
  price: number;
  ts: number;
  title: string;
  slug: string;
  outcome: string;
};

export type CandidatePosition = {
  asset: string;
  title: string;
  slug: string;
  size: number;
  initialValue: number | null;
  currentValue: number | null;
  cashPnl: number | null;
  realizedPnl: number | null;
  redeemable: boolean;
  endDate: string | null;
};

/** Every metric carries its coverage window and data completeness (0..1). */
export type Metric = {
  value: number | null;
  window: string;
  completeness: number;
};

export function metric(value: number | null, window: string, completeness: number): Metric {
  return { value: Number.isFinite(value as number) ? (value as number) : null, window, completeness };
}

/* ------------------------------------------------------------------ */
/* Small deterministic math helpers                                    */
/* ------------------------------------------------------------------ */

export function median(values: readonly number[]): number | null {
  return percentile(values, 0.5);
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * Math.min(Math.max(p, 0), 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (idx - lo);
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number | null {
  if (a.size === 0 || b.size === 0) return null;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? null : inter / union;
}

export function cosine(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number | null {
  if (a.size === 0 || b.size === 0) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, v] of a) na += v * v;
  for (const [k, v] of b) {
    nb += v * v;
    dot += (a.get(k) ?? 0) * v;
  }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Two-sample Kolmogorov–Smirnov distance (0 identical .. 1 disjoint). */
export function ksDistance(a: readonly number[], b: readonly number[]): number | null {
  if (a.length < 3 || b.length < 3) return null;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  const grid = [...new Set([...sa, ...sb])].sort((x, y) => x - y);
  let worst = 0;
  for (const g of grid) {
    const fa = sa.filter((v) => v <= g).length / sa.length;
    const fb = sb.filter((v) => v <= g).length / sb.length;
    worst = Math.max(worst, Math.abs(fa - fb));
  }
  return worst;
}

/** First Wasserstein distance between two empirical samples. */
export function wasserstein(a: readonly number[], b: readonly number[]): number | null {
  if (a.length < 3 || b.length < 3) return null;
  const steps = 20;
  let total = 0;
  for (let i = 1; i <= steps; i += 1) {
    const q = i / (steps + 1);
    total += Math.abs((percentile(a, q) ?? 0) - (percentile(b, q) ?? 0));
  }
  return total / steps;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function score100(v: number | null): number | null {
  return v === null ? null : Math.round(clamp01(v) * 100);
}

/* ------------------------------------------------------------------ */
/* Domain classification (heuristic, transparent)                      */
/* ------------------------------------------------------------------ */

const WEATHER_WORDS = [
  "temperature",
  "temp ",
  "rain",
  "snow",
  "hurricane",
  "tropical storm",
  "tornado",
  "weather",
  "climate",
  "precipitation",
  "heat index",
  "wind",
  "°c",
  "°f",
];

export function isWeatherish(title: string, slug: string): boolean {
  const hay = `${title} ${slug.replace(/-/g, " ")}`.toLowerCase();
  return WEATHER_WORDS.some((w) => hay.includes(w));
}

export function isTemperatureMarket(title: string, slug: string): boolean {
  const hay = `${title} ${slug.replace(/-/g, " ")}`.toLowerCase();
  return hay.includes("temperature") || /\d+\s?°?[cf]\b/.test(hay);
}

/** Extracts the city token from Polymarket weather slugs, when present. */
export function extractCity(slug: string): string | null {
  const m = /temperature-in-([a-z-]+?)-on-/.exec(slug.toLowerCase());
  if (m && m[1]) return m[1];
  const alt = /-in-([a-z-]{3,})-on-/.exec(slug.toLowerCase());
  return alt && alt[1] ? alt[1] : null;
}

/* ------------------------------------------------------------------ */
/* Metrics                                                            */
/* ------------------------------------------------------------------ */

export type CandidateMetrics = {
  coverageStart: number | null;
  coverageEnd: number | null;
  sampleCount: number;
  settledSampleCount: number;
  completeness: number;
  metrics: Record<string, Metric>;
};

const DAY = 86_400;

function settled(p: CandidatePosition): boolean {
  return p.redeemable || (p.currentValue !== null && p.currentValue <= 0.000001);
}

function positionEndTs(p: CandidatePosition): number | null {
  if (!p.endDate) return null;
  const t = Date.parse(p.endDate);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

export function computeMetrics(input: {
  trades: readonly CandidateTrade[];
  positions: readonly CandidatePosition[];
  nowSeconds: number;
}): CandidateMetrics {
  const { trades, positions, nowSeconds } = input;
  const out: Record<string, Metric> = {};

  const timestamps = trades.map((t) => t.ts).filter((t) => t > 0);
  const coverageStart = timestamps.length ? Math.min(...timestamps) : null;
  const coverageEnd = timestamps.length ? Math.max(...timestamps) : null;
  const windowLabel =
    coverageStart && coverageEnd
      ? `${new Date(coverageStart * 1000).toISOString().slice(0, 10)}..${new Date(coverageEnd * 1000).toISOString().slice(0, 10)}`
      : "no coverage";

  const settledPositions = positions.filter(settled);
  const dated = settledPositions.filter((p) => positionEndTs(p) !== null);
  const datedCompleteness = settledPositions.length ? dated.length / settledPositions.length : 0;

  const pnlInWindow = (days: number): number | null => {
    if (dated.length === 0) return null;
    const cutoff = nowSeconds - days * DAY;
    const rows = dated.filter((p) => (positionEndTs(p) as number) >= cutoff);
    if (rows.length === 0) return null;
    return rows.reduce((s, p) => s + (p.cashPnl ?? 0), 0);
  };

  out["pnl7d"] = metric(pnlInWindow(7), "settled markets ending in last 7d", datedCompleteness);
  out["pnl30d"] = metric(pnlInWindow(30), "settled markets ending in last 30d", datedCompleteness);

  const allTimePnl = settledPositions.length
    ? settledPositions.reduce((s, p) => s + (p.cashPnl ?? 0), 0)
    : null;
  out["pnlAllTime"] = metric(allTimePnl, `settled positions (${windowLabel})`, settledPositions.length ? 1 : 0);

  const realized = positions.length
    ? positions.reduce((s, p) => s + (p.realizedPnl ?? 0), 0)
    : null;
  out["realizedPnl"] = metric(realized, "all visible positions", positions.length ? 1 : 0);

  out["closedSampleCount"] = metric(
    settledPositions.length || null,
    "settled positions",
    positions.length ? 1 : 0,
  );

  const tradeCompleteness = trades.length ? 1 : 0;
  const weather = trades.filter((t) => isWeatherish(t.title, t.slug)).length;
  const temp = trades.filter((t) => isTemperatureMarket(t.title, t.slug)).length;
  out["weatherShare"] = metric(trades.length ? weather / trades.length : null, windowLabel, tradeCompleteness);
  out["temperatureShare"] = metric(trades.length ? temp / trades.length : null, windowLabel, tradeCompleteness);

  const buys = trades.filter((t) => t.side === "BUY");
  const sells = trades.filter((t) => t.side === "SELL");
  out["buyPct"] = metric(trades.length ? buys.length / trades.length : null, windowLabel, tradeCompleteness);
  out["sellPct"] = metric(trades.length ? sells.length / trades.length : null, windowLabel, tradeCompleteness);

  const boughtAssets = new Set(buys.map((t) => t.asset));
  const soldAssets = new Set(sells.map((t) => t.asset));
  let held = 0;
  for (const a of boughtAssets) if (!soldAssets.has(a)) held += 1;
  out["holdToSettlementPct"] = metric(
    boughtAssets.size ? held / boughtAssets.size : null,
    windowLabel,
    tradeCompleteness,
  );

  const entries = buys.map((t) => t.price).filter((p) => p > 0 && p < 1);
  out["medianEntryPrice"] = metric(median(entries), windowLabel, entries.length ? 1 : 0);
  for (const p of [10, 25, 75, 90] as const) {
    out[`entryPriceP${p}`] = metric(percentile(entries, p / 100), windowLabel, entries.length ? 1 : 0);
  }

  const notional = trades.map((t) => t.size * t.price).filter((v) => v > 0);
  out["medianPositionUsd"] = metric(median(notional), windowLabel, notional.length ? 1 : 0);

  const spanDays = coverageStart && coverageEnd ? Math.max((coverageEnd - coverageStart) / DAY, 1 / 24) : null;
  out["tradesPerDay"] = metric(spanDays ? trades.length / spanDays : null, windowLabel, tradeCompleteness);

  const cities = new Set(trades.map((t) => extractCity(t.slug)).filter((c): c is string => Boolean(c)));
  out["cityCount"] = metric(cities.size || null, windowLabel, tradeCompleteness);
  out["lastActivityTs"] = metric(coverageEnd, windowLabel, tradeCompleteness);

  const profits = settledPositions
    .map((p) => p.cashPnl ?? 0)
    .filter((v) => v > 0)
    .sort((a, b) => b - a);
  const grossProfit = profits.reduce((s, v) => s + v, 0);
  const conc = (n: number): number | null =>
    grossProfit > 0 ? profits.slice(0, n).reduce((s, v) => s + v, 0) / grossProfit : null;
  out["top1Concentration"] = metric(conc(1), "settled winners", settledPositions.length ? 1 : 0);
  out["top5Concentration"] = metric(conc(5), "settled winners", settledPositions.length ? 1 : 0);

  const losses = settledPositions.map((p) => p.cashPnl ?? 0).filter((v) => v < 0);
  const grossLoss = Math.abs(losses.reduce((s, v) => s + v, 0));
  out["profitFactor"] = metric(
    grossLoss > 0 ? grossProfit / grossLoss : null,
    "settled positions",
    settledPositions.length >= 10 ? 1 : settledPositions.length / 10,
  );

  const wins = settledPositions.filter((p) => (p.cashPnl ?? 0) > 0).length;
  out["winRate"] = metric(
    settledPositions.length ? wins / settledPositions.length : null,
    "settled positions",
    settledPositions.length >= 10 ? 1 : settledPositions.length / 10,
  );

  const invested = settledPositions.reduce((s, p) => s + (p.initialValue ?? 0), 0);
  out["roi"] = metric(invested > 0 && allTimePnl !== null ? allTimePnl / invested : null, "settled positions", invested > 0 ? 1 : 0);

  const ordered = [...dated].sort((a, b) => (positionEndTs(a) ?? 0) - (positionEndTs(b) ?? 0));
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const p of ordered) {
    cum += p.cashPnl ?? 0;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
  }
  out["maxDrawdownEstimate"] = metric(ordered.length >= 5 ? maxDd : null, "settled positions by end date", datedCompleteness);

  const hidden = positions
    .filter((p) => !settled(p))
    .reduce((s, p) => s + Math.min(p.cashPnl ?? 0, 0), 0);
  out["openUnrealizedLoss"] = metric(positions.length ? hidden : null, "open positions", positions.length ? 1 : 0);

  const values = Object.values(out);
  const completeness = values.length
    ? values.reduce((s, m) => s + (m.value === null ? 0 : m.completeness), 0) / values.length
    : 0;

  return {
    coverageStart,
    coverageEnd,
    sampleCount: trades.length,
    settledSampleCount: settledPositions.length,
    completeness: Number(completeness.toFixed(4)),
    metrics: out,
  };
}

/* ------------------------------------------------------------------ */
/* Strategy fingerprint                                               */
/* ------------------------------------------------------------------ */

export type CandidateFingerprint = {
  markets: string[];
  cities: Record<string, number>;
  entryPrices: number[];
  temperatureShare: number | null;
  holdToSettlement: number | null;
  partialSellRatio: number | null;
  medianHoldSeconds: number | null;
  medianNotional: number | null;
  capitalRecycling: number | null;
  repeatedEntryRatio: number | null;
  medianGapSeconds: number | null;
  hourCoverage: number | null;
  repeatedExactSizeRatio: number | null;
  multiCityBurstRatio: number | null;
  mechanicalPriceBandRatio: number | null;
  botLikelihood: number | null;
  botLabel: "BEHAVIORAL / PROBABILISTIC";
};

export function computeFingerprint(trades: readonly CandidateTrade[]): CandidateFingerprint {
  const empty: CandidateFingerprint = {
    markets: [],
    cities: {},
    entryPrices: [],
    temperatureShare: null,
    holdToSettlement: null,
    partialSellRatio: null,
    medianHoldSeconds: null,
    medianNotional: null,
    capitalRecycling: null,
    repeatedEntryRatio: null,
    medianGapSeconds: null,
    hourCoverage: null,
    repeatedExactSizeRatio: null,
    multiCityBurstRatio: null,
    mechanicalPriceBandRatio: null,
    botLikelihood: null,
    botLabel: "BEHAVIORAL / PROBABILISTIC",
  };
  if (trades.length === 0) return empty;

  const sorted = [...trades].sort((a, b) => a.ts - b.ts);
  const cities: Record<string, number> = {};
  for (const t of sorted) {
    const c = extractCity(t.slug);
    if (c) cities[c] = (cities[c] ?? 0) + 1;
  }

  const buys = sorted.filter((t) => t.side === "BUY");
  const sells = sorted.filter((t) => t.side === "SELL");
  const entryPrices = buys.map((t) => t.price).filter((p) => p > 0 && p < 1);

  const boughtByAsset = new Map<string, CandidateTrade[]>();
  for (const t of buys) boughtByAsset.set(t.asset, [...(boughtByAsset.get(t.asset) ?? []), t]);
  const soldByAsset = new Map<string, CandidateTrade[]>();
  for (const t of sells) soldByAsset.set(t.asset, [...(soldByAsset.get(t.asset) ?? []), t]);

  let held = 0;
  let partial = 0;
  const holdSeconds: number[] = [];
  for (const [asset, list] of boughtByAsset) {
    const exits = soldByAsset.get(asset);
    if (!exits || exits.length === 0) {
      held += 1;
      continue;
    }
    const bought = list.reduce((s, t) => s + t.size, 0);
    const sold = exits.reduce((s, t) => s + t.size, 0);
    if (sold < bought * 0.95) partial += 1;
    const firstBuy = list[0];
    const lastExit = exits[exits.length - 1];
    if (firstBuy && lastExit) holdSeconds.push(Math.max(lastExit.ts - firstBuy.ts, 0));
  }

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev && cur) gaps.push(Math.max(cur.ts - prev.ts, 0));
  }

  const hours = new Set(sorted.map((t) => new Date(t.ts * 1000).getUTCHours()));
  const sizeCounts = new Map<string, number>();
  for (const t of sorted) {
    const k = t.size.toFixed(4);
    sizeCounts.set(k, (sizeCounts.get(k) ?? 0) + 1);
  }
  const repeatedSizes = [...sizeCounts.values()].filter((c) => c > 1).reduce((s, c) => s + c, 0);

  const bucketCities = new Map<number, Set<string>>();
  for (const t of sorted) {
    const c = extractCity(t.slug);
    if (!c) continue;
    const bucket = Math.floor(t.ts / 300);
    const set = bucketCities.get(bucket) ?? new Set<string>();
    set.add(c);
    bucketCities.set(bucket, set);
  }
  const buckets = [...bucketCities.values()];
  const multiCityBurstRatio = buckets.length
    ? buckets.filter((s) => s.size >= 3).length / buckets.length
    : null;

  const banded = entryPrices.filter((p) => Math.abs(p * 100 - Math.round(p * 100)) < 1e-6).length;
  const notionals = sorted.map((t) => t.size * t.price).filter((v) => v > 0);
  const repeatedEntry = [...boughtByAsset.values()].filter((l) => l.length > 1).length;

  const fp: CandidateFingerprint = {
    markets: [...new Set(sorted.map((t) => t.slug))],
    cities,
    entryPrices,
    temperatureShare: sorted.filter((t) => isTemperatureMarket(t.title, t.slug)).length / sorted.length,
    holdToSettlement: boughtByAsset.size ? held / boughtByAsset.size : null,
    partialSellRatio: boughtByAsset.size ? partial / boughtByAsset.size : null,
    medianHoldSeconds: median(holdSeconds),
    medianNotional: median(notionals),
    capitalRecycling: buys.length ? sells.length / buys.length : null,
    repeatedEntryRatio: boughtByAsset.size ? repeatedEntry / boughtByAsset.size : null,
    medianGapSeconds: median(gaps),
    hourCoverage: hours.size / 24,
    repeatedExactSizeRatio: sorted.length ? repeatedSizes / sorted.length : null,
    multiCityBurstRatio,
    mechanicalPriceBandRatio: entryPrices.length ? banded / entryPrices.length : null,
    botLikelihood: null,
    botLabel: "BEHAVIORAL / PROBABILISTIC",
  };

  const indicators = [
    fp.hourCoverage,
    fp.repeatedExactSizeRatio,
    fp.multiCityBurstRatio,
    fp.mechanicalPriceBandRatio,
    fp.medianGapSeconds === null ? null : clamp01(1 - fp.medianGapSeconds / 3600),
  ].filter((v): v is number => v !== null);
  fp.botLikelihood = indicators.length
    ? Math.round((indicators.reduce((s, v) => s + v, 0) / indicators.length) * 100)
    : null;

  return fp;
}

/* ------------------------------------------------------------------ */
/* Mirror similarity vs the reference wallet                           */
/* ------------------------------------------------------------------ */

export type WeightedComponent = { key: string; weight: number; value: number | null };

export type CompositeScore = {
  score: number | null;
  status: "SCORED" | "INSUFFICIENT_DATA";
  completeness: number;
  components: Record<string, number | null>;
  weightsUsed: Record<string, number>;
};

/** Renormalizes across available components; never scores a gap as zero. */
export function composite(components: readonly WeightedComponent[], minCoverage = 0.5): CompositeScore {
  const available = components.filter((c) => c.value !== null);
  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  const usedWeight = available.reduce((s, c) => s + c.weight, 0);
  const completeness = totalWeight > 0 ? usedWeight / totalWeight : 0;

  const componentMap: Record<string, number | null> = {};
  for (const c of components) componentMap[c.key] = c.value === null ? null : score100(c.value);
  const weightsUsed: Record<string, number> = {};
  for (const c of available) weightsUsed[c.key] = Number((c.weight / usedWeight).toFixed(4));

  if (usedWeight === 0 || completeness < minCoverage) {
    return { score: null, status: "INSUFFICIENT_DATA", completeness: Number(completeness.toFixed(4)), components: componentMap, weightsUsed };
  }
  const weighted = available.reduce((s, c) => s + (c.value as number) * c.weight, 0) / usedWeight;
  return {
    score: score100(weighted),
    status: "SCORED",
    completeness: Number(completeness.toFixed(4)),
    components: componentMap,
    weightsUsed,
  };
}

function closeness(a: number | null, b: number | null, scale: number): number | null {
  if (a === null || b === null) return null;
  return clamp01(1 - Math.abs(a - b) / scale);
}

export function mirrorSimilarity(
  candidate: CandidateFingerprint,
  reference: CandidateFingerprint,
): CompositeScore {
  const marketOverlap = (() => {
    const a = new Set(candidate.markets);
    const b = new Set(reference.markets);
    const slugJaccard = jaccard(a, b);
    const catJaccard = closeness(candidate.temperatureShare, reference.temperatureShare, 1);
    if (slugJaccard === null && catJaccard === null) return null;
    // Category alignment dominates: identical strategies rarely share exact slugs.
    return 0.7 * (catJaccard ?? 0) + 0.3 * (slugJaccard ?? 0);
  })();

  const ks = ksDistance(candidate.entryPrices, reference.entryPrices);
  const entryPriceSimilarity = ks === null ? null : clamp01(1 - ks);

  const holdExit = (() => {
    const hold = closeness(candidate.holdToSettlement, reference.holdToSettlement, 1);
    const partialSell = closeness(candidate.partialSellRatio, reference.partialSellRatio, 1);
    const parts = [hold, partialSell].filter((v): v is number => v !== null);
    return parts.length ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
  })();

  const timing = closeness(candidate.medianHoldSeconds, reference.medianHoldSeconds, 3 * DAY);

  const geography = cosine(
    new Map(Object.entries(candidate.cities)),
    new Map(Object.entries(reference.cities)),
  );

  const sizing = (() => {
    const w = wasserstein(
      candidate.medianNotional === null ? [] : [candidate.medianNotional],
      reference.medianNotional === null ? [] : [reference.medianNotional],
    );
    void w;
    const size = closeness(candidate.medianNotional, reference.medianNotional, 200);
    const recycle = closeness(candidate.capitalRecycling, reference.capitalRecycling, 1);
    const parts = [size, recycle].filter((v): v is number => v !== null);
    return parts.length ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
  })();

  const cadence = (() => {
    const hour = closeness(candidate.hourCoverage, reference.hourCoverage, 1);
    const repeats = closeness(candidate.repeatedExactSizeRatio, reference.repeatedExactSizeRatio, 1);
    const gap = closeness(candidate.medianGapSeconds, reference.medianGapSeconds, 3600);
    const parts = [hour, repeats, gap].filter((v): v is number => v !== null);
    return parts.length ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
  })();

  return composite([
    { key: "marketOverlap", weight: 0.25, value: marketOverlap },
    { key: "entryPriceDistribution", weight: 0.2, value: entryPriceSimilarity },
    { key: "holdExitBehavior", weight: 0.15, value: holdExit },
    { key: "timingToResolution", weight: 0.1, value: timing },
    { key: "geography", weight: 0.1, value: geography },
    { key: "sizingRecycling", weight: 0.1, value: sizing },
    { key: "cadenceAutomation", weight: 0.1, value: cadence },
  ]);
}

/* ------------------------------------------------------------------ */
/* Profit quality                                                     */
/* ------------------------------------------------------------------ */

export function profitQuality(m: CandidateMetrics): CompositeScore {
  const g = (k: string): number | null => m.metrics[k]?.value ?? null;

  const roi = g("roi");
  const winRate = g("winRate");
  const profitFactor = g("profitFactor");
  const settledPnl = g("pnlAllTime");
  const top1 = g("top1Concentration");
  const top5 = g("top5Concentration");
  const drawdown = g("maxDrawdownEstimate");
  const hiddenLoss = g("openUnrealizedLoss");
  const pnl30 = g("pnl30d");
  const lastActivity = g("lastActivityTs");

  const sample = m.settledSampleCount;
  const sampleScore = sample > 0 ? clamp01(Math.log10(sample + 1) / Math.log10(101)) : null;

  const components: WeightedComponent[] = [
    { key: "settledProfitability", weight: 0.25, value: settledPnl === null ? null : clamp01(0.5 + Math.sign(settledPnl) * Math.min(Math.abs(settledPnl) / 20_000, 0.5)) },
    { key: "roi", weight: 0.15, value: roi === null ? null : clamp01(0.5 + roi) },
    { key: "sampleSize", weight: 0.15, value: sampleScore },
    { key: "winRate", weight: 0.1, value: winRate },
    { key: "profitFactor", weight: 0.1, value: profitFactor === null ? null : clamp01((profitFactor - 0.8) / 1.7) },
    { key: "consistency30d", weight: 0.1, value: pnl30 === null ? null : clamp01(0.5 + Math.sign(pnl30) * Math.min(Math.abs(pnl30) / 5_000, 0.5)) },
    { key: "concentration", weight: 0.1, value: top1 === null && top5 === null ? null : clamp01(1 - 0.6 * (top1 ?? 0) - 0.4 * (top5 ?? 0)) },
    { key: "drawdownControl", weight: 0.05, value: drawdown === null || settledPnl === null || settledPnl <= 0 ? null : clamp01(1 - drawdown / Math.max(settledPnl, 1)) },
  ];

  const base = composite(components, 0.4);
  if (base.score === null) return base;

  let penalty = 0;
  if (sample > 0 && sample < 10) penalty += 20; // tiny sample
  if (top1 !== null && top1 > 0.5) penalty += 15; // one lucky jackpot
  if (hiddenLoss !== null && settledPnl !== null && settledPnl > 0 && Math.abs(hiddenLoss) > settledPnl * 0.5) {
    penalty += 15; // large hidden unrealized losses
  }
  if (lastActivity !== null && Date.now() / 1000 - lastActivity > 14 * DAY) penalty += 15; // dormant
  return { ...base, score: Math.max(0, (base.score ?? 0) - penalty) };
}

/* ------------------------------------------------------------------ */
/* Copyability                                                        */
/* ------------------------------------------------------------------ */

export type SlippageSample = {
  delaySeconds: number;
  leaderPrice: number;
  followerPrice: number | null;
};

/**
 * Missing historical prices are unavailable data, never bad performance:
 * they lower completeness and can force INSUFFICIENT_DATA, never the score.
 */
export function copyabilityScore(samples: readonly SlippageSample[]): CompositeScore {
  const byDelay = new Map<number, number[]>();
  for (const s of samples) {
    if (s.followerPrice === null || s.leaderPrice <= 0) continue;
    const slip = s.followerPrice - s.leaderPrice;
    byDelay.set(s.delaySeconds, [...(byDelay.get(s.delaySeconds) ?? []), slip]);
  }
  const scoreFor = (delay: number): number | null => {
    const rows = byDelay.get(delay);
    if (!rows || rows.length === 0) return null;
    const med = median(rows) ?? 0;
    // 0c slippage => 1.0, 5c adverse slippage => 0.
    return clamp01(1 - Math.max(med, 0) / 0.05);
  };
  return composite(
    [
      { key: "delay0s", weight: 0.3, value: scoreFor(0) },
      { key: "delay30s", weight: 0.25, value: scoreFor(30) },
      { key: "delay60s", weight: 0.2, value: scoreFor(60) },
      { key: "delay300s", weight: 0.15, value: scoreFor(300) },
      { key: "delay900s", weight: 0.1, value: scoreFor(900) },
    ],
    0.3,
  );
}

/** Research-only robustness stress tests. */
export function robustness(input: {
  settledProfits: readonly number[];
  slippageCents: readonly number[];
  tradeCount: number;
}): Record<string, number | null> {
  const profits = [...input.settledProfits].sort((a, b) => b - a);
  const total = profits.reduce((s, v) => s + v, 0);
  const drop = (n: number): number | null =>
    profits.length > n ? total - profits.slice(0, n).reduce((s, v) => s + v, 0) : null;
  const cost = (cents: number): number | null =>
    input.tradeCount > 0 ? total - (cents / 100) * input.tradeCount : null;
  return {
    exLargestWin: drop(1),
    exTop5Wins: drop(5),
    minus1Cent: cost(1),
    minus2Cents: cost(2),
    delay60s: input.slippageCents.length ? total - (median([...input.slippageCents]) ?? 0) / 100 * input.tradeCount : null,
    delay300s: null,
  };
}

/* ------------------------------------------------------------------ */
/* Final candidate score                                              */
/* ------------------------------------------------------------------ */

export function finalCandidateScore(input: {
  mirror: number | null;
  profitQuality: number | null;
  copyability: number | null;
  consistency: number | null;
  capacity: number | null;
}): CompositeScore {
  return composite(
    [
      { key: "mirrorSimilarity", weight: 0.35, value: input.mirror === null ? null : input.mirror / 100 },
      { key: "profitQuality", weight: 0.3, value: input.profitQuality === null ? null : input.profitQuality / 100 },
      { key: "copyability", weight: 0.2, value: input.copyability === null ? null : input.copyability / 100 },
      { key: "consistency", weight: 0.1, value: input.consistency === null ? null : input.consistency / 100 },
      { key: "capacity", weight: 0.05, value: input.capacity === null ? null : input.capacity / 100 },
    ],
    0.4,
  );
}

export function consistencyScore(m: CandidateMetrics): number | null {
  const p7 = m.metrics["pnl7d"]?.value ?? null;
  const p30 = m.metrics["pnl30d"]?.value ?? null;
  if (p7 === null && p30 === null) return null;
  const positives = [p7, p30].filter((v): v is number => v !== null);
  const share = positives.filter((v) => v > 0).length / positives.length;
  return Math.round(share * 100);
}

export function capacityScore(m: CandidateMetrics): number | null {
  const size = m.metrics["medianPositionUsd"]?.value ?? null;
  const perDay = m.metrics["tradesPerDay"]?.value ?? null;
  if (size === null && perDay === null) return null;
  // Smaller, frequent tickets are easier to mirror with a small bankroll.
  const sizeScore = size === null ? null : clamp01(1 - size / 500);
  const cadenceScore = perDay === null ? null : clamp01(perDay / 40);
  const parts = [sizeScore, cadenceScore].filter((v): v is number => v !== null);
  return Math.round((parts.reduce((s, v) => s + v, 0) / parts.length) * 100);
}

/* ------------------------------------------------------------------ */
/* Ranking + narrative                                                */
/* ------------------------------------------------------------------ */

export type RankableCandidate = {
  handle: string;
  finalScore: number | null;
  mirrorSimilarity: number | null;
  profitQuality: number | null;
  copyability: number | null;
  weeklyRank: number | null;
};

export type SortKey = "final" | "mirror" | "profit" | "copyability" | "weeklyRank";

/** Deterministic: nulls sort last, ties broken by handle. */
export function rankCandidates<T extends RankableCandidate>(rows: readonly T[], key: SortKey): T[] {
  const pick = (r: T): number | null => {
    switch (key) {
      case "mirror":
        return r.mirrorSimilarity;
      case "profit":
        return r.profitQuality;
      case "copyability":
        return r.copyability;
      case "weeklyRank":
        return r.weeklyRank === null ? null : -r.weeklyRank;
      case "final":
      default:
        return r.finalScore;
    }
  };
  return [...rows].sort((a, b) => {
    const av = pick(a);
    const bv = pick(b);
    if (av === null && bv === null) return a.handle.localeCompare(b.handle);
    if (av === null) return 1;
    if (bv === null) return -1;
    if (bv !== av) return bv - av;
    return a.handle.localeCompare(b.handle);
  });
}

export function strengthsAndRisks(input: {
  metrics: CandidateMetrics;
  mirror: CompositeScore;
  profit: CompositeScore;
  copy: CompositeScore;
  fingerprint: CandidateFingerprint;
}): { strengths: string[]; risks: string[] } {
  const strengths: string[] = [];
  const risks: string[] = [];
  const g = (k: string): number | null => input.metrics.metrics[k]?.value ?? null;

  if ((input.mirror.score ?? 0) >= 65) strengths.push("Strategy profile closely resembles badatmath.");
  if ((g("weatherShare") ?? 0) >= 0.8) strengths.push("Weather specialist (high weather-market share).");
  if ((g("pnlAllTime") ?? 0) > 0) strengths.push("Positive settled P&L over the observed window.");
  if ((g("winRate") ?? 0) >= 0.5) strengths.push("Win rate at or above 50% on settled positions.");
  if ((input.fingerprint.hourCoverage ?? 0) >= 0.8) strengths.push("Round-the-clock coverage suggests systematic execution.");

  if (input.metrics.settledSampleCount > 0 && input.metrics.settledSampleCount < 10) {
    risks.push("Very small settled sample — metrics are unstable.");
  }
  if ((g("top1Concentration") ?? 0) > 0.5) risks.push("Profit concentrated in a single winning market.");
  if ((g("openUnrealizedLoss") ?? 0) < 0) risks.push("Open positions carry unrealized losses not in settled P&L.");
  if (input.copy.status === "INSUFFICIENT_DATA") risks.push("Copyability unproven — historical follower prices unavailable.");
  if (input.mirror.status === "INSUFFICIENT_DATA") risks.push("Mirror similarity incomplete — insufficient overlapping data.");
  if ((input.fingerprint.botLikelihood ?? 0) >= 70) {
    risks.push("High behavioural automation indicators (probabilistic, not proof of a bot).");
  }
  return { strengths, risks };
}
