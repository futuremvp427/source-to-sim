/**
 * Read-only V2 vs V3 capacity comparison.
 *
 * Loads every enabled V2 and V3 experiment and derives per-experiment capacity
 * metrics. Nothing here writes, seeds or mutates: all values are derived from
 * already-persisted paper rows. Drawdown is CASH-basis (see capacity-core).
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import {
  buildCapacityRow,
  countFreshMarks,
  groupCapacityRows,
  type CapacityRow,
  type CapacityWalletGroup,
  type CashPoint,
} from "./capacity-core";
import { fetchAllRows } from "./db-pagination";
import { RAW_IDEALIZED_PNL_LABEL, EXECUTION_ADJUSTED_PNL_LABEL } from "./execution-labels";
import { MARK_MAX_AGE_MS } from "./shadow-core";
import { V2_COHORT, V2_PREFIX, isV2Name } from "./v2-cohort";
import { V3_PREFIX, V3_STARTING_CASH, isV3Name } from "./v3-cohort";

export type CapacityComparisonData = {
  generatedAt: string;
  groups: CapacityWalletGroup[];
  rows: CapacityRow[];
  note: string;
};

const NOTE =
  `PAPER SIMULATION / DERIVED. V2 and V3 follow the same five wallets with the same dynamic-v1 sizing rule; only the simulated bankroll differs ($380 vs $1,000). Max cash deployment measures simulated cash committed/deployed from the running cash peak using the recorded cash_after sequence. It excludes current open-position value, is not mark-to-market drawdown, and is not realized loss. True portfolio drawdown remains unavailable until complete fresh marking exists. ` +
  `EVERY realizedPnl / rawIdealizedPnl figure on this panel is "${RAW_IDEALIZED_PNL_LABEL}": each paper fill is booked at the exact source wallet's own reported price, with no spread, slippage, latency, or fee modeling -- it is NOT a realistic or executable result. Where a sufficient observed-slippage sample exists for an experiment, its "${EXECUTION_ADJUSTED_PNL_LABEL}" figure (executionAdjustedPnl) is the closer, honest approximation and should be preferred for any performance judgment; see the out-of-sample observation log for the full historical breakdown. Where unavailable, executionAdjustedPnl explicitly says so rather than defaulting to or being confused with the raw figure.`;

async function loadCashPoints(experimentId: string): Promise<CashPoint[]> {
  const { rows } = await fetchAllRows<{ created_at: string; cash_after: number | string | null }>(
    async (from, to) => {
      const { data } = await supabaseAdmin
        .from("paper_trades")
        .select("created_at, cash_after")
        .eq("experiment_id", experimentId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
      return data ?? [];
    },
  );
  return rows.map((r) => ({
    createdAt: r.created_at,
    cashAfter: r.cash_after === null ? null : Number(r.cash_after),
  }));
}

/**
 * `includeExecutionAdjusted` defaults to false, preserving the exact prior
 * behavior (and exact prior DB read cost/failure surface) for existing
 * callers -- most importantly live-safety.server.ts's loadLiveSafety(),
 * which feeds the kill-switch/activation-stage/live-allocation gates and
 * must NOT gain a new DB dependency or any new failure mode from this
 * labeling-only change. Only the dashboard-facing API call
 * (ops.functions.ts's getCapacityComparison) opts in.
 */
export async function loadCapacityComparison(
  opts: { includeExecutionAdjusted?: boolean } = {},
): Promise<CapacityComparisonData> {
  const nowMs = Date.now();
  const { data: experimentRows } = await supabaseAdmin
    .from("paper_experiments")
    .select("id, name, wallet_address, starting_cash, cash, realized_pnl, enabled")
    .eq("enabled", true)
    .or(`name.like.${V2_PREFIX}%,name.like.${V3_PREFIX}%`);

  const experiments = (experimentRows ?? []).filter((r) => isV2Name(r.name) || isV3Name(r.name));

  // Join in the system's own already-computed execution-adjusted figures
  // (see observation/daily.server.ts) so each row can carry both P&L views
  // side by side, without recomputing anything here. Opt-in only (see doc
  // comment above). A failure to load the observation log must never block
  // the raw capacity panel: every row's executionAdjustedPnl simply falls
  // back to explicitly unavailable.
  let adjustedByExperimentId = new Map<string, number | null>();
  if (opts.includeExecutionAdjusted) {
    try {
      const { loadObservationLog } = await import("./observation/daily.server");
      const log = await loadObservationLog();
      adjustedByExperimentId = new Map(
        log.series.map((s) => [s.experimentId, s.slippageAdjustedCumulativePnl] as const),
      );
    } catch {
      // executionAdjustedPnl stays unavailable for every row below.
    }
  }

  const rows: CapacityRow[] = [];
  for (const experiment of experiments) {
    const isV3 = isV3Name(experiment.name);
    const handle = experiment.name.slice((isV3 ? V3_PREFIX : V2_PREFIX).length);

    const [{ data: positions }, { count: buys }, { count: sells }, { count: skips }, cashPoints] =
      await Promise.all([
        supabaseAdmin
          .from("paper_positions")
          .select("shares, cost_basis, settlement_status, mark, mark_ts")
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
          .eq("action", "SELL"),
        supabaseAdmin
          .from("paper_trades")
          .select("*", { count: "exact", head: true })
          .eq("experiment_id", experiment.id)
          .eq("action", "SKIP")
          .like("reason", "INSUFFICIENT_CASH_RESERVE%"),
        loadCashPoints(experiment.id),
      ]);

    const openPositions = (positions ?? []).filter((p) => Number(p.shares) > 0);
    const openCostBasis = openPositions.reduce((sum, p) => sum + Number(p.cost_basis ?? 0), 0);
    const markedOpenPositions = countFreshMarks(
      openPositions.map((p) => ({ mark: p.mark, markTs: p.mark_ts })),
      nowMs,
      MARK_MAX_AGE_MS,
    );
    const settledMarkets = (positions ?? []).filter(
      (p) => p.settlement_status === "settled_won" || p.settlement_status === "settled_lost",
    ).length;

    const hasAdjustedEntry = adjustedByExperimentId.has(experiment.id);
    rows.push(
      buildCapacityRow({
        id: experiment.id,
        name: experiment.name,
        cohort: isV3 ? "V3" : "V2",
        handle,
        wallet: experiment.wallet_address,
        startingBankroll: Number(experiment.starting_cash ?? (isV3 ? V3_STARTING_CASH : 0)),
        cash: Number(experiment.cash ?? 0),
        realizedPnl: Number(experiment.realized_pnl ?? 0),
        openCostBasis,
        openPositions: openPositions.length,
        markedOpenPositions,
        buys: buys ?? 0,
        sells: sells ?? 0,
        insufficientCashSkips: skips ?? 0,
        settledMarkets,
        cashPoints,
        executionAdjustedCumulativePnl: hasAdjustedEntry
          ? (adjustedByExperimentId.get(experiment.id) ?? null)
          : null,
        executionAdjustedSource: "observation_log",
        executionAdjustedUnavailableReason: hasAdjustedEntry
          ? undefined
          : "No observation-log series exists yet for this experiment.",
      }),
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    groups: groupCapacityRows(rows, V2_COHORT),
    rows,
    note: NOTE,
  };
}
