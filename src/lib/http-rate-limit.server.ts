/**
 * SERVER-ONLY shared host-level rate-limit cooldown.
 *
 * Phase 1 of the data-api.polymarket.com 429 incident deduplicated identical
 * /trades requests within a single runIngestCycle invocation, but a fresh
 * scheduler tick has no memory of the previous one -- a 429 seen on tick N
 * was independently rediscovered by every experiment on tick N+1, N+2, and
 * so on, because nothing paced requests *across* ticks. This module gives
 * every caller (V2/V3 ingestion and General Shadow alike, since both hit the
 * same upstream host) a durable, host-scoped cooldown backed by one row in
 * Postgres: the first 429 observed anywhere records a short blocked_until,
 * and every caller checks it before touching the host again, instead of
 * each one rediscovering the limit on its own.
 *
 * Deliberately the smallest existing durable coordination mechanism in this
 * repo, not a new subsystem: one row per host, written with an atomic
 * GREATEST-upsert RPC that mirrors the acquire_worker_lease pattern already
 * used for lease fencing.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const DATA_API_HOST = "data-api.polymarket.com";

const MIN_COOLDOWN_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 90_000;
const MAX_COOLDOWN_MS = 600_000;
/**
 * Hard ceiling on the cooldown-recording RPC itself, enforced via
 * postgrest-js's own .abortSignal() -- the same real-cancellation mechanism
 * already used elsewhere in this codebase (see shadow.server.ts's
 * process_source_event_atomic/persistEvents calls) -- rather than a bare
 * Promise.race that would leave the underlying DB request running
 * uncancelled. Short, because this is a single-row upsert: both the /trades
 * (getJson) and General Shadow (getActivityPage) 429 paths await this
 * directly, so it must return well within their own surrounding deadlines
 * regardless of what the database is doing.
 */
const COOLDOWN_WRITE_DEADLINE_MS = 5_000;

/**
 * Parses a Retry-After header (either delay-seconds or an HTTP-date, per
 * RFC 9110 10.2.3) into a millisecond wait. Returns null when absent or
 * unparseable so the caller falls back to its own default.
 */
export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.max(0, when - now);
  return null;
}

/**
 * Clamps a candidate cooldown duration into [MIN_COOLDOWN_MS,
 * MAX_COOLDOWN_MS]. A missing Retry-After falls back to DEFAULT_COOLDOWN_MS
 * before clamping; a present-but-pathological Retry-After (absurdly long, or
 * zero/negative) is still bounded, so one bad header value can never lock
 * ingestion out indefinitely or fail to pace it at all.
 */
export function clampCooldownMs(candidateMs: number | null): number {
  const base = candidateMs ?? DEFAULT_COOLDOWN_MS;
  return Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, base));
}

export type HostCooldown = {
  blocked: boolean;
  until: Date | null;
  reason: string | null;
};

/**
 * Task 13I / P1-T: hard ceiling on the cooldown READ itself, via postgrest-js's
 * .abortSignal() -- the same real-cancellation mechanism already used by
 * COOLDOWN_WRITE_DEADLINE_MS/RESERVATION_RPC_DEADLINE_MS below. Prior to this task,
 * getHostCooldown had NO internal bound at all: a hung DB read could stall its caller
 * indefinitely. General Shadow's shadow.server.ts already wraps its own calls to this
 * function in `boundedStage`/`withDeadline` (a Promise.race-style timeout), but that only
 * bounds the CALLER's wait -- the underlying query keeps running, detached, in the
 * background, since Promise.race never cancels the loser. Sports Shadow's callers
 * (pmus.server.ts/kalshi.server.ts/source-poll.server.ts) call this function directly with
 * no such wrapper at all, so a hang here would have blocked them completely. Adding a real
 * internal bound fixes both: General Shadow's existing behavior is unchanged (still fails
 * closed within its own external deadline, now via genuine cancellation instead of mere
 * abandonment), and Sports Shadow gains a bound it never had.
 */
const COOLDOWN_READ_DEADLINE_MS = 5_000;

/**
 * Reads the current cooldown for a host. Fails CLOSED: if the read itself
 * cannot be trusted (a query error, a thrown exception), the caller treats
 * the host as blocked rather than risk hammering an upstream that may
 * already be rate-limiting this application. The cost of deferring one
 * scheduler cycle is far lower than the cost of amplifying a live 429 storm.
 */
export async function getHostCooldown(host: string): Promise<HostCooldown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COOLDOWN_READ_DEADLINE_MS);
  try {
    // Cast: http_rate_limits is defined in this session's migration;
    // generated Supabase types are refreshed only after the migration is
    // applied (same pattern as record_http_rate_limit's RPC cast below).
    const { data, error } = await supabaseAdmin
      .from("http_rate_limits" as never)
      .select("blocked_until, reason")
      .eq("host", host)
      .abortSignal(controller.signal)
      .maybeSingle();
    if (error) {
      return { blocked: true, until: null, reason: `cooldown state unreadable: ${error.message}` };
    }
    const row = data as { blocked_until: string | null; reason: string | null } | null;
    const until = row?.blocked_until ? new Date(row.blocked_until) : null;
    const blocked = until !== null && until.getTime() > Date.now();
    return {
      blocked,
      until: blocked ? until : null,
      reason: blocked ? (row?.reason ?? null) : null,
    };
  } catch (err) {
    return {
      blocked: true,
      until: null,
      reason: `cooldown state unreadable: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Records (extends, never shortens) a cooldown for a host after observing a
 * 429. Bounded and safely awaitable by both 429 paths (/trades and
 * /activity): a real AbortController + postgrest-js's .abortSignal() cancels
 * the underlying request at COOLDOWN_WRITE_DEADLINE_MS instead of merely
 * abandoning it, so a stalled RPC can never hold either caller open. Still
 * best-effort in outcome -- a failure (including the deadline abort) is
 * swallowed rather than thrown, since the request that triggered this has
 * already failed regardless and the cooldown only paces the *next* attempt
 * -- but bounded/best-effort are independent properties: this call always
 * returns within COOLDOWN_WRITE_DEADLINE_MS, whether or not the write
 * actually landed.
 */
export async function recordHostRateLimit(
  host: string,
  retryAfterMs: number | null,
): Promise<void> {
  const durationMs = clampCooldownMs(retryAfterMs);
  const until = new Date(Date.now() + durationMs).toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COOLDOWN_WRITE_DEADLINE_MS);
  try {
    // Cast: record_http_rate_limit is defined in this session's migration;
    // generated Supabase types are refreshed only after the migration is
    // applied (same pattern as release_reconcile_lease in shadow.server.ts).
    await supabaseAdmin
      .rpc(
        "record_http_rate_limit" as never,
        {
          p_host: host,
          p_blocked_until: until,
          p_reason:
            retryAfterMs !== null ? `Retry-After ${retryAfterMs}ms` : "429 without Retry-After",
        } as never,
      )
      .abortSignal(controller.signal);
  } catch {
    // Best-effort only -- see doc comment above. Covers both a genuine RPC
    // failure and the deadline-triggered abort.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Minimum spacing enforced between any two actual upstream requests to the
 * same host, regardless of how many callers (in-process or cross-process)
 * race to issue one. This is what closes the concurrency gap
 * getHostCooldown/recordHostRateLimit cannot: that pair is a plain
 * check-then-act read of blocked_until, so two callers that both read
 * blocked=false before either has fired a request -- e.g. the two siblings
 * in one EXPERIMENT_CONCURRENCY batch, or General Shadow's /activity path
 * racing a /trades call, or two overlapping scheduler invocations -- can
 * still both proceed to a real fetch at the same instant. 500ms is small
 * next to a cycle's ~40-50s budget (a worst-case pile-up of every caller in
 * one cycle adds low-single-digit seconds total) but enough to force
 * Postgres's own row-level serialization of reserve_http_request_slot to
 * turn a simultaneous burst into a strict queue.
 */
const MIN_REQUEST_INTERVAL_MS = 500;

/**
 * Bounds how long a caller will actually WAIT on a granted reservation
 * before giving up and deferring instead of fetching -- an application-level
 * decision, not a SQL-side clamp (see the migration's doc comment for why a
 * SQL-side ceiling caused bunching: every caller past the clamp collapsed
 * onto the identical ceiling timestamp, silently reintroducing simultaneous
 * firing). Every granted reservation stays strictly MIN_REQUEST_INTERVAL_MS
 * apart from its neighbor no matter how deep the pile-up gets; a caller
 * whose own slot would land past this budget simply never gets used --
 * reserveRequestSlot throws instead of returning a wait, and the caller
 * defers to the next scheduler tick rather than fetching.
 *
 * Sized from the actual known concurrent data-api.polymarket.com callers:
 *   - EXPERIMENT_CONCURRENCY (2) within one scheduler invocation's batch
 *   - +2 for one assumed overlapping scheduler invocation (the platform
 *     does not guarantee mutually exclusive ticks -- see acquireLease)
 *   - +1 candidate research (its own /trades + /positions calls; fenced
 *     against itself by acquireResearchLease, but not against ingestion)
 *   - +1 an independent health-probe caller (a separate dashboard tab/
 *     process; TTL-cached but not fenced against ingestion)
 *   realistic worst case ~= 6 concurrent callers.
 * 8000ms / 500ms = 16 slots before any caller must defer -- ~2.5x that
 * worst case, while still only 20% of EXPERIMENT_DEADLINE_MS (40s) and 16%
 * of CYCLE_BUDGET_MS (50s), so even a fully-queued caller's wait is a small
 * fraction of its own cycle budget.
 */
const MAX_RESERVATION_LOOKAHEAD_MS = 8_000;

/**
 * Hard ceiling on the reservation RPC itself, mirroring
 * COOLDOWN_WRITE_DEADLINE_MS's real-cancellation pattern: a single-row
 * upsert has no reason to run long, and every caller of reserveRequestSlot
 * is about to make its own bounded upstream request regardless.
 */
const RESERVATION_RPC_DEADLINE_MS = 5_000;

/**
 * Raised whenever reserveRequestSlot cannot guarantee a paced slot: an RPC
 * error, a deadline abort, an unreadable response, or a granted reservation
 * whose wait exceeds MAX_RESERVATION_LOOKAHEAD_MS. Every one of these means
 * the same thing to a caller -- do not fetch -- so they share one type
 * rather than forcing callers to distinguish "coordination unavailable"
 * from "coordination available but the queue is full" when the correct
 * response (defer, no upstream request) is identical either way.
 */
export class ReservationUnavailableError extends Error {}

/**
 * Task 13I / P1-S, P1-T: raised specifically when a CALLER-SUPPLIED deadline (not this
 * module's own internal timeouts) is the reason a paced operation cannot proceed --
 * either because the deadline had already passed before the operation could even start,
 * or because a genuinely-granted reservation's wait would land at/after it. Deliberately a
 * DIFFERENT type from ReservationUnavailableError: that type means "the shared
 * coordination mechanism itself is unavailable" (an RPC failure, a queue that is
 * genuinely full); this type means "coordination is working fine, but MY OWN caller has
 * run out of time to use it," which downstream callers (Section 7's observation capture,
 * Section 5's discovery) must treat differently -- a scheduler-budget expiry is never
 * evidence about the venue/market and must never be persisted as one.
 */
export class DeadlineExceededError extends Error {}

/**
 * Atomically claims the next pacing slot for a host and returns how long
 * the caller must wait before it may actually issue its upstream request.
 * Deliberately independent of getHostCooldown/blocked_until -- see the
 * migration's doc comment for why the two mechanisms are kept separate.
 * Only actual upstream requests should call this: a same-cycle cache hit
 * (see TradesRequestCache) must never consume a reservation, so callers
 * gate this behind their own cache-miss branch, not before it.
 *
 * Fails CLOSED: throws ReservationUnavailableError on any RPC error, on
 * hitting its own deadline, or when the granted slot exceeds
 * MAX_RESERVATION_LOOKAHEAD_MS. A DB-coordination hiccup must never let
 * concurrent callers bypass pacing and recreate exactly the burst this
 * mechanism exists to prevent -- getHostCooldown already applies this same
 * fail-closed principle for the reactive cooldown, and a temporarily
 * deferred poll (retried on the next scheduler tick via the existing
 * checkpoint-driven catch-up) is a far smaller cost than an uncontrolled
 * request burst. Callers are expected to let this propagate into their
 * existing generic error handling (runExperimentCycle's catch-all,
 * ingestGeneralActivity's per-page catch, candidate research's per-attempt
 * retry / per-candidate catch) rather than special-case it -- none of those
 * paths advance a checkpoint or touch paper accounting on a thrown error.
 *
 * Task 13I / P1-S, P1-T: `callerDeadlineAtMs` (optional epoch ms; omitted preserves the
 * exact prior behavior for every existing caller -- General Shadow, candidate research,
 * the health probe) lets a caller with its own absolute wall-clock budget (Sports Shadow's
 * venue matching, discovery, and observation capture) avoid two specific escapes this
 * function previously had no way to prevent: (1) if the deadline has ALREADY passed, the
 * RPC is never even attempted; (2) the RPC's own internal AbortController timeout is
 * shortened to whatever time remains, so it cannot itself run past the caller's deadline;
 * (3) a GENUINELY granted reservation whose wait would land at or after the caller's
 * deadline is rejected (DeadlineExceededError) rather than returned for the caller to
 * sleep through and blow its own budget on. In every one of these three cases the thrown
 * error is DeadlineExceededError, not ReservationUnavailableError -- the shared pacing
 * mechanism itself remains perfectly healthy; only this one caller has run out of time.
 */
export async function reserveRequestSlot(host: string, callerDeadlineAtMs?: number): Promise<number> {
  if (callerDeadlineAtMs !== undefined && Date.now() >= callerDeadlineAtMs) {
    throw new DeadlineExceededError(`${host} reservation skipped: caller deadline already reached`);
  }
  const controller = new AbortController();
  let deadlineCausedAbort = false;
  const rpcTimer = setTimeout(() => controller.abort(), RESERVATION_RPC_DEADLINE_MS);
  // Task 13I / P1-T: a SECOND, independent timer racing on the same controller -- if the
  // caller's own deadline would fire before the RPC's normal timeout, whichever fires
  // first aborts the same in-flight request; `deadlineCausedAbort` records which one it
  // was so the catch block below can throw the correct, distinguishable error type.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (callerDeadlineAtMs !== undefined) {
    const remainingMs = callerDeadlineAtMs - Date.now();
    deadlineTimer = setTimeout(() => {
      deadlineCausedAbort = true;
      controller.abort();
    }, remainingMs);
  }
  try {
    // Cast: reserve_http_request_slot is defined in this session's
    // migration; generated Supabase types are refreshed only after the
    // migration is applied (same pattern as record_http_rate_limit above).
    const { data, error } = await supabaseAdmin
      .rpc(
        "reserve_http_request_slot" as never,
        { p_host: host, p_min_interval_ms: MIN_REQUEST_INTERVAL_MS } as never,
      )
      .abortSignal(controller.signal);
    if (error) {
      throw new ReservationUnavailableError(`${host} reservation RPC failed: ${error.message}`);
    }
    if (typeof data !== "string") {
      throw new ReservationUnavailableError(`${host} reservation RPC returned an unexpected shape`);
    }
    const reservedAtMs = new Date(data).getTime();
    if (!Number.isFinite(reservedAtMs)) {
      throw new ReservationUnavailableError(`${host} reservation RPC returned an invalid timestamp`);
    }
    const waitMs = Math.max(0, reservedAtMs - Date.now());
    if (waitMs > MAX_RESERVATION_LOOKAHEAD_MS) {
      throw new ReservationUnavailableError(
        `${host} reservation queue exceeds max lookahead (${waitMs}ms > ${MAX_RESERVATION_LOOKAHEAD_MS}ms)`,
      );
    }
    // Task 13I / P1-T: a genuinely granted, in-budget-per-MAX_RESERVATION_LOOKAHEAD_MS
    // reservation can STILL land at or after the caller's OWN deadline -- reject it rather
    // than returning a wait the caller would sleep through and blow its own budget on.
    if (callerDeadlineAtMs !== undefined && Date.now() + waitMs >= callerDeadlineAtMs) {
      throw new DeadlineExceededError(
        `${host} reservation granted (wait ${waitMs}ms) but would land at/after the caller's own deadline`,
      );
    }
    return waitMs;
  } catch (err) {
    if (err instanceof DeadlineExceededError) throw err;
    if (deadlineCausedAbort) {
      throw new DeadlineExceededError(`${host} reservation RPC aborted: caller deadline reached mid-request`);
    }
    if (err instanceof ReservationUnavailableError) throw err;
    // Covers both a rejected/thrown RPC call and the deadline-triggered abort.
    throw new ReservationUnavailableError(
      `${host} reservation unavailable: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  } finally {
    clearTimeout(rpcTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

/** Test-only aliases so the cooldown constants can be asserted directly. */
export const MIN_COOLDOWN_MS_FOR_TEST = MIN_COOLDOWN_MS;
export const DEFAULT_COOLDOWN_MS_FOR_TEST = DEFAULT_COOLDOWN_MS;
export const MAX_COOLDOWN_MS_FOR_TEST = MAX_COOLDOWN_MS;
export const COOLDOWN_WRITE_DEADLINE_MS_FOR_TEST = COOLDOWN_WRITE_DEADLINE_MS;
export const MIN_REQUEST_INTERVAL_MS_FOR_TEST = MIN_REQUEST_INTERVAL_MS;
export const MAX_RESERVATION_LOOKAHEAD_MS_FOR_TEST = MAX_RESERVATION_LOOKAHEAD_MS;
export const RESERVATION_RPC_DEADLINE_MS_FOR_TEST = RESERVATION_RPC_DEADLINE_MS;
export const COOLDOWN_READ_DEADLINE_MS_FOR_TEST = COOLDOWN_READ_DEADLINE_MS;
