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

type ComparisonTradeRow = {
  id: string;
  action: string;
  realized_pnl: number | null;
  created_at: string;
  reason: string | null;
  notional: number | null;
  source_ts: number | null;
};

type SettlementRow = {
  id: string;
  realized_pnl: number | null;
  settled_at: string;
};

async function loadAllTrades(experimentId: string): Promise<ComparisonTradeRow[]> {
  const paged = await fetchAllRows<ComparisonTradeRow>(async (from, to) => {
    const { data, error } = await supabaseAdmin
      .from("paper_trades")
      .select("id, action, realized_pnl, created_at, reason, notional, source_ts")
      .eq("experiment_id", experimentId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as ComparisonTradeRow[];
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

function meanNotional(rows: ComparisonTradeRow[], action: string): number | null {
  const values = rows
    .filter((t) => String(t.action) === action)
    .map((t) => Number(t.notional ?? 0))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, n) => sum + n, 0) / values.length) * 100) / 100;
}

export async function loadComparison(): Promise<ComparisonData> {
  const { data: experiments, error: experimentsError } = await supabaseAdmin
    .from("paper_experiments")
    .select("*");
  if (experimentsError) throw new Error(experimentsError.message);

  const rows: ComparisonRow[] = [];
  for (const experiment of experiments ?? []) {
    const workerId = workerIdFor({ id: experiment.id, name: experiment.name });
    const [
      positionsRes,
      allTrades,
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
      loadAllTrades(experiment.id),
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

    const skipped = allTrades.filter((t) => String(t.action) === "SKIP");
    const reasonCounts = new Map<string, number>();
    for (const t of skipped) {
      const raw = String(t.reason ?? "Unspecified");
      const key = raw.split("(")[0]!.trim() || "Unspecified";
      reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
    }
    const skipReasons = [...reasonCounts]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    const tradePerformanceEvents: TradeLite[] = allTrades.map((t) => ({
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
      latencies: (auditRes.data ?? [])
        .filter((a) => a.total_latency_seconds !== null)
        .map((a) => Number(a.total_latency_seconds)),
    });

    const runway = estimateCashRunway({
      startingCash: Number(experiment.starting_cash),
      cash: Number(experiment.cash),
    });
    const lastSourceActivityTs = allTrades.reduce<number | null>((acc, t) => {
      const ts = t.source_ts === null ? null : Number(t.source_ts);
      return ts === null ? acc : acc === null ? ts : Math.max(acc, ts);
    }, null);

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
      skippedCount: skipped.length,
      skipReasons,
      settledCount: settlements.length,
      lastEventTs: checkpointRes.data?.last_source_ts ?? null,
      lagSeconds: statusRes.data?.lag_seconds ?? null,
      workerState: statusRes.data?.state ?? null,
      lastSuccessAt: statusRes.data?.last_success_at ?? null,
      lastError: statusRes.data?.last_error ?? null,
      postGoLiveSourceEvents: postGoLiveRes.count ?? null,
      eligibleDecisions: allTrades.length,
      totalPaperTrades: summary.buys + summary.sells,
      skipRatePct:
        allTrades.length === 0 ? null : Math.round((skipped.length / allTrades.length) * 1000) / 10,
      avgBuyUsd: meanNotional(allTrades, "BUY"),
      avgSellUsd: meanNotional(allTrades, "SELL"),
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
