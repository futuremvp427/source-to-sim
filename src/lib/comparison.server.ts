/**
 * Fair-comparison read model for the reference wallet vs. the candidate shadow
 * experiments. All figures are PAPER SIMULATION / DERIVED.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { cashBreakdown } from "./shadow-core";

import { summarizeExperiment, type ExperimentSummary, type TradeLite } from "./comparison-core";
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
};

export type ComparisonData = {
  generatedAt: string;
  /** Primary fair-comparison cohort. */
  v2Rows: ComparisonRow[];
  /** Frozen historical experiments, kept for audit only. */
  v1Rows: ComparisonRow[];
};

const TRADE_LIMIT = 500;

export async function loadComparison(): Promise<ComparisonData> {
  const { data: experiments } = await supabaseAdmin.from("paper_experiments").select("*");

  const rows: ComparisonRow[] = [];
  for (const experiment of experiments ?? []) {
    const workerId = workerIdFor({ id: experiment.id, name: experiment.name });
    const [positionsRes, tradesRes, auditRes, settledRes, statusRes, checkpointRes] = await Promise.all([
      supabaseAdmin
        .from("paper_positions")
        .select("shares, cost_basis, mark")
        .eq("experiment_id", experiment.id)
        .gt("shares", 0),
      supabaseAdmin
        .from("paper_trades")
        .select("action, realized_pnl, created_at, reason")
        .eq("experiment_id", experiment.id)
        .order("created_at", { ascending: true })
        .limit(TRADE_LIMIT),
      supabaseAdmin
        .from("pipeline_audit")
        .select("total_latency_seconds")
        .eq("experiment_id", experiment.id)
        .not("total_latency_seconds", "is", null)
        .order("created_at", { ascending: false })
        .limit(100),
      supabaseAdmin
        .from("paper_settlements")
        .select("id", { count: "exact", head: true })
        .eq("experiment_id", experiment.id),
      supabaseAdmin.from("worker_status").select("*").eq("id", workerId).maybeSingle(),
      supabaseAdmin.from("worker_checkpoints").select("*").eq("id", workerId).maybeSingle(),
    ]);

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

    const skipped = (tradesRes.data ?? []).filter((t) => String(t.action) === "SKIP");
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

    const trades: TradeLite[] = (tradesRes.data ?? []).map((t) => ({
      action: String(t.action),
      realizedPnl: Number(t.realized_pnl ?? 0),
      createdAt: String(t.created_at),
    }));

    const summary = summarizeExperiment({
      startingCash: Number(experiment.starting_cash),
      cash: Number(experiment.cash),
      realizedPnl: Number(experiment.realized_pnl),
      openValue,
      trades,
      latencies: (auditRes.data ?? []).map((a) => Number(a.total_latency_seconds)),
    });

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
      settledCount: settledRes.count ?? 0,
      lastEventTs: checkpointRes.data?.last_source_ts ?? null,
      lagSeconds: statusRes.data?.lag_seconds ?? null,
      workerState: statusRes.data?.state ?? null,
      lastSuccessAt: statusRes.data?.last_success_at ?? null,
      lastError: statusRes.data?.last_error ?? null,
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
