/**
 * Fair-comparison read model for the reference wallet vs. the candidate shadow
 * experiments. All figures are PAPER SIMULATION / DERIVED.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { summarizeExperiment, type ExperimentSummary, type TradeLite } from "./comparison-core";
import { EXPERIMENT_NAME, workerIdFor } from "./shadow.server";

export type ComparisonRow = ExperimentSummary & {
  id: string;
  name: string;
  label: string;
  wallet: string;
  isReference: boolean;
  startingCash: number;
  cash: number;
  reservedCash: number;
  spendableCash: number;
  sizingRule: string;
  openPositions: number;
  markedPositions: number;
  settledCount: number;
  lastEventTs: number | null;
  lagSeconds: number | null;
  workerState: string | null;
  lastError: string | null;
};

export type ComparisonData = {
  generatedAt: string;
  rows: ComparisonRow[];
};

const TRADE_LIMIT = 500;

export async function loadComparison(): Promise<ComparisonData> {
  const { data: experiments } = await supabaseAdmin
    .from("paper_experiments")
    .select("*")
    .eq("enabled", true);

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
        .select("action, realized_pnl, created_at")
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
      label: experiment.name === EXPERIMENT_NAME ? "badatmath. (reference)" : experiment.name.replace("SHADOW:", ""),
      wallet: experiment.wallet_address,
      isReference: experiment.name === EXPERIMENT_NAME,
      startingCash: Number(experiment.starting_cash),
      cash: Number(experiment.cash),
      openPositions: positions.length,
      markedPositions: marked.length,
      settledCount: settledRes.count ?? 0,
      lastEventTs: checkpointRes.data?.last_source_ts ?? null,
      lagSeconds: statusRes.data?.lag_seconds ?? null,
      workerState: statusRes.data?.state ?? null,
      lastError: statusRes.data?.last_error ?? null,
    });
  }

  rows.sort((a, b) => (a.isReference ? -1 : b.isReference ? 1 : a.label.localeCompare(b.label)));
  return { generatedAt: new Date().toISOString(), rows };
}
