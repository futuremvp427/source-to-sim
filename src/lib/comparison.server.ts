/**
 * Fair-comparison read model for the reference wallet vs. the candidate shadow
 * experiments. All figures are PAPER SIMULATION / DERIVED.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { cashBreakdown } from "./shadow-core";
import { estimateCashRunway } from "./cash-runway";
import { median } from "./copyability/core";
import { summarizeCopyability, type CopyabilitySummary } from "./copyability/observe.server";
import { fetchAllRows } from "./db-pagination";

import { summarizeExperiment, type ExperimentSummary, type TradeLite } from "./comparison-core";
import { summarizeLatency, type LatencyBreakdown } from "./latency-core";
import { workerIdFor } from "./shadow.server";
import { V2_REFERENCE_NAME, experimentCohort, experimentLabel, type Cohort } from "./v2-cohort";
import { isV4PilotName } from "./v4-pilot";

export type ComparisonRow = ExperimentSummary & {
  id: string;
  name: string;
  label: string;
  wallet: string;
  cohort: Cohort;
  enabled: boolean;
  isReference: boolean;
  startingCash: number;
  cash: number;
  reservedCash: number;
  spendableCash: number;
  sizingRule: string;
  openPositions: number;
  markedPositions: number;
  openCostBasis: number;
  unrealizedPnl: number | null;
  skippedCount: number;
  skipReasons: { reason: string; count: number }[];
  settledCount: number;
  lastEventTs: number | null;
  lagSeconds: number | null;
  workerState: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  /* --- evidence pass (measurement only) --- */
  postGoLiveSourceEvents: number | null;
  eligibleDecisions: number;
  totalPaperTrades: number;
  skipRatePct: number | null;
  avgBuyUsd: number | null;
  avgSellUsd: number | null;
  nextBuyUsd: number | null;
  estimatedRemainingBuys: number;
  medianDetectionLatencySeconds: number | null;
  medianDecisionLatencySeconds: number | null;
  /** Stage-by-stage decomposition; decision latency alone is never the total. */
  latency: LatencyBreakdown;
  lastSourceActivityTs: number | null;
  copyability: CopyabilitySummary;
};

export type ComparisonData = {
  generatedAt: string;
  /** Primary fair-comparison cohort. */
  v2Rows: ComparisonRow[];
  /** Frozen historical experiments, kept for audit only. */
  v1Rows: ComparisonRow[];
};

type RealizedTradeRow = {
  id: string;
  action: string;
  realized_pnl: number | null;
  created_at: string;
};

/** Exact database-side aggregation of the full decision history. */
export type DecisionStats = {
  eligibleDecisions: number;
  buys: number;
  sells: number;
  skips: number;
  avgBuyUsd: number | null;
  avgSellUsd: number | null;
  lastSourceTs: number | null;
  skipReasons: { reason: string; count: number }[];
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Parses the `paper_trade_decision_stats` RPC payload. The RPC excludes
 * SETTLEMENT lifecycle rows, so these numbers are the eligible-decision
 * denominators the dashboard has always shown — computed in Postgres instead of
 * by paginating ~100k+ paper_trades rows into memory on every refresh.
 */
export function parseDecisionStats(payload: unknown): DecisionStats {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const int = (key: string): number => {
    const n = Number(raw[key] ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  const avg = (key: string): number | null => {
    const value = raw[key];
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? round2(n) : null;
  };
  const lastSourceTs = raw["last_source_ts"];
  const reasons = Array.isArray(raw["skip_reasons"]) ? (raw["skip_reasons"] as unknown[]) : [];
  return {
    eligibleDecisions: int("eligible_decisions"),
    buys: int("buys"),
    sells: int("sells"),
    skips: int("skips"),
    avgBuyUsd: avg("avg_buy_usd"),
    avgSellUsd: avg("avg_sell_usd"),
    lastSourceTs:
      lastSourceTs === null || lastSourceTs === undefined || !Number.isFinite(Number(lastSourceTs))
        ? null
        : Number(lastSourceTs),
    skipReasons: reasons.map((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      return { reason: String(row["reason"] ?? "Unspecified"), count: Number(row["count"] ?? 0) };
    }),
  };
}

async function loadDecisionStats(experimentId: string): Promise<DecisionStats> {
  const { data, error } = await supabaseAdmin.rpc("paper_trade_decision_stats", {
    p_experiment_id: experimentId,
  });
  if (error) throw new Error(error.message);
  return parseDecisionStats(data);
}

type SettlementRow = {
  id: string;
  realized_pnl: number | null;
  settled_at: string;
};

/**
 * Only realized-P&L-bearing decision rows are loaded. Wins, losses and
 * drawdown are driven exclusively by non-zero realized P&L, so excluding the
 * (vastly larger) BUY/SKIP population is exact, not an approximation.
 */
async function loadRealizedTrades(experimentId: string): Promise<RealizedTradeRow[]> {
  const paged = await fetchAllRows<RealizedTradeRow>(async (from, to) => {
    const { data, error } = await supabaseAdmin
      .from("paper_trades")
      .select("id, action, realized_pnl, created_at")
      .eq("experiment_id", experimentId)
      .neq("action", "SETTLEMENT")
      .neq("realized_pnl", 0)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as RealizedTradeRow[];
  });
  if (!paged.complete) throw new Error(`Comparison trade history truncated for ${experimentId}`);
  return paged.rows;
}

async function loadAllSettlements(experimentId: string): Promise<SettlementRow[]> {
  const paged = await fetchAllRows<SettlementRow>(async (from, to) => {
    const { data, error } = await supabaseAdmin
      .from("paper_settlements")
      .select("id, realized_pnl, settled_at")
      .eq("experiment_id", experimentId)
      .order("settled_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as SettlementRow[];
  });
  if (!paged.complete) throw new Error(`Comparison settlement history truncated for ${experimentId}`);
  return paged.rows;
}

export async function loadComparison(): Promise<ComparisonData> {
  const { data: experiments, error: experimentsError } = await supabaseAdmin
    .from("paper_experiments")
    .select("*");
  if (experimentsError) throw new Error(experimentsError.message);

  const rows: ComparisonRow[] = [];
  // The V4 compound pilot has its own dedicated card (see the HighTempTation
  // strategy detail view) and does not fit either the frozen-V1-audit or
  // fair-comparison-V2 bucket this reader produces — excluded, not silently
  // miscategorized as V1.
  for (const experiment of (experiments ?? []).filter((e) => !isV4PilotName(e.name))) {
    const workerId = workerIdFor({ id: experiment.id, name: experiment.name });
    const [
      positionsRes,
      decisionStats,
      realizedTrades,
      auditRes,
      settlements,
      statusRes,
      checkpointRes,
      postGoLiveRes,
      copyability,
    ] = await Promise.all([
      supabaseAdmin
        .from("paper_positions")
        .select("shares, cost_basis, mark")
        .eq("experiment_id", experiment.id)
        .gt("shares", 0),
      loadDecisionStats(experiment.id),
      loadRealizedTrades(experiment.id),
      supabaseAdmin
        .from("pipeline_audit")
        .select(
          "total_latency_seconds, detection_latency_seconds, decision_latency_seconds, source_ts, detected_at, event_persisted_at, decision_at",
        )
        .eq("experiment_id", experiment.id)
        .order("created_at", { ascending: false })
        .limit(100),
      loadAllSettlements(experiment.id),
      supabaseAdmin.from("worker_status").select("*").eq("id", workerId).maybeSingle(),
      supabaseAdmin.from("worker_checkpoints").select("*").eq("id", workerId).maybeSingle(),
      experiment.follow_from_ts === null
        ? Promise.resolve({ count: null })
        : supabaseAdmin
            .from("source_events")
            .select("*", { count: "exact", head: true })
            .eq("wallet", experiment.wallet_address.toLowerCase())
            .gte("source_ts", Number(experiment.follow_from_ts)),
      summarizeCopyability(experiment.id),
    ]);

    if (positionsRes.error) throw new Error(positionsRes.error.message);
    if (auditRes.error) throw new Error(auditRes.error.message);
    if (statusRes.error) throw new Error(statusRes.error.message);
    if (checkpointRes.error) throw new Error(checkpointRes.error.message);

    const positions = positionsRes.data ?? [];
    const marked = positions.filter((p) => p.mark !== null);
    const openValue =
      positions.length === 0
        ? 0
        : marked.length === positions.length
          ? marked.reduce((sum, p) => sum + Number(p.shares) * Number(p.mark), 0)
          : null;
    const openCostBasis =
      Math.round(positions.reduce((sum, p) => sum + Number(p.cost_basis), 0) * 100) / 100;

    // The SETTLEMENT-action paper_trades row is lifecycle audit evidence only
    // (realized_pnl is always 0 — see apply_verified_paper_settlement). It is
    // never an eligible trading decision: excluded from the decision
    // denominator, skip rate, source-activity timestamp and the performance
    // stream fed into summarizeExperiment. The real settlement P&L already
    // enters that stream exactly once via settlementPerformanceEvents below,
    // sourced from paper_settlements.
    const tradePerformanceEvents: TradeLite[] = realizedTrades.map((t) => ({
      action: String(t.action),
      realizedPnl: Number(t.realized_pnl ?? 0),
      createdAt: String(t.created_at),
    }));
    const settlementPerformanceEvents: TradeLite[] = settlements.map((s) => ({
      action: "SETTLEMENT",
      realizedPnl: Number(s.realized_pnl ?? 0),
      createdAt: String(s.settled_at),
    }));

    const summary = summarizeExperiment({
      startingCash: Number(experiment.starting_cash),
      cash: Number(experiment.cash),
      realizedPnl: Number(experiment.realized_pnl),
      openValue,
      trades: [...tradePerformanceEvents, ...settlementPerformanceEvents],
      counts: { buys: decisionStats.buys, sells: decisionStats.sells },
      latencies: (auditRes.data ?? [])
        .filter((a) => a.total_latency_seconds !== null)
        .map((a) => Number(a.total_latency_seconds)),
    });

    const runway = estimateCashRunway({
      startingCash: Number(experiment.starting_cash),
      cash: Number(experiment.cash),
    });
    const lastSourceActivityTs = decisionStats.lastSourceTs;

    rows.push({
      ...summary,
      id: experiment.id,
      name: experiment.name,
      label: experimentLabel(experiment.name),
      wallet: experiment.wallet_address,
      cohort: experimentCohort(experiment.name),
      enabled: Boolean(experiment.enabled),
      isReference: experiment.name === V2_REFERENCE_NAME || experiment.name === "SHADOW",
      startingCash: Number(experiment.starting_cash),
      cash: Number(experiment.cash),
      reservedCash: cashBreakdown({
        startingCash: Number(experiment.starting_cash),
        cash: Number(experiment.cash),
      }).reservedCash,
      spendableCash: cashBreakdown({
        startingCash: Number(experiment.starting_cash),
        cash: Number(experiment.cash),
      }).spendableCash,
      sizingRule: String(experiment.sizing_rule ?? "dynamic-v1"),
      openPositions: positions.length,
      markedPositions: marked.length,
      openCostBasis,
      unrealizedPnl: openValue === null ? null : Math.round((openValue - openCostBasis) * 100) / 100,
      skippedCount: decisionStats.skips,
      skipReasons: decisionStats.skipReasons,
      settledCount: settlements.length,
      lastEventTs: checkpointRes.data?.last_source_ts ?? null,
      lagSeconds: statusRes.data?.lag_seconds ?? null,
      workerState: statusRes.data?.state ?? null,
      lastSuccessAt: statusRes.data?.last_success_at ?? null,
      lastError: statusRes.data?.last_error ?? null,
      postGoLiveSourceEvents: postGoLiveRes.count ?? null,
      eligibleDecisions: decisionStats.eligibleDecisions,
      totalPaperTrades: summary.buys + summary.sells,
      skipRatePct:
        decisionStats.eligibleDecisions === 0
          ? null
          : Math.round((decisionStats.skips / decisionStats.eligibleDecisions) * 1000) / 10,
      avgBuyUsd: decisionStats.avgBuyUsd,
      avgSellUsd: decisionStats.avgSellUsd,
      nextBuyUsd: runway.nextBuyUsd,
      estimatedRemainingBuys: runway.estimatedRemainingBuys,
      medianDetectionLatencySeconds: median(
        (auditRes.data ?? [])
          .filter((a) => a.detection_latency_seconds !== null)
          .map((a) => Number(a.detection_latency_seconds)),
      ),
      medianDecisionLatencySeconds: median(
        (auditRes.data ?? [])
          .filter((a) => a.decision_latency_seconds !== null)
          .map((a) => Number(a.decision_latency_seconds)),
      ),
      latency: summarizeLatency(
        (auditRes.data ?? []).map((a) => ({
          sourceTs: a.source_ts === null ? null : Number(a.source_ts),
          detectedAt: a.detected_at ?? null,
          eventPersistedAt: a.event_persisted_at ?? null,
          decisionAt: a.decision_at ?? null,
        })),
      ),
      lastSourceActivityTs,
      copyability,
    });
  }

  const order = (a: ComparisonRow, b: ComparisonRow) =>
    a.isReference ? -1 : b.isReference ? 1 : a.label.localeCompare(b.label);
  return {
    generatedAt: new Date().toISOString(),
    v2Rows: rows.filter((r) => r.cohort === "V2").sort(order),
    v1Rows: rows.filter((r) => r.cohort === "V1").sort(order),
  };
}
