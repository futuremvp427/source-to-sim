/**
 * Performance aggregation and the acceptance gate.
 *
 * Two rules from the research phase are enforced structurally here:
 *
 * 1. **The independent unit is the station-day, not the bucket.** A station-day
 *    event has several mutually exclusive buckets whose outcomes are perfectly
 *    dependent. Counting each bucket as a sample inflates n and narrows every
 *    confidence interval. `aggregateByStationDay` collapses first; nothing
 *    downstream ever sees bucket-level rows.
 *
 * 2. **Headline numbers must survive winner removal.** The prior research was
 *    repeatedly rescued or destroyed by a handful of events, so top-1% and
 *    top-5% trimmed results are computed alongside the headline, never instead
 *    of it on request.
 */

export type PaperTradeRow = {
  /** Station-day key, e.g. "CLINYC:2026-08-27". The independent unit. */
  stationDay: string;
  city: string;
  /** Whole-event settled net P/L in dollars for this row. */
  netPnlUsd: number;
  /** Premium committed, the ROI denominator. */
  costUsd: number;
  /** Fill price, for price-band breakdowns. */
  entryPriceUsd: number;
  /** Net edge at entry, for edge-band breakdowns. */
  netEdge: number;
  /** Local hour of entry, for time-of-day breakdowns. */
  entryLocalHour: number;
  /** Distribution confidence at entry. */
  confidence: number;
  settledAt: string;
};

export type Metrics = {
  events: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netPnlUsd: number;
  costUsd: number;
  roi: number | null;
  profitFactor: number | null;
  maxDrawdownUsd: number;
  averageWinUsd: number;
  averageLossUsd: number;
  worstEventUsd: number | null;
  bestEventUsd: number | null;
};

export type StationDayResult = { stationDay: string; city: string; netPnlUsd: number; costUsd: number; settledAt: string };

/** Collapse bucket-level paper rows into one economic result per station-day. */
export function aggregateByStationDay(rows: readonly PaperTradeRow[]): StationDayResult[] {
  const byKey = new Map<string, StationDayResult>();
  for (const r of rows) {
    const existing = byKey.get(r.stationDay);
    if (existing) {
      existing.netPnlUsd += r.netPnlUsd;
      existing.costUsd += r.costUsd;
      if (r.settledAt > existing.settledAt) existing.settledAt = r.settledAt;
    } else {
      byKey.set(r.stationDay, {
        stationDay: r.stationDay,
        city: r.city,
        netPnlUsd: r.netPnlUsd,
        costUsd: r.costUsd,
        settledAt: r.settledAt,
      });
    }
  }
  return [...byKey.values()].sort((a, b) => a.settledAt.localeCompare(b.settledAt));
}

export function computeMetrics(results: readonly StationDayResult[]): Metrics {
  const ordered = [...results].sort((a, b) => a.settledAt.localeCompare(b.settledAt));
  const pnls = ordered.map((r) => r.netPnlUsd);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  const costUsd = ordered.reduce((a, r) => a + r.costUsd, 0);
  const netPnlUsd = pnls.reduce((a, b) => a + b, 0);

  let equity = 0;
  let peak = 0;
  let maxDrawdownUsd = 0;
  for (const p of pnls) {
    equity += p;
    peak = Math.max(peak, equity);
    maxDrawdownUsd = Math.min(maxDrawdownUsd, equity - peak);
  }

  return {
    events: ordered.length,
    wins: wins.length,
    losses: losses.length,
    winRate: ordered.length ? wins.length / ordered.length : null,
    netPnlUsd,
    costUsd,
    roi: costUsd > 0 ? netPnlUsd / costUsd : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    maxDrawdownUsd,
    averageWinUsd: wins.length ? grossWin / wins.length : 0,
    averageLossUsd: losses.length ? -grossLoss / losses.length : 0,
    worstEventUsd: pnls.length ? Math.min(...pnls) : null,
    bestEventUsd: pnls.length ? Math.max(...pnls) : null,
  };
}

/** Deterministic LCG so bootstrap intervals are reproducible across runs. */
function lcg(seed = 0x5eed1234) {
  let s = seed >>> 0;
  return () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
}

export type Bootstrap = {
  iterations: number;
  netPnl95: [number, number];
  winRate95: [number, number];
};

export function bootstrap(results: readonly StationDayResult[], iterations = 2000): Bootstrap | null {
  if (results.length === 0) return null;
  const rnd = lcg();
  const pnlTotals: number[] = [];
  const winRates: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let total = 0;
    let wins = 0;
    for (let j = 0; j < results.length; j++) {
      const pick = results[Math.floor(rnd() * results.length)];
      const p = pick ? pick.netPnlUsd : 0;
      total += p;
      if (p > 0) wins++;
    }
    pnlTotals.push(total);
    winRates.push(wins / results.length);
  }
  const q = (xs: number[], p: number): number => {
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))] ?? 0;
  };
  return {
    iterations,
    netPnl95: [q(pnlTotals, 0.025), q(pnlTotals, 0.975)],
    winRate95: [q(winRates, 0.025), q(winRates, 0.975)],
  };
}

/** Metrics after removing the top `fraction` of winning events. */
export function trimTopWinners(results: readonly StationDayResult[], fraction: number): Metrics {
  const winners = results.filter((r) => r.netPnlUsd > 0).sort((a, b) => b.netPnlUsd - a.netPnlUsd);
  const dropCount = Math.ceil(winners.length * fraction);
  const dropped = new Set(winners.slice(0, dropCount).map((r) => r.stationDay));
  return computeMetrics(results.filter((r) => !dropped.has(r.stationDay)));
}

export function groupBy<T extends string>(
  rows: readonly PaperTradeRow[],
  key: (row: PaperTradeRow) => T,
): Array<{ group: T; metrics: Metrics }> {
  const groups = new Map<T, PaperTradeRow[]>();
  for (const r of rows) {
    const g = key(r);
    const list = groups.get(g);
    if (list) list.push(r);
    else groups.set(g, [r]);
  }
  return [...groups.entries()]
    .map(([group, list]) => ({ group, metrics: computeMetrics(aggregateByStationDay(list)) }))
    .sort((a, b) => a.group.localeCompare(b.group));
}

export function priceBand(priceUsd: number): string {
  if (priceUsd < 0.05) return "<5c";
  if (priceUsd < 0.1) return "5-10c";
  if (priceUsd < 0.2) return "10-20c";
  if (priceUsd <= 0.55) return "20-55c";
  if (priceUsd < 0.9) return "55-90c";
  return ">=90c";
}

export function edgeBand(netEdge: number): string {
  if (netEdge < 0.02) return "<2pt";
  if (netEdge < 0.05) return "2-5pt";
  if (netEdge < 0.1) return "5-10pt";
  if (netEdge < 0.2) return "10-20pt";
  return ">=20pt";
}

/**
 * The acceptance gate. Thresholds are the pre-registered ones from the research
 * brief and are constants, not inputs, so a caller cannot loosen them to
 * manufacture a pass.
 */
export const ACCEPTANCE_THRESHOLDS = Object.freeze({
  minIndependentStationDays: 50,
  preferredStationDays: 100,
  strongStationDays: 200,
  minProfitFactor: 1.3,
  /** Fraction of net P/L a single event may contribute before it is a concern. */
  maxSingleEventShare: 0.5,
  /** Max tolerated drawdown as a fraction of gross premium committed. */
  maxDrawdownFractionOfCost: 0.5,
});

export type AcceptanceVerdict = {
  verdict: "PASS" | "FAIL" | "INSUFFICIENT_SAMPLE";
  failures: string[];
  metrics: Metrics;
  trimmedTop1Pct: Metrics;
  trimmedTop5Pct: Metrics;
  bootstrap: Bootstrap | null;
  largestSingleEventShare: number | null;
  sampleStrength: "INSUFFICIENT" | "MINIMUM" | "PREFERRED" | "STRONG";
};

export function evaluateAcceptance(results: readonly StationDayResult[]): AcceptanceVerdict {
  const metrics = computeMetrics(results);
  const trimmedTop1Pct = trimTopWinners(results, 0.01);
  const trimmedTop5Pct = trimTopWinners(results, 0.05);
  const boot = bootstrap(results);

  const grossWin = results.filter((r) => r.netPnlUsd > 0).reduce((a, r) => a + r.netPnlUsd, 0);
  const largestWin = results.reduce((a, r) => Math.max(a, r.netPnlUsd), 0);
  const largestSingleEventShare = grossWin > 0 ? largestWin / grossWin : null;

  const sampleStrength =
    metrics.events >= ACCEPTANCE_THRESHOLDS.strongStationDays
      ? "STRONG"
      : metrics.events >= ACCEPTANCE_THRESHOLDS.preferredStationDays
        ? "PREFERRED"
        : metrics.events >= ACCEPTANCE_THRESHOLDS.minIndependentStationDays
          ? "MINIMUM"
          : "INSUFFICIENT";

  const failures: string[] = [];
  if (metrics.netPnlUsd <= 0) failures.push("NET_PNL_NOT_POSITIVE");
  if (metrics.roi === null || metrics.roi <= 0) failures.push("ROI_NOT_POSITIVE");
  if (metrics.profitFactor === null || metrics.profitFactor < ACCEPTANCE_THRESHOLDS.minProfitFactor) {
    failures.push("PROFIT_FACTOR_BELOW_1_3");
  }
  if (trimmedTop5Pct.netPnlUsd <= 0) failures.push("DEPENDS_ON_TOP_5PCT_WINNERS");
  if (trimmedTop1Pct.netPnlUsd <= 0) failures.push("DEPENDS_ON_TOP_1PCT_WINNERS");
  if (largestSingleEventShare !== null && largestSingleEventShare > ACCEPTANCE_THRESHOLDS.maxSingleEventShare) {
    failures.push("SINGLE_EVENT_CONCENTRATION");
  }
  if (
    metrics.costUsd > 0 &&
    Math.abs(metrics.maxDrawdownUsd) / metrics.costUsd > ACCEPTANCE_THRESHOLDS.maxDrawdownFractionOfCost
  ) {
    failures.push("DRAWDOWN_TOO_LARGE");
  }

  const verdict = sampleStrength === "INSUFFICIENT" ? "INSUFFICIENT_SAMPLE" : failures.length === 0 ? "PASS" : "FAIL";

  return {
    verdict,
    failures,
    metrics,
    trimmedTop1Pct,
    trimmedTop5Pct,
    bootstrap: boot,
    largestSingleEventShare,
    sampleStrength,
  };
}
