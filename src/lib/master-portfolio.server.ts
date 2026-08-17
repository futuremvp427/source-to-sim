/**
 * Read-only Master Portfolio loader (PAPER SIMULATION / DERIVED).
 * Reads existing experiment/position/worker rows and aggregates them; it never
 * writes, and it never includes V3 CAPACITY, candidate, general shadow or V1 rows.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import {
  buildMasterPortfolio,
  masterCategoryForExperiment,
  walletTotals,
  type MasterCategoryKey,
  type MasterPortfolio,
  type MasterWallet,
} from "./master-portfolio";
import { workerIdFor } from "./shadow.server";
import { experimentLabel } from "./v2-cohort";

export async function loadMasterPortfolio(): Promise<MasterPortfolio> {
  const { data: experiments, error } = await supabaseAdmin
    .from("paper_experiments")
    .select("id, name, wallet_address, starting_cash, cash, realized_pnl");
  if (error) throw new Error(error.message);

  const included = (experiments ?? []).filter((e) => masterCategoryForExperiment(e.name) !== null);
  const byCategory = new Map<MasterCategoryKey, MasterWallet[]>();

  for (const experiment of included) {
    const category = masterCategoryForExperiment(experiment.name)!;
    const workerId = workerIdFor({ id: experiment.id, name: experiment.name });
    const [positionsRes, statusRes] = await Promise.all([
      supabaseAdmin
        .from("paper_positions")
        .select("shares, cost_basis, mark")
        .eq("experiment_id", experiment.id)
        .gt("shares", 0),
      supabaseAdmin
        .from("worker_status")
        .select("state, lag_seconds, last_error")
        .eq("id", workerId)
        .maybeSingle(),
    ]);
    if (positionsRes.error) throw new Error(positionsRes.error.message);
    if (statusRes.error) throw new Error(statusRes.error.message);

    const positions = positionsRes.data ?? [];
    const marked = positions.filter((p) => p.mark !== null);
    const wallet = walletTotals({
      experimentId: experiment.id,
      name: experiment.name,
      label: experimentLabel(experiment.name),
      wallet: experiment.wallet_address,
      startingCapital: Number(experiment.starting_cash),
      cash: Number(experiment.cash),
      openCostBasis: positions.reduce((sum, p) => sum + Number(p.cost_basis), 0),
      realizedPnl: Number(experiment.realized_pnl),
      markedOpenValue: marked.reduce((sum, p) => sum + Number(p.shares) * Number(p.mark), 0),
      openPositions: positions.length,
      markedPositions: marked.length,
      workerState: statusRes.data?.state ?? null,
      lagSeconds: statusRes.data?.lag_seconds ?? null,
      lastError: statusRes.data?.last_error ?? null,
    });
    byCategory.set(category, [...(byCategory.get(category) ?? []), wallet]);
  }

  return buildMasterPortfolio(new Date().toISOString(), byCategory);
}