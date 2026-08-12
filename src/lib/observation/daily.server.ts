/**
 * READ-ONLY out-of-sample observation log.
 *
 * Every value here is derived from already-persisted, append-only paper rows
 * (paper_settlements, paper_trades, paper_positions, copyability_observations,
 * worker_status). This module writes nothing, seeds nothing, resizes nothing and
 * changes no qualification rule: it exists purely so daily statistics survive
 * and stay inspectable while the cohorts keep running untouched.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { fetchAllRows } from "./../db-pagination";
import { median } from "./../copyability/core";
import { MARK_MAX_AGE_MS } from "./../shadow-core";
import { V2_PREFIX, isV2Name } from "./../v2-cohort";
import { V3_PREFIX, isV3Name } from "./../v3-cohort";
import { classifyWorker, type WorkerRow } from "./../worker-health";
import { buildMilestones, estimateSlippageAdjustedPnl, type Milestone } from "./milestones";

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
  /** Median observed entry slippage in cents used for the adjusted estimates. */
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
  realizedPnl: number;
  slippageAdjustedCumulativePnl: number | null;
  worker: { id: string; status: "PASS" | "WARN" | "FAIL"; reason: string };
  days: ObservationDay[];
  milestones: Milestone[];
};

export type ObservationLogData = {
  generatedAt: string;
  handle: string;
  series: ObservationSeries[];
  note: string;
};

const NOTE =
  "PAPER SIMULATION / DERIVED. Out-of-sample observation only: no strategy, sizing, bankroll or qualification change is driven by anything on this panel. Milestones are research flags and never promote a wallet or enable live execution — live allocation stays $0 with the kill switch engaged. Slippage-adjusted figures are estimates built from observed entry slippage, not realized results.";

const OBSERVED_HANDLE = "Poligarch";

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

async function loadSlippageCents(experimentId: string): Promise<{
  medianCents: number | null;
  fillabilityPct: number | null;
  completenessPct: number | null;
}> {
  const { rows } = await fetchAllRows<{
    status: string;
    fillable: boolean | null;
    slippage_cents: number | string | null;
  }>(async (from, to) => {
    const { data } = await supabaseAdmin
      .from("copyability_observations")
      .select("status, fillable, slippage_cents")
      .eq("experiment_id", experimentId)
      .range(from, to);
    return data ?? [];
  });

  if (rows.length === 0) return { medianCents: null, fillabilityPct: null, completenessPct: null };
  const observed = rows.filter((r) => r.status === "observed");
  const cents = observed
    .map((r) => (r.slippage_cents === null ? null : Number(r.slippage_cents)))
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const fillableCount = observed.filter((r) => r.fillable === true).length;
  return {
    medianCents: median(cents),
    fillabilityPct: observed.length === 0 ? null : (fillableCount / observed.length) * 100,
    completenessPct: (observed.length / rows.length) * 100,
  };
}

async function buildSeries(experiment: {
  id: string;
  name: string;
}): Promise<ObservationSeries> {
  const cohort: "V2" | "V3" = isV3Name(experiment.name) ? "V3" : "V2";
  const handle = experiment.name.slice((cohort === "V3" ? V3_PREFIX : V2_PREFIX).length);

  const [settlements, slippage, positions, buys, skips, workers] = await Promise.all([
    loadSettlements(experiment.id),
    loadSlippageCents(experiment.id),
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
      slippageCents: slippage.medianCents,
    });
    if (adjusted !== null) {
      bucket.adjusted += adjusted;
      bucket.adjustable += 1;
    }
    bucket.settlements > 0 && (realizedTotal += 0);
    byDay.set(key, bucket);
  }

  const days: ObservationDay[] = [];
  let cumulative = 0;
  let cumulativeAdjusted: number | null = slippage.medianCents === null ? null : 0;
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

export async function loadObservationLog(): Promise<ObservationLogData> {
  const { data } = await supabaseAdmin
    .from("paper_experiments")
    .select("id, name, enabled")
    .eq("enabled", true)
    .or(`name.like.${V2_PREFIX}%,name.like.${V3_PREFIX}%`);

  const experiments = (data ?? []).filter(
    (row) => (isV2Name(row.name) || isV3Name(row.name)) && row.name.includes(OBSERVED_HANDLE),
  );

  const series = await Promise.all(experiments.map((row) => buildSeries(row)));
  series.sort((a, b) => a.cohort.localeCompare(b.cohort));

  return { generatedAt: new Date().toISOString(), handle: OBSERVED_HANDLE, series, note: NOTE };
}
