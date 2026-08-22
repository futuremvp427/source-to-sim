/**
 * FINAL BUILD Parts 1-5: fetch + orchestration — SERVER (DB) layer.
 *
 * Fetches the flat get_sports_shadow_episode_outcomes join for a whole epoch (paginated
 * -- PostgREST's default row cap would otherwise silently truncate a large epoch, the
 * exact class of bug Part 7 fixed for milestone counting), maps it to analytics.ts's
 * EpisodeOutcomeRow, and runs the full analytics/robustness/bootstrap/baseline/
 * classification pipeline. All actual math stays in the pure modules this file only
 * calls into -- this file's only job is I/O and wiring.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import {
  computeClusterReturns,
  computeFullAnalyticsReport,
  DECLARED_STRATEGY_NOTIONAL_USD,
  filterToTier,
  type EpisodeOutcomeRow,
  type FullAnalyticsReport,
} from "./analytics";
import { computeMarketImpliedBaseline, type BaselineComparison } from "./baseline";
import { bootstrapConfidenceInterval, type BootstrapResult } from "./bootstrap";
import {
  applyOneCentAdverseStress,
  applyTwoCentAdverseStress,
  compareFirstHalfSecondHalf,
  compareSizeTierCapacity,
  computeWalletConcentration,
  removeLargestLoss,
  removeLargestWin,
  removeTopNWins,
  type HalfComparison,
  type WalletConcentration,
} from "./robustness";
import type { BreakdownEntry, CoreMetrics } from "./analytics";

const PAGE_SIZE = 1000;

type RawOutcomeRow = {
  signal_id: string;
  cluster_key: string | null;
  source_wallet: string;
  bet_type: EpisodeOutcomeRow["betType"];
  scheduled_start_at: string | null;
  signal_created_at: string;
  notional_tier_usd: number;
  chosen_venue: EpisodeOutcomeRow["chosenVenue"];
  fill_status: EpisodeOutcomeRow["fillStatus"];
  contracts: number;
  vwap: number | null;
  fee_usd: number | null;
  all_in_cost_usd: number | null;
  reject_reason: string | null;
  routing_timestamp: string;
  spread: number | null;
  detection_latency_ms: number | null;
  fire_at: string | null;
  observed_at: string | null;
  pmus_result: EpisodeOutcomeRow["pmusResult"];
  kalshi_result: EpisodeOutcomeRow["kalshiResult"];
  settlement_status: EpisodeOutcomeRow["settlementStatus"];
  gross_pnl_usd: number | null;
  total_fees_usd: number | null;
  net_pnl_usd: number | null;
};

function fromRawRow(row: RawOutcomeRow): EpisodeOutcomeRow {
  return {
    signalId: row.signal_id,
    clusterKey: row.cluster_key,
    sourceWallet: row.source_wallet,
    betType: row.bet_type,
    scheduledStartAtIso: row.scheduled_start_at,
    signalCreatedAtIso: row.signal_created_at,
    notionalTierUsd: Number(row.notional_tier_usd),
    chosenVenue: row.chosen_venue,
    fillStatus: row.fill_status,
    contracts: Number(row.contracts),
    vwap: row.vwap !== null ? Number(row.vwap) : null,
    feeUsd: row.fee_usd !== null ? Number(row.fee_usd) : null,
    allInCostUsd: row.all_in_cost_usd !== null ? Number(row.all_in_cost_usd) : null,
    rejectReason: row.reject_reason,
    routingTimestampIso: row.routing_timestamp,
    spread: row.spread !== null ? Number(row.spread) : null,
    detectionLatencyMs: row.detection_latency_ms,
    fireAtIso: row.fire_at,
    observedAtIso: row.observed_at,
    pmusResult: row.pmus_result,
    kalshiResult: row.kalshi_result,
    settlementStatus: row.settlement_status,
    grossPnlUsd: row.gross_pnl_usd !== null ? Number(row.gross_pnl_usd) : null,
    totalFeesUsd: row.total_fees_usd !== null ? Number(row.total_fees_usd) : null,
    netPnlUsd: row.net_pnl_usd !== null ? Number(row.net_pnl_usd) : null,
  };
}

/**
 * Paginated (never a single unbounded call, never silently truncated by PostgREST's
 * default row cap) -- fetches EVERY (episode, tier) row for the epoch. This is a batch
 * analytics job, not a live dashboard read, so an unbounded-by-volume fetch here (unlike
 * dashboard.server.ts's deliberately bounded reads) is the correct choice: a milestone
 * snapshot must reflect the COMPLETE epoch, not a recent window of it.
 */
export async function fetchAllEpisodeOutcomes(epochId: string): Promise<EpisodeOutcomeRow[]> {
  const all: EpisodeOutcomeRow[] = [];
  let offset = 0;
  for (;;) {
    // Codex review (commit fa34d0f) caught a real P2: offset pagination with NO stable
    // ordering is undefined in Postgres -- a concurrent insert while paging could shift
    // rows across the offset boundary, duplicating or dropping rows and silently
    // corrupting P&L/bootstrap/classification. Order by the same (signal_id,
    // notional_tier_usd) pair the RPC's own DISTINCT ON is unique over.
    const { data, error } = await supabaseAdmin
      .rpc("get_sports_shadow_episode_outcomes" as never, { p_epoch_id: epochId } as never)
      .order("signal_id", { ascending: true })
      .order("notional_tier_usd", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as RawOutcomeRow[];
    all.push(...rows.map(fromRawRow));
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

export type AnalysisWindow = { sinceIso: string | null; untilIso: string | null };

function withinWindow(row: EpisodeOutcomeRow, window: AnalysisWindow): boolean {
  const t = Date.parse(row.signalCreatedAtIso);
  if (window.sinceIso !== null && t < Date.parse(window.sinceIso)) return false;
  if (window.untilIso !== null && t >= Date.parse(window.untilIso)) return false;
  return true;
}

export type EpisodeAnalysisReport = {
  notionalTierUsd: number;
  analytics: FullAnalyticsReport;
  robustness: {
    top5WinsRemoved: { removedCount: number; removedNetPnlUsd: number; remaining: CoreMetrics };
    largestWinRemoved: { removedCount: number; removedNetPnlUsd: number; remaining: CoreMetrics };
    largestLossRemoved: { removedNetPnlUsd: number; remaining: CoreMetrics };
    oneCentAdverseStress: CoreMetrics;
    twoCentAdverseStress: CoreMetrics;
    firstHalfSecondHalf: HalfComparison;
    walletConcentration: WalletConcentration;
    sizeTierCapacity: BreakdownEntry[];
  };
  bootstrap: BootstrapResult;
  baseline: BaselineComparison;
};

/**
 * `allEpisodeRows` -- the COMPLETE, unfiltered (all tiers, all time) fetch for the
 * epoch, so size-tier capacity comparison always sees every tier and this function can
 * be called repeatedly (calibration window, OOS window, full epoch) without re-fetching.
 */
export function computeEpisodeAnalysisReport(
  allEpisodeRows: readonly EpisodeOutcomeRow[],
  window: AnalysisWindow,
  notionalTierUsd: number = DECLARED_STRATEGY_NOTIONAL_USD,
  bootstrapSeed?: number,
): EpisodeAnalysisReport {
  const windowed = allEpisodeRows.filter((r) => withinWindow(r, window));
  const declaredTierRows = filterToTier(windowed, notionalTierUsd);

  const analytics = computeFullAnalyticsReport(declaredTierRows);
  const clusterReturns = computeClusterReturns(declaredTierRows).map((c) => c.netPnlUsd);
  const bootstrap = bootstrapConfidenceInterval(clusterReturns, bootstrapSeed !== undefined ? { seed: bootstrapSeed } : {});
  const baseline = computeMarketImpliedBaseline(declaredTierRows, analytics.core.expectancyPerIndependentEpisode);

  return {
    notionalTierUsd,
    analytics,
    robustness: {
      top5WinsRemoved: removeTopNWins(declaredTierRows, 5),
      largestWinRemoved: removeLargestWin(declaredTierRows),
      largestLossRemoved: removeLargestLoss(declaredTierRows),
      oneCentAdverseStress: applyOneCentAdverseStress(declaredTierRows),
      twoCentAdverseStress: applyTwoCentAdverseStress(declaredTierRows),
      firstHalfSecondHalf: compareFirstHalfSecondHalf(declaredTierRows),
      walletConcentration: computeWalletConcentration(declaredTierRows),
      sizeTierCapacity: compareSizeTierCapacity(windowed),
    },
    bootstrap,
    baseline,
  };
}

/** Convenience: fetches and computes in one call, for the common "just give me the current epoch's report" case (dashboard, milestone snapshot). */
export async function runFullAnalysis(epochId: string, window: AnalysisWindow = { sinceIso: null, untilIso: null }, notionalTierUsd: number = DECLARED_STRATEGY_NOTIONAL_USD): Promise<EpisodeAnalysisReport> {
  const rows = await fetchAllEpisodeOutcomes(epochId);
  return computeEpisodeAnalysisReport(rows, window, notionalTierUsd);
}
