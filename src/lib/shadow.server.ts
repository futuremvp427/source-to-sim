/**
 * SERVER-ONLY engine for the autonomous SHADOW follower.
 * Read-only against public Polymarket endpoints; writes only to our own tables.
 * There is no signing, no credential use and no order-placement path in this file.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { fetchAllRows } from "./db-pagination";
import {
  classifyWorker,
  findAbandonedWorkers,
  orderByStaleness,
  type WorkerRow,
} from "./worker-health";
import {
  EMPTY_POSITION,
  MARK_MAX_AGE_MS,
  applyBuy,
  applySell,
  buildEventCommit,
  decideDynamicBuy,
  decideProportionalSell,
  normalizeSourceEvents,
  openPnl,
  reconcileSourceState,
  replaySourcePositions,
  resolveMark,
  roundShares,
  roundUsd,
  type FollowerDecision,
  type NormalizedEvent,
  type PaperPositionState,
  type Side,
} from "./shadow-core";
import {
  SETTLED_POSITION_SKIP_REASON,
  isPhantomClosedPosition,
  isTerminalSettlementStatus,
  shouldPersistPaperPosition,
} from "./shadow-core";
import {
  V2_REFERENCE_NAME,
  isEligibleForV2Copy,
  isV2Name,
} from "./v2-cohort";
import { isInMarketScope, parseMarketScope } from "./market-scope";
import {
  GENERAL_SHADOW_CATCHUP_PAGE_BUDGET,
  GENERAL_SHADOW_POLLING_ENABLED,
  isGeneralShadowName,
} from "./general-shadow";
import {
  DATA_API_HOST,
  getHostCooldown,
  parseRetryAfterMs,
  recordHostRateLimit,
} from "./http-rate-limit.server";
/** Re-exported so existing external imports of parseRetryAfterMs from this module keep working. */
export { parseRetryAfterMs } from "./http-rate-limit.server";

export const TARGET_WALLET = "0x8fbd7cf5f806f563080864694415829f7229a959";
export const EXPERIMENT_NAME = "SHADOW";
export const WORKER_ID = "ingest";

const DATA_API = "https://data-api.polymarket.com";
export const PAGE_SIZE = 250;
const BOOTSTRAP_PAGES = 4;
const LEASE_SECONDS = 180;
/** Exposed for the lease regression tests only. */
export const LEASE_SECONDS_FOR_TEST = LEASE_SECONDS;
/**
 * A refresh pass must be able to cover every open position inside
 * MARK_MAX_AGE_MS, otherwise equity can never satisfy the freshness rule.
 * Books are fetched in small concurrent batches to keep the pass well inside
 * one scheduler cycle without hammering the public CLOB.
 */
const MAX_MARK_REFRESH = 800;
/** Books arrive in one batched request; only the DB writes are fanned out. */
const MARK_WRITE_CONCURRENCY = 25;
const PROCESS_BATCH = 300;
/**
 * A scheduled invocation is a single HTTP request with a finite platform budget.
 * Without an explicit budget the request is killed mid-experiment, which leaves
 * that experiment's worker row stuck at state='running' with last_poll_at
 * frozen. We therefore stop starting new experiment cycles once the budget is
 * spent, and bound each individual cycle so a hung upstream call still releases
 * its lease through the normal error path.
 */
const CYCLE_BUDGET_MS = 50_000;
/**
 * Independent-lease experiments processed concurrently per batch. Kept small:
 * each experiment already fans out its own mark fetches, so too much total
 * concurrency makes the public CLOB rate-limit and marks fail.
 */
const EXPERIMENT_CONCURRENCY = 2;
const EXPERIMENT_DEADLINE_MS = 40_000;
/**
 * Scheduler budget for the candidate research stage. This is enforced with a
 * REAL AbortController (not Promise.race): candidate research shares the signal
 * with every public HTTP call it makes, so hitting this budget cancels the
 * in-flight work and we AWAIT its unwind + terminal worker_status write before
 * returning. Previously the race returned after 8s while the research pass kept
 * running in an abandoned context, stranding its 300s lease at state='running'.
 */
export const RESEARCH_DEADLINE_MS = 8_000;
/** Auxiliary (non-accounting) stage budgets, so one slow stage cannot eat a cycle. */
/**
 * Unlike every other auxiliary stage below, mark_refresh previously had no
 * budget of its own — only the outer EXPERIMENT_DEADLINE_MS bounded it. A
 * single unreachable/stalled public CLOB /books chunk can legitimately
 * consume up to ~37s across fetchBooksBatched's 3 retry attempts (each up to
 * a 12s AbortSignal.timeout, plus backoff), which is dangerously close to —
 * and for experiments needing more than one 100-asset chunk, can exceed —
 * the 40s cycle deadline on its own. When that happens the platform's own
 * hard request timeout can kill the invocation before our JS-level deadline
 * ever gets a chance to run the catch block and release the lease, leaving
 * the worker row stuck at state='running' indefinitely. Marks are
 * measurement only, so mark_refresh gets the same bounded-with-safe-fallback
 * treatment as reconciliation/settlement/previews/copyability.
 */
const MARK_REFRESH_DEADLINE_MS = 15_000;
const SETTLEMENT_DEADLINE_MS = 8_000;
const PREVIEW_DEADLINE_MS = 6_000;
const COPYABILITY_DEADLINE_MS = 6_000;
/** General Shadow non-trade activity evidence stage. Bounded and isolated. */
const GENERAL_ACTIVITY_DEADLINE_MS = 6_000;
const RECONCILE_DEADLINE_MS = 8_000;
/**
 * Cleanup-path budgets. These run after the cycle budget is already exhausted,
 * so each is independent and small, in strict priority order:
 * lease release first, worker status second, alerting last.
 */
const CLEANUP_STATUS_DEADLINE_MS = 4_000;
const CLEANUP_RELEASE_DEADLINE_MS = 5_000;
const CLEANUP_ALERT_DEADLINE_MS = 4_000;
/**
 * The host-cooldown read happens after the lease is acquired but before the
 * withDeadline-bounded stages pipeline starts, so without its own bound a
 * stalled query here would recreate exactly the pre-Phase-1 checkpoint-load
 * hang: heartbeat_at/fence advancing on retry while the lease is never
 * released, stranding the worker at state='running' and blocking its
 * Promise.allSettled batch. Short because this is a single-row PK lookup.
 */
const HOST_COOLDOWN_CHECK_DEADLINE_MS = 5_000;

class DeadlineError extends Error {}

async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineError(`${label} exceeded ${ms}ms deadline`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Bounded auxiliary stage. On timeout the cycle continues with the neutral
 * fallback so ingestion, paper accounting and marking always complete; the
 * stage's own writes remain idempotent and fenced.
 */
async function boundedStage<T>(work: Promise<T>, ms: number, label: string, fallback: T): Promise<T> {
  try {
    return await withDeadline(work, ms, label);
  } catch {
    return fallback;
  }
}

type Json = Record<string, unknown>;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/* ------------------------------------------------------------------ */
/* HTTP helpers (public, unauthenticated)                              */
/* ------------------------------------------------------------------ */

/**
 * Combines the caller's cancellation signal with this request's own timeout so
 * either one aborts the individual fetch. When no cycle signal is supplied the
 * behaviour is byte-identical to the previous timeout-only form.
 */
function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(12_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Raised on HTTP 429 so callers can special-case rate limiting (e.g. to
 * avoid alert spam or to short-circuit sibling requests) without parsing
 * error messages.
 */
export class RateLimitedError extends Error {
  constructor(message: string, readonly retryAfterMs: number | null) {
    super(message);
  }
}

const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 8_000;

/**
 * Backoff for a retryable failure: honors a server-supplied Retry-After
 * verbatim (never shortened), otherwise full-jitter exponential backoff
 * (random(0, min(RETRY_MAX_MS, base * 2^attempt))). Full jitter — rather than
 * a fixed schedule — is deliberate: with EXPERIMENT_CONCURRENCY workers (and,
 * in production, several sibling experiments sharing a wallet) all retrying
 * the same upstream 429 at once, a fixed 400ms/800ms schedule makes every
 * retry collide again on the same tick; independent random delays spread
 * retries out instead of resonating with each other.
 */
function backoffDelayMs(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return retryAfterMs;
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
  return Math.random() * ceiling;
}

/**
 * Sleeps for `ms`, but resolves early (never rejects) if `signal` aborts
 * first. Used for the inter-attempt backoff delay so a pathological
 * Retry-After value (or any long delay) cannot keep a retry loop waiting
 * past its own hard deadline: the caller's AbortController firing wakes this
 * up immediately instead of leaving a dangling timer to fire on its own
 * schedule, possibly minutes later.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * `deadlineAt` (absolute ms epoch) is an optional hard ceiling on the whole
 * multi-attempt sequence, independent of `signal`: even a huge
 * server-supplied Retry-After is clamped to whatever budget remains before
 * `deadlineAt`, and once that budget is exhausted no further attempt starts.
 * This is what stops a pathological Retry-After from extending a request
 * past its bounded operational envelope (see SHARED_TRADES_FETCH_DEADLINE_MS).
 */
async function getJson(
  url: string,
  attempts = 3,
  signal?: AbortSignal,
  deadlineAt?: number,
): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    if (signal?.aborted) break;
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: requestSignal(signal),
      });
      if (!res.ok) {
        const label = `${url.split("?")[0]} responded ${res.status}`;
        if (res.status === 429) {
          throw new RateLimitedError(label, parseRetryAfterMs(res.headers.get("retry-after")));
        }
        throw new Error(label);
      }
      return (await res.json()) as unknown;
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) break;
      // 429 gets zero in-process retries, regardless of attempts remaining:
      // Phase 1 (jittered backoff) reduced collisions within one request's
      // own retry loop, but production evidence showed bursts recurring
      // every ~5-6 minutes across all 10 V2/V3 experiments even with that in
      // place -- retrying inside a single request just rediscovers the same
      // host-wide limit up to 3x per experiment per cycle, amplifying it.
      // Pacing now happens at the shared host-cooldown level (below)
      // instead, which survives across scheduler ticks; a non-429 transient
      // failure (network blip, 5xx) keeps the existing bounded retry.
      if (err instanceof RateLimitedError) break;
      if (i < attempts - 1) {
        let delay = backoffDelayMs(i, null);
        if (deadlineAt !== undefined) {
          const remaining = deadlineAt - Date.now();
          if (remaining <= 0) break;
          delay = Math.min(delay, remaining);
        }
        await sleep(delay, signal);
      }
    }
  }
  if (lastErr instanceof RateLimitedError) {
    // Safely awaited: recordHostRateLimit now has its own real
    // AbortController-based hard deadline (COOLDOWN_WRITE_DEADLINE_MS, 5s),
    // enforced via postgrest-js's .abortSignal() rather than mere
    // Promise.race abandonment, so a stalled Supabase RPC can no longer
    // extend this call indefinitely -- it returns within 5s regardless, well
    // inside SHARED_TRADES_FETCH_DEADLINE_MS (45s). Awaiting (rather than
    // fire-and-forget) means the cooldown is reliably recorded before this
    // request's own failure is reported, instead of racing an unrelated
    // caller that might check it a moment later.
    await recordHostRateLimit(new URL(url).host, lastErr.retryAfterMs);
  }
  throw lastErr instanceof Error ? lastErr : new Error("request failed");
}

/**
 * In-flight/completed response cache for one runIngestCycle invocation,
 * keyed by request URL. V2 and V3 experiments follow identical wallets and
 * would otherwise issue byte-identical /trades requests independently every
 * cycle; sharing one promise per URL for the lifetime of a single cycle
 * halves that duplicate traffic with no change to per-experiment checkpoint
 * or accounting logic (each experiment still evaluates its own copy of the
 * same fetched page). Never persisted or reused across cycles.
 */
export type TradesRequestCache = Map<string, Promise<Json[]>>;

/**
 * Hard ceiling on one shared (cache-populating) /trades fetch, independent of
 * any individual experiment's own cycle deadline or AbortSignal. Bounded
 * strictly below CYCLE_BUDGET_MS (50s) so a stuck shared request can never
 * outlive the whole scheduler invocation, and comfortably above
 * EXPERIMENT_DEADLINE_MS (40s) so a legitimate retry sequence isn't cut off
 * merely because the first caller's own deadline happened to be tight. This
 * is the fix for a real risk in the first version of this cache: binding the
 * shared fetch to nothing meant it could run indefinitely once every waiting
 * experiment had already timed out and moved on -- the exact
 * "outer deadline stops waiting, inner fetch keeps running" failure mode
 * already proven in production for persistEvents (see its own doc comment)
 * and fixed there with real cancellation. The shared fetch gets the same
 * treatment here, via its own independent AbortController rather than any
 * individual caller's signal (see getArray).
 */
const SHARED_TRADES_FETCH_DEADLINE_MS = 45_000;

async function getArray(url: string, signal?: AbortSignal, cache?: TradesRequestCache): Promise<Json[]> {
  const fetchOnce = async (fetchSignal?: AbortSignal, deadlineAt?: number): Promise<Json[]> => {
    const json = await getJson(url, 3, fetchSignal, deadlineAt);
    if (Array.isArray(json)) return json as Json[];
    if (json && typeof json === "object" && Array.isArray((json as { data?: unknown[] }).data)) {
      return (json as { data: Json[] }).data;
    }
    throw new Error(`${url.split("?")[0]} returned an unexpected shape`);
  };
  if (!cache) return fetchOnce(signal);
  const existing = cache.get(url);
  if (existing) return existing;
  // Deliberately NOT bound to this caller's own cycle-abort signal: the
  // promise stored here may be awaited by a sibling experiment (same wallet,
  // different cycle deadline/AbortController) via the cache hit above, and
  // that sibling's request must not be cancelled just because the first
  // caller's cycle happened to time out first. Each experiment's own
  // deadline race (withDeadline in runExperimentCycle) still bounds how long
  // IT waits; the underlying shared network call instead gets its own
  // independent hard deadline below, so it is bounded without being tied to
  // any one caller's fate.
  const ownController = new AbortController();
  const deadlineAt = Date.now() + SHARED_TRADES_FETCH_DEADLINE_MS;
  const hardTimer = setTimeout(() => ownController.abort(), SHARED_TRADES_FETCH_DEADLINE_MS);
  const promise = fetchOnce(ownController.signal, deadlineAt).finally(() => clearTimeout(hardTimer));
  // A failed fetch must not poison the cache for the cycle's remaining
  // batches: each sibling gets its own chance to retry rather than all
  // inheriting one experiment's failure.
  promise.catch(() => cache.delete(url));
  cache.set(url, promise);
  return promise;
}

/* ------------------------------------------------------------------ */
/* Alerts                                                              */
/* ------------------------------------------------------------------ */

export async function raiseAlert(
  level: "info" | "warn" | "error",
  kind: string,
  message: string,
  context?: Json,
  /** When set, the same condition is only ever alerted (and notified) once. */
  dedupKey?: string,
): Promise<void> {
  const row = {
    level,
    kind,
    message,
    context: (context ?? null) as never,
    dedup_key: dedupKey ?? null,
  };
  const { data } = dedupKey
    ? await supabaseAdmin
        .from("alerts")
        .upsert(row, { onConflict: "dedup_key", ignoreDuplicates: true })
        .select("id")
    : await supabaseAdmin.from("alerts").insert(row).select("id");
  const id = data?.[0]?.id;
  if (!id) return;
  const { notifyAlert } = await import("./notify.server");
  await notifyAlert({ id, level, kind, message });
}

/* ------------------------------------------------------------------ */
/* Lease / fencing so only one worker ingests at a time                */
/* ------------------------------------------------------------------ */

export type Lease = { fence: number; workerId: string; lockId: string };

/**
 * Atomic lease acquisition. One SQL statement decides ownership and bumps the
 * fence; there is no read-then-decide window, so two overlapping cycles can
 * never both believe they hold the lease. Returns null when the lease is held
 * by a different, still-live worker.
 */
export async function acquireLease(workerId: string, lockId: string = WORKER_ID): Promise<Lease | null> {
  const { data, error } = await supabaseAdmin.rpc("acquire_worker_lease", {
    p_id: lockId,
    p_worker_id: workerId,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error(error.message);
  const fence = typeof data === "number" ? data : null;
  if (fence === null) return null;
  return { fence, workerId, lockId };
}

async function releaseLease(
  lease: Lease,
  patch: Partial<{
    state: string;
    last_error: string | null;
    poll_failures: number;
    events_ingested: number;
    lag_seconds: number | null;
    last_success_at: string;
    /** Per-stage durations (ms) for the cycle that is releasing the lease. */
    stage_ms: Record<string, number>;
    /**
     * Diagnostic telemetry only: how many source_events this specific
     * COMPLETED poll attempt persisted, win or lose. Never affects paper
     * accounting, sizing, bankroll, settlement or lease ownership.
     */
    last_poll_events_inserted: number;
  }>,
): Promise<void> {
  await supabaseAdmin
    .from("worker_status")
    .update({
      ...patch,
      heartbeat_at: new Date().toISOString(),
      last_poll_at: new Date().toISOString(),
      // Release immediately so the next scheduled poll is never blocked by a stale lease.
      lease_expires_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as never)
    .eq("id", lease.lockId)
    .eq("fence", lease.fence)
    // A stale owner must not be able to clobber the worker that took over.
    .eq("worker_id", lease.workerId);
}

/** Test-only alias so the lease fencing rules can be asserted directly. */
export const releaseLeaseForTest = releaseLease;
/** Test-only alias so the bounded-stage timeout/fallback mechanism can be asserted directly. */
export const boundedStageForTest = boundedStage;
export const MARK_REFRESH_DEADLINE_MS_FOR_TEST = MARK_REFRESH_DEADLINE_MS;
/** Test-only aliases so the per-cycle /trades request dedup and backoff can be asserted directly. */
export const getArrayForTest = getArray;
export const fetchSourceWindowForTest = fetchSourceWindow;
export const backoffDelayMsForTest = backoffDelayMs;
export const getJsonForTest = getJson;
export const sleepForTest = sleep;
export const SHARED_TRADES_FETCH_DEADLINE_MS_FOR_TEST = SHARED_TRADES_FETCH_DEADLINE_MS;
export const HOST_COOLDOWN_CHECK_DEADLINE_MS_FOR_TEST = HOST_COOLDOWN_CHECK_DEADLINE_MS;
export const CLEANUP_RELEASE_DEADLINE_MS_FOR_TEST = CLEANUP_RELEASE_DEADLINE_MS;
export const candidateResearchIfCycleAndHostAllowForTest = candidateResearchIfCycleAndHostAllow;

/* ------------------------------------------------------------------ */
/* Experiment / config                                                 */
/* ------------------------------------------------------------------ */

export type Experiment = {
  id: string;
  name: string;
  wallet_address: string;
  starting_cash: number;
  cash: number;
  buy_amount: number;
  poll_interval_seconds: number;
  enabled: boolean;
  weather_only: boolean;
  /** Post-follow paper-copy category scope. Defaults to ALL for every legacy row. */
  market_scope?: string | null;
  realized_pnl: number;
  /** Unix seconds. Fills older than this are stored as history only, never paper-copied. */
  follow_from_ts: number | null;
};

/**
 * The active reference experiment: the V2 fair-comparison row for the reference
 * wallet when it exists, otherwise the frozen V1 SHADOW row.
 */
export async function getExperiment(): Promise<Experiment> {
  const { data, error } = await supabaseAdmin
    .from("paper_experiments")
    .select("*")
    .in("name", [V2_REFERENCE_NAME, EXPERIMENT_NAME]);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as Experiment[];
  const row = rows.find((r) => r.name === V2_REFERENCE_NAME) ?? rows[0];
  if (!row) throw new Error("Reference experiment row is missing");
  return row;
}

/**
 * Every enabled experiment. The reference SHADOW experiment is always polled
 * first; candidate shadow experiments follow. Each row carries its own wallet,
 * bankroll and accounting, so one cycle can never cross-contaminate another.
 */
export async function listActiveExperiments(): Promise<Experiment[]> {
  const { data, error } = await supabaseAdmin
    .from("paper_experiments")
    .select("*")
    .eq("enabled", true)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as Experiment[];
  return rows.sort((a, b) =>
    a.name === EXPERIMENT_NAME ? -1 : b.name === EXPERIMENT_NAME ? 1 : a.name.localeCompare(b.name),
  );
}

/** Per-experiment worker/checkpoint row id. The V1 reference keeps its historical id. */
export function workerIdFor(experiment: { id: string; name: string }): string {
  return experiment.name === EXPERIMENT_NAME ? WORKER_ID : `ingest:${experiment.id}`;
}

/* ------------------------------------------------------------------ */
/* Ingestion                                                          */
/* ------------------------------------------------------------------ */

/**
 * takerOnly=false is explicit: the endpoint default omits a large share of this
 * wallet's activity (maker-side fills), so relying on the default would leave
 * the source history materially incomplete.
 */
export const TAKER_ONLY_PARAM = "takerOnly=false";

/**
 * The public Data API rejects /trades offset > 10000 with HTTP 400. Deeper
 * history must be read inside timestamp windows, each with its own offset
 * budget (see fetchUntilCheckpointCovered).
 */
export const MAX_TRADES_OFFSET = 10_000;

export function buildTradesUrl(
  limit: number,
  offset: number,
  wallet: string = TARGET_WALLET,
  endTs?: number,
): string {
  const window = endTs === undefined ? "" : `&end=${endTs}`;
  return `${DATA_API}/trades?user=${wallet}&${TAKER_ONLY_PARAM}&limit=${limit}&offset=${offset}${window}`;
}

/** Raised when a windowed catch-up cannot prove it moved backwards in time. */
export class CatchupProgressionError extends Error {}

/**
 * Bounded page walk: used only for a fixed number of newest pages.
 *
 * Exported (with an injected page fetcher, like fetchUntilCheckpointCovered)
 * so its cancellation behaviour can be tested without mocking the network.
 */
export async function fetchFixedPages(
  fetchPage: (offset: number) => Promise<Json[]>,
  pages: number,
  pageSize: number = PAGE_SIZE,
  signal?: AbortSignal,
): Promise<{ raw: Json[]; pagesFetched: number }> {
  const raw: Json[] = [];
  let pagesFetched = 0;
  for (let p = 0; p < pages; p += 1) {
    // Before-each-page abort check, mirroring processPendingEvents: once the
    // cycle deadline has fired, no NEW page request is started.
    if (signal?.aborted) throw new CycleAbortedError();
    const page = await fetchPage(p * pageSize);
    pagesFetched += 1;
    raw.push(...page);
    if (page.length < pageSize) break;
  }
  return { raw, pagesFetched };
}

/**
 * Checkpoint-driven catch-up: walk pages newest-to-oldest until the previous
 * checkpoint is fully covered, or the API's available history is exhausted.
 *
 * Coverage is proven by either:
 *  - a page containing an event strictly OLDER than checkpointTs (a page
 *    whose oldest event is exactly == checkpointTs does NOT prove coverage —
 *    more events sharing that same second may sit on the next page), or
 *  - the API returning fewer than pageSize rows (history exhausted).
 *
 * No artificial page cap is applied: a real backlog must be fully covered or
 * the caller's own deadline aborts the cycle (fail closed — see
 * runExperimentCycle, which only advances the checkpoint and processes
 * events once this promise resolves).
 *
 * Offset ceiling: the provider rejects offset > MAX_TRADES_OFFSET (HTTP 400).
 * When a window hits that ceiling without proving coverage or exhaustion, the
 * walk restarts at offset 0 inside an older window whose INCLUSIVE end
 * boundary is the oldest valid timestamp observed in the exhausted window.
 * Inclusive is deliberate: events sharing that same second may straddle the
 * boundary, so they are re-fetched (duplicates are absorbed by the unique
 * event_key on persistence) rather than skipped. If no valid timestamp was
 * observed, or the boundary would not move strictly backwards, this fails
 * closed instead of truncating history.
 *
 * Exported so the stopping semantics can be tested directly against an
 * injected page fetcher, without mocking the network.
 */
export async function fetchUntilCheckpointCovered(
  fetchPage: (offset: number, endTs?: number) => Promise<Json[]>,
  checkpointTs: number,
  pageSize: number = PAGE_SIZE,
  signal?: AbortSignal,
  maxPages?: number,
): Promise<{ raw: Json[]; pagesFetched: number }> {
  const raw: Json[] = [];
  let pagesFetched = 0;
  let endTs: number | undefined;
  for (;;) {
    let offset = 0;
    let oldestValid: number | null = null;
    for (;;) {
      // Before-each-page abort check, mirroring processPendingEvents.
      if (signal?.aborted) throw new CycleAbortedError();
      const page = await fetchPage(offset, endTs);
      pagesFetched += 1;
      raw.push(...page);
      const exhausted = page.length < pageSize;
      // A malformed timestamp (null, "", non-numeric) must never falsely prove
      // coverage or window progression: Number(null) === 0 and Number("") === 0
      // would otherwise look like a genuine event older than any positive
      // checkpoint.
      let coversCheckpoint = false;
      for (const r of page) {
        const ts = Number(r["timestamp"]);
        if (!Number.isFinite(ts) || ts <= 0) continue;
        if (ts < checkpointTs) coversCheckpoint = true;
        if (oldestValid === null || ts < oldestValid) oldestValid = ts;
      }
      if (exhausted || coversCheckpoint) return { raw, pagesFetched };
      // Bounded catch-up (General Shadow safe-resume guard only; undefined for
      // V2/V3/candidate polling, which keep their unbounded semantics). Fail
      // closed instead of returning a partial window: the caller then leaves
      // the checkpoint untouched and a later cycle retries the same boundary.
      if (maxPages !== undefined && pagesFetched >= maxPages) {
        throw new CatchupPageBudgetExceededError(
          `Bounded catch-up budget of ${maxPages} pages exhausted before covering checkpoint ${checkpointTs}`,
        );
      }
      offset += pageSize;
      if (offset > MAX_TRADES_OFFSET) break;
    }
    if (oldestValid === null) {
      throw new CatchupProgressionError(
        "Trades offset ceiling reached with no valid timestamp to move the window backward",
      );
    }
    if (endTs !== undefined && oldestValid >= endTs) {
      throw new CatchupProgressionError(
        `Trades window did not progress backwards (end=${endTs}, oldest observed=${oldestValid})`,
      );
    }
    endTs = oldestValid;
  }
}

/** Raised when a bootstrapped worker has no valid boundary to catch up against. */
export class MissingCatchupBoundaryError extends Error {}

/** Raised when a bounded (General Shadow) catch-up hits its per-cycle page budget. */
export class CatchupPageBudgetExceededError extends Error {}

/**
 * A first-ever bootstrap stays a bounded fixed-page fetch (never an unlimited
 * history download). Once bootstrapped, catchupBoundary (the previous
 * checkpoint, or experiment.follow_from_ts when there is no real checkpoint
 * yet — e.g. a newly followed wallet whose first bootstrap saw zero trades)
 * drives how far back this poll must catch up, so a backlog larger than the
 * old fixed window can never leave older unseen events permanently out of
 * reach. If neither boundary exists, this fails closed rather than silently
 * falling back to a bounded window: the caller's existing error/lease-release
 * path handles it, exactly like a deadline timeout.
 */
async function fetchSourceWindow(
  wallet: string,
  bootstrapped: boolean,
  catchupBoundary: number | null,
  signal?: AbortSignal,
  cache?: TradesRequestCache,
  maxCatchupPages?: number,
): Promise<{ raw: Json[]; pagesFetched: number }> {
  if (!bootstrapped) {
    return fetchFixedPages(
      (offset) => getArray(buildTradesUrl(PAGE_SIZE, offset, wallet), signal, cache),
      BOOTSTRAP_PAGES,
      PAGE_SIZE,
      signal,
    );
  }
  if (catchupBoundary === null) {
    throw new MissingCatchupBoundaryError(
      "Bootstrapped worker has neither a checkpoint nor a follow_from_ts to catch up against",
    );
  }
  return fetchUntilCheckpointCovered(
    (offset, endTs) => getArray(buildTradesUrl(PAGE_SIZE, offset, wallet, endTs), signal, cache),
    catchupBoundary,
    PAGE_SIZE,
    signal,
    maxCatchupPages,
  );
}

/** Previous checkpoint, falling back to go-live when there is no real checkpoint yet. */
export function resolveCatchupBoundary(
  checkpointTs: number | null | undefined,
  followFromTs: number | null | undefined,
): number | null {
  if (Number(checkpointTs) > 0) return Number(checkpointTs);
  if (Number(followFromTs) > 0) return Number(followFromTs);
  return null;
}

/**
 * Insert new events only. The unique event_key makes replays idempotent.
 *
 * keepRaw=false stores no raw provider payload. Used for the high-frequency
 * General Shadow wallets: every field we measure or display is already
 * extracted into typed columns, and the raw blob is ~75% of the row, so
 * dropping it keeps this cohort from crowding out the Weather observation
 * window. Weather rows are untouched.
 */
/**
 * Accepts an optional AbortSignal so the cycle's own deadline can actually
 * cancel this request instead of merely abandoning interest in its result.
 * Proven necessary in production 2026-08-14: pg_stat_statements showed this
 * exact upsert never exceeds ~8s of real query execution, yet stage_ms
 * repeatedly recorded 44s-82s wall-clock for it -- the request was still
 * outstanding, holding a connection/request slot, tens of seconds after the
 * cycle's 40s deadline had already fired, released the lease, and let a new
 * attempt start. Promise.race (withDeadline/boundedStage) never cancels its
 * losing promise; this is the one call site with proven, repeated, extreme
 * overruns, so it is the one given real cancellation here.
 */
async function persistEvents(events: NormalizedEvent[], keepRaw = true, signal?: AbortSignal): Promise<number> {
  if (events.length === 0) return 0;
  const rows = events.map((e) => ({
    event_key: e.eventKey,
    wallet: e.wallet,
    tx_hash: e.txHash,
    source_native_id: e.sourceNativeId,
    log_index: e.logIndex,
    condition_id: e.conditionId,
    asset: e.asset,
    market_title: e.marketTitle,
    outcome: e.outcome,
    slug: e.slug,
    side: e.side,
    shares: e.shares,
    price: e.price,
    source_ts: e.sourceTs,
    identity_basis: e.identityBasis,
    identity_degraded: e.identityDegraded,
    raw: (keepRaw ? e.raw : null) as never,
  }));
  const query = supabaseAdmin
    .from("source_events")
    // Event identity is wallet-scoped: two wallets may legitimately report the
    // same event_key, and one wallet can never record the same event twice.
    .upsert(rows, { onConflict: "wallet,event_key", ignoreDuplicates: true })
    .select("id");
  const { data, error } = await (signal ? query.abortSignal(signal) : query);
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}

/** Test-only alias so real request cancellation can be asserted directly. */
export const persistEventsForTest = persistEvents;


/* ------------------------------------------------------------------ */
/* Follower pass over experiment-scoped pending events                 */
/* ------------------------------------------------------------------ */

type SourceEventRow = {
  id: string;
  event_key: string;
  asset: string;
  market_title: string;
  outcome: string | null;
  side: string;
  shares: number;
  price: number;
  source_ts: number;
  first_seen_at: string;
};

type PaperPositionRow = {
  asset: string;
  shares: number;
  cost_basis: number;
  avg_price: number;
  realized_pnl: number;
  settlement_status: string;
};

type ExperimentSourcePositionRow = {
  asset: string;
  shares: number;
};

export type ProcessResult = {
  processed: number;
  buys: number;
  sells: number;
  skips: number;
  /** Pre-go-live fills recorded for history/reconciliation only. */
  backfilled: number;
  /**
   * Post-follow fills consumed WITHOUT any paper decision because the market is
   * outside the experiment's market_scope. Never a SKIP: no paper_trades row,
   * no cash/P&L change and no paper_positions write.
   */
  scopeExcluded: number;
};

/**
 * Real-event validation record: source timestamp vs. detection vs. decision.
 * Written once per (experiment, event) so latency can be audited after the fact.
 */
function buildAuditRow(input: {
  experimentId: string;
  wallet: string;
  eventKey: string;
  marketTitle: string | null;
  side: string;
  action: string;
  sourceTs: number;
  firstSeenAt: string;
}): Record<string, unknown> {
  const decisionAt = new Date();
  const detectedMs = new Date(input.firstSeenAt).getTime();
  const sourceMs = input.sourceTs * 1000;
  const secs = (ms: number) => Math.round((ms / 1000) * 100) / 100;
  return {
    experiment_id: input.experimentId,
    event_key: input.eventKey,
    wallet: input.wallet,
    market_title: input.marketTitle,
    side: input.side,
    action: input.action,
    source_ts: input.sourceTs,
    detected_at: input.firstSeenAt,
    event_persisted_at: input.firstSeenAt,
    decision_at: decisionAt.toISOString(),
    paper_trade_at: decisionAt.toISOString(),
    position_updated_at: decisionAt.toISOString(),
    detection_latency_seconds: sourceMs > 0 ? Math.max(0, secs(detectedMs - sourceMs)) : null,
    decision_latency_seconds: Math.max(0, secs(decisionAt.getTime() - detectedMs)),
    total_latency_seconds: sourceMs > 0 ? Math.max(0, secs(decisionAt.getTime() - sourceMs)) : null,
  };
}

/** Raised when the database refuses a commit because another worker took the lease. */
export class StaleFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleFenceError";
  }
}

export function isStaleFenceMessage(message: string): boolean {
  return message.toLowerCase().includes("stale_fence");
}

/**
 * Commits one source event as ONE PostgreSQL transaction that also re-verifies
 * the worker lease fence. A stale worker cannot commit, and a partial failure
 * cannot leave half of an event's accounting applied.
 */
async function commitEventAtomically(
  lease: Lease,
  experimentId: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ applied: boolean }> {
  const call = supabaseAdmin.rpc("process_source_event_atomic", {
    p_lock_id: lease.lockId,
    p_worker_id: lease.workerId,
    p_fence: lease.fence,
    p_experiment_id: experimentId,
    p_event: payload as never,
  } as never);
  // Real cancellation: an aborted request is cancelled server-side, and because
  // the RPC is ONE transaction it rolls back rather than partially committing.
  const { data, error } = await (signal ? call.abortSignal(signal) : call);
  if (error) {
    if (isStaleFenceMessage(error.message)) throw new StaleFenceError(error.message);
    throw new Error(error.message);
  }
  const applied = Boolean((data as { applied?: boolean } | null)?.applied);
  return { applied };
}

/** Thrown when the cycle deadline fires mid-batch. Ends the loop cleanly. */
export class CycleAbortedError extends Error {
  constructor() {
    super("cycle aborted before the next source event was started");
  }
}

async function processPendingEvents(
  experiment: Experiment,
  lease: Lease,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  const wallet = experiment.wallet_address.toLowerCase();

  // Pending/consumed state belongs to (experiment, source_event). The source
  // event row itself is immutable shared input and is never filtered by the
  // legacy wallet-global processed_at bit here.
  const pendingCall = supabaseAdmin.rpc(
    "get_pending_experiment_source_events" as never,
    { p_experiment_id: experiment.id, p_limit: PROCESS_BATCH } as never,
  );
  const { data: pending, error } = await (signal ? pendingCall.abortSignal(signal) : pendingCall);
  if (error) throw new Error(error.message);
  const rows = (pending ?? []) as unknown as SourceEventRow[];
  if (rows.length === 0)
    return { processed: 0, buys: 0, sells: 0, skips: 0, backfilled: 0, scopeExcluded: 0 };
  const followFrom = experiment.follow_from_ts ?? 0;
  const scope = parseMarketScope(experiment.market_scope);

  const assets = [...new Set(rows.map((r) => r.asset))];

  // SourceSharesBefore must also be experiment-scoped. A wallet-global compact
  // row can be ahead of another experiment and would distort proportional sells.
  const sourceStateCall = supabaseAdmin.rpc(
    "get_experiment_source_positions" as never,
    { p_experiment_id: experiment.id, p_assets: assets } as never,
  );
  const { data: sourceStateRows, error: sourceStateError } = await (signal
    ? sourceStateCall.abortSignal(signal)
    : sourceStateCall);
  if (sourceStateError) throw new Error(sourceStateError.message);
  const sourceShares = new Map<string, number>();
  for (const r of (sourceStateRows ?? []) as unknown as ExperimentSourcePositionRow[]) {
    sourceShares.set(r.asset, Number(r.shares));
  }

  const paperCall = supabaseAdmin
    .from("paper_positions")
    .select("asset, shares, cost_basis, avg_price, realized_pnl, settlement_status")
    .eq("experiment_id", experiment.id)
    .in("asset", assets);
  const { data: paperRows } = await (signal ? paperCall.abortSignal(signal) : paperCall);
  const paper = new Map<string, PaperPositionState>();
  const settlementStatusByAsset = new Map<string, string>();
  for (const r of (paperRows ?? []) as PaperPositionRow[]) {
    paper.set(r.asset, {
      shares: Number(r.shares),
      costBasis: Number(r.cost_basis),
      avgPrice: Number(r.avg_price),
      realizedPnl: Number(r.realized_pnl),
    });
    settlementStatusByAsset.set(r.asset, r.settlement_status);
  }

  let cash = Number(experiment.cash);
  let realizedTotal = Number(experiment.realized_pnl);
  const result: ProcessResult = {
    processed: 0,
    buys: 0,
    sells: 0,
    skips: 0,
    backfilled: 0,
    scopeExcluded: 0,
  };
  const meta = new Map<string, { title: string; outcome: string | null; ts: number }>();
  /** Assets that already had a persisted paper_positions row before this batch. */
  const existingPaperAssets = new Set<string>(
    ((paperRows ?? []) as PaperPositionRow[]).map((r) => r.asset),
  );
  /** Assets genuinely traded (BUY/SELL) in this batch. SKIP-only assets are never written. */
  const tradedAssets = new Set<string>();

  for (const row of rows) {
    // Between-event abort check: once the cycle deadline has fired, no NEW
    // event work is scheduled. Everything already committed stayed committed
    // (each event is its own transaction), and the checkpoint is only advanced
    // by the caller's success path, so the next poll safely resumes the rest.
    if (signal?.aborted) throw new CycleAbortedError();
    const side = (row.side === "SELL" ? "SELL" : "BUY") as Side;
    const price = Number(row.price);
    const srcShares = Number(row.shares);
    const before = sourceShares.has(row.asset) ? (sourceShares.get(row.asset) as number) : null;
    const position = paper.get(row.asset) ?? EMPTY_POSITION;
    meta.set(row.asset, { title: row.market_title, outcome: row.outcome, ts: Number(row.source_ts) });

    // Advance source state for pre-go-live history, but never spend simulated cash on it.
    const nextSourceForRow =
      side === "BUY" ? (before ?? 0) + srcShares : Math.max(0, (before ?? 0) - srcShares);

    if (!isEligibleForV2Copy(Number(row.source_ts), followFrom)) {
      const nextShares = roundShares(nextSourceForRow);
      await commitEventAtomically(
        lease,
        experiment.id,
        buildEventCommit({
          sourceEventId: row.id,
          backfilled: true,
          sourceState: {
            wallet,
            asset: row.asset,
            marketTitle: row.market_title,
            outcome: row.outcome,
            shares: nextShares,
            lastEventKey: row.event_key,
            lastEventTs: Number(row.source_ts),
          },
          trade: null,
          paperPosition: null,
          experiment: null,
          audit: null,
        }),
        signal,
      );
      sourceShares.set(row.asset, nextShares);
      result.backfilled += 1;
      result.processed += 1;
      continue;
    }

    // Post-follow but out of scope: consume the event and keep experiment-scoped
    // source state truthful, without any paper accounting or SKIP statistics.
    if (!isInMarketScope(scope, row.market_title)) {
      const nextShares = roundShares(nextSourceForRow);
      await commitEventAtomically(
        lease,
        experiment.id,
        buildEventCommit({
          sourceEventId: row.id,
          backfilled: false,
          sourceState: {
            wallet,
            asset: row.asset,
            marketTitle: row.market_title,
            outcome: row.outcome,
            shares: nextShares,
            lastEventKey: row.event_key,
            lastEventTs: Number(row.source_ts),
          },
          trade: null,
          paperPosition: null,
          experiment: null,
          audit: null,
        }),
        signal,
      );
      sourceShares.set(row.asset, nextShares);
      result.scopeExcluded += 1;
      result.processed += 1;
      continue;
    }

    // A late source event must never reopen a paper position that already
    // reached final settlement: that row is a closed historical record.
    const isTerminal = isTerminalSettlementStatus(settlementStatusByAsset.get(row.asset));
    const decision: FollowerDecision = isTerminal
      ? { action: "SKIP", shares: 0, notional: 0, price, reason: SETTLED_POSITION_SKIP_REASON }
      : side === "BUY"
        ? decideDynamicBuy({
            price,
            startingCash: Number(experiment.starting_cash),
            cash,
          })
        : decideProportionalSell({
            price,
            sourceSharesBefore: before,
            sourceSoldShares: srcShares,
            paperShares: position.shares,
          });

    let cashAfter = cash;
    let realized = 0;
    let nextPosition = position;
    const prevCash = cash;
    const prevRealizedTotal = realizedTotal;

    if (decision.action === "BUY") {
      const applied = applyBuy(position, cash, decision.shares, decision.notional);
      nextPosition = applied.position;
      cashAfter = applied.cash;
      result.buys += 1;
      tradedAssets.add(row.asset);
    } else if (decision.action === "SELL") {
      const applied = applySell(position, cash, decision.shares, decision.price);
      nextPosition = applied.position;
      cashAfter = applied.cash;
      realized = applied.realized;
      realizedTotal = roundUsd(realizedTotal + realized);
      result.sells += 1;
      tradedAssets.add(row.asset);
    } else {
      result.skips += 1;
    }

    cash = cashAfter;

    const tradeRow = {
      experiment_id: experiment.id,
      source_event_id: row.id,
      event_key: row.event_key,
      action: decision.action,
      side,
      asset: row.asset,
      market_title: row.market_title,
      outcome: row.outcome,
      price: decision.price,
      shares: decision.shares,
      notional: decision.notional,
      reason: decision.reason,
      cash_after: cashAfter,
      realized_pnl: realized,
      source_ts: row.source_ts,
    };
    const auditRow = buildAuditRow({
      experimentId: experiment.id,
      wallet,
      eventKey: row.event_key,
      marketTitle: row.market_title,
      side,
      action: decision.action,
      sourceTs: Number(row.source_ts),
      firstSeenAt: row.first_seen_at,
    });

    const nextSourceShares = roundShares(nextSourceForRow);
    // Terminal positions are never written, even with unchanged values: the
    // existing paper_positions row (including settlement_status) must stay
    // byte-for-byte untouched by a late source event.
    const persistPosition =
      !isTerminal &&
      shouldPersistPaperPosition({
        hadExistingRow: existingPaperAssets.has(row.asset),
        tradedThisBatch: tradedAssets.has(row.asset),
      });

    const commit = await commitEventAtomically(
      lease,
      experiment.id,
      buildEventCommit({
        sourceEventId: row.id,
        backfilled: false,
        sourceState: {
          wallet,
          asset: row.asset,
          marketTitle: row.market_title,
          outcome: row.outcome,
          shares: nextSourceShares,
          lastEventKey: row.event_key,
          lastEventTs: Number(row.source_ts),
        },
        trade: tradeRow,
        paperPosition: persistPosition
          ? {
              asset: row.asset,
              marketTitle: row.market_title,
              outcome: row.outcome,
              shares: nextPosition.shares,
              costBasis: nextPosition.costBasis,
              avgPrice: nextPosition.avgPrice,
              realizedPnl: nextPosition.realizedPnl,
              lastActivityTs: Number(row.source_ts),
            }
          : null,
        experiment: { cash, realizedPnl: realizedTotal },
        audit: auditRow,
      }),
      signal,
    );

    // This local source state is experiment-scoped and advances even for SKIP.
    sourceShares.set(row.asset, nextSourceShares);

    if (commit.applied) {
      paper.set(row.asset, nextPosition);
    } else {
      // This event's trade already existed: its accounting is already in the
      // persisted bankroll, so nothing may be applied a second time.
      cash = prevCash;
      realizedTotal = prevRealizedTotal;
      if (decision.action === "BUY") result.buys -= 1;
      if (decision.action === "SELL") result.sells -= 1;
    }
    result.processed += 1;
  }

  return result;
}

/** Test-only alias so real paper_processing cancellation can be asserted. */
export const processPendingEventsForTest = processPendingEvents;

/* ------------------------------------------------------------------ */
/* Marks from the public CLOB                                          */
/* ------------------------------------------------------------------ */

/**
 * Marks come from ONE batched public POST /books call per 100 open positions.
 * Per-asset fetching could not cover a 200-position book inside a cycle, which
 * was the direct cause of both cycle-deadline failures and low mark coverage.
 */
export async function refreshMarks(experimentId: string): Promise<{ updated: number; failed: number }> {
  const { data: open } = await supabaseAdmin
    .from("paper_positions")
    .select("asset")
    .eq("experiment_id", experimentId)
    .gt("shares", 0)
    .order("updated_at", { ascending: true })
    .limit(MAX_MARK_REFRESH);

  let updated = 0;
  let failed = 0;
  const rows = open ?? [];
  if (rows.length === 0) return { updated, failed };

  const { fetchBooksBatched } = await import("./clob-books.server");
  const books = await fetchBooksBatched(rows.map((r) => r.asset));

  const writeOne = async (asset: string) => {
    const book = books.get(asset) ?? null;
    if (book === null) {
      failed += 1;
      // No public book in this pass: clear rather than reuse a stale price, so
      // open P&L reads Unavailable instead of a fabricated mark.
      await supabaseAdmin
        .from("paper_positions")
        .update({ mark: null, mark_source: null, mark_ts: null, updated_at: new Date().toISOString() })
        .eq("experiment_id", experimentId)
        .eq("asset", asset);
      return;
    }
    const resolved = resolveMark({
      bestBid: book.bid,
      bestAsk: book.ask,
      midpoint: null,
      markTs: book.ts,
      nowMs: Date.now(),
    });
    await supabaseAdmin
      .from("paper_positions")
      .update({
        best_bid: book.bid,
        best_ask: book.ask,
        midpoint: resolved.mark,
        mark: resolved.mark,
        mark_source: resolved.source,
        mark_ts: resolved.mark === null ? null : new Date(book.ts).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("experiment_id", experimentId)
      .eq("asset", asset);
    if (resolved.mark === null) failed += 1;
    else updated += 1;
  };

  for (let i = 0; i < rows.length; i += MARK_WRITE_CONCURRENCY) {
    await Promise.all(rows.slice(i, i + MARK_WRITE_CONCURRENCY).map((r) => writeOne(r.asset)));
  }
  return { updated, failed };
}

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

export async function reconcile(
  wallet: string = TARGET_WALLET,
  options: { expectAdvance?: boolean } = {},
): Promise<{
  ok: boolean;
  mismatches: number;
  replayComplete: boolean;
  replayedEvents: number;
  skipped?: boolean;
}> {
  /**
   * source_position_state is WALLET-scoped, but V2 and V3 sibling experiments
   * follow the same wallet and each call reconcile() within ~1s of each other
   * every cron tick. Unfenced, their full-history replays raced on the same
   * cache rows and produced an oscillating repair count (observed in
   * production: 55 -> 111 -> 2 -> 20 -> 5 for one wallet in 13 minutes) while
   * doubling the replay load on the database during the timeout wave. A short
   * wallet-scoped lease makes the loser skip cheaply instead of racing.
   */
  const holder = `reconcile:${crypto.randomUUID()}`;
  const { data: acquired, error: leaseError } = await supabaseAdmin.rpc(
    "try_acquire_reconcile_lease" as never,
    { p_wallet: wallet, p_holder: holder, p_seconds: 60 } as never,
  );
  if (leaseError) throw new Error(leaseError.message);
  if (acquired !== true) {
    // A sibling experiment is already reconciling this exact wallet. Its result
    // is equally authoritative, so this is a no-op, not a failure.
    return { ok: true, mismatches: 0, replayComplete: false, replayedEvents: 0, skipped: true };
  }
  try {
    return await reconcileHeld(wallet, options);
  } finally {
    await supabaseAdmin
      .rpc("release_reconcile_lease" as never, { p_wallet: wallet, p_holder: holder } as never)
      .then(
        () => undefined,
        () => undefined,
      );
  }
}

async function reconcileHeld(
  wallet: string,
  options: { expectAdvance?: boolean },
): Promise<{ ok: boolean; mismatches: number; replayComplete: boolean; replayedEvents: number }> {
  // The replay MUST cover every persisted fill. PostgREST caps a single request
  // at 1000 rows, so a plain .limit(5000) silently replayed only the oldest
  // page and reported every later asset as a phantom mismatch.
  const paged = await fetchAllRows<{ asset: string; side: string; shares: number }>(
    async (from, to) => {
      const { data, error } = await supabaseAdmin
        .from("source_events")
        .select("asset, side, shares")
        .eq("wallet", wallet)
        .order("source_ts", { ascending: true })
        .order("event_key", { ascending: true })
        .range(from, to);
      if (error) throw new Error(error.message);
      return (data ?? []) as { asset: string; side: string; shares: number }[];
    },
  );

  if (!paged.complete) {
    // Never repair from a truncated replay: that would corrupt correct state.
    await raiseAlert(
      "warn",
      "reconciliation_incomplete",
      `Reconciliation skipped for ${wallet}: the event replay was truncated after ${paged.rows.length} events.`,
      { wallet, events: paged.rows.length } as never,
    );
    return { ok: true, mismatches: 0, replayComplete: false, replayedEvents: paged.rows.length };
  }

  const replayed = replaySourcePositions(
    paged.rows.map((e) => ({
      asset: e.asset,
      side: (e.side === "SELL" ? "SELL" : "BUY") as Side,
      shares: Number(e.shares),
    })),
  );

  const compactPaged = await fetchAllRows<{ asset: string; shares: number }>(async (from, to) => {
    const { data, error } = await supabaseAdmin
      .from("source_position_state")
      .select("asset, shares")
      .eq("wallet", wallet)
      .order("asset", { ascending: true })
      .range(from, to);
    if (error) throw new Error(error.message);
    return (data ?? []) as { asset: string; shares: number }[];
  });
  const compact = new Map<string, number>();
  for (const r of compactPaged.rows) compact.set(r.asset, Number(r.shares));

  const result = reconcileSourceState(compact, replayed);
  const stamp = new Date().toISOString();
  const bad = new Set(result.mismatches.map((m) => m.asset));

  const rows = [...new Set([...compact.keys(), ...replayed.keys()])].map((asset) => ({
    wallet,
    asset,
    shares: replayed.get(asset) ?? 0,
    reconciled_at: stamp,
    reconciliation_status: bad.has(asset) ? "repaired_from_replay" : "ok",
    updated_at: stamp,
  }));
  for (const chunk of chunked(rows, 200)) {
    const { error: repairError } = await supabaseAdmin
      .from("source_position_state")
      .upsert(chunk as never, { onConflict: "wallet,asset" });
    // A failed repair upsert must NEVER be reported as repaired/advanced: fail
    // visibly before any reconciliation_advanced / reconciliation_mismatch
    // alert is raised. Paper accounting tables are untouched either way.
    if (repairError) {
      throw new Error(`source_position_state repair failed for ${wallet}: ${repairError.message}`);
    }
  }

  if (!result.ok) {
    // Distinguish the two genuinely different causes instead of hiding either.
    // expectAdvance means this cycle just ingested new source fills, so the
    // wallet-level compact cache is EXPECTED to be one step behind the replay:
    // that is routine advancement, not an integrity failure. Only a mismatch
    // with no new ingestion is a real, unexplained divergence.
    if (options.expectAdvance) {
      await raiseAlert(
        "info",
        "reconciliation_advanced",
        `Reconciliation advanced ${result.mismatches.length} source position(s) after newly ingested fills.`,
        { wallet, advanced: result.mismatches.length as never },
        `reconciliation_advanced:${wallet}`,
      );
    } else {
      await raiseAlert(
        "warn",
        "reconciliation_mismatch",
        `Reconciliation repaired ${result.mismatches.length} source position(s) from the persisted event replay.`,
        { mismatches: result.mismatches.slice(0, 20) as never },
      );
    }
  }
  return {
    ok: result.ok,
    mismatches: result.mismatches.length,
    replayComplete: true,
    replayedEvents: paged.rows.length,
  };
}

/* ------------------------------------------------------------------ */
/* One full poll cycle                                                 */
/* ------------------------------------------------------------------ */

export type CycleResult = {
  ranAt: string;
  experimentName: string;
  wallet: string;
  skipped: string | null;
  newEvents: number;
  pagesFetched: number;
  process: ProcessResult;
  marks: { updated: number; failed: number };
  reconciliation: { ok: boolean; mismatches: number } | null;
  lagSeconds: number | null;
  previews: { created: number; ineligible: number; failed: number; skippedReason: string | null };
  settlements: { settled: number; unresolved: number };
  copyability: { scheduled: number; sampled: number; unavailable: number };
  /** Stage-duration telemetry (ms) for this cycle. Empty on a skipped cycle. */
  stageMs?: Record<string, number>;
};

export type MultiCycleResult = {
  ranAt: string;
  experiments: number;
  cycles: CycleResult[];
  /** Reference SHADOW experiment result, kept for the existing dashboard read. */
  reference: CycleResult | null;
  /** Stuck worker rows whose state was reclaimed at the start of this cycle. */
  reclaimedWorkers: number;
  /** Experiments intentionally left for the next cycle to stay inside the budget. */
  deferredExperiments: number;
  candidateResearch: { ran: boolean; detail: string | null };
};

const NO_SETTLEMENTS = { settled: 0, unresolved: 0 };

const NO_PREVIEWS = {
  created: 0,
  ineligible: 0,
  failed: 0,
  skippedReason: null as string | null,
};

/**
 * Order-preview generation is best-effort: a Polymarket US outage must never
 * break autonomous public-wallet ingestion.
 */
async function generatePreviewsSafely(
  experimentId: string,
  wallet: string,
): Promise<typeof NO_PREVIEWS> {
  try {
    // Bounded, self-throttled public weather-availability scan. Its result is
    // what triggers automatic rechecks of previously unmatched source markets.
    const { runAvailabilityScan } = await import("./pmus/availability.server");
    await runAvailabilityScan();
    const { generatePendingPreviews } = await import("./pmus/previews.server");
    const result = await generatePendingPreviews(experimentId, {}, undefined, wallet);
    return {
      created: result.created,
      ineligible: result.ineligible,
      failed: result.failed,
      skippedReason: result.skippedReason,
    };
  } catch {
    return { ...NO_PREVIEWS, skippedReason: "Order-preview generation was skipped after an error." };
  }
}

/** Settlement automation is best-effort and must never break ingestion. */
async function settleSafely(experimentId: string): Promise<typeof NO_SETTLEMENTS> {
  try {
    const { runSettlementPass } = await import("./settlement.server");
    const result = await runSettlementPass(experimentId);
    return { settled: result.settled, unresolved: result.unresolved };
  } catch (err) {
    // Ingestion must stay isolated from settlement failure, but the failure
    // itself must never be silent. Bucketed hourly so a persistent outage does
    // not notify every minute.
    const message = err instanceof Error ? err.message : "unknown settlement error";
    const bucket = new Date().toISOString().slice(0, 13);
    try {
      await raiseAlert(
        "error",
        "settlement_pass_failed",
        `Settlement pass failed for experiment ${experimentId}: ${message} (at ${new Date().toISOString()})`,
        { experiment_id: experimentId as never, error: message as never },
        `settlement_pass_failed:${experimentId}:${bucket}`,
      );
    } catch {
      // alerting itself must not break ingestion
    }
    return NO_SETTLEMENTS;
  }
}

/**
 * Iterates every ENABLED experiment. Each experiment has its own lease,
 * checkpoint, bankroll, paper book, event-consumption state and source-position
 * state, so same-wallet experiments can evaluate the same immutable event stream
 * independently without competing for a shared processing bit.
 */
export async function runIngestCycle(workerId: string): Promise<MultiCycleResult> {
  const ranAt = new Date().toISOString();
  const startedMs = Date.now();
  const experiments = await listActiveExperiments();
  const reclaimed = await reclaimAbandonedWorkers();
  const ordered = await orderExperimentsForCycle(experiments);
  const cycles: CycleResult[] = [];
  let deferred = 0;
  // Shared across every batch in this cycle only: V2 and V3 experiments follow
  // identical wallets, so without this, two experiments in the same or
  // different batches would each fire their own byte-identical /trades
  // request every tick. One cache per runIngestCycle invocation collapses
  // those duplicates to a single upstream request while leaving each
  // experiment's own checkpoint/accounting fully independent (see
  // TradesRequestCache doc comment). Never carried across cycles.
  const tradesCache: TradesRequestCache = new Map();
  // Experiments hold independent leases, checkpoints and books, so a small
  // concurrent batch cannot overlap execution for the same experiment. Batching
  // lets every enabled experiment finish inside one scheduler cycle, which is
  // what keeps marks inside the freshness window.
  for (const batch of chunked(ordered, EXPERIMENT_CONCURRENCY)) {
    if (Date.now() - startedMs > CYCLE_BUDGET_MS) {
      // Out of budget: leave the remaining experiments untouched. They are served
      // first on the next cycle because ordering is least-recently-completed-first.
      for (const experiment of batch) {
        deferred += 1;
        cycles.push({
          ...emptyCycle(ranAt, experiment),
          skipped: "Deferred to the next scheduled cycle (cycle time budget reached).",
        });
      }
      continue;
    }
    const settled = await Promise.allSettled(
      batch.map((experiment) => runExperimentCycle(experiment, workerId, tradesCache)),
    );
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        cycles.push(result.value);
        return;
      }
      cycles.push({
        ...emptyCycle(ranAt, batch[index]!),
        skipped: result.reason instanceof Error ? result.reason.message : "cycle failed",
      });
    });
  }
  return {
    ranAt,
    experiments: experiments.length,
    cycles,
    reference: cycles.find((c) => c.experimentName === EXPERIMENT_NAME) ?? null,
    reclaimedWorkers: reclaimed,
    deferredExperiments: deferred,
    candidateResearch: await candidateResearchIfCycleAndHostAllow(startedMs),
  };
}

/**
 * Candidate research (candidates/research.server.ts) has its own,
 * independent /trades fetcher against the same data-api.polymarket.com host
 * -- it is not routed through getJson/getArray in this file, so it does not
 * automatically respect the shared cooldown on its own. Gated here instead:
 * skip the whole (6-hour-throttled, so low-cost to defer) pass while the
 * host is in cooldown, rather than let it keep rediscovering or prolonging
 * the same rate limit the cooldown exists to stop.
 */
async function candidateResearchIfCycleAndHostAllow(
  startedMs: number,
): Promise<{ ran: boolean; detail: string | null }> {
  if (Date.now() - startedMs > CYCLE_BUDGET_MS) {
    return { ran: false, detail: "deferred: cycle time budget reached" };
  }
  const cooldown = await boundedStage(
    getHostCooldown(DATA_API_HOST),
    HOST_COOLDOWN_CHECK_DEADLINE_MS,
    "candidate_research_cooldown_check",
    { blocked: true, until: null, reason: "cooldown check timed out" },
  );
  if (cooldown.blocked) {
    return {
      ran: false,
      detail: `deferred: ${DATA_API_HOST} rate-limit cooldown active${
        cooldown.until ? ` until ${cooldown.until.toISOString()}` : ""
      }`,
    };
  }
  return refreshCandidateResearchSafely();
}

/**
 * A cycle killed by the platform leaves state='running' forever even though its
 * lease has long expired. The lease itself never blocked recovery (acquisition
 * is atomic and expiry-based), but the stuck state hid the failure from health
 * reporting. Reclaiming only rewrites worker STATE — never any paper accounting,
 * fence, or lease ownership — so fencing guarantees are untouched.
 */
async function reclaimAbandonedWorkers(): Promise<number> {
  const { data } = await supabaseAdmin
    .from("worker_status")
    .select("id, state, heartbeat_at, last_poll_at, last_success_at, lease_expires_at, poll_failures");
  const abandoned = findAbandonedWorkers((data ?? []) as unknown as WorkerRow[], Date.now());
  for (const row of abandoned) {
    await supabaseAdmin
      .from("worker_status")
      .update({
        state: "stale",
        last_error: "Previous cycle was abandoned before completion (lease expired while running).",
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id", row.id)
      .eq("state", "running");
  }
  return abandoned.length;
}

/** Least-recently-completed experiment first, so no experiment can be starved. */
async function orderExperimentsForCycle(experiments: Experiment[]): Promise<Experiment[]> {
  const { data } = await supabaseAdmin.from("worker_status").select("id, last_poll_at, last_success_at");
  const completedAt = new Map<string, number | null>();
  for (const row of (data ?? []) as { id: string; last_poll_at: string | null; last_success_at: string | null }[]) {
    const iso = row.last_success_at ?? row.last_poll_at;
    const ms = iso ? new Date(iso).getTime() : NaN;
    completedAt.set(row.id, Number.isFinite(ms) ? ms : null);
  }
  return orderByStaleness(experiments, (e) => completedAt.get(workerIdFor(e)) ?? null);
}

function emptyCycle(ranAt: string, experiment: Experiment): CycleResult {
  return {
    ranAt,
    experimentName: experiment.name,
    wallet: experiment.wallet_address,
    skipped: null,
    newEvents: 0,
    pagesFetched: 0,
    process: { processed: 0, buys: 0, sells: 0, skips: 0, backfilled: 0, scopeExcluded: 0 },
    marks: { updated: 0, failed: 0 },
    reconciliation: null,
    lagSeconds: null,
    previews: NO_PREVIEWS,
    settlements: NO_SETTLEMENTS,
    copyability: { scheduled: 0, sampled: 0, unavailable: 0 },
  };
}

/**
 * Public-CLOB copyability sampling. Measurement only: a failure here must never
 * break ingestion or paper accounting.
 */
async function observeCopyabilitySafely(
  experiment: Experiment,
): Promise<{ scheduled: number; sampled: number; unavailable: number }> {
  try {
    const { runCopyabilityPass } = await import("./copyability/observe.server");
    return await runCopyabilityPass({
      id: experiment.id,
      starting_cash: Number(experiment.starting_cash),
      cash: Number(experiment.cash),
      ...(isGeneralShadowName(experiment.name)
        ? { delays: ["immediate", "30s", "60s"] as const }
        : {}),
    });
  } catch {
    return { scheduled: 0, sampled: 0, unavailable: 0 };
  }
}

/** Deterministic, de-duplicated cash-runway alerts. Never changes any bankroll. */
async function raiseCashAlerts(experiment: Experiment): Promise<void> {
  try {
    const { decideCashAlerts } = await import("./cash-runway");
    const { data: fresh } = await supabaseAdmin
      .from("paper_experiments")
      .select("cash, starting_cash")
      .eq("id", experiment.id)
      .maybeSingle();
    const alerts = decideCashAlerts({
      experimentId: experiment.id,
      experimentName: experiment.name,
      startingCash: Number(fresh?.starting_cash ?? experiment.starting_cash),
      cash: Number(fresh?.cash ?? experiment.cash),
    });
    for (const alert of alerts) {
      await raiseAlert(alert.level, alert.kind, alert.message, { experiment: experiment.name as never }, alert.dedupKey);
    }
  } catch {
    /* measurement only */
  }
}

/**
 * Recurring candidate research refresh (cadence owned by the research module).
 * Cancellation, not abandonment: the abort is propagated into the research
 * deadline and we await the terminal state write before returning.
 */
export async function refreshCandidateResearchSafely(
  budgetMs: number = RESEARCH_DEADLINE_MS,
): Promise<{ ran: boolean; detail: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("candidate research scheduler budget reached")), budgetMs);
  try {
    const { refreshCandidateResearchIfDue } = await import("./candidates/research.server");
    return await refreshCandidateResearchIfDue(controller.signal);
  } catch (err) {
    return { ran: false, detail: err instanceof Error ? err.message : "research refresh skipped" };
  } finally {
    clearTimeout(timer);
  }
}

export async function runExperimentCycle(
  experiment: Experiment,
  baseWorkerId: string,
  tradesCache?: TradesRequestCache,
): Promise<CycleResult> {
  const ranAt = new Date().toISOString();
  const lockId = workerIdFor(experiment);
  const wallet = experiment.wallet_address.toLowerCase();
  const workerId = `${baseWorkerId}:${experiment.name}`;
  const base = emptyCycle(ranAt, experiment);
  if (!experiment.enabled) {
    return {
      ...base,
      skipped: "Follower is paused (enabled = false).",
    };
  }

  // Explicit identity gate, not a strategy fix: pauses ONLY the two General
  // Shadow wallets (GS_PREFIX-named experiments) while they are stalled and
  // generating 429s. Checked before any lease/checkpoint/network work, so a
  // paused cycle never touches worker_status, worker_checkpoints, or the
  // upstream host at all. Every V2/V3 experiment name fails
  // isGeneralShadowName and is completely unaffected. See
  // GENERAL_SHADOW_POLLING_ENABLED's doc comment for how to resume.
  if (isGeneralShadowName(experiment.name) && !GENERAL_SHADOW_POLLING_ENABLED) {
    return {
      ...base,
      skipped: `General Shadow polling is paused (GENERAL_SHADOW_POLLING_ENABLED = false); ${experiment.name} deferred, no upstream request made.`,
    };
  }

  const lease = await acquireLease(workerId, lockId);
  if (!lease) {
    return {
      ...base,
      skipped: "Another worker holds the ingestion lease.",
    };
  }

  // Read fresh every call (not threaded down from runIngestCycle) so a
  // cooldown recorded by an earlier experiment IN THIS SAME cycle is seen
  // immediately by a later one, not just on the next scheduler tick. Applies
  // uniformly to every experiment -- including General Shadow, since it hits
  // the same host via a different path (see general-shadow.server.ts) -- so
  // one shared budget paces all of them together instead of each
  // independently rediscovering the limit. Checked before any checkpoint or
  // network work starts: a deferred cycle must never touch
  // worker_checkpoints, so nothing here can advance a checkpoint.
  //
  // Bounded (not a bare await): this read runs before the withDeadline-wrapped
  // stages pipeline below, so it has no deadline of its own otherwise -- a
  // stalled query here would strand the lease exactly like the pre-Phase-1
  // checkpoint-load hang. On timeout, fail closed (treat as blocked) rather
  // than risk hammering an upstream that may already be rate-limiting this
  // app; the lease is still released as idle either way.
  const hostCooldown = await boundedStage(
    getHostCooldown(DATA_API_HOST),
    HOST_COOLDOWN_CHECK_DEADLINE_MS,
    "host_cooldown_check",
    { blocked: true, until: null, reason: "cooldown check timed out" },
  );
  if (hostCooldown.blocked) {
    // Bounded via the same cleanup pattern used by the error path below
    // (boundedStage + CLEANUP_RELEASE_DEADLINE_MS): releaseLease is an
    // unbounded Supabase update, and a stalled worker_status write here
    // would otherwise strand this function -- with the cooldown active and
    // nothing else running, that's exactly the "worker never returns"
    // failure mode this whole gate exists to avoid. A timeout still lets
    // the function return promptly; fencing (fence/worker_id match) means a
    // write that eventually lands late is still safe, and the next cycle's
    // own lease acquisition is unaffected either way.
    await boundedStage(
      releaseLease(lease, { state: "idle" }),
      CLEANUP_RELEASE_DEADLINE_MS,
      "cooldown_release_lease",
      undefined,
    );
    return {
      ...base,
      skipped: `${DATA_API_HOST} rate-limit cooldown active${
        hostCooldown.until ? ` until ${hostCooldown.until.toISOString()}` : ""
      }${hostCooldown.reason ? ` (${hostCooldown.reason})` : ""}; deferring to next cycle.`,
    };
  }

  /**
   * Per-stage durations, persisted with the worker row. This is how a slow
   * stage is identified in production instead of guessed at, and why the
   * mark stage could be proven to be the deadline consumer.
   */
  const stageMs: Record<string, number> = {};
  const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await work();
    } finally {
      stageMs[label] = Date.now() - startedAt;
    }
  };

  /**
   * How many source_events THIS poll attempt persisted, regardless of
   * whether the cycle goes on to succeed or fail in a later stage. Stays 0
   * if the cycle never reaches a successful persistEvents() result.
   */
  let cycleEventsInserted = 0;

  // Real cancellation for the one proven-worst-offending call (persistEvents):
  // Promise.race (withDeadline/boundedStage below) never cancels its losing
  // promise, so without this a slow request just keeps running in the
  // background, past when the cycle has already failed and moved on. See
  // persistEvents' own doc comment for the production evidence.
  const cycleAbort = new AbortController();
  const cycleAbortTimer = setTimeout(() => cycleAbort.abort(), EXPERIMENT_DEADLINE_MS);
  try {
    // Bounded so a hung upstream call fails through the normal error path (which
    // releases the lease) instead of being killed with the lease still claimed.
    const stages = await withDeadline(
      (async () => {
        // Bounded so a hung checkpoint load (or the one-time first-run bootstrap
        // write) can no longer strand the lease with no internal recovery: before
        // this was moved inside the deadline race, a hang here left heartbeat_at
        // advancing on lease acquisition but stage_ms/last_error/poll_failures
        // frozen forever, indistinguishable in worker_status from a permanent hang.
        const { data: checkpoint } = await timed("checkpoint_load", async () =>
          supabaseAdmin.from("worker_checkpoints").select("*").eq("id", lockId).maybeSingle(),
        );
        const bootstrapped = checkpoint?.bootstrap_complete ?? false;

        // First ever run: shadow-copy only from go-live onwards.
        if (experiment.follow_from_ts === null) {
          const goLive = Math.floor(Date.now() / 1000);
          await supabaseAdmin
            .from("paper_experiments")
            .update({ follow_from_ts: goLive, updated_at: new Date().toISOString() })
            .eq("id", experiment.id);
          experiment.follow_from_ts = goLive;
          await raiseAlert(
            "info",
            "follower_started",
            "Follower go-live recorded. Earlier fills are stored as history only and are not paper-copied.",
            { follow_from_ts: goLive as never },
          );
        }

        const window = await timed("source_ingest", () =>
          // Real cancellation for source_ingest: the catch-up walk can issue
          // many sequential page requests, so without the cycle signal it kept
          // starting NEW HTTP requests (and retrying in-flight ones) long after
          // the cycle deadline had released the lease -- the same class of bug
          // already fixed for persistEvents/processPendingEvents. Pagination
          // semantics are unchanged; only cancellability is added.
          fetchSourceWindow(
            wallet,
            bootstrapped,
            resolveCatchupBoundary(checkpoint?.last_source_ts, experiment.follow_from_ts),
            cycleAbort.signal,
            tradesCache,
            isGeneralShadowName(experiment.name)
              ? GENERAL_SHADOW_CATCHUP_PAGE_BUDGET
              : undefined,
          ),
        );
        const events = normalizeSourceEvents(window.raw, wallet);
        const inserted = await timed("persist_events", () =>
          persistEvents(events, !isGeneralShadowName(experiment.name), cycleAbort.signal),
        );
        cycleEventsInserted = inserted;
        const process = await timed("paper_processing", () =>
          // Real cancellation for paper_processing: a 300-event batch commits
          // sequentially, so without the signal the loop kept starting NEW
          // event RPCs long after the 40s cycle deadline had already released
          // the lease and let a fresh attempt start -- the same class of bug
          // fixed for persistEvents. Atomicity is unchanged: each event is
          // still one fenced transaction and an aborted one rolls back.
          processPendingEvents(experiment, lease, cycleAbort.signal),
        );
        const marks = await timed("mark_refresh", () =>
          boundedStage(refreshMarks(experiment.id), MARK_REFRESH_DEADLINE_MS, "mark_refresh", {
            updated: 0,
            failed: 0,
          }),
        );
        const reconciliation = await timed("reconciliation", () =>
          inserted > 0 || !bootstrapped
            ? boundedStage(
                reconcile(wallet, { expectAdvance: inserted > 0 }),
                RECONCILE_DEADLINE_MS,
                "reconciliation",
                null,
              )
            : Promise.resolve(null),
        );
        const settlements = await timed("settlement", () =>
          boundedStage(settleSafely(experiment.id), SETTLEMENT_DEADLINE_MS, "settlement", NO_SETTLEMENTS),
        );
        const previews = await timed("previews", () =>
          // General Shadow has no order path at all: the PMUS preview stage is
          // never reached for those experiments.
          isGeneralShadowName(experiment.name)
            ? Promise.resolve(NO_PREVIEWS)
            : boundedStage(
                generatePreviewsSafely(experiment.id, wallet),
                PREVIEW_DEADLINE_MS,
                "previews",
                NO_PREVIEWS,
              ),
        );
        if (isGeneralShadowName(experiment.name)) {
          await timed("general_activity", async () => {
            try {
              const { ingestGeneralActivity } = await import("./general-shadow.server");
              await withDeadline(
                ingestGeneralActivity(wallet),
                GENERAL_ACTIVITY_DEADLINE_MS,
                "general activity",
              );
            } catch {
              // Evidence-only stage: a failure never blocks paper accounting.
            }
          });
        }
        const copyability = await timed("copyability", () =>
          boundedStage(observeCopyabilitySafely(experiment), COPYABILITY_DEADLINE_MS, "copyability", {
            scheduled: 0,
            sampled: 0,
            unavailable: 0,
          }),
        );
        await timed("cash_alerts", () => raiseCashAlerts(experiment));
        return {
          checkpoint,
          window,
          events,
          inserted,
          process,
          marks,
          reconciliation,
          settlements,
          previews,
          copyability,
        };
      })(),
      EXPERIMENT_DEADLINE_MS,
      `${experiment.name} ingest cycle`,
    );
    const {
      checkpoint,
      window,
      events,
      inserted,
      process,
      marks,
      reconciliation,
      settlements,
      previews,
      copyability,
    } = stages;

    const newest = events.length ? Math.max(...events.map((e) => e.sourceTs)) : 0;
    const lagSeconds = newest > 0 ? Math.max(0, Math.round(Date.now() / 1000 - newest)) : null;

    await supabaseAdmin.from("worker_checkpoints").upsert({
      id: lockId,
      wallet,
      last_source_ts: Math.max(newest, checkpoint?.last_source_ts ?? 0),
      last_event_key: events.at(-1)?.eventKey ?? checkpoint?.last_event_key ?? null,
      events_seen: (checkpoint?.events_seen ?? 0) + inserted,
      bootstrap_complete: true,
      updated_at: new Date().toISOString(),
    });

    const { data: statusRow } = await supabaseAdmin
      .from("worker_status")
      .select("events_ingested")
      .eq("id", lockId)
      .maybeSingle();

    await releaseLease(lease, {
      state: "idle",
      last_error: null,
      poll_failures: 0,
      events_ingested: (statusRow?.events_ingested ?? 0) + inserted,
      lag_seconds: lagSeconds,
      last_success_at: new Date().toISOString(),
      stage_ms: stageMs as never,
      last_poll_events_inserted: cycleEventsInserted,
    });

    if (inserted > 0) {
      await raiseAlert("info", "new_source_trades", `${experiment.name}: detected ${inserted} new source trade(s).`, {
        experiment: experiment.name as never,
        buys: process.buys as never,
        sells: process.sells as never,
        skips: process.skips as never,
      });
    }
    if (process.skips > 0) {
      await raiseAlert("info", "paper_copy_skips", `${experiment.name}: skipped ${process.skips} source fill(s).`, {
        experiment: experiment.name as never,
      });
    }

    return {
      ...base,
      skipped: null,
      newEvents: inserted,
      pagesFetched: window.pagesFetched,
      process,
      marks,
      reconciliation,
      lagSeconds,
      previews,
      settlements,
      copyability,
      stageMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    // The cleanup path runs AFTER the cycle budget is already spent, so it gets
    // its own small independent budgets in strict priority order. Releasing the
    // lease must never be blocked by a slow status read or by Telegram.
    const statusRow = await boundedStage(
      (async () => {
        const { data } = await supabaseAdmin
          .from("worker_status")
          .select("poll_failures")
          .eq("id", lockId)
          .maybeSingle();
        return data;
      })(),
      CLEANUP_STATUS_DEADLINE_MS,
      "cleanup_status_read",
      null,
    );
    const failures = (statusRow?.poll_failures ?? 0) + 1;
    await boundedStage(
      releaseLease(lease, {
        state: "error",
        last_error: message,
        poll_failures: failures,
        stage_ms: stageMs as never,
        last_poll_events_inserted: cycleEventsInserted,
      }),
      CLEANUP_RELEASE_DEADLINE_MS,
      "cleanup_release_lease",
      undefined,
    );
    if (failures === 1 || failures % 5 === 0) {
      // Alerting is last and lowest priority: a stalled Telegram delivery can
      // never hold the lease or the worker row hostage. The error itself is
      // already persisted in last_error above, so nothing is suppressed.
      // rateLimited/retryAfterMs are recorded so a future 429 incident can be
      // diagnosed from the alerts table alone, without re-deriving it from
      // the error string.
      await boundedStage(
        raiseAlert("error", "poll_failure", `${experiment.name}: ingestion poll failed: ${message}`, {
          experiment: experiment.name as never,
          failures: failures as never,
          rateLimited: (err instanceof RateLimitedError) as never,
          retryAfterMs: (err instanceof RateLimitedError ? err.retryAfterMs : null) as never,
        }),
        CLEANUP_ALERT_DEADLINE_MS,
        "cleanup_alert",
        undefined,
      );
    }
    throw err;
  } finally {
    clearTimeout(cycleAbortTimer);
  }
}

/* ------------------------------------------------------------------ */
/* Dashboard read model                                               */
/* ------------------------------------------------------------------ */

export type DashboardOpenPosition = {
  asset: string;
  marketTitle: string;
  outcome: string | null;
  shares: number;
  costBasis: number;
  avgPrice: number;
  mark: number | null;
  markSource: string | null;
  markAgeSeconds: number | null;
  openPnl: number | null;
  realizedPnl: number;
};

export async function loadDashboard() {
  const experiment = await getExperiment();
  const workerId = workerIdFor(experiment);
  const nowMs = Date.now();

  const [statusRes, checkpointRes, eventsRes, tradesRes, positionsRes, alertsRes, countsRes] =
    await Promise.all([
      supabaseAdmin.from("worker_status").select("*").eq("id", workerId).maybeSingle(),
      supabaseAdmin.from("worker_checkpoints").select("*").eq("id", workerId).maybeSingle(),
      supabaseAdmin
        .from("source_events")
        .select("*")
        .eq("wallet", TARGET_WALLET)
        .order("source_ts", { ascending: false })
        .limit(300),
      supabaseAdmin
        .from("paper_trades")
        .select("*")
        .eq("experiment_id", experiment.id)
        .order("source_ts", { ascending: false })
        .limit(300),
      supabaseAdmin.from("paper_positions").select("*").eq("experiment_id", experiment.id),
      supabaseAdmin.from("alerts").select("*").order("created_at", { ascending: false }).limit(20),
      supabaseAdmin
        .from("source_events")
        .select("*", { count: "exact", head: true })
        .eq("wallet", TARGET_WALLET),
    ]);

  const status = statusRes.data;

  // Lifetime count comes from source_events (the source of truth). The
  // hand-maintained worker_status.events_ingested counter is not presented
  // as authoritative for that figure.
  const totalEventsPersisted = countsRes.count ?? 0;
  // last_poll_events_inserted is diagnostic telemetry persisted directly by
  // the worker itself (see releaseLease in runExperimentCycle): the exact
  // count persistEvents() returned for the most recently COMPLETED poll
  // attempt, win or lose. Deriving this from first_seen_at >= last_poll_at
  // was structurally wrong — last_poll_at is stamped at cycle END, strictly
  // after that same cycle's own inserts, so the comparison always missed them.
  const lastPollEventsInserted: number | null = status
    ? Number((status as unknown as { last_poll_events_inserted?: number | null }).last_poll_events_inserted ?? 0)
    : null;

  const positions = positionsRes.data ?? [];
  const open: DashboardOpenPosition[] = positions
    .filter((p) => Number(p.shares) > 0)
    .map((p) => {
      const markTs = p.mark_ts ? new Date(p.mark_ts).getTime() : null;
      const age = markTs === null ? null : Math.round((nowMs - markTs) / 1000);
      const fresh = markTs !== null && nowMs - markTs < MARK_MAX_AGE_MS;
      const mark = fresh && p.mark !== null ? Number(p.mark) : null;
      return {
        asset: p.asset,
        marketTitle: p.market_title ?? "Unknown market",
        outcome: p.outcome,
        shares: Number(p.shares),
        costBasis: Number(p.cost_basis),
        avgPrice: Number(p.avg_price),
        mark,
        markSource: mark === null ? null : p.mark_source,
        markAgeSeconds: age,
        openPnl: openPnl(Number(p.shares), Number(p.cost_basis), mark),
        realizedPnl: Number(p.realized_pnl),
      };
    })
    .sort((a, b) => b.costBasis - a.costBasis);

  const closed = positions
    .filter((p) => Number(p.shares) <= 0)
    // Phantom rows from the old write path: never funded, never closed for real.
    .filter(
      (p) =>
        !isPhantomClosedPosition({
          costBasis: Number(p.cost_basis),
          realizedPnl: Number(p.realized_pnl),
        }),
    )
    .map((p) => ({
      asset: p.asset,
      marketTitle: p.market_title ?? "Unknown market",
      outcome: p.outcome,
      realizedPnl: Number(p.realized_pnl),
      settlementStatus: p.settlement_status as string,
      lastActivityTs: p.last_activity_ts ? Number(p.last_activity_ts) : null,
    }))
    .sort((a, b) => (b.lastActivityTs ?? 0) - (a.lastActivityTs ?? 0));

  const openCostBasis = roundUsd(open.reduce((s, p) => s + p.costBasis, 0));
  const markedValue = open.every((p) => p.mark !== null)
    ? roundUsd(open.reduce((s, p) => s + p.shares * (p.mark as number), 0))
    : null;

  const heartbeatAgeSeconds = status?.heartbeat_at
    ? Math.round((nowMs - new Date(status.heartbeat_at).getTime()) / 1000)
    : null;

  return {
    fetchedAt: new Date(nowMs).toISOString(),
    wallet: TARGET_WALLET,
    experiment: {
      id: experiment.id,
      name: experiment.name,
      cohort: isV2Name(experiment.name) ? ("V2" as const) : ("V1" as const),
      startingCash: Number(experiment.starting_cash),
      cash: Number(experiment.cash),
      buyAmount: Number(experiment.buy_amount),
      pollIntervalSeconds: experiment.poll_interval_seconds,
      enabled: experiment.enabled,
      weatherOnly: experiment.weather_only,
      realizedPnl: Number(experiment.realized_pnl),
      followFromTs: experiment.follow_from_ts,
    },
    worker: {
      workerId: status?.worker_id ?? null,
      state: status?.state ?? "stopped",
      heartbeatAt: status?.heartbeat_at ?? null,
      heartbeatAgeSeconds,
      lastSuccessAt: status?.last_success_at ?? null,
      lastPollAt: status?.last_poll_at ?? null,
      lastError: status?.last_error ?? null,
      pollFailures: status?.poll_failures ?? 0,
      lagSeconds: status?.lag_seconds ?? null,
      fence: status?.fence ?? 0,
      bootstrapComplete: checkpointRes.data?.bootstrap_complete ?? false,
      lastSourceTs: checkpointRes.data?.last_source_ts ?? 0,
    },
    totals: {
      totalEventsPersisted,
      lastPollEventsInserted,
      persistedEvents: totalEventsPersisted,
      openPositions: open.length,
      openCostBasis,
      markedValue,
      equity: markedValue === null ? null : roundUsd(Number(experiment.cash) + markedValue),
    },
    events: (eventsRes.data ?? []).map((e) => ({
      id: e.id,
      eventKey: e.event_key,
      asset: e.asset,
      marketTitle: e.market_title,
      outcome: e.outcome,
      slug: e.slug,
      side: e.side as Side,
      shares: Number(e.shares),
      price: Number(e.price),
      sourceTs: Number(e.source_ts),
      firstSeenAt: e.first_seen_at,
      identityBasis: e.identity_basis,
      identityDegraded: e.identity_degraded,
      // Legacy wallet-global processing flags remain visible only as provenance.
      processed: e.processed_at !== null,
      backfilled: e.backfilled ?? false,
      txHash: e.tx_hash,
    })),
    paperTrades: (tradesRes.data ?? []).map((t) => ({
      id: t.id,
      eventKey: t.event_key,
      action: t.action,
      side: t.side,
      asset: t.asset,
      marketTitle: t.market_title ?? "Unknown market",
      outcome: t.outcome,
      price: t.price === null ? null : Number(t.price),
      shares: Number(t.shares),
      notional: Number(t.notional),
      reason: t.reason,
      cashAfter: t.cash_after === null ? null : Number(t.cash_after),
      realizedPnl: Number(t.realized_pnl),
      sourceTs: t.source_ts ? Number(t.source_ts) : null,
      createdAt: t.created_at,
    })),
    open,
    closed,
    alerts: (alertsRes.data ?? []).map((a) => ({
      id: a.id,
      level: a.level,
      kind: a.kind,
      message: a.message,
      createdAt: a.created_at,
      acknowledged: a.acknowledged,
    })),
    degradedIdentityCount: (eventsRes.data ?? []).filter((e) => e.identity_degraded).length,
    sourceCompleteness: {
      status: "COMPLETE AS AVAILABLE FROM PUBLIC API" as const,
      detail: `Public trade history requested with ${TAKER_ONLY_PARAM}, which returns maker and taker fills.`,
    },
  };
}

export type DashboardData = Awaited<ReturnType<typeof loadDashboard>>;
