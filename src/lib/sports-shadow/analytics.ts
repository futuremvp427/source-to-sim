/**
 * FINAL BUILD Part 1: research analytics engine — PURE math only.
 *
 * Consumes the flat per-(episode, notional-tier) join produced by the
 * get_sports_shadow_episode_outcomes RPC (analytics.server.ts fetches it, paginated,
 * for a whole epoch) and computes CORE/BREAKDOWNS/EXECUTION/RISK metrics. No I/O here
 * -- every function is a straight reduction over already-fetched rows, so the numbers
 * this module produces are fully deterministic and unit-testable without Supabase.
 *
 * Independence discipline (the mission's own hard rule): raw dollars are summed over
 * EVERY executed episode (correlated or not -- real money is real money regardless of
 * statistical independence), but any metric making a STATISTICAL claim about a sample
 * size (expectancy per independent episode, and everything bootstrap.ts/classification.ts
 * consume) is computed over `computeClusterReturns`' cluster-level aggregates, never over
 * raw per-signal rows. A cluster with N correlated wallet signals on the same game
 * contributes ONE observation to any independence-sensitive calculation, exactly
 * matching independence.ts's own game-level clustering rule.
 */

export type Venue = "PMUS" | "KALSHI";
export type FillStatus = "FULL" | "PARTIAL" | "NONE" | "INVALID" | "REJECTED";
export type SettlementStatus = "PENDING" | "SETTLED_WIN" | "SETTLED_LOSS" | "SETTLED_PUSH" | "VOID" | "CANCELED";
export type BetType = "MONEYLINE" | "SPREAD" | "TOTAL";

/**
 * The strategy this build reports as ITS headline result -- never a retroactively
 * selected subgroup (the mission's own explicit anti-cherry-picking rule). $25 is
 * chosen as a realistic mid-cohort paper size: large enough to be a meaningful signal
 * of real executable liquidity (unlike the $5 floor tier), small enough to avoid the
 * liquidity-starved tail the $100 tier is expected to show. The other four tiers
 * ($5/$10/$50/$100) remain fully computed for size-tier capacity comparison
 * (robustness.ts) -- this constant selects only which one is ever called "the" result.
 */
export const DECLARED_STRATEGY_NOTIONAL_USD = 25;

export type EpisodeOutcomeRow = {
  signalId: string;
  clusterKey: string | null;
  sourceWallet: string;
  betType: BetType;
  scheduledStartAtIso: string | null;
  signalCreatedAtIso: string;
  notionalTierUsd: number;
  chosenVenue: Venue | null;
  fillStatus: FillStatus;
  contracts: number;
  vwap: number | null;
  feeUsd: number | null;
  allInCostUsd: number | null;
  rejectReason: string | null;
  routingTimestampIso: string;
  spread: number | null;
  detectionLatencyMs: number | null;
  fireAtIso: string | null;
  observedAtIso: string | null;
  pmusResult: { depthWalk: { priceImpactCents: number | null } | null } | null;
  kalshiResult: { depthWalk: { priceImpactCents: number | null } | null } | null;
  settlementStatus: SettlementStatus | null;
  grossPnlUsd: number | null;
  totalFeesUsd: number | null;
  netPnlUsd: number | null;
};

/** Matches independence.ts's own fallback exactly: a signal with no cluster_key is its own singleton, never merged with another unknown signal. */
export function effectiveClusterKey(row: Pick<EpisodeOutcomeRow, "clusterKey" | "signalId">): string {
  return row.clusterKey ?? row.signalId;
}

export function filterToTier(rows: readonly EpisodeOutcomeRow[], notionalTierUsd: number): EpisodeOutcomeRow[] {
  return rows.filter((r) => r.notionalTierUsd === notionalTierUsd);
}

function isSettled(row: EpisodeOutcomeRow): boolean {
  return row.settlementStatus === "SETTLED_WIN" || row.settlementStatus === "SETTLED_LOSS" || row.settlementStatus === "SETTLED_PUSH";
}

export type ClusterReturn = { clusterKey: string; netPnlUsd: number; episodeCount: number };

/**
 * ONE row per independent cluster, summing net P&L across every settled episode in that
 * cluster -- the ONLY input bootstrap.ts and any sample-size-sensitive metric here may
 * consume. Clusters with zero settled episodes are excluded entirely (not zero-padded):
 * an unrealized position is not yet a "return".
 */
export function computeClusterReturns(rows: readonly EpisodeOutcomeRow[]): ClusterReturn[] {
  const byCluster = new Map<string, { netPnlUsd: number; episodeCount: number }>();
  for (const row of rows) {
    if (!isSettled(row) || row.netPnlUsd === null) continue;
    const key = effectiveClusterKey(row);
    const entry = byCluster.get(key) ?? { netPnlUsd: 0, episodeCount: 0 };
    entry.netPnlUsd += row.netPnlUsd;
    entry.episodeCount += 1;
    byCluster.set(key, entry);
  }
  return [...byCluster.entries()].map(([clusterKey, v]) => ({ clusterKey, ...v }));
}

export type CoreMetrics = {
  rawEpisodeCount: number;
  independentEpisodeCount: number;
  settledCount: number;
  independentSettledCount: number;
  wins: number;
  losses: number;
  pushes: number;
  grossPnlUsd: number;
  feesUsd: number;
  netPnlUsd: number;
  capitalDeployedUsd: number;
  /** netPnlUsd / capitalDeployedUsd over settled episodes. NaN-safe: 0 when nothing was settled. */
  roi: number;
  /** netPnlUsd / independentSettledCount -- the mission's own named metric, per INDEPENDENT unit, never per raw fill. */
  expectancyPerIndependentEpisode: number;
};

export function computeCoreMetrics(rows: readonly EpisodeOutcomeRow[]): CoreMetrics {
  const settledRows = rows.filter(isSettled);
  const independentEpisodeCount = new Set(rows.map(effectiveClusterKey)).size;
  const independentSettledCount = new Set(settledRows.map(effectiveClusterKey)).size;
  const wins = settledRows.filter((r) => r.settlementStatus === "SETTLED_WIN").length;
  const losses = settledRows.filter((r) => r.settlementStatus === "SETTLED_LOSS").length;
  const pushes = settledRows.filter((r) => r.settlementStatus === "SETTLED_PUSH").length;
  const grossPnlUsd = sum(settledRows.map((r) => r.grossPnlUsd ?? 0));
  const feesUsd = sum(settledRows.map((r) => r.totalFeesUsd ?? 0));
  const netPnlUsd = sum(settledRows.map((r) => r.netPnlUsd ?? 0));
  const capitalDeployedUsd = sum(settledRows.map((r) => r.allInCostUsd ?? 0));
  return {
    rawEpisodeCount: rows.length,
    independentEpisodeCount,
    settledCount: settledRows.length,
    independentSettledCount,
    wins,
    losses,
    pushes,
    grossPnlUsd,
    feesUsd,
    netPnlUsd,
    capitalDeployedUsd,
    roi: capitalDeployedUsd > 0 ? netPnlUsd / capitalDeployedUsd : 0,
    expectancyPerIndependentEpisode: independentSettledCount > 0 ? netPnlUsd / independentSettledCount : 0,
  };
}

export type BreakdownEntry = { key: string; metrics: CoreMetrics };

/** Generic breakdown -- used for wallet / bet_type / venue / size-tier / fill-status groupings alike (Part 1's BREAKDOWNS list). */
export function computeBreakdown(rows: readonly EpisodeOutcomeRow[], keyFn: (row: EpisodeOutcomeRow) => string): BreakdownEntry[] {
  const byKey = new Map<string, EpisodeOutcomeRow[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }
  return [...byKey.entries()]
    .map(([key, groupRows]) => ({ key, metrics: computeCoreMetrics(groupRows) }))
    .sort((a, b) => b.metrics.netPnlUsd - a.metrics.netPnlUsd);
}

export const breakdownByWallet = (rows: readonly EpisodeOutcomeRow[]): BreakdownEntry[] => computeBreakdown(rows, (r) => r.sourceWallet);
export const breakdownByBetType = (rows: readonly EpisodeOutcomeRow[]): BreakdownEntry[] => computeBreakdown(rows, (r) => r.betType);
export const breakdownByChosenVenue = (rows: readonly EpisodeOutcomeRow[]): BreakdownEntry[] => computeBreakdown(rows, (r) => r.chosenVenue ?? "NONE");
export const breakdownBySizeTier = (rows: readonly EpisodeOutcomeRow[]): BreakdownEntry[] => computeBreakdown(rows, (r) => String(r.notionalTierUsd));
export const breakdownByFillStatus = (rows: readonly EpisodeOutcomeRow[]): BreakdownEntry[] => computeBreakdown(rows, (r) => r.fillStatus);

/** Coarse price-bucket for the mission's "price/odds bucket" breakdown -- deciles of the entry VWAP. */
export function priceBucket(vwap: number | null): string {
  if (vwap === null || !Number.isFinite(vwap)) return "UNKNOWN";
  const decile = Math.min(9, Math.max(0, Math.floor(vwap * 10)));
  return `${decile / 10}-${(decile + 1) / 10}`;
}
export const breakdownByPriceBucket = (rows: readonly EpisodeOutcomeRow[]): BreakdownEntry[] => computeBreakdown(rows, (r) => priceBucket(r.vwap));

export type ExecutionMetrics = {
  matchRate: number;
  rejectRate: number;
  liquidityFailureRate: number;
  averageSpread: number | null;
  averageSlippageCents: number | null;
  p95SlippageCents: number | null;
  detectionLatencyMsP50: number | null;
  detectionLatencyMsP95: number | null;
  detectionLatencyMsP99: number | null;
  observationLatenessMsP50: number | null;
  observationLatenessMsP95: number | null;
  observationLatenessMsP99: number | null;
};

function chosenVenueSlippageCents(row: EpisodeOutcomeRow): number | null {
  const result = row.chosenVenue === "PMUS" ? row.pmusResult : row.chosenVenue === "KALSHI" ? row.kalshiResult : null;
  return result?.depthWalk?.priceImpactCents ?? null;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? null;
}

export function computeExecutionMetrics(rows: readonly EpisodeOutcomeRow[]): ExecutionMetrics {
  const total = rows.length;
  const full = rows.filter((r) => r.fillStatus === "FULL" || r.fillStatus === "PARTIAL").length;
  const rejected = rows.filter((r) => r.fillStatus === "REJECTED").length;
  const liquidityFailed = rows.filter((r) => r.fillStatus === "NONE" || r.fillStatus === "INVALID").length;
  const spreads = rows.map((r) => r.spread).filter((v): v is number => v !== null);
  const slippages = rows.map(chosenVenueSlippageCents).filter((v): v is number => v !== null);
  const detectionLatencies = rows.map((r) => r.detectionLatencyMs).filter((v): v is number => v !== null);
  const observationLateness = rows
    .map((r) => (r.observedAtIso && r.fireAtIso ? Date.parse(r.observedAtIso) - Date.parse(r.fireAtIso) : null))
    .filter((v): v is number => v !== null);
  return {
    matchRate: total > 0 ? full / total : 0,
    rejectRate: total > 0 ? rejected / total : 0,
    liquidityFailureRate: total > 0 ? liquidityFailed / total : 0,
    averageSpread: spreads.length > 0 ? sum(spreads) / spreads.length : null,
    averageSlippageCents: slippages.length > 0 ? sum(slippages) / slippages.length : null,
    p95SlippageCents: percentile(slippages, 95),
    detectionLatencyMsP50: percentile(detectionLatencies, 50),
    detectionLatencyMsP95: percentile(detectionLatencies, 95),
    detectionLatencyMsP99: percentile(detectionLatencies, 99),
    observationLatenessMsP50: percentile(observationLateness, 50),
    observationLatenessMsP95: percentile(observationLateness, 95),
    observationLatenessMsP99: percentile(observationLateness, 99),
  };
}

export type RiskMetrics = {
  /** Chronological (routing_timestamp order), one point per settled episode -- cumulative net P&L. */
  equityCurve: { timestampIso: string; cumulativeNetPnlUsd: number }[];
  peakEquityUsd: number;
  maxDrawdownUsd: number;
  largestWinUsd: number;
  largestLossUsd: number;
  /** Fraction of total positive net P&L contributed by the single largest winning episode -- Part 2's "profit concentration" input. */
  profitConcentration: number;
};

export function computeRiskMetrics(rows: readonly EpisodeOutcomeRow[]): RiskMetrics {
  const settledRows = rows
    .filter(isSettled)
    .filter((r) => r.netPnlUsd !== null)
    .sort((a, b) => Date.parse(a.routingTimestampIso) - Date.parse(b.routingTimestampIso));

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const equityCurve: { timestampIso: string; cumulativeNetPnlUsd: number }[] = [];
  for (const row of settledRows) {
    cumulative += row.netPnlUsd ?? 0;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
    equityCurve.push({ timestampIso: row.routingTimestampIso, cumulativeNetPnlUsd: cumulative });
  }

  const pnls = settledRows.map((r) => r.netPnlUsd ?? 0);
  const largestWinUsd = pnls.length > 0 ? Math.max(0, ...pnls) : 0;
  const largestLossUsd = pnls.length > 0 ? Math.min(0, ...pnls) : 0;
  const totalPositive = sum(pnls.filter((p) => p > 0));

  return {
    equityCurve,
    peakEquityUsd: peak,
    maxDrawdownUsd: maxDrawdown,
    largestWinUsd,
    largestLossUsd,
    profitConcentration: totalPositive > 0 ? largestWinUsd / totalPositive : 0,
  };
}

export type FullAnalyticsReport = {
  core: CoreMetrics;
  execution: ExecutionMetrics;
  risk: RiskMetrics;
  breakdowns: {
    byWallet: BreakdownEntry[];
    byBetType: BreakdownEntry[];
    byChosenVenue: BreakdownEntry[];
    byFillStatus: BreakdownEntry[];
    byPriceBucket: BreakdownEntry[];
  };
};

/**
 * `rows` should already be filtered to ONE notional tier (normally
 * DECLARED_STRATEGY_NOTIONAL_USD) -- this function never filters by tier itself, and
 * deliberately has no by-size-tier breakdown (meaningless once pre-filtered to one
 * tier). Size-tier capacity COMPARISON is a robustness concern, not a headline-report
 * breakdown -- see robustness.ts's compareSizeTierCapacity, which calls
 * breakdownBySizeTier directly on the UNFILTERED, all-tier row set.
 */
export function computeFullAnalyticsReport(rows: readonly EpisodeOutcomeRow[]): FullAnalyticsReport {
  return {
    core: computeCoreMetrics(rows),
    execution: computeExecutionMetrics(rows),
    risk: computeRiskMetrics(rows),
    breakdowns: {
      byWallet: breakdownByWallet(rows),
      byBetType: breakdownByBetType(rows),
      byChosenVenue: breakdownByChosenVenue(rows),
      byFillStatus: breakdownByFillStatus(rows),
      byPriceBucket: breakdownByPriceBucket(rows),
    },
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
