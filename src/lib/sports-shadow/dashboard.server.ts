/**
 * FINAL BUILD Part 28: read model for the Sports Shadow dashboard — SERVER (DB) layer.
 * Read-only, bounded queries only (Part 31's "avoid unbounded dashboard queries").
 * Never a trading control -- this module cannot mutate anything.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import type { EpisodeAnalysisReport } from "./analytics.server";
import { computeEpisodeAnalysisReport, fetchAllEpisodeOutcomes } from "./analytics.server";
import type { CalibrationClassification, LivePilotGateResult, OosClassification } from "./classification";
import { evaluateCalibrationClassification, evaluateOosClassification } from "./classification.server";
import { getEpochCounters, nextMilestoneFor } from "./counters.server";
import type { ExperimentStage } from "./epoch";
import { OOS_MIN_DURATION_MS, OOS_MIN_INDEPENDENT_EPISODES } from "./stage";
import type { Venue } from "./types";

export type DashboardEpochSummary = {
  id: string;
  goLiveAtIso: string;
  walletCohort: string[];
  stage: ExperimentStage;
  stageEnteredAtIso: string;
  gitSha: string;
  configHash: string;
  calibrationStartedAtIso: string | null;
  oosStartedAtIso: string | null;
} | null;

export type DashboardVenueCapability = { venue: Venue; discoveryAvailable: boolean; orderbookAvailable: boolean; checkedAtIso: string } | null;

export type DashboardWalletSummary = { wallet: string; episodeCount: number; lastActivityIso: string | null };

export type DashboardMilestoneProgress = {
  rawEpisodeCount: number;
  independentEpisodeCount: number;
  settledIndependentCount: number;
  nextMilestone: "100_INDEPENDENT_SETTLED" | "300_INDEPENDENT_SETTLED" | null;
};

export type DashboardIntegrityStatus = { lastRunIso: string | null; passed: boolean | null; checksFailed: number };

export type DashboardResults = {
  /** Whole-epoch declared-strategy analysis -- the headline numbers (Part 9). */
  fullEpoch: EpisodeAnalysisReport;
  calibration: { classification: CalibrationClassification; report: EpisodeAnalysisReport } | null;
  oos: { classification: OosClassification; gate: LivePilotGateResult; report: EpisodeAnalysisReport } | null;
} | null;

export type SportsShadowDashboardData = {
  epoch: DashboardEpochSummary;
  pmusCapability: DashboardVenueCapability;
  kalshiCapability: DashboardVenueCapability;
  wallets: DashboardWalletSummary[];
  milestones: DashboardMilestoneProgress;
  integrity: DashboardIntegrityStatus;
  unresolvedAlertCount: number;
  results: DashboardResults;
};

const WALLET_SUMMARY_LIMIT = 10;

export type DashboardSignalRow = { source_wallet: string; cluster_key: string | null; status: string; created_at: string };

/** Pure -- extracted for direct unit testing without a real Supabase round trip. */
export function summarizeWallets(rows: readonly DashboardSignalRow[], limit: number = WALLET_SUMMARY_LIMIT): DashboardWalletSummary[] {
  const walletMap = new Map<string, { count: number; lastActivity: string | null }>();
  for (const row of rows) {
    const entry = walletMap.get(row.source_wallet) ?? { count: 0, lastActivity: null };
    entry.count += 1;
    if (!entry.lastActivity || row.created_at > entry.lastActivity) entry.lastActivity = row.created_at;
    walletMap.set(row.source_wallet, entry);
  }
  return [...walletMap.entries()]
    .map(([wallet, v]) => ({ wallet, episodeCount: v.count, lastActivityIso: v.lastActivity }))
    .sort((a, b) => (b.lastActivityIso ?? "").localeCompare(a.lastActivityIso ?? ""))
    .slice(0, limit);
}

/** Pure -- matches independence.ts's own clustering fallback (a signal missing cluster_key is its own singleton, never merged with another unknown signal). */
export function computeMilestoneProgress(rows: readonly DashboardSignalRow[]): DashboardMilestoneProgress {
  const independentClusters = new Set(rows.map((r) => r.cluster_key ?? `__unclustered_${r.source_wallet}_${r.created_at}`));
  const settledIndependentClusters = new Set(
    rows.filter((r) => r.status.startsWith("SETTLED")).map((r) => r.cluster_key ?? `__unclustered_${r.source_wallet}_${r.created_at}`),
  );
  const settledIndependentCount = settledIndependentClusters.size;
  return {
    rawEpisodeCount: rows.length,
    independentEpisodeCount: independentClusters.size,
    settledIndependentCount,
    nextMilestone: settledIndependentCount < 100 ? "100_INDEPENDENT_SETTLED" : settledIndependentCount < 300 ? "300_INDEPENDENT_SETTLED" : null,
  };
}

export async function loadSportsShadowDashboard(): Promise<SportsShadowDashboardData> {
  const [epochRes, pmusCapRes, kalshiCapRes, signalsRes, integrityRes, alertsRes] = await Promise.all([
    supabaseAdmin.from("sports_shadow_experiment_epochs" as never).select("*").eq("is_current", true).maybeSingle(),
    supabaseAdmin.from("sports_shadow_venue_capability" as never).select("*").eq("venue", "PMUS").maybeSingle(),
    supabaseAdmin.from("sports_shadow_venue_capability" as never).select("*").eq("venue", "KALSHI").maybeSingle(),
    // Bounded: most recent 500 signals only -- never an unbounded scan (Part 31).
    supabaseAdmin.from("sports_shadow_signals" as never).select("source_wallet, cluster_key, status, created_at").order("created_at", { ascending: false }).limit(500),
    supabaseAdmin.from("sports_shadow_integrity_audits" as never).select("run_at, passed, checks_failed").order("run_at", { ascending: false }).limit(1).maybeSingle(),
    supabaseAdmin.from("sports_shadow_alerts" as never).select("id", { count: "exact", head: true }).is("resolved_at", null),
  ]);

  const epochRow = epochRes.data as unknown as {
    id: string;
    go_live_at: string;
    wallet_cohort: string[];
    stage: ExperimentStage;
    stage_entered_at: string;
    git_sha: string;
    config_hash: string;
    calibration_started_at: string | null;
    oos_started_at: string | null;
  } | null;

  const epoch: DashboardEpochSummary = epochRow
    ? {
        id: epochRow.id,
        goLiveAtIso: epochRow.go_live_at,
        walletCohort: epochRow.wallet_cohort,
        stage: epochRow.stage,
        stageEnteredAtIso: epochRow.stage_entered_at,
        gitSha: epochRow.git_sha,
        configHash: epochRow.config_hash,
        calibrationStartedAtIso: epochRow.calibration_started_at,
        oosStartedAtIso: epochRow.oos_started_at,
      }
    : null;

  function toCapability(row: unknown): DashboardVenueCapability {
    const r = row as { venue: Venue; discovery_available: boolean; orderbook_available: boolean; checked_at: string } | null;
    return r ? { venue: r.venue, discoveryAvailable: r.discovery_available, orderbookAvailable: r.orderbook_available, checkedAtIso: r.checked_at } : null;
  }

  const signalRows = (signalsRes.data ?? []) as unknown as DashboardSignalRow[];
  // Recent-activity view only (bounded to 500) -- NOT the authoritative milestone
  // counter, which would silently under-count once the epoch exceeds this window. See
  // milestones below.
  const wallets = summarizeWallets(signalRows);

  // FINAL BUILD Part 7: authoritative, unbounded-by-volume milestone counts via an
  // indexed SQL aggregate (get_sports_shadow_epoch_counters) -- correct at any epoch
  // size, while this dashboard read itself stays a single bounded RPC call. Falls back
  // to the bounded-signal-rows computation only when there is no current epoch at all
  // (nothing to count either way).
  const milestones: DashboardMilestoneProgress = epoch
    ? await (async () => {
        const counters = await getEpochCounters(epoch.id);
        return {
          rawEpisodeCount: counters.rawEpisodeCount,
          independentEpisodeCount: counters.independentEpisodeCount,
          settledIndependentCount: counters.settledIndependentCount,
          nextMilestone: nextMilestoneFor(counters),
        };
      })()
    : computeMilestoneProgress(signalRows);

  const integrityRow = integrityRes.data as unknown as { run_at: string; passed: boolean; checks_failed: number } | null;
  const integrity: DashboardIntegrityStatus = integrityRow
    ? { lastRunIso: integrityRow.run_at, passed: integrityRow.passed, checksFailed: integrityRow.checks_failed }
    : { lastRunIso: null, passed: null, checksFailed: 0 };

  // FINAL BUILD Part 9: RESULTS -- computed live from the complete, unbounded-by-volume
  // episode-outcome fetch (never the 500-row-bounded signalRows above). This is a
  // research dashboard read, not a hot path (30s client poll interval) -- recomputing on
  // every load keeps it always current rather than depending on a milestone snapshot
  // that may not exist yet for this epoch.
  const results: DashboardResults = epoch
    ? await (async () => {
        const allRows = await fetchAllEpisodeOutcomes(epoch.id);
        const fullEpoch = computeEpisodeAnalysisReport(allRows, { sinceIso: null, untilIso: null });

        const calibration = epoch.calibrationStartedAtIso ? await evaluateCalibrationClassification(epoch.id, epoch.calibrationStartedAtIso) : null;

        let oos: { classification: OosClassification; gate: LivePilotGateResult; report: EpisodeAnalysisReport } | null = null;
        if (epoch.oosStartedAtIso) {
          const counters = await getEpochCounters(epoch.id);
          const durationOk = Date.now() - Date.parse(epoch.oosStartedAtIso) >= OOS_MIN_DURATION_MS;
          const countOk = counters.oosIndependentSettledCount >= OOS_MIN_INDEPENDENT_EPISODES;
          oos = await evaluateOosClassification(epoch.id, epoch.oosStartedAtIso, durationOk && countOk);
        }

        return { fullEpoch, calibration, oos };
      })()
    : null;

  return {
    epoch,
    pmusCapability: toCapability(pmusCapRes.data),
    kalshiCapability: toCapability(kalshiCapRes.data),
    wallets,
    milestones,
    integrity,
    unresolvedAlertCount: alertsRes.count ?? 0,
    results,
  };
}
