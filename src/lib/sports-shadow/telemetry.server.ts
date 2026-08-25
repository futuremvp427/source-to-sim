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
 * ============ CODEX P2-5: REAL RATE-LIMIT TELEMETRY, NOT A HARDCODED CONSTANT ============
 * PROVEN root cause: worker.server.ts's per-cycle alert evaluation and
 * soak.server.ts's multi-cycle health rollup both fed a hardcoded `false`/`0` for
 * rate-limit-storm detection -- http_rate_limits (shared with General Shadow) is a
 * single-row-per-host CURRENT-cooldown snapshot, never a durable history of 429 events,
 * so there was no signal available to compute a real rate over time from at all. A
 * sustained 429 problem across any Sports Shadow upstream host could never be detected,
 * regardless of how severe.
 *
 * FIX: every Sports Shadow network module's `recordHostRateLimit` default dependency
 * wraps the shared cooldown write with a durable Sports-Shadow-owned NETWORK telemetry
 * event per 429 -- see wrapRecordHostRateLimitWithTelemetry below, used as the DEFAULT
 * dependency in pmus.server.ts/kalshi.server.ts/source-poll.server.ts/source-metadata.server.ts
 * (never touches their own call sites, so existing tests injecting their own
 * recordHostRateLimit mock are completely unaffected). countRecentRateLimitEvents then
 * gives both the per-cycle alert check and the soak rollup a genuine, queryable rate.
 *
 * ============ CODEX P2-2: PERSISTENCE FAILURE MUST NOT DISAPPEAR SILENTLY ============
 * PROVEN root cause: pmus.server.ts/kalshi.server.ts/source-poll.server.ts/
 * source-metadata.server.ts all SKIPPED calling recordHostRateLimit entirely once the
 * caller's own deadline had already passed by the time a 429 response arrived -- an
 * already-COMPLETED HTTP response's cooldown/telemetry fact was thrown away instead of
 * persisted, and the next cycle could immediately re-hit the same host with zero memory
 * of the just-observed 429. The underlying write (recordHostRateLimitInternal in
 * http-rate-limit.server.ts) was ALREADY hard-bounded to COOLDOWN_WRITE_DEADLINE_MS
 * (5s, via a real AbortController) regardless of the caller's own deadline -- there was
 * never an unbounded-wait reason to skip it, only a mistaken belief that a bounded 5s
 * write was an unacceptable "new" overrun. FIX: those four call sites now ALWAYS call
 * this, and the inner dependency is recordHostRateLimitReporting (not the plain
 * recordHostRateLimit), so a genuine PERSISTENCE failure -- the write itself erroring or
 * hitting its own 5s abort -- is surfaced as its own `rate_limit_persist_failed` NETWORK
 * event (see countRecentRateLimitPersistFailures below) instead of vanishing into a
 * swallowed catch block the way General Shadow's own recordHostRateLimit still does.
 * ================================================================================
 */
export function wrapRecordHostRateLimitWithTelemetry(
  inner: (host: string, retryAfterMs: number | null) => Promise<{ ok: boolean; error: string | null }>,
): (host: string, retryAfterMs: number | null) => Promise<void> {
  return async (host, retryAfterMs) => {
    let result: { ok: boolean; error: string | null };
    try {
      result = await inner(host, retryAfterMs);
    } catch (err) {
      // Defensive only -- recordHostRateLimitReporting never throws by construction. A
      // caller mid-way through handling an already-observed 429 must never have that
      // handling replaced by a persistence-layer exception (CODEX P2-2's own explicit
      // "do not continue additional business requests" / "never throws" requirement).
      result = { ok: false, error: err instanceof Error ? err.message : "unknown error" };
    }
    // Fire-and-forget, deliberately NOT awaited on the caller's own critical path beyond
    // this point -- recordTelemetry is already internally best-effort/non-throwing, but
    // this still lets the paced-fetch caller's own already-bounded deadline continue
    // without waiting on a second network round trip for a diagnostic write.
    const events: TelemetryEvent[] = [{ category: "NETWORK", metric: "rate_limited_429", value: 1, labels: { host, retryAfterMs } }];
    if (!result.ok) {
      events.push({ category: "NETWORK", metric: "rate_limit_persist_failed", value: 1, labels: { host, error: result.error } });
    }
    void recordTelemetry(events);
  };
}

/** A window with at least this many 429s (any host, any Sports Shadow upstream) counts as a storm -- see RATE_LIMIT_STORM_WINDOW_MS for the window this is measured over. */
export const RATE_LIMIT_STORM_THRESHOLD = 5;
/** Matches the scheduler's own justified cadence (~30s) at roughly one full lane's worth of cycles -- a burst within one or two cycles, not a slow trickle across hours. */
export const RATE_LIMIT_STORM_WINDOW_MS = 5 * 60 * 1000;
/** CODEX P2-2: even a single persistence failure is worth surfacing -- unlike a 429 storm (an upstream condition we can only pace around), a persist failure means OUR OWN durable coordination is degraded. */
export const RATE_LIMIT_PERSIST_FAILURE_THRESHOLD = 1;

export type RateLimitTelemetryRepository = { countSince(sinceIso: string): Promise<number> };

function countByMetricSince(metric: string) {
  return async (sinceIso: string): Promise<number> => {
    const { count, error } = await supabaseAdmin
      .from("sports_shadow_telemetry_events" as never)
      .select("id", { count: "exact", head: true })
      .eq("category", "NETWORK")
      .eq("metric", metric)
      .gte("created_at", sinceIso);
    if (error) throw new Error(error.message);
    return count ?? 0;
  };
}

export const supabaseRateLimitTelemetryRepository: RateLimitTelemetryRepository = {
  countSince: countByMetricSince("rate_limited_429"),
};

/** CODEX P2-2: same shape as supabaseRateLimitTelemetryRepository, counting `rate_limit_persist_failed` instead of `rate_limited_429`. */
export const supabaseRateLimitPersistFailureRepository: RateLimitTelemetryRepository = {
  countSince: countByMetricSince("rate_limit_persist_failed"),
};

/** Best-effort: a failure to READ the rate-limit history must never itself look like a storm (fails to `0`, never fabricates a positive count). */
export async function countRecentRateLimitEvents(nowMs: number = Date.now(), windowMs: number = RATE_LIMIT_STORM_WINDOW_MS, repo: RateLimitTelemetryRepository = supabaseRateLimitTelemetryRepository): Promise<number> {
  try {
    return await repo.countSince(new Date(nowMs - windowMs).toISOString());
  } catch {
    return 0;
  }
}

/** CODEX P2-2: mirrors countRecentRateLimitEvents, over the same window, for persist failures instead of raw 429s -- fails to 0, never fabricates a positive count. */
export async function countRecentRateLimitPersistFailures(nowMs: number = Date.now(), windowMs: number = RATE_LIMIT_STORM_WINDOW_MS, repo: RateLimitTelemetryRepository = supabaseRateLimitPersistFailureRepository): Promise<number> {
  try {
    return await repo.countSince(new Date(nowMs - windowMs).toISOString());
  } catch {
    return 0;
  }
}

/**
 * ============ CODEX P2-6 / P2-5: SCHEDULER HEARTBEAT ============
 * PROVEN root cause: worker.server.ts's per-cycle alert evaluation hardcoded
 * `schedulerLastRunAgeMs: null` with the reasoning "this IS the scheduler's own current
 * run -- nothing to measure staleness against here." True for THIS cycle's own existence,
 * but blind to a real, useful signal: how long ago the PREVIOUS cycle's own telemetry was
 * recorded. A scheduler that stalled for an extended period and has now resumed is
 * exactly the condition this should surface -- the alert fires on the FIRST cycle back,
 * not retroactively.
 *
 * FIX: reads the most recent SYSTEM/cycle_duration_ms telemetry row's timestamp BEFORE
 * this cycle's own telemetry is recorded (worker.server.ts's own call ordering) -- null
 * only when no prior cycle telemetry exists at all (a genuinely fresh epoch, not a stall).
 * ================================================================================
 */
/**
 * CODEX P2-1: `metric` was hardcoded to "cycle_duration_ms" -- the combined-cycle
 * scheduler's own SYSTEM heartbeat. Now that the scheduler is split into independently
 * leased/deadlined jobs (worker.server.ts's SOURCE/OBSERVATION/SETTLEMENT jobs), each
 * job needs its OWN heartbeat metric so one job's staleness can never be masked by
 * another job's healthy, unrelated cadence. Defaulted to the original metric name so
 * every pre-existing caller (the source job, and every existing test's fake repo, which
 * ignores the extra parameter under normal JS/TS structural typing) is unaffected.
 */
export type SchedulerHeartbeatRepository = { latestCycleTelemetryAtIso(metric?: string): Promise<string | null> };

export const supabaseSchedulerHeartbeatRepository: SchedulerHeartbeatRepository = {
  async latestCycleTelemetryAtIso(metric = "cycle_duration_ms") {
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_telemetry_events" as never)
      .select("created_at")
      .eq("category", "SYSTEM")
      .eq("metric", metric)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as unknown as { created_at: string } | null)?.created_at ?? null;
  },
};

/** Best-effort: a failure to READ the heartbeat must never itself look like a stall (fails to `null`, i.e. "cannot determine," never fabricates a large staleness value). */
export async function computeSchedulerLastRunAgeMs(
  nowMs: number = Date.now(),
  repo: SchedulerHeartbeatRepository = supabaseSchedulerHeartbeatRepository,
  metric = "cycle_duration_ms",
): Promise<number | null> {
  try {
    const lastRunAtIso = await repo.latestCycleTelemetryAtIso(metric);
    if (lastRunAtIso === null) return null;
    return Math.max(0, nowMs - Date.parse(lastRunAtIso));
  } catch {
    return null;
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
  sourceLane: {
    acquired?: boolean;
    walletsAttempted: number;
    newSignalsCreated: number;
    leaseLost: boolean;
    /** CODEX P1-1 (round 2): only sourceCoverageComplete is read here -- the full WalletSummary is accepted structurally. */
    walletSummaries: { sourceCoverageComplete: boolean; pendingSelected: number; freshPendingSelected: number; pendingProcessed: number }[];
    pmus: { attempted: number; exact: number; discoveryFailed: boolean; deadlineReached: boolean };
    kalshi: { attempted: number; exact: number; discoveryFailed: boolean; deadlineReached: boolean };
  } | null;
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
    const sourceAcquired = summary.sourceLane.acquired !== false;
    events.push(
      { category: "SOURCE", metric: "source_lease_acquired", value: sourceAcquired ? 1 : 0 },
      { category: "SOURCE", metric: "source_lease_skipped", value: sourceAcquired ? 0 : 1 },
    );
    if (!sourceAcquired) {
      return events.map((e) => ({ ...e, experimentEpochId: summary.epochId }));
    }
    events.push(
      { category: "SOURCE", metric: "wallets_attempted", value: summary.sourceLane.walletsAttempted },
      { category: "SOURCE", metric: "source_starved", value: summary.sourceLane.walletsAttempted === 0 ? 1 : 0 },
      { category: "SOURCE", metric: "new_signals", value: summary.sourceLane.newSignalsCreated },
      { category: "SOURCE", metric: "pending_selected", value: summary.sourceLane.walletSummaries.reduce((a, w) => a + w.pendingSelected, 0) },
      { category: "SOURCE", metric: "pending_fresh_selected", value: summary.sourceLane.walletSummaries.reduce((a, w) => a + w.freshPendingSelected, 0) },
      { category: "SOURCE", metric: "pending_processed", value: summary.sourceLane.walletSummaries.reduce((a, w) => a + w.pendingProcessed, 0) },
      { category: "SOURCE", metric: "lease_lost", value: summary.sourceLane.leaseLost ? 1 : 0 },
      // CODEX P1-1 (round 2): durable per-cycle visibility into the continuous
      // source-coverage invariant -- how many of the wallets actually polled THIS cycle
      // ended it with an unresolved coverage gap (see source-poll.server.ts's own doc
      // comment for the steady-state gap-detection this counts).
      { category: "SOURCE", metric: "wallets_incomplete_coverage", value: summary.sourceLane.walletSummaries.filter((w) => !w.sourceCoverageComplete).length },
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
