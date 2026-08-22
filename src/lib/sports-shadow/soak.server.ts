/**
 * FINAL BUILD Part 6: operational soak health rollup — SERVER (DB) layer.
 *
 * Sources every number in soak.ts's SoakHealthInput from DURABLE tables only
 * (sports_shadow_telemetry_events, sports_shadow_integrity_audits,
 * sports_shadow_settlements) -- a process restart cannot erase any of this evidence,
 * satisfying the mission's own "persist enough rollup data that a restart cannot erase
 * the evidence" requirement without needing a brand-new summary table: the raw events
 * ARE the durable record, and this rollup is a pure, idempotent, re-derivable
 * aggregation over them.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { evaluateSoakHealth, type SoakHealthInput, type SoakHealthResult } from "./soak";
import { countRecentRateLimitEvents } from "./telemetry.server";

/**
 * The external scheduler's actual cadence is not configured anywhere in this repo (the
 * hook route tolerates arbitrary invocation timing by design -- see
 * sports-shadow.ts's own doc comment). This is a DOCUMENTED ASSUMPTION, not a measured
 * fact: if the real external cron is materially slower than once a minute, the
 * completion-ratio check will under-count expected cycles and could fail health for a
 * healthy-but-slower-than-assumed scheduler. Tune this constant once the real external
 * cadence is known; until then, soak.ts's own 50% floor (not 90%+) is deliberately
 * forgiving of this uncertainty.
 */
export const EXPECTED_CYCLE_INTERVAL_MS = 60_000;

/** A settlement still PENDING this long after its paper fill is considered stuck -- generous relative to any real sports settlement (games resolve in hours, not days). */
export const SETTLEMENT_STUCK_THRESHOLD_MS = 48 * 60 * 60 * 1000;

type RawTelemetryRollup = {
  actual_cycle_count: number;
  total_cycle_errors: number;
  observation_captured_total: number;
  observation_failed_total: number;
  observation_backlog_total: number;
  pmus_discovery_failed_count: number;
  pmus_discovery_attempted_cycles: number;
  kalshi_discovery_failed_count: number;
  kalshi_discovery_attempted_cycles: number;
  source_lane_acquired_cycles: number;
  source_starved_cycles: number;
  lease_lost_count: number;
};

async function fetchTelemetryRollup(epochId: string, sinceIso: string): Promise<RawTelemetryRollup> {
  const { data, error } = await supabaseAdmin
    .rpc("get_sports_shadow_soak_telemetry_rollup" as never, { p_epoch_id: epochId, p_since: sinceIso } as never)
    .single();
  if (error) throw new Error(error.message);
  return data as unknown as RawTelemetryRollup;
}

async function countIntegrityAudits(sinceIso: string): Promise<{ run: number; failed: number }> {
  const [runRes, failedRes] = await Promise.all([
    supabaseAdmin.from("sports_shadow_integrity_audits" as never).select("id", { count: "exact", head: true }).gte("run_at", sinceIso),
    supabaseAdmin.from("sports_shadow_integrity_audits" as never).select("id", { count: "exact", head: true }).gte("run_at", sinceIso).eq("passed", false),
  ]);
  if (runRes.error) throw new Error(runRes.error.message);
  if (failedRes.error) throw new Error(failedRes.error.message);
  return { run: runRes.count ?? 0, failed: failedRes.count ?? 0 };
}

/**
 * NOT epoch-scoped (sports_shadow_settlements carries no experiment_epoch_id column) --
 * an accepted simplification since at most one epoch is ever active at a time in
 * practice, and a stuck settlement is urgent regardless of which epoch it belongs to.
 */
/** Exported for alerts.server.ts's own per-cycle stuck-settlement check (Part 10) -- a single cheap indexed COUNT, reused rather than duplicated. */
export async function countStuckSettlements(now: number): Promise<number> {
  const cutoffIso = new Date(now - SETTLEMENT_STUCK_THRESHOLD_MS).toISOString();
  const { count, error } = await supabaseAdmin
    .from("sports_shadow_settlements" as never)
    .select("id", { count: "exact", head: true })
    .eq("settlement_status", "PENDING")
    .lt("created_at", cutoffIso);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function computeSoakHealthRollup(epochId: string, soakStartedAtIso: string, now: number = Date.now()): Promise<SoakHealthResult & { input: SoakHealthInput }> {
  // CODEX P2-5: total 429s recorded across the WHOLE soak window (not just a recent
  // slice) -- see telemetry.server.ts's own doc comment for why this table (unlike the
  // shared http_rate_limits current-cooldown snapshot) is the durable, queryable history
  // this rollup needs.
  const [telemetry, integrity, stuckSettlements, rateLimitStormCount] = await Promise.all([
    fetchTelemetryRollup(epochId, soakStartedAtIso),
    countIntegrityAudits(soakStartedAtIso),
    countStuckSettlements(now),
    countRecentRateLimitEvents(now, Math.max(0, now - Date.parse(soakStartedAtIso))),
  ]);

  const expectedCycleCount = Math.max(0, Math.floor((now - Date.parse(soakStartedAtIso)) / EXPECTED_CYCLE_INTERVAL_MS));

  const input: SoakHealthInput = {
    actualCycleCount: Number(telemetry.actual_cycle_count),
    expectedCycleCount,
    totalCycleErrors: Number(telemetry.total_cycle_errors),
    observationBacklogTotal: Number(telemetry.observation_backlog_total),
    observationAttemptedTotal: Number(telemetry.observation_backlog_total) + Number(telemetry.observation_captured_total) + Number(telemetry.observation_failed_total),
    pmusDiscoveryFailedCount: Number(telemetry.pmus_discovery_failed_count),
    pmusDiscoveryAttemptedCycles: Number(telemetry.pmus_discovery_attempted_cycles),
    kalshiDiscoveryFailedCount: Number(telemetry.kalshi_discovery_failed_count),
    kalshiDiscoveryAttemptedCycles: Number(telemetry.kalshi_discovery_attempted_cycles),
    sourceStarvedCycles: Number(telemetry.source_starved_cycles),
    sourceLaneAcquiredCycles: Number(telemetry.source_lane_acquired_cycles),
    leaseLostCount: Number(telemetry.lease_lost_count),
    integrityAuditFailures: integrity.failed,
    integrityAuditsRun: integrity.run,
    settlementStuckCount: stuckSettlements,
    rateLimitStormCount,
  };

  return { ...evaluateSoakHealth(input), input };
}
