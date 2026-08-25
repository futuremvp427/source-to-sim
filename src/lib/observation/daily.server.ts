/**
 * READ-ONLY out-of-sample observation log.
 *
 * Every value here is derived from already-persisted paper rows
 * (paper_settlements, paper_trades, paper_positions, copyability_observations,
 * worker_status). Historical slippage-adjusted figures use a precommitted
 * prior-day cutoff, so later observations cannot rewrite an older settled day.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { fetchAllRows } from "../db-pagination";
import { median } from "../copyability/core";
import { MARK_MAX_AGE_MS } from "../shadow-core";
import { V2_PREFIX, isV2Name } from "../v2-cohort";
import { V3_PREFIX, isV3Name } from "../v3-cohort";
import { classifyWorker, type WorkerRow } from "../worker-health";
import { buildMilestones, estimateSlippageAdjustedPnl, type Milestone } from "./milestones";
import {
  SLIPPAGE_METHODOLOGY_VERSION,
  SLIPPAGE_SAMPLE_LIMIT,
  priorUtcDayCutoff,
} from "./slippage-asof";

export type ObservationDay = {
  day: string;
  settlements: number;
  realizedPnl: number;
  cumulativeRealizedPnl: number;
  slippageAdjustedPnl: number | null;
  cumulativeSlippageAdjustedPnl: number | null;
};

export type ObservationSeries = {
  experimentId: string;
  name: string;
  cohort: "V2" | "V3";
  handle: string;
  /** Current descriptive median; historical adjusted estimates do not reuse it. */
  observedSlippageCents: number | null;
  fillabilityPct: number | null;
  copyabilityCompletenessPct: number | null;
  markCoveragePct: number | null;
  openPositions: number;
  freshlyMarkedPositions: number;
  buyAttempts: number;
  cashStarvedSkips: number;
  cashSkipRatePct: number | null;
  settledDays: number;
  settlements: number;
  /** Raw theoretical paper-book result, before copyability/friction adjustment. */
  realizedPnl: number;
  /** Friction-adjusted/copyable estimate derived from no-lookahead slippage observations. */
  slippageAdjustedCumulativePnl: number | null;
  worker: { id: string; status: "PASS" | "WARN" | "FAIL"; reason: string };
  days: ObservationDay[];
  milestones: Milestone[];
};

export type ObservationLogData = {
  generatedAt: string;
  scope: ObservationLogScope;
  handle: string;
  series: ObservationSeries[];
  note: string;
};

const NOTE =
  `PAPER SIMULATION / DERIVED. Out-of-sample observation only: no strategy, sizing, bankroll or qualification change is driven by anything on this panel. Raw realized P&L is the theoretical paper ledger. Historical friction-adjusted/copyable P&L uses ${SLIPPAGE_METHODOLOGY_VERSION}: each settled UTC day uses at most the ${SLIPPAGE_SAMPLE_LIMIT.toLocaleString("en-US")} most recent observed entry-slippage samples strictly before 00:00 UTC that day. Samples collected during or after a settled day cannot retrospectively change that day's estimate. The current observed slippage median is descriptive only. Future paper-to-limited-live promotion analysis must use friction-adjusted/copyable performance, not raw theoretical paper P&L alone. Milestones are research flags and never promote a wallet or enable live execution.`;

export type ObservationLogScope = "ALL_ENABLED_V2_V3" | "POLIGARCH_ONLY";

const DEFAULT_SCOPE: ObservationLogScope = "ALL_ENABLED_V2_V3";
const LEGACY_OBSERVED_HANDLE = "Poligarch";

type SettlementRow = {
  resolution_ts: string | null;
  shares: number | string | null;
  cost_basis: number | string | null;
  payout: number | string | null;
  realized_pnl: number | string | null;
};

function dayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

async function loadSettlements(experimentId: string): Promise<SettlementRow[]> {
  const { rows } = await fetchAllRows<SettlementRow>(async (from, to) => {
    const { data } = await supabaseAdmin
      .from("paper_settlements")
      .select("resolution_ts, shares, cost_basis, payout, realized_pnl")
      .eq("experiment_id", experimentId)
      .order("resolution_ts", { ascending: true })
      .range(from, to);
    return data ?? [];
  });
  return rows;
}

/**
 * Copyability aggregates without a full-table read: counts come from indexed
 * head queries and the current descriptive median uses the latest sample window.
 */
async function loadSlippageCents(experimentId: string): Promise<{
  medianCents: number | null;
  fillabilityPct: number | null;
  completenessPct: number | null;
}> {
  const base = () =>
    supabaseAdmin
      .from("copyability_observations")
      .select("*", { count: "exact", head: true })
      .eq("experiment_id", experimentId);

  const [total, observedCount, fillableCount, sample] = await Promise.all([
    base(),
    base().eq("status", "observed"),
    base().eq("status", "observed").eq("fillable", true),
    supabaseAdmin
      .from("copyability_observations")
      .select("slippage_cents")
      .eq("experiment_id", experimentId)
      .eq("status", "observed")
      .not("slippage_cents", "is", null)
      .order("observed_at", { ascending: false })
      .limit(SLIPPAGE_SAMPLE_LIMIT),
  ]);

  const totalRows = total.count ?? 0;
  const observed = observedCount.count ?? 0;
  if (totalRows === 0) return { medianCents: null, fillabilityPct: null, completenessPct: null };

  const cents = (sample.data ?? [])
    .map((r) => Number(r.slippage_cents))
    .filter((v) => Number.isFinite(v));

  return {
    medianCents: median(cents),
    fillabilityPct: observed === 0 ? null : ((fillableCount.count ?? 0) / observed) * 100,
    completenessPct: (observed / totalRows) * 100,
  };
}

/**
 * Historical execution basis for each settlement day. This intentionally reads
 * the same copyability table as the existing observation panel, but applies the
 * no-lookahead cutoff before selecting the most recent sample window. Apart
 * from that time boundary, the slippage sample population is unchanged.
 */
async function loadHistoricalSlippageByDay(
  experimentId: string,
  days: string[],
): Promise<Map<string, number | null>> {
  const uniqueDays = [...new Set(days)].sort();
  const entries = await Promise.all(
    uniqueDays.map(async (day) => {
      const cutoffAt = priorUtcDayCutoff(day);
      const { data, error } = await supabaseAdmin
        .from("copyability_observations")
        .select("slippage_cents")
        .eq("experiment_id", experimentId)
        .eq("status", "observed")
        .not("slippage_cents", "is", null)
        .lt("observed_at", cutoffAt)
        .order("observed_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(SLIPPAGE_SAMPLE_LIMIT);
      if (error) throw new Error(error.message);
      const cents = (data ?? [])
        .map((row) => Number(row.slippage_cents))
        .filter((value) => Number.isFinite(value));
      return [day, median(cents)] as const;
    }),
  );
  return new Map(entries);
}

async function buildSeries(experiment: {
  id: string;
  name: string;
}): Promise<ObservationSeries> {
  const cohort: "V2" | "V3" = isV3Name(experiment.name) ? "V3" : "V2";
  const handle = experiment.name.slice((cohort === "V3" ? V3_PREFIX : V2_PREFIX).length);

  const settlements = await loadSettlements(experiment.id);
  const settlementDays = settlements.flatMap((row) =>
    row.resolution_ts ? [dayKey(row.resolution_ts)] : [],
  );

  const [slippage, historicalSlippage, positions, buys, skips, workers] = await Promise.all([
    loadSlippageCents(experiment.id),
    loadHistoricalSlippageByDay(experiment.id, settlementDays),
    supabaseAdmin
      .from("paper_positions")
      .select("shares, mark, mark_ts")
      .eq("experiment_id", experiment.id),
    supabaseAdmin
      .from("paper_trades")
      .select("*", { count: "exact", head: true })
      .eq("experiment_id", experiment.id)
      .eq("action", "BUY"),
    supabaseAdmin
      .from("paper_trades")
      .select("*", { count: "exact", head: true })
      .eq("experiment_id", experiment.id)
      .eq("action", "SKIP")
      .like("reason", "INSUFFICIENT_CASH_RESERVE%"),
    supabaseAdmin
      .from("worker_status")
      .select("id, state, heartbeat_at, last_poll_at, last_success_at, lease_expires_at, poll_failures")
      .eq("id", `ingest:${experiment.id}`)
      .maybeSingle(),
  ]);

  const nowMs = Date.now();
  const openPositions = (positions.data ?? []).filter((p) => Number(p.shares) > 0);
  const freshlyMarked = openPositions.filter(
    (p) =>
      p.mark !== null &&
      p.mark_ts !== null &&
      nowMs - new Date(p.mark_ts as string).getTime() <= MARK_MAX_AGE_MS,
  ).length;

  const buyAttempts = (buys.count ?? 0) + (skips.count ?? 0);
  const cashSkipRatePct = buyAttempts === 0 ? null : ((skips.count ?? 0) / buyAttempts) * 100;

  const byDay = new Map<string, { settlements: number; realized: number; adjusted: number; adjustable: number }>();
  let realizedTotal = 0;
  for (const row of settlements) {
    if (!row.resolution_ts) continue;
    const key = dayKey(row.resolution_ts);
    const bucket = byDay.get(key) ?? { settlements: 0, realized: 0, adjusted: 0, adjustable: 0 };
    const realized = Number(row.realized_pnl ?? 0);
    bucket.settlements += 1;
    bucket.realized += realized;
    const adjusted = estimateSlippageAdjustedPnl({
      shares: Number(row.shares ?? 0),
      costBasis: Number(row.cost_basis ?? 0),
      payout: Number(row.payout ?? 0),
      slippageCents: historicalSlippage.get(key) ?? null,
    });
    if (adjusted !== null) {
      bucket.adjusted += adjusted;
      bucket.adjustable += 1;
    }
    byDay.set(key, bucket);
  }

  const days: ObservationDay[] = [];
  let cumulative = 0;
  let cumulativeAdjusted: number | null = byDay.size === 0 ? null : 0;
  for (const key of [...byDay.keys()].sort()) {
    const bucket = byDay.get(key)!;
    cumulative += bucket.realized;
    realizedTotal = cumulative;
    const dayAdjusted = bucket.adjustable === bucket.settlements ? bucket.adjusted : null;
    if (cumulativeAdjusted !== null && dayAdjusted !== null) cumulativeAdjusted += dayAdjusted;
    else if (dayAdjusted === null) cumulativeAdjusted = null;
    days.push({
      day: key,
      settlements: bucket.settlements,
      realizedPnl: round2(bucket.realized),
      cumulativeRealizedPnl: round2(cumulative),
      slippageAdjustedPnl: dayAdjusted === null ? null : round2(dayAdjusted),
      cumulativeSlippageAdjustedPnl: cumulativeAdjusted === null ? null : round2(cumulativeAdjusted),
    });
  }

  const workerRow = (workers.data ?? undefined) as WorkerRow | undefined;
  const verdict = classifyWorker(workerRow, nowMs);

  return {
    experimentId: experiment.id,
    name: experiment.name,
    cohort,
    handle,
    observedSlippageCents: slippage.medianCents,
    fillabilityPct: slippage.fillabilityPct,
    copyabilityCompletenessPct: slippage.completenessPct,
    markCoveragePct: openPositions.length === 0 ? null : (freshlyMarked / openPositions.length) * 100,
    openPositions: openPositions.length,
    freshlyMarkedPositions: freshlyMarked,
    buyAttempts,
    cashStarvedSkips: skips.count ?? 0,
    cashSkipRatePct,
    settledDays: days.length,
    settlements: settlements.length,
    realizedPnl: round2(realizedTotal),
    slippageAdjustedCumulativePnl: cumulativeAdjusted === null ? null : round2(cumulativeAdjusted),
    worker: { id: verdict.id, status: verdict.status, reason: verdict.reason },
    days,
    milestones: buildMilestones({
      settledDays: days.length,
      cashSkipRatePct: cohort === "V3" ? cashSkipRatePct : null,
      slippageAdjustedCumulativePnl: cumulativeAdjusted,
    }),
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function observedHandleForScope(scope: ObservationLogScope): string {
  return scope === "POLIGARCH_ONLY" ? LEGACY_OBSERVED_HANDLE : "ALL_ENABLED_V2_V3";
}

function shouldIncludeObservationExperiment(
  experiment: { name: string },
  scope: ObservationLogScope,
): boolean {
  if (!isV2Name(experiment.name) && !isV3Name(experiment.name)) return false;
  if (scope === "POLIGARCH_ONLY") return experiment.name.includes(LEGACY_OBSERVED_HANDLE);
  return true;
}

export async function loadObservationLog(
  options: { scope?: ObservationLogScope } = {},
): Promise<ObservationLogData> {
  const scope = options.scope ?? DEFAULT_SCOPE;
  const { data } = await supabaseAdmin
    .from("paper_experiments")
    .select("id, name, enabled")
    .eq("enabled", true)
    .or(`name.like.${V2_PREFIX}%,name.like.${V3_PREFIX}%`);

  const experiments = (data ?? []).filter((row) => shouldIncludeObservationExperiment(row, scope));

  const series = await Promise.all(experiments.map((row) => buildSeries(row)));
  series.sort((a, b) => a.cohort.localeCompare(b.cohort) || a.handle.localeCompare(b.handle));

  return { generatedAt: new Date().toISOString(), scope, handle: observedHandleForScope(scope), series, note: NOTE };
}
