/**
 * SHADOW V4 COMPOUND PILOT: HighTempTation read model (PAPER SIMULATION /
 * DERIVED). Read-only: loads the pilot experiment plus the existing V2
 * HighTempTation experiment for a since-activation A/B comparison. Never
 * writes, never touches Master Portfolio, never modifies V2/V3.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { v2ExperimentName } from "./v2-cohort";
import { workerIdFor } from "./shadow.server";
import {
  V4_PILOT_ACTIVATION_BASELINE,
  V4_PILOT_FOLLOW_FROM_TS,
  V4_PILOT_NAME,
  V4_PILOT_SIZING_RULE,
} from "./v4-pilot";

export type V4PilotWalletView = {
  experimentId: string;
  name: string;
  bookCapital: number;
  cash: number;
  realizedPnl: number;
  openCostBasis: number;
  /** null when book capital is not positive — never shown as a fabricated 0%. */
  deployedPct: number | null;
  openPositions: number;
  /** Book capital minus the shared activation baseline. Never called "equity". */
  sinceActivationDelta: number;
};

type FullWalletView = V4PilotWalletView & {
  startingCash: number;
  workerState: string | null;
  lastError: string | null;
};

export type V4PilotComparison = {
  activationBaseline: number;
  activatedAt: string;
  followFromTs: number;
  sizingRule: string;
  pilot: FullWalletView;
  /** Existing V2 HighTempTation (dynamic-v1), for the A/B comparison. Null only if that row is missing. */
  v2: V4PilotWalletView | null;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

async function loadWalletView(name: string): Promise<FullWalletView | null> {
  const { data: experiment, error } = await supabaseAdmin
    .from("paper_experiments")
    .select("id, name, starting_cash, cash, realized_pnl")
    .eq("name", name)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!experiment) return null;

  const workerId = workerIdFor({ id: experiment.id, name: experiment.name });
  const [positionsRes, statusRes] = await Promise.all([
    supabaseAdmin.from("paper_positions").select("cost_basis").eq("experiment_id", experiment.id).gt("shares", 0),
    supabaseAdmin.from("worker_status").select("state, last_error").eq("id", workerId).maybeSingle(),
  ]);
  if (positionsRes.error) throw new Error(positionsRes.error.message);
  if (statusRes.error) throw new Error(statusRes.error.message);

  const openCostBasis = round2((positionsRes.data ?? []).reduce((sum, p) => sum + Number(p.cost_basis), 0));
  const bookCapital = round2(Number(experiment.starting_cash) + Number(experiment.realized_pnl));

  return {
    experimentId: experiment.id,
    name: experiment.name,
    startingCash: round2(Number(experiment.starting_cash)),
    bookCapital,
    cash: round2(Number(experiment.cash)),
    realizedPnl: round2(Number(experiment.realized_pnl)),
    openCostBasis,
    deployedPct: bookCapital > 0 ? round2((openCostBasis / bookCapital) * 100) : null,
    openPositions: (positionsRes.data ?? []).length,
    sinceActivationDelta: round2(bookCapital - V4_PILOT_ACTIVATION_BASELINE),
    workerState: statusRes.data?.state ?? null,
    lastError: statusRes.data?.last_error ?? null,
  };
}

/** Null when the pilot has not been seeded yet (e.g. before its migration ran). */
export async function loadV4PilotComparison(): Promise<V4PilotComparison | null> {
  const pilot = await loadWalletView(V4_PILOT_NAME);
  if (!pilot) return null;
  const v2 = await loadWalletView(v2ExperimentName("HighTempTation"));

  return {
    activationBaseline: V4_PILOT_ACTIVATION_BASELINE,
    activatedAt: new Date(V4_PILOT_FOLLOW_FROM_TS * 1000).toISOString(),
    followFromTs: V4_PILOT_FOLLOW_FROM_TS,
    sizingRule: V4_PILOT_SIZING_RULE,
    pilot,
    v2,
  };
}
