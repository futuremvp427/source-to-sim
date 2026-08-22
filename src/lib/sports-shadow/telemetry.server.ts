/**
 * FINAL BUILD Part 25: durable operational telemetry — SERVER (DB) layer.
 *
 * A single wide metric-event table (sports_shadow_telemetry_events) rather than one
 * bespoke table per subsystem -- every category Part 25 lists (SOURCE/VENUE/NETWORK/
 * OBSERVATION/PAPER/SETTLEMENT/SYSTEM) is a `category` value, every named measurement a
 * `metric` + numeric `value`, with `labels` for dimensions (venue, wallet, reason,
 * etc). Durable and queryable -- not "logs only" (Part 25's explicit bar). Recording is
 * always best-effort/fire-and-forget from the caller's perspective: a telemetry write
 * failure must never fail the operation being measured.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type TelemetryCategory = "SOURCE" | "VENUE" | "NETWORK" | "OBSERVATION" | "PAPER" | "SETTLEMENT" | "SYSTEM";

export type TelemetryEvent = {
  category: TelemetryCategory;
  metric: string;
  value: number | null;
  labels?: Record<string, unknown>;
  experimentEpochId?: string | null;
};

export type TelemetryRepository = {
  record(events: TelemetryEvent[]): Promise<void>;
};

export const supabaseTelemetryRepository: TelemetryRepository = {
  async record(events) {
    if (events.length === 0) return;
    const { error } = await supabaseAdmin.from("sports_shadow_telemetry_events" as never).insert(
      events.map((e) => ({
        category: e.category,
        metric: e.metric,
        value: e.value,
        labels: e.labels ?? {},
        experiment_epoch_id: e.experimentEpochId ?? null,
      })) as never,
    );
    if (error) throw new Error(error.message);
  },
};

/** Best-effort: swallows any repository failure so a telemetry outage never breaks the operation being measured. */
export async function recordTelemetry(events: TelemetryEvent[], repo: TelemetryRepository = supabaseTelemetryRepository): Promise<void> {
  try {
    await repo.record(events);
  } catch {
    // Best-effort by design -- see this module's own doc comment.
  }
}

/**
 * Flattens a SportsShadowCycleSummary (worker.server.ts) into the SYSTEM/SOURCE/VENUE/
 * OBSERVATION telemetry events Part 25 asks for, without worker.server.ts needing to
 * know anything about the telemetry schema itself.
 */
export function cycleSummaryToTelemetryEvents(summary: {
  durationMs: number;
  observationLane: { pmus: { attempted: number; captured: number; failed: number; skipped: number }; kalshi: { attempted: number; captured: number; failed: number; skipped: number } };
  sourceLane: { walletsAttempted: number; newSignalsCreated: number; leaseLost: boolean; pmus: { attempted: number; exact: number; discoveryFailed: boolean; deadlineReached: boolean }; kalshi: { attempted: number; exact: number; discoveryFailed: boolean; deadlineReached: boolean } } | null;
  errors: string[];
  /**
   * FINAL BUILD Part 6/repository-completion pass (Codex-caught P1): every event this
   * cycle records MUST carry this, or soak.server.ts's rollup RPC (which filters
   * strictly by experiment_epoch_id) sees zero cycles forever and the soak health gate
   * can never pass. null is a legitimate value (epoch resolution failed this cycle,
   * best-effort) -- events are still recorded, just unattributed to any epoch.
   */
  epochId: string | null;
}): TelemetryEvent[] {
  const events: TelemetryEvent[] = [
    { category: "SYSTEM", metric: "cycle_duration_ms", value: summary.durationMs },
    { category: "SYSTEM", metric: "cycle_error_count", value: summary.errors.length },
    { category: "OBSERVATION", metric: "captured", value: summary.observationLane.pmus.captured, labels: { venue: "PMUS" } },
    { category: "OBSERVATION", metric: "captured", value: summary.observationLane.kalshi.captured, labels: { venue: "KALSHI" } },
    { category: "OBSERVATION", metric: "failed", value: summary.observationLane.pmus.failed, labels: { venue: "PMUS" } },
    { category: "OBSERVATION", metric: "failed", value: summary.observationLane.kalshi.failed, labels: { venue: "KALSHI" } },
    // FINAL BUILD Part 6: backlog (skipped) is what the soak health rollup sums to
    // detect a sustained observation backlog across the whole 72h window -- previously
    // only used per-cycle by alerts.server.ts's threshold check, never accumulated.
    { category: "OBSERVATION", metric: "skipped", value: summary.observationLane.pmus.skipped, labels: { venue: "PMUS" } },
    { category: "OBSERVATION", metric: "skipped", value: summary.observationLane.kalshi.skipped, labels: { venue: "KALSHI" } },
  ];
  if (summary.sourceLane) {
    events.push(
      { category: "SOURCE", metric: "wallets_attempted", value: summary.sourceLane.walletsAttempted },
      { category: "SOURCE", metric: "new_signals", value: summary.sourceLane.newSignalsCreated },
      { category: "SOURCE", metric: "lease_lost", value: summary.sourceLane.leaseLost ? 1 : 0 },
      { category: "VENUE", metric: "exact_matches", value: summary.sourceLane.pmus.exact, labels: { venue: "PMUS" } },
      { category: "VENUE", metric: "exact_matches", value: summary.sourceLane.kalshi.exact, labels: { venue: "KALSHI" } },
      { category: "VENUE", metric: "discovery_failed", value: summary.sourceLane.pmus.discoveryFailed ? 1 : 0, labels: { venue: "PMUS" } },
      { category: "VENUE", metric: "discovery_failed", value: summary.sourceLane.kalshi.discoveryFailed ? 1 : 0, labels: { venue: "KALSHI" } },
      { category: "VENUE", metric: "deadline_reached", value: summary.sourceLane.pmus.deadlineReached ? 1 : 0, labels: { venue: "PMUS" } },
      { category: "VENUE", metric: "deadline_reached", value: summary.sourceLane.kalshi.deadlineReached ? 1 : 0, labels: { venue: "KALSHI" } },
    );
  }
  return events.map((e) => ({ ...e, experimentEpochId: summary.epochId }));
}
