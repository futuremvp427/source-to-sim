/**
 * FINAL BUILD Part 28: read model for the Sports Shadow dashboard — SERVER (DB) layer.
 * Read-only, bounded queries only (Part 31's "avoid unbounded dashboard queries").
 * Never a trading control -- this module cannot mutate anything.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import type { ExperimentStage } from "./epoch";
import type { Venue } from "./types";

export type DashboardEpochSummary = {
  id: string;
  goLiveAtIso: string;
  walletCohort: string[];
  stage: ExperimentStage;
  stageEnteredAtIso: string;
  gitSha: string;
  configHash: string;
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

export type SportsShadowDashboardData = {
  epoch: DashboardEpochSummary;
  pmusCapability: DashboardVenueCapability;
  kalshiCapability: DashboardVenueCapability;
  wallets: DashboardWalletSummary[];
  milestones: DashboardMilestoneProgress;
  integrity: DashboardIntegrityStatus;
  unresolvedAlertCount: number;
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
      }
    : null;

  function toCapability(row: unknown): DashboardVenueCapability {
    const r = row as { venue: Venue; discovery_available: boolean; orderbook_available: boolean; checked_at: string } | null;
    return r ? { venue: r.venue, discoveryAvailable: r.discovery_available, orderbookAvailable: r.orderbook_available, checkedAtIso: r.checked_at } : null;
  }

  const signalRows = (signalsRes.data ?? []) as unknown as DashboardSignalRow[];
  const wallets = summarizeWallets(signalRows);
  const milestones = computeMilestoneProgress(signalRows);

  const integrityRow = integrityRes.data as unknown as { run_at: string; passed: boolean; checks_failed: number } | null;
  const integrity: DashboardIntegrityStatus = integrityRow
    ? { lastRunIso: integrityRow.run_at, passed: integrityRow.passed, checksFailed: integrityRow.checks_failed }
    : { lastRunIso: null, passed: null, checksFailed: 0 };

  return {
    epoch,
    pmusCapability: toCapability(pmusCapRes.data),
    kalshiCapability: toCapability(kalshiCapRes.data),
    wallets,
    milestones,
    integrity,
    unresolvedAlertCount: alertsRes.count ?? 0,
  };
}
