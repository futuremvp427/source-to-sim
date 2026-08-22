/**
 * Sports Forward Shadow source wallet poller — SERVER (network/DB) orchestration.
 *
 * One bounded, one-shot call per wallet: paginate data-api.polymarket.com/trades for
 * ONE approved wallet, normalize via shadow-core.ts's already-proven
 * `normalizeSourceEvents`, persist every genuinely-new fill as durable evidence, then
 * retry EVERY currently-pending fill for this wallet (freshly inserted this poll, or
 * orphaned by an earlier failure/crash — see the Task 12D / P1-A design below) through
 * Task 3 eligibility and Task 4's pure `decideFill` reducer against durably-reconstructed
 * episode state. Task 11 is expected to invoke `pollSportsShadowWallet` repeatedly (once
 * per wallet per cycle) — this module has no internal loop, no timer, and no daemon of
 * its own.
 *
 * ============================== TASK 12D / P1-A: DURABLE DOWNSTREAM RETRY ==============================
 * ROOT CAUSE (Codex P1 finding): a fill's raw row could be inserted successfully, then
 * fail LATER — metadata lookup, UNVERIFIED metadata, findLatestEpisode, the episode
 * mutation itself — and the ONLY thing a later poll checked was insertRawFill's
 * `inserted: false` (i.e. "the raw row already exists"). That collapsed two genuinely
 * different states into one: "raw evidence persisted" and "downstream processing safely
 * applied" are NOT the same thing, and treating them as one meant a transient failure
 * permanently lost that fill from ever contributing to an episode/signal.
 *
 * FIX: `sports_shadow_source_fills.downstream_status` (see
 * supabase/migrations/20260821040000_sports_shadow_fill_retry_and_fairness.sql) makes
 * the two states independently durable. Every poll now has two phases: (1) insert every
 * genuinely-new fill as before (default downstream_status = PENDING, dedup semantics on
 * the raw insert itself are UNCHANGED); (2) query EVERY currently-PENDING fill for this
 * wallet — bounded, oldest source_ts first — and run it through classification +
 * decideFill, exactly like the pre-Task-12D inline loop did, except the DB write that
 * "commits" a fill's outcome now happens ONLY through insertEpisodeAtomic /
 * updateEpisodeAtomic (see below), which the migration proves atomically pairs the
 * episode mutation with marking that exact fill COMPLETE in one transaction.
 *
 * HARD DESIGN GATE — why a fill can never be applied twice, even across a crash:
 *   a. raw fill exists (downstream_status = PENDING)
 *   b. episode aggregation is COMPUTED (decideFill runs, produces nextState)
 *   c. the atomic RPC call that would commit nextState + mark this fill COMPLETE either
 *      fully commits or the process crashes before/during it
 *   d. if it crashed: NEITHER the episode mutation NOR the completion marker landed —
 *      Postgres rolled back the whole (single-function-call) transaction
 *   e. the next worker's retry re-reads episode state fresh via findLatestEpisode, sees
 *      the SAME prior state as before (because nothing from the crashed attempt
 *      persisted), recomputes the IDENTICAL decideFill result, and this time either
 *      commits cleanly (episode mutated + fill COMPLETE together) or crashes again with
 *      the same all-or-nothing guarantee
 * There is no reachable intermediate state where the episode was mutated but the fill is
 * still PENDING — by construction, not by convention. This relies on wallet polling
 * being serialized by Task 11's SOURCE_LOCK_ID lease (only one worker ever calls
 * pollSportsShadowWallet for a given wallet at a time); true concurrent double-processing
 * of the same wallet was already out of scope for the rest of Task 10/11.
 *
 * Terminal classification (a fill's OWN immutable data will never produce a different
 * outcome on retry, so it is safe to stop retrying it):
 *   - missing conditionId, or metadata.status === "INELIGIBLE"  -> TERMINAL_INELIGIBLE
 *   - decideFill returns INVALID_FILL (shares/price/side already violate its own
 *     invariants; those values never change once persisted)                -> TERMINAL_INVALID
 *   - metadata.status === "UNVERIFIED" (or a metadata fetch throws)  -> STAYS PENDING.
 *     Per the mission's explicit instruction, temporary uncertainty is never silently
 *     treated as permanently processed — Task 3's UNVERIFIED reason-code vocabulary
 *     mixes genuinely transient causes (fetch failure, malformed/empty response) with
 *     causes that happen to also be permanent in practice (ambiguous period, unknown
 *     team) without a cheap, already-proven way to tell them apart here; retrying a
 *     permanently-ambiguous market is bounded wasted work, not a correctness bug,
 *     whereas terminally dropping a transient one would be.
 *   - pre-go-live suppression (isEligibleForEpisodeTrigger === false)  -> COMPLETE. This
 *     is the historically-correct, final answer for that exact fill: goLiveAtMs is fixed
 *     and durable (Task 10), and (as of Task 12E / P1-F below) the decision depends ONLY
 *     on the fill's own immutable sourceTs vs. that fixed boundary — never on
 *     wallet-history state — so re-evaluating it on a later retry always reproduces the
 *     identical answer. Marking it COMPLETE here is a bounded-work optimization (stop
 *     retrying a fill whose answer can never change), not a correctness requirement.
 *
 * ============================== TASK 12E / P1-F: IMMUTABLE GO-LIVE DECISION ==============================
 * ROOT CAUSE (Codex P1 finding): isEligibleForEpisodeTrigger used to take an `isBootstrap`
 * flag and return `true` unconditionally once it was false. `isBootstrap` is recomputed
 * fresh every poll from `hasAnyFillsForWallet` — NOT an immutable property of any one
 * fill. A pre-go-live fill left PENDING (e.g. past MAX_PENDING_FILLS_PER_POLL, or a
 * transient markFillComplete failure) could therefore be retried on a later poll, once
 * the wallet had accrued unrelated history, and wrongly become eligible — the SAME fill
 * producing a DIFFERENT answer depending purely on when it happened to be retried.
 *
 * FIX: isEligibleForEpisodeTrigger(sourceTs, goLiveAtMs) now compares two immutable,
 * durable values only — no wallet-history flag. Truth table (verified by
 * source-poll.test.ts and this file's own P1-F integration tests):
 *   sourceTs  < goLiveAt                          -> NEVER eligible, on any retry/restart
 *   sourceTs == goLiveAt                           -> ELIGIBLE (inclusive boundary)
 *   sourceTs  > goLiveAt                           -> ELIGIBLE, on any retry/restart
 *   first bootstrap poll                           -> same pure rule, no special case
 *   later retry of a durably-PENDING fill          -> identical answer (sourceTs/goLiveAtMs unchanged)
 *   process restart                                -> identical answer (goLiveAtMs re-parsed from the same static config)
 *   pre-go-live fill beyond the pending cap         -> stays ineligible forever
 *   post-go-live fill recovered after worker downtime -> eligible regardless of how late it's discovered
 * ================================================================================
 *   - DUPLICATE_FILL, or SELL_RECORDED with no matching open episode  -> COMPLETE
 *     (single fill-only write, safe alone: either the aggregation is already reflected
 *     elsewhere, or there is genuinely nothing durable left to do for a SELL against no
 *     tracked position).
 *   - a network/DB failure at any step (metadata fetch, findLatestEpisode, the atomic
 *     RPC itself)  -> STAYS PENDING, retried next poll.
 *
 * Never imports pmus.ts/kalshi.ts/resolver.ts/observation.ts/depth-walk.ts — target-venue
 * matching and quote capture are explicitly out of scope here; Task 11 wires this
 * module's `newSignals` output into Task 8's `persistVenueMatch`.
 *
 * All network, DB, and clock access is dependency-injected (see WalletPollDeps) so tests
 * never touch a real database, network, or wall clock.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import {
  DATA_API_HOST,
  DeadlineExceededError,
  getHostCooldown,
  parseRetryAfterMs,
  recordHostRateLimit,
  reserveRequestSlot,
} from "../http-rate-limit.server";
import { buildTradesUrl, MAX_TRADES_OFFSET, PAGE_SIZE } from "../shadow.server";
import { normalizeSourceEvents, type NormalizedEvent, type RawTrade } from "../shadow-core";
import { classifyUnverifiedDisposition, type UnverifiedReasonCode } from "./eligibility";
import { decideFill, type EligibleFill, type OpenEpisodeState } from "./episode";
import { computeClusterKey } from "./independence";
import { runtimeFetch } from "./runtime-fetch.server";
import { fetchSourceMarketMetadata } from "./source-metadata.server";
import { isEligibleForEpisodeTrigger } from "./source-poll";
import { NO_OP_LEASE_CHECKPOINT, type LeaseCheckpoint } from "./sports-lease.server";
import type { BetType, SourceMarketMetadata } from "./types";

/**
 * Bounded to exactly the provider's own offset ceiling (see MAX_TRADES_OFFSET's doc
 * comment in shadow.server.ts): 40 pages * 250/page = 10,000, the last offset the public
 * Data API will serve for /trades before returning HTTP 400. A wallet whose entire
 * unread backlog exceeds this in one poll cannot be fully covered by a single call —
 * `backlogTruncated` reports that explicitly rather than silently dropping older history.
 */
export const MAX_PAGES_PER_WALLET = Math.floor(MAX_TRADES_OFFSET / PAGE_SIZE) + 1;

/** Bounded per-poll cap on how many currently-PENDING fills are retried in phase 2 — generous relative to expected per-wallet volume, but never unbounded. Excess pending work simply stays durable for a later poll, exactly like Task 11B's pending-signal batch. */
export const MAX_PENDING_FILLS_PER_POLL = 500;

/**
 * ============ SOAK INCIDENT (2026-08-22): PHASE-2 DOWNSTREAM RESERVE ============
 * PROVEN production failure: Phase 1 (trade-page pagination + persistence) consumed the
 * whole poll deadline while catching up a heavy backlog, so the Phase-2 deadline guard
 * below tripped immediately on every single poll. Durably-PENDING fills therefore never
 * reached classification/episode creation at all -- not "delayed", starved indefinitely,
 * and the pending backlog only grew.
 *
 * FIX: Phase 1 now stops at `deadlineAtMs - PHASE2_DOWNSTREAM_RESERVE_MS`, leaving a
 * structurally guaranteed slice of every poll for draining durable pending work. Phase 2
 * still uses the FULL `deadlineAtMs`. Nothing about Phase 1's stop semantics changes: an
 * interrupted scan is still discarded rather than partially trusted (backlogTruncated),
 * and unprocessed pending fills still simply stay PENDING.
 * ================================================================================
 */
export const PHASE2_DOWNSTREAM_RESERVE_MS = 8_000;

/**
 * RECONCILIATION FIX (2026-08-22): the original version of this function subtracted
 * PHASE2_DOWNSTREAM_RESERVE_MS from `deadlineAtMs` UNCONDITIONALLY, with no floor. When a
 * caller's remaining window (`deadlineAtMs - nowMs`) is already smaller than the reserve
 * itself -- a real case, not just a test artifact: a LATER wallet in runSourceLane's
 * rotation can reach `pollSportsShadowWallet` with only a few seconds left before the
 * shared worker-level ingest deadline -- the unconditional subtraction pushed the ingest
 * cutoff BEFORE `nowMs`, giving Phase 1 zero opportunity even though real time remained.
 * Confirmed via 5 failing tests in this file that all passed a short (~500ms) deadline
 * window and got `pagesFetched: 0` / episode-mutation timing changes they did not expect.
 *
 * FIX: only reserve the fixed floor when the window is large enough to have that much
 * slack to spare. When the window is already at or below the reserve, ingestion gets the
 * WHOLE remaining window (identical to this file's pre-reserve behavior) rather than a
 * negative one -- Phase 2 then gets whatever (possibly zero) time is left after Phase 1's
 * natural stop, exactly like every deadline-exhaustion case already handled elsewhere in
 * this file (left PENDING, safely retryable, never fabricated).
 */
export function phase1IngestDeadline(deadlineAtMs: number, nowMs: number): number {
  if (!Number.isFinite(deadlineAtMs)) return deadlineAtMs;
  if (deadlineAtMs - nowMs <= PHASE2_DOWNSTREAM_RESERVE_MS) return deadlineAtMs;
  return deadlineAtMs - PHASE2_DOWNSTREAM_RESERVE_MS;
}

/**
 * FINAL BUILD Part 2 (closes the Task 13G-documented degraded-tuple liveness residual):
 * `countDurableOrdinalFills` used to issue one `count:"exact",head:true` `.like()` query
 * PER distinct tuple prefix, chunked concurrently at a fixed cap with a deadline check
 * BETWEEN chunks -- correct, but a page with more distinct prefixes than the shared
 * deadline allowed chunks for could repeatedly fail to fully reconcile. The new
 * `count_durable_ordinal_fills` RPC (see
 * supabase/migrations/20260823070000_sports_shadow_tuple_prefix.sql) groups by the new
 * indexed, GENERATED `tuple_prefix` column server-side, so an ENTIRE page's distinct
 * prefixes are now counted in exactly ONE bounded round trip regardless of how many
 * there are -- no chunking, no per-chunk deadline loop, no starvation possible.
 */


const REQUEST_TIMEOUT_MS = 12_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* Paced network fetch                                                 */
/* ------------------------------------------------------------------ */

export type SourcePollNetworkDeps = {
  fetchImpl: typeof fetch;
  /** Task 13I / P1-T: `deadlineAtMs` optional, forwarded from pacedFetchTradesPage -- see http-rate-limit.server.ts's own doc comment for exactly what it changes. */
  reserveRequestSlot: (host: string, deadlineAtMs?: number) => Promise<number>;
  getHostCooldown: (host: string) => Promise<{ blocked: boolean; reason: string | null }>;
  recordHostRateLimit: (host: string, retryAfterMs: number | null) => Promise<void>;
};

const defaultNetworkDeps: SourcePollNetworkDeps = {
  // Task 13E: never the bare `fetch` reference -- see runtime-fetch.server.ts's doc
  // comment for why that breaks in Cloudflare Workers (confirmed live in production).
  fetchImpl: runtimeFetch,
  reserveRequestSlot,
  getHostCooldown,
  recordHostRateLimit,
};

/**
 * Fails CLOSED and EXPLICITLY (throws) on cooldown, reservation failure, timeout,
 * non-2xx, or a non-array body — mirrors pmus.server.ts/kalshi.server.ts's `pacedGetJson`
 * exactly. shadow.server.ts's own `getJson` is private/not exported and tightly coupled
 * to its checkpoint model, so this is a small, deliberately independent fetcher against
 * the SAME shared host budget (`DATA_API_HOST`), reusing only `buildTradesUrl` — the URL
 * shape that is already the proven production contract for this endpoint.
 */
async function pacedFetchTradesPage(
  wallet: string,
  offset: number,
  deps: SourcePollNetworkDeps,
  deadlineAtMs: number = Number.POSITIVE_INFINITY,
  now: () => number = Date.now,
  /**
   * CODEX P1-1: the SAME `end` timestamp parameter shadow.server.ts's own
   * fetchUntilCheckpointCovered already uses in production to walk successive time
   * windows once the /trades offset ceiling is reached within one window -- never an
   * invented/unsupported parameter. Undefined (default) preserves the exact prior
   * behavior (paginate "now" backward with no window boundary).
   */
  endTs?: number,
): Promise<RawTrade[]> {
  if (now() >= deadlineAtMs) {
    throw new DeadlineExceededError(`${DATA_API_HOST} request skipped: caller deadline already reached`);
  }
  const cooldown = await deps.getHostCooldown(DATA_API_HOST);
  if (cooldown.blocked) throw new Error(`${DATA_API_HOST} is in cooldown: ${cooldown.reason ?? "unknown reason"}`);
  if (now() >= deadlineAtMs) {
    throw new DeadlineExceededError(`${DATA_API_HOST} request skipped: caller deadline reached after cooldown check`);
  }

  // reserveRequestSlot itself throws DeadlineExceededError if the RPC would run past
  // deadlineAtMs, or if a genuinely granted wait would land at/after it.
  const waitMs = await deps.reserveRequestSlot(DATA_API_HOST, deadlineAtMs === Number.POSITIVE_INFINITY ? undefined : deadlineAtMs);
  if (waitMs > 0) await sleep(waitMs);
  if (now() >= deadlineAtMs) {
    throw new DeadlineExceededError(`${DATA_API_HOST} request skipped: caller deadline reached after pacing wait`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = buildTradesUrl(PAGE_SIZE, offset, wallet, endTs);
    const response = await deps.fetchImpl(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (response.status === 429) {
      // Task 13I / P1-T (Codex re-review): see pmus.server.ts's pacedGetJson for the full
      // rationale -- recordHostRateLimit is a NEW post-fetch operation with its own
      // up-to-5s bound; skip it once the deadline is already gone rather than silently
      // stacking it on top of the already-accepted fetch overrun. `deadlineAtMs` defaults
      // to Number.POSITIVE_INFINITY here, so this is always true for callers with no
      // deadline at all -- exact prior behavior preserved.
      if (now() < deadlineAtMs) {
        await deps.recordHostRateLimit(DATA_API_HOST, parseRetryAfterMs(response.headers.get("retry-after")));
      }
      throw new Error(`${DATA_API_HOST} rate limited (429) on /trades offset=${offset}`);
    }
    if (!response.ok) {
      throw new Error(`${DATA_API_HOST} request failed (HTTP ${response.status}) on /trades offset=${offset}`);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw new Error(`${DATA_API_HOST} /trades response was not valid JSON: ${err instanceof Error ? err.message : "unknown"}`);
    }
    if (!Array.isArray(json)) throw new Error(`${DATA_API_HOST} /trades returned a non-array response`);
    return json as RawTrade[];
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Repository (DI) — the ONLY thing that talks to Postgres              */
/* ------------------------------------------------------------------ */

export type RawFillRow = {
  eventKey: string;
  wallet: string;
  walletHandle: string | null;
  conditionId: string | null;
  asset: string;
  marketTitle: string;
  outcome: string | null;
  eventSlug: string | null;
  marketSlug: string | null;
  side: "BUY" | "SELL";
  shares: number;
  price: number;
  sourceTs: number;
  identityBasis: string;
  identityDegraded: boolean;
  raw: unknown;
};

export type InsertFillResult = { id: string; inserted: boolean };

/** Task 13G / P1-R: batched form of InsertFillResult, one entry per input row, same order. */
export type BatchInsertFillResult = { eventKey: string; id: string; inserted: boolean };

export type EpisodeCacheEntry = { id: string; state: OpenEpisodeState };

export type NewSignalRow = {
  episodeKey: string;
  wallet: string;
  walletHandle: string | null;
  conditionId: string;
  asset: string;
  firstFillAtIso: string;
  lastFillAtIso: string;
  vwap: number;
  shares: number;
  notional: number;
  fillCount: number;
  sellSeen: boolean;
  league: string;
  scheduledStartAt: string | null;
  awayTeam: string | null;
  homeTeam: string | null;
  betType: BetType;
  selectedSide: string;
  line: number | null;
  sourceEventSlug: string | null;
  sourceMarketSlug: string | null;
  sourceOutcome: string | null;
  /** FINAL BUILD Part 17/analytics: the current experiment epoch at insert time, or null when ensureCurrentEpoch failed this cycle (best-effort -- collection must never block on epoch bookkeeping). */
  experimentEpochId: string | null;
};

/** A durably-persisted fill whose downstream (classification + episode) processing has not yet safely completed. Reconstructed entirely from already-stored columns — never re-fetched from the source API. */
export type PendingDownstreamFillRow = {
  id: string;
  eventKey: string;
  walletHandle: string | null;
  conditionId: string | null;
  asset: string;
  outcome: string | null;
  eventSlug: string | null;
  marketSlug: string | null;
  side: "BUY" | "SELL";
  shares: number;
  price: number;
  sourceTs: number;
};

/**
 * ============ RECONCILIATION FIX (2026-08-22): PENDING-FILL HEAD-OF-LINE BLOCKING ============
 * findPendingDownstreamFills was a strict `ORDER BY source_ts ASC LIMIT
 * MAX_PENDING_FILLS_PER_POLL` query. Production accumulated 31,000+ historical PENDING
 * rows well before go-live; a large old backlog dominated by non-MLB/unverified rows can
 * occupy every one of the bounded batch's 500 slots on every single poll, indefinitely
 * hiding freshly-arrived, genuinely eligible (e.g. MLB) fills that happened to be
 * inserted AFTER that backlog -- oldest-first fairness for the historical backlog, but
 * zero forward liveness for new work, forever, as long as the backlog stays large.
 *
 * FIX: split the bounded batch into two independently-queried, deterministic slices --
 * PENDING_FILLS_OLDEST_SHARE rows oldest-first (preserves forward progress on the
 * historical backlog, unchanged from before) and the remainder newest-first (guarantees
 * freshly-arrived work is ALWAYS represented in the batch regardless of backlog size) --
 * then merge them back into a single oldest-to-newest, de-duplicated list. This is a
 * pure, deterministic function of the two already-bounded query results: no in-memory
 * toggle/alternation state (which would reset on restart and be unfair across
 * concurrent/restarted workers), no profitability- or sport-based prioritization, and no
 * change to HOW any individual fill is classified -- only WHICH rows this poll's Phase 2
 * looks at. A duplicate wallet cursor scenario simply means the merge's own dedupe (by
 * `id`) drops the repeat; a small total backlog (smaller than the combined slice size)
 * degenerates to plain oldest-first behavior, unchanged from before this fix.
 * ================================================================================
 */
export const PENDING_FILLS_OLDEST_SHARE = 350;
export const PENDING_FILLS_NEWEST_SHARE = MAX_PENDING_FILLS_PER_POLL - PENDING_FILLS_OLDEST_SHARE;

/**
 * Pure merge so the fairness property is directly unit-testable without a real Supabase
 * round trip. `oldestRows` must already be oldest-first; `newestRows` must already be
 * newest-first (i.e. exactly the shape each of the two underlying queries returns) --
 * reversed back to chronological order here, with any row already present in
 * `oldestRows` dropped so a small total backlog (full overlap between the two slices)
 * never processes the same fill twice in one poll.
 */
export function mergePendingFillSlices<T extends { id: string }>(oldestRows: readonly T[], newestRows: readonly T[]): T[] {
  const seen = new Set(oldestRows.map((r) => r.id));
  const dedupedNewest = [...newestRows].reverse().filter((r) => !seen.has(r.id));
  return [...oldestRows, ...dedupedNewest];
}

export type PollRepository = {
  hasAnyFillsForWallet(wallet: string): Promise<boolean>;
  findExistingEventKeys(wallet: string, eventKeys: string[]): Promise<Set<string>>;
  insertRawFill(row: RawFillRow): Promise<InsertFillResult>;
  /**
   * Task 13G / P1-R: batched equivalent of `insertRawFill`, same idempotent
   * onConflict(event_key)/ignoreDuplicates semantics, one result per input row in the
   * same order. Exists purely to bound the number of sequential DB round trips for a
   * large genuinely-new batch — no schema change, same table, same dedup contract.
   */
  insertRawFillsBatch(rows: RawFillRow[]): Promise<BatchInsertFillResult[]>;
  /**
   * For tx_hash_ordinal (degraded) identity reconciliation ONLY — see the
   * STABLE EVENT-KEY WINDOW-SHIFT AUDIT doc comment above
   * `reconcileDegradedEvents`. Counts, per raw economic tuple (the "ord:...#"
   * prefix, ordinal digits excluded), how many rows already durably exist for
   * this wallet — queried fresh against the database every call, never
   * cached, never derived from any single poll's own batch.
   */
  /**
   * `deadline` (optional): if provided, checked BETWEEN this bounded read's own internal
   * pages -- see the real implementation's doc comment for why the total candidate set is
   * now naturally small regardless of wallet history size, but a caller-supplied deadline
   * still takes priority over finishing every page.
   */
  countDurableOrdinalFills(wallet: string, tuplePrefixes: string[], deadline?: { now: () => number; deadlineAtMs: number }): Promise<Map<string, number>>;
  /** Most recent episode (by source_last_fill_at) for this exact position, if any. */
  findLatestEpisode(wallet: string, conditionId: string, asset: string): Promise<EpisodeCacheEntry | null>;
  /** Bounded, oldest-source_ts-first: every fill for this wallet whose downstream processing has not yet safely completed. Includes fills inserted THIS poll and any orphaned by an earlier failure/crash — see this module's Task 12D/P1-A doc comment. */
  findPendingDownstreamFills(wallet: string, limit: number): Promise<PendingDownstreamFillRow[]>;
  /** Atomically inserts the new episode row AND marks fillId's downstream_status COMPLETE in one transaction. */
  insertEpisodeAtomic(fillId: string, row: NewSignalRow): Promise<{ id: string }>;
  /**
   * Atomically updates the existing episode's aggregate fields AND marks fillId's
   * downstream_status COMPLETE in one transaction. `sellEvent`, when provided (a
   * SELL_RECORDED update against a KNOWN open episode), ALSO atomically inserts the
   * individual auditable sell-event row in the SAME transaction (FINAL BUILD Part 5/14)
   * -- omitted entirely for a plain BUY aggregation update (AGGREGATED_BUY/
   * LATE_RECONCILIATION), which never touches the sell ledger.
   */
  updateEpisodeAtomic(fillId: string, signalId: string, state: OpenEpisodeState, sellEvent?: { shares: number; price: number; notional: number; sourceTs: number }): Promise<void>;
  /** FINAL BUILD Part 5: records a sell fill with NO known forward open position (pre-epoch/untracked -- Part 5's explicit case) and marks the fill COMPLETE, atomically. Never fabricates a signal_id. */
  recordPreEpochSell(fillId: string, shares: number, price: number, notional: number, sourceTs: number): Promise<void>;
  /** Marks a fill COMPLETE with no paired episode mutation — safe as a lone single-table write (see this module's terminal-classification doc comment). */
  markFillComplete(fillId: string): Promise<void>;
  /** Marks a fill permanently terminal — its own immutable data will never produce a different outcome on retry. */
  markFillTerminal(fillId: string, status: "TERMINAL_INELIGIBLE" | "TERMINAL_INVALID"): Promise<void>;
  /** Task 12F / P1-H: marks a fill TERMINAL_UNVERIFIED, durably retaining the exact classifier reason code for later audit/accounting -- distinct from TERMINAL_INELIGIBLE (a positive ineligibility determination) since "could not verify" and "determined ineligible" remain different outcomes. */
  markFillTerminalUnverified(fillId: string, reasonCode: UnverifiedReasonCode): Promise<void>;
  /**
   * CODEX P1-1: durable per-wallet source-coverage watermark. `null` means no row exists
   * yet -- the real (supabasePollRepository) implementation's caller treats that as "not
   * yet proven," forcing one genuine verification pass. See the migration's own doc
   * comment (20260825010000_sports_shadow_wallet_source_coverage.sql) for the full model.
   */
  getWalletCoverage(wallet: string): Promise<{ coveredThroughTs: number | null; coverageComplete: boolean } | null>;
  /** Best-effort durable upsert of the coverage watermark -- a failure here must never fail the poll (see its call site's own try/catch); at worst, the next poll re-verifies a range it did not strictly need to. */
  upsertWalletCoverage(wallet: string, coveredThroughTs: number | null, coverageComplete: boolean): Promise<void>;
};

type RawPendingFillRow = {
  id: string;
  event_key: string;
  wallet_handle: string | null;
  condition_id: string | null;
  asset: string;
  outcome: string | null;
  event_slug: string | null;
  market_slug: string | null;
  side: "BUY" | "SELL";
  shares: number;
  price: number;
  source_ts: number;
};

/**
 * Real Supabase-backed repository. Table names cast `as never` — same established
 * pattern as http-rate-limit.server.ts / observation.server.ts — since generated
 * Supabase types lag this unapplied migration.
 *
 * SCHEMA GATE limitation (documented, non-blocking): `sports_shadow_signals` has only
 * `source_sell_seen boolean`, no `first_sell_at`/`last_sell_at`/`sell_count` columns.
 * OpenEpisodeState's three sell-detail fields are therefore never durably round-tripped
 * — reconstructed as null/0 on load, and never written back. This does not affect
 * `decideFill`'s branching (those fields are pure evidence, never read for a decision),
 * only their own future value, which the DB cannot represent yet.
 */
export const supabasePollRepository: PollRepository = {
  async hasAnyFillsForWallet(wallet) {
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_source_fills" as never)
      .select("id")
      .eq("wallet", wallet)
      .limit(1);
    if (error) throw new Error(error.message);
    return ((data as unknown[] | null)?.length ?? 0) > 0;
  },

  async findExistingEventKeys(wallet, eventKeys) {
    if (eventKeys.length === 0) return new Set();
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_source_fills" as never)
      .select("event_key")
      .eq("wallet", wallet)
      .in("event_key", eventKeys);
    if (error) throw new Error(error.message);
    return new Set(((data as unknown as { event_key: string }[] | null) ?? []).map((r) => r.event_key));
  },

  async insertRawFill(row) {
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_source_fills" as never)
      .upsert(
        {
          event_key: row.eventKey,
          wallet: row.wallet,
          wallet_handle: row.walletHandle,
          condition_id: row.conditionId,
          asset: row.asset,
          market_title: row.marketTitle,
          outcome: row.outcome,
          event_slug: row.eventSlug,
          market_slug: row.marketSlug,
          side: row.side,
          shares: row.shares,
          price: row.price,
          source_ts: row.sourceTs,
          identity_basis: row.identityBasis,
          identity_degraded: row.identityDegraded,
          raw: row.raw,
        } as never,
        { onConflict: "event_key", ignoreDuplicates: true },
      )
      .select("id");
    if (error) throw new Error(error.message);
    const inserted = (data as unknown as { id: string }[] | null) ?? [];
    if (inserted.length > 0) return { id: inserted[0]!.id, inserted: true };
    // Conflict path: the row already existed (a concurrent poller or a pre-filter miss).
    const { data: existing, error: selectError } = await supabaseAdmin
      .from("sports_shadow_source_fills" as never)
      .select("id")
      .eq("event_key", row.eventKey)
      .single();
    if (selectError) throw new Error(selectError.message);
    return { id: (existing as unknown as { id: string }).id, inserted: false };
  },

  async insertRawFillsBatch(rows) {
    if (rows.length === 0) return [];
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_source_fills" as never)
      .upsert(
        rows.map((row) => ({
          event_key: row.eventKey,
          wallet: row.wallet,
          wallet_handle: row.walletHandle,
          condition_id: row.conditionId,
          asset: row.asset,
          market_title: row.marketTitle,
          outcome: row.outcome,
          event_slug: row.eventSlug,
          market_slug: row.marketSlug,
          side: row.side,
          shares: row.shares,
          price: row.price,
          source_ts: row.sourceTs,
          identity_basis: row.identityBasis,
          identity_degraded: row.identityDegraded,
          raw: row.raw,
        })) as never,
        { onConflict: "event_key", ignoreDuplicates: true },
      )
      .select("id, event_key");
    if (error) throw new Error(error.message);
    // Task 13G / P1-R (Codex re-review, P1): unlike insertRawFill's single-row conflict
    // fallback, NO second lookup is issued for rows that already existed. The caller
    // (pollSportsShadowWallet's Phase 1 persist loop) never reads `.id` for an
    // `inserted: false` result — it is only used to add a freshly-inserted row's id to
    // `insertedThisPoll` — so the extra round trip was pure overhead with no consumer, and
    // (per Codex's finding) a real unbounded-by-deadline DB operation the timing contract
    // never accounted for. Removing it is a strict improvement, not a deadline workaround.
    const insertedByKey = new Map(
      ((data as unknown as { id: string; event_key: string }[] | null) ?? []).map((r) => [r.event_key, r.id]),
    );
    return rows.map((row) => {
      const insertedId = insertedByKey.get(row.eventKey);
      if (insertedId) return { eventKey: row.eventKey, id: insertedId, inserted: true };
      return { eventKey: row.eventKey, id: "", inserted: false };
    });
  },

  async countDurableOrdinalFills(wallet, tuplePrefixes, deadline) {
    const out = new Map<string, number>();
    if (tuplePrefixes.length === 0) return out;
    for (const prefix of tuplePrefixes) out.set(prefix, 0);
    // FINAL BUILD Part 2: a deadline already gone before this call even starts still
    // defers every requested prefix (Number.POSITIVE_INFINITY sentinel, unchanged
    // contract -- see reconcileDegradedEvents's own handling of this value below).
    if (deadline && deadline.now() >= deadline.deadlineAtMs) {
      for (const prefix of tuplePrefixes) out.set(prefix, Number.POSITIVE_INFINITY);
      return out;
    }
    // Task 13G (Codex re-review rounds 3-7, P1) narrated the failure of four prior
    // per-prefix designs (unbounded per-prefix queries, an unpaged read truncated by
    // PostgREST's row cap, a paginated read still unbounded over a wallet's lifetime, and
    // an exact-key `.in()` filter whose URL could reach hundreds of thousands of
    // characters) -- see git history for the full account. FINAL BUILD Part 2 replaces
    // the per-prefix-chunked-with-a-deadline-loop fix those rounds converged on with a
    // single grouped, exact, bounded RPC (`count_durable_ordinal_fills`, see
    // supabase/migrations/20260823070000_sports_shadow_tuple_prefix.sql): the new
    // GENERATED `tuple_prefix` column lets Postgres itself GROUP BY prefix server-side,
    // so an entire page's distinct prefixes are counted in exactly ONE round trip
    // regardless of count -- an RPC call is a JSON POST body, not a URL query string, so
    // the `.in()` design's URL-length failure mode does not apply here. This closes the
    // "same page can retry forever" liveness hole: there is no longer a per-poll ceiling
    // on how many distinct prefixes one page's reconciliation can cover.
    const { data, error } = await supabaseAdmin.rpc(
      "count_durable_ordinal_fills" as never,
      { p_wallet: wallet, p_tuple_prefixes: tuplePrefixes } as never,
    );
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as unknown as { tuple_prefix: string; fill_count: number }[]) {
      out.set(row.tuple_prefix, row.fill_count);
    }
    return out;
  },

  async findLatestEpisode(wallet, conditionId, asset) {
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_signals" as never)
      .select(
        "id, episode_key, source_first_fill_at, source_last_fill_at, source_vwap, source_shares, source_notional, source_fill_count, source_sell_seen, source_sell_shares, source_sell_notional, sports_shadow_source_fills!first_fill_id(event_key)",
      )
      .eq("source_wallet", wallet)
      .eq("source_condition_id", conditionId)
      .eq("source_asset", asset)
      .order("source_last_fill_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    type Row = {
      id: string;
      episode_key: string;
      source_first_fill_at: string;
      source_last_fill_at: string;
      source_vwap: number;
      source_shares: number;
      source_notional: number;
      source_fill_count: number;
      source_sell_seen: boolean;
      source_sell_shares: number;
      source_sell_notional: number;
      sports_shadow_source_fills: { event_key: string } | null;
    };
    const row = data as unknown as Row;
    const anchorEventKey = row.sports_shadow_source_fills?.event_key ?? "";
    return {
      id: row.id,
      state: {
        episodeKey: row.episode_key,
        anchorEventKey,
        wallet,
        conditionId,
        asset,
        firstBuyAt: Math.floor(new Date(row.source_first_fill_at).getTime() / 1000),
        lastFillAt: Math.floor(new Date(row.source_last_fill_at).getTime() / 1000),
        vwap: row.source_vwap,
        totalShares: row.source_shares,
        totalNotional: row.source_notional,
        buyFillCount: row.source_fill_count,
        sellSeen: row.source_sell_seen,
        firstSellAt: null,
        lastSellAt: null,
        sellCount: 0,
        sellShares: row.source_sell_shares,
        sellNotional: row.source_sell_notional,
        triggered: true,
        processedEventKeys: new Set(anchorEventKey ? [anchorEventKey] : []),
      },
    };
  },

  async findPendingDownstreamFills(wallet, limit) {
    const oldestShare = Math.min(PENDING_FILLS_OLDEST_SHARE, limit);
    const newestShare = Math.max(0, limit - oldestShare);
    const baseQuery = () =>
      supabaseAdmin
        .from("sports_shadow_source_fills" as never)
        .select("id, event_key, wallet_handle, condition_id, asset, outcome, event_slug, market_slug, side, shares, price, source_ts")
        .eq("wallet", wallet)
        .eq("downstream_status", "PENDING");

    // CODEX P2-1: `id` is a deterministic, total-order tie-breaker for rows sharing an
    // identical source_ts (a real case, not merely theoretical -- e.g. bulk-imported or
    // degraded-identity history). Each slice's tie-break direction matches its own primary
    // direction so both remain a consistent, deterministic partition of the SAME total
    // order, ensuring repeated/restarted polling makes identical, converging progress
    // rather than risking an arbitrary subset of a tied group winning forever.
    const [oldest, newest] = await Promise.all([
      baseQuery().order("source_ts", { ascending: true }).order("id", { ascending: true }).limit(oldestShare),
      newestShare > 0
        ? baseQuery().order("source_ts", { ascending: false }).order("id", { ascending: false }).limit(newestShare)
        : Promise.resolve({ data: [] as unknown[], error: null }),
    ]);
    if (oldest.error) throw new Error(oldest.error.message);
    if (newest.error) throw new Error(newest.error.message);

    const toRow = (r: RawPendingFillRow): PendingDownstreamFillRow => ({
      id: r.id,
      eventKey: r.event_key,
      walletHandle: r.wallet_handle,
      conditionId: r.condition_id,
      asset: r.asset,
      outcome: r.outcome,
      eventSlug: r.event_slug,
      marketSlug: r.market_slug,
      side: r.side,
      shares: r.shares,
      price: r.price,
      sourceTs: r.source_ts,
    });
    const oldestRows = ((oldest.data ?? []) as unknown as RawPendingFillRow[]).map(toRow);
    const newestRows = ((newest.data ?? []) as unknown as RawPendingFillRow[]).map(toRow);
    return mergePendingFillSlices(oldestRows, newestRows);
  },

  async insertEpisodeAtomic(fillId, row) {
    // FINAL BUILD Part 16: computed here (not stored on NewSignalRow) since it is
    // purely derivable from fields the row already carries -- see independence.ts's
    // computeClusterKey for the exact game-level clustering rule and rationale.
    const clusterKey = computeClusterKey({ signalId: row.episodeKey, awayTeam: row.awayTeam, homeTeam: row.homeTeam, scheduledStartAt: row.scheduledStartAt });
    const { data, error } = await supabaseAdmin.rpc("insert_sports_shadow_episode" as never, {
      p_fill_id: fillId,
      p_episode_key: row.episodeKey,
      p_source_wallet: row.wallet,
      p_source_handle: row.walletHandle,
      p_source_condition_id: row.conditionId,
      p_source_asset: row.asset,
      p_source_outcome: row.sourceOutcome,
      p_source_event_slug: row.sourceEventSlug,
      p_source_market_slug: row.sourceMarketSlug,
      p_source_first_fill_at: row.firstFillAtIso,
      p_source_last_fill_at: row.lastFillAtIso,
      p_source_vwap: row.vwap,
      p_source_shares: row.shares,
      p_source_notional: row.notional,
      p_source_fill_count: row.fillCount,
      p_source_sell_seen: row.sellSeen,
      p_league: row.league,
      p_scheduled_start_at: row.scheduledStartAt,
      p_away_team: row.awayTeam,
      p_home_team: row.homeTeam,
      p_experiment_epoch_id: row.experimentEpochId,
      p_bet_type: row.betType,
      p_selected_side: row.selectedSide,
      p_line: row.line,
      p_cluster_key: clusterKey,
    } as never);
    if (error) throw new Error(error.message);
    return { id: data as unknown as string };
  },

  async updateEpisodeAtomic(fillId, signalId, state, sellEvent) {
    const { error } = await supabaseAdmin.rpc("update_sports_shadow_episode" as never, {
      p_fill_id: fillId,
      p_signal_id: signalId,
      p_source_first_fill_at: new Date(state.firstBuyAt * 1000).toISOString(),
      p_source_last_fill_at: new Date(state.lastFillAt * 1000).toISOString(),
      p_source_vwap: state.vwap,
      p_source_shares: state.totalShares,
      p_source_notional: state.totalNotional,
      p_source_fill_count: state.buyFillCount,
      p_source_sell_seen: state.sellSeen,
      p_source_sell_shares: state.sellShares,
      p_source_sell_notional: state.sellNotional,
      p_sell_event_shares: sellEvent?.shares ?? null,
      p_sell_event_price: sellEvent?.price ?? null,
      p_sell_event_notional: sellEvent?.notional ?? null,
      p_sell_event_source_ts: sellEvent?.sourceTs ?? null,
    } as never);
    if (error) throw new Error(error.message);
  },

  async recordPreEpochSell(fillId, shares, price, notional, sourceTs) {
    const { error } = await supabaseAdmin.rpc("record_pre_epoch_sell" as never, {
      p_fill_id: fillId,
      p_shares: shares,
      p_price: price,
      p_notional: notional,
      p_source_ts: sourceTs,
    } as never);
    if (error) throw new Error(error.message);
  },

  async markFillComplete(fillId) {
    const { error } = await supabaseAdmin
      .from("sports_shadow_source_fills" as never)
      .update({ downstream_status: "COMPLETE" } as never)
      .eq("id", fillId);
    if (error) throw new Error(error.message);
  },

  async markFillTerminal(fillId, status) {
    const { error } = await supabaseAdmin
      .from("sports_shadow_source_fills" as never)
      .update({ downstream_status: status } as never)
      .eq("id", fillId);
    if (error) throw new Error(error.message);
  },

  async markFillTerminalUnverified(fillId, reasonCode) {
    const { error } = await supabaseAdmin
      .from("sports_shadow_source_fills" as never)
      .update({ downstream_status: "TERMINAL_UNVERIFIED", downstream_unverified_reason: reasonCode } as never)
      .eq("id", fillId);
    if (error) throw new Error(error.message);
  },

  async getWalletCoverage(wallet) {
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_wallet_coverage" as never)
      .select("covered_through_ts, coverage_complete")
      .eq("wallet", wallet)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as unknown as { covered_through_ts: number | null; coverage_complete: boolean };
    return { coveredThroughTs: row.covered_through_ts, coverageComplete: row.coverage_complete };
  },

  async upsertWalletCoverage(wallet, coveredThroughTs, coverageComplete) {
    const { error } = await supabaseAdmin
      .from("sports_shadow_wallet_coverage" as never)
      .upsert({ wallet, covered_through_ts: coveredThroughTs, coverage_complete: coverageComplete, updated_at: new Date().toISOString() } as never, { onConflict: "wallet" });
    if (error) throw new Error(error.message);
  },
};

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

export type WalletPollDeps = {
  network: SourcePollNetworkDeps;
  repo: PollRepository;
  fetchSourceMarketMetadata: typeof fetchSourceMarketMetadata;
  now: () => number;
  /** Task 12F / P1-G: checked between trade pages and before each pending fill's downstream write so this poll can never continue non-idempotent episode mutations after its caller's source lease has been lost. Defaults to always-true for any caller not exercising lease-loss behavior. */
  checkpointLease: LeaseCheckpoint;
  /** FINAL BUILD Part 17/analytics: the current experiment epoch, resolved once per cycle by the caller (worker.server.ts's runSourceLane) -- null when ensureCurrentEpoch failed this cycle. Every newly-created episode is tagged with this so per-epoch analytics/counters can scope to it. */
  epochId: string | null;
};

const defaultWalletPollDeps: WalletPollDeps = {
  network: defaultNetworkDeps,
  repo: supabasePollRepository,
  fetchSourceMarketMetadata,
  now: () => Date.now(),
  checkpointLease: NO_OP_LEASE_CHECKPOINT,
  epochId: null,
};

export type NewSignalSummary = {
  id: string;
  episodeKey: string;
  wallet: string;
  conditionId: string;
  asset: string;
  betType: BetType;
  selectedSide: string;
  line: number | null;
  awayTeam: string | null;
  homeTeam: string | null;
  scheduledStartAt: string | null;
  sourceEventSlug: string | null;
  sourceMarketSlug: string | null;
  vwap: number;
  shares: number;
  notional: number;
  firstFillAtIso: string;
};

export type WalletPollResult = {
  wallet: string;
  isBootstrap: boolean;
  pagesFetched: number;
  rowsFetched: number;
  newRows: number;
  duplicateRows: number;
  invalidRows: number;
  metadataFetchFailures: number;
  ineligibleRows: number;
  unverifiedRows: number;
  /** Task 12F / P1-H: the subset of unverifiedRows classified TERMINAL (see eligibility.ts's classifyUnverifiedDisposition) and marked TERMINAL_UNVERIFIED rather than left PENDING. */
  terminalUnverifiedRows: number;
  suppressedPreGoLive: number;
  newSignals: NewSignalSummary[];
  aggregatedCount: number;
  sellRecordedCount: number;
  lateReconciliationCount: number;
  /** True only when this was a RESUMPTION poll (wallet had prior history) and no durable overlap was found within MAX_PAGES_PER_WALLET — a genuine first-ever bootstrap hitting the page cap is NOT truncation (there is no "backlog" to complete). */
  backlogTruncated: boolean;
  /** How many fills processed this poll (phase 2) were NOT part of this poll's freshly-inserted batch — i.e. genuinely recovered from an earlier failed/crashed poll. Direct evidence of the Task 12D/P1-A durable-retry mechanism actually doing something, not just existing. */
  orphanedFillsRecovered: number;
  /** Task 12F / P1-G: true when checkpointLease() reported the source lease lost at any point this poll -- pagination and/or phase-2 downstream processing stopped immediately rather than continuing under a stale fence. */
  leaseLost: boolean;
  /** First error encountered, if any. Partial progress made before the error is still reflected in the other fields above — one bad page/row does not discard already-persisted evidence. */
  error: string | null;
  /** CODEX P1-1: durably known/proven coverage state as of the END of this poll -- true only once a scan has actually crossed goLiveAtMs or reached genuine history-start, never merely because the offset ceiling was hit. See sports_shadow_wallet_coverage. */
  sourceCoverageComplete: boolean;
};

function emptyResult(wallet: string): WalletPollResult {
  return {
    wallet,
    isBootstrap: false,
    pagesFetched: 0,
    rowsFetched: 0,
    newRows: 0,
    duplicateRows: 0,
    invalidRows: 0,
    metadataFetchFailures: 0,
    ineligibleRows: 0,
    unverifiedRows: 0,
    terminalUnverifiedRows: 0,
    suppressedPreGoLive: 0,
    newSignals: [],
    aggregatedCount: 0,
    sellRecordedCount: 0,
    lateReconciliationCount: 0,
    backlogTruncated: false,
    orphanedFillsRecovered: 0,
    leaseLost: false,
    error: null,
    sourceCoverageComplete: false,
  };
}

/**
 * ============================ STABLE EVENT-KEY WINDOW-SHIFT AUDIT ============================
 * `normalizeSourceEvents`'s tx_hash_ordinal fallback (the tier every currently-observed
 * /trades row uses — see source-poll.ts's module doc) assigns "#N" per raw economic tuple
 * (txHash:asset:side:sourceTs:shares:price) FRESH within each call, counting occurrences in
 * whatever order that call's own input array happens to hold them. Two DIFFERENT physical
 * fills sharing an identical 6-way tuple (same tx, asset, side, integer-second timestamp,
 * shares, AND price — e.g. one taker order matching two makers at the same price/size in the
 * same block) get "#0"/"#1" ordinals that are ONLY meaningful within that one call. If a later
 * poll's own batch reorders or only partially re-observes such a colliding tuple, naively
 * trusting the recomputed "#N" string against a flat existing-key set can either (a) silently
 * skip a genuinely new physical fill as a false duplicate, or (b) attempt a duplicate insert —
 * see the Task 10 checkpoint report for the traced examples.
 *
 * FIX (Task-10-local, does not touch shadow-core.ts's shared identity scheme): reliable-basis
 * events (source_id / tx_hash_log_index) are unaffected — those keys are stable by
 * construction and use the plain existing-key-set path unchanged. Degraded (tx_hash_ordinal)
 * events are instead reconciled by COUNT per raw tuple against `countDurableOrdinalFills`,
 * which queries the database directly (never a prior poll's own in-memory computation):
 * if this poll's batch holds <= as many occurrences of a tuple as are already durable, ALL of
 * them are treated as already-represented and skipped; otherwise exactly the numeric excess
 * is inserted, using the highest-ordinal labels in the batch. This makes the OUTCOME
 * (row count, and therefore every VWAP/shares aggregate downstream) independent of which
 * specific physical occurrence happens to be labeled "#0" vs "#1" in any given poll — the six
 * tuple fields are, by definition of colliding, byte-identical across occurrences, so a
 * mislabeled instance still carries the correct data.
 *
 * Paired with the pagination change above (a page can only be trusted as "already-seen
 * territory" via a RELIABLE key match, never a degraded one), this eliminates the concrete
 * reordering/false-early-stop scenarios: whenever a poll finds a reliable anchor and stops
 * "normally" (not MAX_PAGES-truncated), its fetched pages are a complete, gapless,
 * newest-to-oldest slice back to that anchor, so any colliding tuple's occurrences within that
 * slice are counted together, in one call, correctly.
 *
 * RESIDUAL RISK (explicitly not claimed to be eliminated): this reasoning is inductive on
 * every EARLIER poll that established the durable state also having had complete coverage
 * back to ITS OWN reliable anchor. A poll whose own pagination hit MAX_PAGES_PER_WALLET
 * without ever finding a reliable anchor (`backlogTruncated: true`) does not itself corrupt
 * anything — `countDurableOrdinalFills` always reflects the database's true current count,
 * not that poll's own view — but if some earlier, already-forgotten poll was ALSO truncated
 * in a way that left one instance of a colliding tuple permanently outside every subsequent
 * poll's fetch window, that instance could still be undercounted. This requires the compound,
 * extremely narrow combination of (1) a genuine 6-way tuple collision between two distinct
 * physical fills, AND (2) that collision's instances being split across polls whose pagination
 * windows never both include them together. Eliminating this residual entirely would require
 * either a native identifier from the source API (not available today) or unconditionally
 * re-walking full wallet history every poll (defeats incremental resumption) — both out of
 * Task 10's local scope. Reported as OUTCOME C, not OUTCOME A, in the Task 10 checkpoint.
 * ================================================================================
 */

function ordinalSuffix(eventKey: string): number {
  const idx = eventKey.lastIndexOf("#");
  const n = idx >= 0 ? Number(eventKey.slice(idx + 1)) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
}

function ordinalPrefix(eventKey: string): string {
  const idx = eventKey.lastIndexOf("#");
  return idx >= 0 ? eventKey.slice(0, idx + 1) : eventKey;
}

/**
 * Splits `events` into (reliable, degraded), reconciles the degraded half by durable count
 * per raw tuple (see the window-shift audit above), and returns the combined genuinely-new
 * set — reliable events filtered by simple existing-key-set membership (unchanged behavior),
 * degraded events filtered by the count-based rule. `existingReliableKeys` must already be
 * the result of checking every reliable event's own eventKey against the repository.
 */
async function reconcileDegradedEvents(
  degradedEvents: NormalizedEvent[],
  wallet: string,
  repo: Pick<PollRepository, "countDurableOrdinalFills">,
  deadline?: { now: () => number; deadlineAtMs: number },
): Promise<{ newDegraded: NormalizedEvent[]; duplicateCount: number; error: string | null }> {
  if (degradedEvents.length === 0) return { newDegraded: [], duplicateCount: 0, error: null };

  const groups = new Map<string, NormalizedEvent[]>();
  for (const e of degradedEvents) {
    const prefix = ordinalPrefix(e.eventKey);
    const list = groups.get(prefix);
    if (list) list.push(e);
    else groups.set(prefix, [e]);
  }

  let durableCounts: Map<string, number>;
  let error: string | null = null;
  try {
    durableCounts = await repo.countDurableOrdinalFills(wallet, [...groups.keys()], deadline);
  } catch (err) {
    // Fail closed: on a genuine reconciliation-query failure, treat every degraded tuple this
    // poll observed as already fully durable (skip, never insert) rather than risk a
    // miscount under unverifiable state. Deferred fills are simply re-evaluated next poll.
    error = `countDurableOrdinalFills failed: ${err instanceof Error ? err.message : "unknown error"}`;
    durableCounts = new Map([...groups.keys()].map((k) => [k, Number.POSITIVE_INFINITY]));
  }

  const newDegraded: NormalizedEvent[] = [];
  let duplicateCount = 0;
  for (const [prefix, group] of groups) {
    const durableCount = durableCounts.get(prefix) ?? 0;
    // Task 13G (Codex re-review round 9, P1): filter by each event's OWN ordinal number
    // against the durable count, never by POSITION within `group`. Positional slicing
    // (`sorted.slice(durableCount)`) silently assumed `group` always contains the FULL,
    // contiguous 0..N-1 ordinal range for this tuple -- true when reconciliation ran once
    // for the whole scan, but false once reconciliation runs PER PAGE (see the "one page
    // at a time" persist loop above): a later page's `group` for this tuple can contain
    // ONLY ordinal #1 (say), with ordinal #0 already committed by an earlier page THIS
    // SAME POLL, making `sorted.slice(durableCount=1)` on a 1-element group incorrectly
    // slice off the position, not the ordinal -- wrongly treating a genuinely-new higher
    // ordinal as a duplicate merely because it happens to be the only entry in its own
    // page's local group. Checking each entry's actual ordinal suffix is correct
    // regardless of whether `group` represents a whole scan or one page's local subset.
    for (const event of group) {
      if (ordinalSuffix(event.eventKey) < durableCount) {
        duplicateCount += 1;
      } else {
        newDegraded.push(event);
      }
    }
  }

  return { newDegraded, duplicateCount, error };
}

/**
 * One bounded poll of ONE approved source wallet. `goLiveAtMs` is REQUIRED input
 * (caller-supplied, e.g. Task 11/config) — see `isEligibleForEpisodeTrigger` in
 * source-poll.ts for exactly how it gates a wallet's first-ever (bootstrap) poll.
 * Never throws: every failure mode is reported via `result.error` plus whatever partial
 * progress was made, so Task 11 can log/retry without special-casing exceptions.
 *
 * ============================== TASK 13F: PER-WALLET WALL-CLOCK DEADLINE ==============================
 * ROOT CAUSE (production canary, Task 13F): `SOURCE_LANE_BUDGET_MS` (worker.server.ts) was
 * only ever checked BETWEEN wallets ("do not START another wallet"), never WITHIN one
 * wallet's own pagination (Phase 1) or pending-fill/metadata-resolution loop (Phase 2). A
 * single wallet with substantial real trade history -- exactly the case for the three
 * approved, already-active wallets -- can legitimately need up to MAX_PAGES_PER_WALLET
 * (41) trade pages plus up to MAX_PENDING_FILLS_PER_POLL (500) Gamma metadata lookups,
 * each individually bounded (12s / 10s) but with NO aggregate bound, so one wallet's poll
 * alone measurably consumed 66-91 real seconds in production -- far longer than any HTTP
 * client/edge proxy reliably keeps a connection open for.
 *
 * FIX: `deadlineAtMs` (optional, defaults to no deadline — existing callers/tests
 * unaffected) is checked at the top of EVERY page iteration (Phase 1) and EVERY pending-
 * fill iteration (Phase 2), alongside the existing lease-checkpoint check. Stopping early
 * this way is safe by the SAME reasoning already established for lease loss: Phase 1's
 * already-fetched pages are still persisted (idempotent, durable), and Phase 2's
 * unprocessed fills simply stay PENDING (re-evaluated identically next poll — this was
 * already Task 12D/P1-A's exact retry contract, requiring zero new mechanism). The one
 * addition needed is `backlogTruncated`: previously only set for a RESUMPTION poll that
 * exhausted MAX_PAGES_PER_WALLET (an intentional, accepted historical-depth boundary,
 * per Task 10). A deadline-triggered stop is NOT that -- it is an unintentional, must-
 * retry-soon incompleteness, for EITHER a bootstrap or a resumption poll, so it now sets
 * `backlogTruncated = true` unconditionally (never gated on `hasHistory`).
 *
 * Continuation is durable with NO new schema: once a page's rows are persisted, the
 * EXISTING overlap-detection mechanism (`findExistingEventKeys`, unchanged) finds them on
 * the wallet's next poll turn and stops pagination there naturally -- durable progress,
 * exactly like a lease-loss-interrupted poll already relied on before Task 13F.
 * ================================================================================
 *
 * ============================== TASK 13G / P1-Q: FORWARD-ONLY BOOTSTRAP ==============================
 * ROOT CAUSE (Codex P1 finding on PR #53, confirmed independently before review): Task
 * 13F's deadline threading made an INTERRUPTED pagination pass safe from the "hold the
 * HTTP response open forever" failure mode, but did not make it safe from a subtler one --
 * `findExistingEventKeys` cannot tell the difference between "this row is durable because
 * an earlier poll walked ALL THE WAY back to it" and "this row is durable merely because
 * an earlier poll fetched it before being interrupted, without ever reaching a genuine
 * historical boundary." Routine interruption (deadline, lease loss) of a poll that
 * persisted SOME newly-fetched pages before stopping could therefore create a FALSE
 * stepping-stone: a later poll, seeing new trades shift pagination, could encounter that
 * falsely-early row, mistake it for the true completeness boundary, and stop -- silently
 * stranding older, never-fetched real fills between the false boundary and the true one,
 * forever (nothing ever re-attempts a range that overlap-detection believes is covered).
 *
 * REASSESSED BOOTSTRAP SEMANTICS (mission Section 1): the ROOT CAUSE of why this bug was
 * essentially GUARANTEED to trigger routinely was that bootstrap tried to walk up to
 * MAX_PAGES_PER_WALLET (41) pages -- up to 10,000 trades -- of history on a wallet's very
 * first poll, an expensive multi-page pass with every opportunity to be interrupted. That
 * walk turns out to be UNNECESSARY: `findLatestEpisode` (this file's PollRepository) reads
 * `sports_shadow_signals` for `OpenEpisodeState`, and that table is BRAND NEW and
 * EXPERIMENT-SPECIFIC -- it durably holds ZERO rows before this experiment's own signals
 * start landing, so there is no pre-existing DCA/episode state to reconstruct from a
 * wallet's trading history at all, no matter how deep. And `isEligibleForEpisodeTrigger`
 * (source-poll.ts, Task 12E/P1-F) compares only a fill's own immutable `sourceTs` against
 * the fixed, durable `goLiveAtMs` -- it has no dependency on `isBootstrap`, wallet history,
 * or how many pages have ever been walked. Neither of the two things bootstrap could
 * plausibly be FOR (DCA continuity, go-live eligibility) requires historical replay.
 *
 * FIX (revised after a second Codex review round, see the identically-tagged P1 finding
 * this paragraph replaces): a wallet's first-ever poll (`!hasHistory`) is NOT capped at a
 * fixed one page -- an unconditional single-page bootstrap is unsound whenever more than
 * PAGE_SIZE post-go-live trades already exist by the time a wallet's first poll runs (a
 * real, not merely theoretical, case for a fast-trading approved wallet): page 0 alone
 * would not reach back to `goLiveAtMs`, yet would still become the wallet's PERMANENT
 * first overlap anchor, silently stranding every eligible fill on page 1 and beyond
 * forever (a direct B4 violation). Instead, bootstrap keeps paging -- sharing the exact
 * same MAX_PAGES_PER_WALLET ceiling steady-state resumption already uses -- until a
 * fetched page contains a fill strictly BEFORE `goLiveAtMs`, proving this scan has walked
 * CONTINUOUSLY from "now" back across the go-live boundary, so every fill at or after it,
 * on every page seen so far, has been captured. If `goLiveAtMs` is not yet configured, no
 * fill can ever be eligible regardless of history depth (Task 12E/P1-F), so a single page
 * remains sufficient in that (degenerate, pre-configuration) case. In the common case --
 * fewer than PAGE_SIZE trades since go-live by the time bootstrap runs -- this still
 * completes in exactly one page, unchanged from the original (unsound) design's happy
 * path; it now also correctly handles the high-volume case by walking further instead of
 * silently truncating. This durably seeds `hasAnyFillsForWallet` (so every later poll is
 * steady-state resumption) and gives steady-state polling its first overlap anchor.
 * Forward requirements B1-B8 (mission Section 2) all hold: B1/B7 -- bootstrap either
 * genuinely completes (crossed the go-live boundary, a natural end, or the accepted
 * MAX_PAGES_PER_WALLET ceiling -- see `scanConfirmedComplete` below) or is retried
 * identically next poll, never silently "done" via a deadline race. B2 -- unaffected,
 * already guaranteed by isEligibleForEpisodeTrigger regardless of how bootstrap is
 * implemented. B3/B4 -- bootstrap itself now proves every post-go-live fill on the source
 * as of "now" is captured (not merely delegated to steady-state's short-gap assumption),
 * and ordinary steady-state polling closes any remaining gap from there forward. B5 -- the
 * boundary is the durable content of `sports_shadow_source_fills` itself, not in-memory
 * state, so a restart before/after bootstrap changes nothing (an interrupted multi-page
 * bootstrap attempt is discarded in full, same as any other unconfirmed scan -- see
 * `scanConfirmedComplete`). B6 -- wallets remain fully independent (unchanged). B8 --
 * proved above: no DCA state ever needs reconstructing from history (still true
 * regardless of how many pages bootstrap ends up walking); the number of pages needed is
 * instead exactly however many are required to prove the go-live boundary has been
 * crossed, which this design computes directly rather than assuming.
 *
 * ============================== TASK 13G / P1-Q + P1-R: NO-STRANDING PERSISTENCE ==============================
 * The bootstrap redesign above eliminates the GUARANTEED, every-cycle trigger for P1-Q
 * (bootstrap no longer walks deep history), but a steady-state poll asked to close an
 * unusually large gap (e.g. after a scheduler outage) can still, in principle, be
 * interrupted before reaching a genuine completeness boundary. The invariant this section
 * enforces UNCONDITIONALLY, for bootstrap and steady-state alike: AN INCOMPLETE SCAN MAY
 * NEVER CREATE A DURABLE OVERLAP THAT CAUSES UNREAD SOURCE DATA TO BECOME UNREACHABLE.
 *
 * FIX: pagination already buffers every fetched page in memory (`rawPages`) rather than
 * persisting per-page -- Phase 1's persist step runs only AFTER the pagination loop below
 * exits. This poll now tracks WHY the loop exited and computes `scanConfirmedComplete`:
 * true only if the loop stopped via a genuine overlap, a natural end (short/empty page),
 * or (steady-state only) exhausting MAX_PAGES_PER_WALLET -- i.e. never via deadline or
 * lease loss. If NOT confirmed complete, `rawPages` is discarded WITHOUT calling
 * insertRawFillsBatch at all: zero new durable rows are created, so there is nothing a
 * later poll could ever mistake for a completeness boundary. The discarded rows are not
 * lost -- they were never durable evidence to begin with, and the wallet's next poll
 * re-fetches from page 0 (always the cheapest page) and either completes (persisting the
 * full, gapless range in one shot) or defers again. Because the ONLY way this poll ever
 * advances the durable boundary is via a scan that walked CONTINUOUSLY from the newest row
 * to a genuine stopping point, no interrupted scan -- regardless of how many times it
 * repeats, how pages shift between attempts, or whether a restart happens between every
 * attempt -- can ever manufacture a false stepping-stone. This is a safety property (no
 * fill is ever incorrectly treated as "covered"), not a liveness one: under a sustained,
 * pathological trading burst that outpaces every single poll's budget, forward progress
 * could stall, but no data is ever silently stranded -- see the Task 13G final report for
 * the exact bound at which this residual, bounded-probability liveness risk would require
 * new durable state (a per-wallet coverage watermark) to fully eliminate.
 *
 * P1-R (persistence-phase bound): once a scan IS confirmed complete, `genuinelyNew` is a
 * proven-complete, already-deduped set -- persisting a SUBSET of it (stopping partway
 * through, deadline permitting) is safe in a way partial FETCHING is not, because
 * `findExistingEventKeys` only ever reports rows that are genuinely durable; any row not
 * yet inserted this poll is simply re-discovered as still-genuinely-new and retried next
 * poll (fully idempotent). Persistence is therefore chunked into one batch PER ORIGINATING
 * PAGE (one bounded DB round trip each, via `insertRawFillsBatch`, never exceeding
 * PAGE_SIZE rows since a page can never hold more), with a deadline check BEFORE every
 * batch including the first -- bounding the previously-unbounded sequential per-row insert
 * loop that Codex flagged as capable of holding the response open indefinitely for a large
 * genuinely-new batch. Batches are aligned to page boundaries rather than an arbitrary
 * fixed-size window (an earlier version of this fix used a flat PERSIST_BATCH_SIZE slice,
 * which Codex flagged as able to leave a page PARTIALLY durable if a batch straddling two
 * pages' rows committed while a later batch failed) -- see the "NO-STRANDING PERSISTENCE"
 * section's per-page-batch paragraph below for the full reasoning.
 * ================================================================================
 */
export async function pollSportsShadowWallet(
  wallet: string,
  goLiveAtMs: number | null,
  deps: Partial<WalletPollDeps> = {},
  deadlineAtMs: number = Number.POSITIVE_INFINITY,
): Promise<WalletPollResult> {
  const d: WalletPollDeps = {
    ...defaultWalletPollDeps,
    ...deps,
    network: { ...defaultNetworkDeps, ...deps.network },
  };
  const normalizedWallet = wallet.toLowerCase();
  const detectedAtMs = d.now();
  const result = emptyResult(normalizedWallet);
  // Soak-incident fix: Phase 1 stops early so Phase 2 (durable pending-fill drain) is never starved.
  const ingestDeadlineAtMs = phase1IngestDeadline(deadlineAtMs, detectedAtMs);

  let hasHistory: boolean;
  try {
    hasHistory = await d.repo.hasAnyFillsForWallet(normalizedWallet);
  } catch (err) {
    result.error = `hasAnyFillsForWallet failed: ${err instanceof Error ? err.message : "unknown error"}`;
    return result;
  }
  result.isBootstrap = !hasHistory;

  /**
   * CODEX P1-1: `hasHistory` alone is NOT proof this wallet's history has ever been
   * durably captured back to goLiveAtMs -- a wallet whose lifetime trade count (or whose
   * gap since a prior poll) exceeds MAX_TRADES_OFFSET (10,000) could previously have its
   * bootstrap/resumption scan hit that ceiling and get treated as complete regardless
   * (see the "ranOutOfPages" handling below, pre-fix). `coverage` is the durable
   * per-wallet watermark that makes this provable instead of assumed. `coverage === null`
   * (no row yet -- true for every wallet before this fix's migration) is treated as "not
   * yet proven," forcing one genuine verification pass -- never an implicit pass.
   */
  let coverage: { coveredThroughTs: number | null; coverageComplete: boolean } | null = null;
  try {
    coverage = await d.repo.getWalletCoverage(normalizedWallet);
  } catch (err) {
    // Best-effort read: a failure here must not fail the whole poll -- fail toward
    // "not yet proven" (provingCoverage=true), the safe direction, rather than silently
    // trusting an unreadable coverage state as complete.
    void err;
  }
  const provingCoverage = !(coverage?.coverageComplete ?? false);
  const windowEndTs: number | undefined = provingCoverage ? (coverage?.coveredThroughTs ?? undefined) : undefined;
  let coverageProvenCompleteThisScan = false;
  // Default reflects whatever was already durably known; overridden below only once this
  // scan's own fetch+persist work is confirmed (scanConfirmedComplete).
  result.sourceCoverageComplete = coverage?.coverageComplete ?? false;

  // Task 13G / P1-Q (Codex re-review): bootstrap and steady-state share the SAME page
  // ceiling. Bootstrap typically stops after just one page in the common case (see the
  // go-live-boundary-crossing check below), but must be allowed to walk as far as
  // steady-state resumption can when a wallet already has substantial post-go-live volume
  // by its first-ever poll -- a fixed, smaller cap would silently strand real eligible
  // fills beyond it (B4).
  const maxPagesThisScan = MAX_PAGES_PER_WALLET;
  const rawPages: RawTrade[][] = [];
  let overlapFound = false;
  let naturalEnd = false;
  let deadlineExceeded = false;
  try {
    for (let page = 0; page < maxPagesThisScan; page += 1) {
      const offset = page * PAGE_SIZE;
      if (offset > MAX_TRADES_OFFSET) {
        naturalEnd = true;
        break;
      }
      // Task 13F: checked BEFORE each page, same spirit as the lease checkpoint below --
      // a wallet with a long real trade history must not hold this poll (and the HTTP
      // response it blocks) open indefinitely. Task 13G / P1-Q: pages already fetched are
      // now discarded, NOT persisted, when the loop is interrupted this way -- see
      // scanConfirmedComplete below.
      if (d.now() >= ingestDeadlineAtMs) {
        deadlineExceeded = true;
        break;
      }
      // Task 12F / P1-G: a full pagination pass can take up to MAX_PAGES_PER_WALLET * 12s
      // -- checked before each page so a lease lost mid-pagination stops issuing further
      // requests immediately. Task 13G / P1-Q: pages already fetched are now discarded,
      // NOT persisted, when the loop is interrupted this way -- see scanConfirmedComplete
      // below; it is ONLY Phase 2's episode mutations that ever needed this distinction
      // before, but an interrupted Phase 1 fetch is no longer trusted as evidence either.
      if (!(await d.checkpointLease())) {
        result.leaseLost = true;
        break;
      }
      // Task 13G (Codex re-review round 4, P1): checkpointLease can itself perform a
      // real renewal RPC -- re-check the deadline immediately after it returns, before
      // starting the next (up to 12s) network request, so that await's own latency can
      // never let the deadline check above become stale by the time the fetch begins.
      if (d.now() >= ingestDeadlineAtMs) {
        deadlineExceeded = true;
        break;
      }
      // Task 13I / P1-T: deadlineAtMs threaded into the paced fetch itself so a cooldown
      // wait, reservation RPC, or granted pacing wait cannot run past this poll's own
      // budget before the (up to 12s) upstream request even starts. A DeadlineExceededError
      // here is handled the SAME way as the deadline pre-checks above it (deadlineExceeded
      // = true, then break) -- never folded into result.error, which would incorrectly
      // suppress backlogTruncated (see its derivation below) and misreport a scheduler
      // budget running out as a genuine upstream/network failure.
      let rows: RawTrade[];
      try {
        rows = await pacedFetchTradesPage(normalizedWallet, offset, d.network, ingestDeadlineAtMs, d.now, windowEndTs);
      } catch (err) {
        if (err instanceof DeadlineExceededError) {
          deadlineExceeded = true;
          break;
        }
        throw err;
      }
      result.pagesFetched += 1;
      if (rows.length === 0) {
        naturalEnd = true;
        // CODEX P1-1: an empty page within a coverage-proving window (windowEndTs set, or
        // windowEndTs undefined but this IS page 0) proves genuine history-start -- there
        // is nothing older left to cover, so coverage is complete by construction, not
        // merely "this window's ceiling wasn't hit."
        if (provingCoverage) coverageProvenCompleteThisScan = true;
        break;
      }
      rawPages.push(rows);
      result.rowsFetched += rows.length;

      if (provingCoverage) {
        // Task 13G / P1-Q (Codex re-review, P1): a FIXED one-page bootstrap is unsound in
        // general -- if more than PAGE_SIZE post-go-live trades already exist by the time
        // a wallet's first-ever poll runs, page 0 alone would not reach back to
        // goLiveAtMs, yet it would still become the wallet's permanent first overlap
        // anchor, silently stranding every eligible fill on page 1 and beyond forever
        // (violates B4). Bootstrap therefore keeps paging, exactly like steady-state's
        // MAX_PAGES_PER_WALLET budget, until a fetched page contains a fill strictly
        // BEFORE goLiveAtMs -- proof this scan has walked continuously from "now" back
        // across the go-live boundary, so every fill at or after it on every page seen so
        // far has been captured (B1-B4, B8: `sports_shadow_signals` starting empty and
        // isEligibleForEpisodeTrigger's pure sourceTs/goLiveAtMs comparison, see the module
        // doc comment, mean nothing PRE-go-live ever needs to be reached at all). If
        // goLiveAtMs is not yet configured, no fill can ever be eligible regardless of
        // history depth (Task 12E/P1-F), so a single page remains sufficient.
        if (goLiveAtMs === null) {
          naturalEnd = true;
          break;
        }
        const crossedGoLive = normalizeSourceEvents(rows, normalizedWallet).some((e) => e.sourceTs * 1000 < goLiveAtMs);
        if (crossedGoLive) {
          naturalEnd = true;
          coverageProvenCompleteThisScan = true; // proof this scan has walked continuously across the go-live boundary
          break;
        }
        if (rows.length < PAGE_SIZE) {
          naturalEnd = true;
          coverageProvenCompleteThisScan = true; // genuine history-start reached -- nothing older exists to cover
          break;
        }
        continue; // keep paging further back -- go-live boundary not yet reached
      }

      // Overlap-to-stop must be proven with a RELIABLE key only (source_id or
      // tx_hash_log_index). A tx_hash_ordinal (degraded) key is re-derived fresh
      // per call from THIS page's own row order and carries no cross-poll identity
      // guarantee on its own — trusting it here could stop pagination one page too
      // early, leaving an older, not-yet-covered sibling of a colliding tuple
      // outside this poll's fetched range. See the window-shift audit above
      // reconcileDegradedEvents for the full reasoning.
      const pageReliableKeys = normalizeSourceEvents(rows, normalizedWallet)
        .filter((e) => !e.identityDegraded)
        .map((e) => e.eventKey);
      if (pageReliableKeys.length > 0) {
        const pageExisting = await d.repo.findExistingEventKeys(normalizedWallet, pageReliableKeys);
        if (pageExisting.size > 0) {
          overlapFound = true;
          break;
        }
      }
      if (rows.length < PAGE_SIZE) {
        naturalEnd = true;
        break;
      }
    }
  } catch (err) {
    result.error = `trade page fetch failed: ${err instanceof Error ? err.message : "unknown error"}`;
  }

  // Task 12F / P1-G: a pagination pass stopped early by lease loss is NOT genuine backlog
  // exhaustion -- there may well be more history the wallet's own overlap key would have
  // found had the lease survived. Only a real MAX_PAGES_PER_WALLET exhaustion (loop ran
  // out of iterations without overlap, a natural end, a deadline stop, or an error) counts
  // as backlogTruncated in this (accepted historical-depth boundary) sense. Task 13G / P1-Q
  // (Codex re-review): bootstrap can now ALSO exhaust MAX_PAGES_PER_WALLET without ever
  // crossing the go-live boundary (an extreme case -- 10,000+ post-go-live trades for one
  // wallet since bootstrap) -- this is genuine, unconditional-of-hasHistory truncation too.
  const ranOutOfPages = !overlapFound && !naturalEnd && !deadlineExceeded && !result.leaseLost && result.error === null;
  if (ranOutOfPages) {
    result.backlogTruncated = true;
  }
  // Task 13F: a deadline-triggered stop is NEVER an intentional completion boundary --
  // unlike MAX_PAGES_PER_WALLET (an accepted historical-depth ceiling, Task 10), running
  // out of THIS invocation's time budget proves nothing about how much history remains.
  // Applies to a bootstrap poll too (unlike the hasHistory-gated case above), since a
  // deadline-truncated bootstrap is exactly as incomplete as a deadline-truncated
  // resumption -- both must be retried, not silently treated as "done."
  if (deadlineExceeded && !overlapFound && !result.leaseLost && result.error === null) {
    result.backlogTruncated = true;
  }

  // Task 13G / P1-Q: the CENTRAL no-stranding invariant. `rawPages` is durable evidence
  // ONLY if this scan reached a genuine, provable stopping point (overlap / natural end /
  // accepted MAX_PAGES boundary) -- never if it was cut short by the deadline or lease
  // loss. See the module doc comment's "NO-STRANDING PERSISTENCE" section for the full
  // proof of why this is both necessary and sufficient to make an interrupted scan unable
  // to ever create a false completeness boundary for a later poll.
  const scanConfirmedComplete = !deadlineExceeded && !result.leaseLost && result.error === null;

  const insertedThisPoll = new Set<string>();
  if (scanConfirmedComplete) {
    // Task 13G / P1-Q (Codex re-review, P1): persist in the SAME oldest-fetched-page-first
    // order pagination actually walked, never re-sorted by sourceTs/eventKey. Sorting the
    // merged set by sourceTs/eventKey (the prior approach) does not track the provider's
    // actual page boundaries for same-second collisions, so a partial commit under that
    // ordering could land rows from a NEWER page in an earlier batch than rows from an
    // OLDER page -- exactly the kind of out-of-page-order commit that lets a later poll's
    // overlap check recognize newer content as covered while an older, still-unpersisted
    // page is not.
    //
    // normalizeSourceEvents MUST still be called ONCE on the full flattened array (not
    // per-page): a degraded (tx_hash_ordinal) event's "#N" ordinal label is assigned fresh
    // per call by counting occurrences of its raw tuple WITHIN that call's input, in INPUT
    // ORDER -- calling it separately per page would independently label two genuinely
    // distinct physical fills (split across two pages) as the SAME "#0", collapsing them
    // into one durable row.
    //
    // Task 13G (Codex re-review round 3, P1): the ordinal-assignment order and the
    // persist order must be the SAME order. reconcileDegradedEvents's count-based
    // reconciliation assumes "N rows already durable" means the LOWEST N ordinals (#0..)
    // are the durable ones (see its own doc comment) -- an assumption that only holds if
    // ordinal #0 is always assigned to whichever occurrence is persisted FIRST. The input
    // array is therefore fed in the SAME oldest-fetched-page-first order used for
    // persistence below (see `orderedRawPages`), not the raw newest-page-first fetch
    // order -- so ordinal #0 always means "oldest page's occurrence," matching whichever
    // occurrence a partial persist would have committed first. `raw` is passed through by
    // reference (shadow-core.ts's own `raw: r`), so page origin for grouping batches by
    // page (below) is recovered via a reference-keyed Map, without touching the
    // durably-stored raw evidence blob at all.
    const pageIndexByRawRow = new Map<RawTrade, number>();
    rawPages.forEach((page, pageIndex) => {
      for (const row of page) pageIndexByRawRow.set(row, pageIndex);
    });
    // rawPages[0] is the NEWEST page (offset 0); reversing gives oldest-page-first, the
    // single source of truth for BOTH ordinal assignment and persist order below.
    const orderedRawPages = [...rawPages].reverse();
    const allEventsBySourceOrder: NormalizedEvent[] = normalizeSourceEvents(orderedRawPages.flat(), normalizedWallet);
    // normalizeSourceEvents' OWN return statement re-sorts its output by (sourceTs,
    // eventKey) regardless of input order -- feeding it oldest-page-first content (above)
    // fixes WHICH ordinal number each occurrence gets, but the returned array's element
    // order still needs restoring to actual page order for persistence and batch-grouping
    // below, via the same reference-keyed page-index map.
    const allEvents = [...allEventsBySourceOrder].sort((a, b) => (pageIndexByRawRow.get(b.raw) ?? 0) - (pageIndexByRawRow.get(a.raw) ?? 0));

    // Task 13G (Codex re-review round 9, P1): reconciliation and persistence are now ONE
    // PAGE at a time, oldest page first, rather than a single scan-wide "reconcile
    // everything, then persist everything" gate. The prior all-or-nothing design meant a
    // scan whose degraded-tuple reconciliation could not fully complete within budget
    // (rare per-scan, but possible for a large catch-up with many distinct prefixes)
    // committed NOTHING -- and since nothing changes between identical retries of the same
    // scan, that could repeat every poll, making zero durable progress indefinitely under a
    // routinely tight deadline. Processing one page's reconciliation+persist as a single
    // atomic unit means an EARLIER page that fully completes is durably committed even if a
    // LATER page's reconciliation or persist doesn't fit in the remaining budget -- genuine,
    // monotonic incremental progress every poll, not "all or nothing" per scan. This does
    // not weaken the no-stranding invariant: exactly like the previous per-batch design, a
    // page is only ever committed once its own findExistingEventKeys AND degraded
    // reconciliation AND insertRawFillsBatch have all genuinely completed, and stopping
    // after any earlier page still leaves every later (unprocessed) page's content
    // discoverable as genuinely-new on the wallet's next poll.
    //
    // RESIDUAL RISK (Codex re-review round 10) -- CLOSED by FINAL BUILD Part 2: a single
    // PAGE is still the smallest atomic commit unit, and one page's own degraded-tuple
    // reconciliation (up to PAGE_SIZE=250 distinct prefixes) previously required one
    // count query PER CHUNK of prefixes, with a deadline check between chunks -- a page
    // with more distinct prefixes than the shared deadline allowed chunks for could
    // repeatedly fail to fully reconcile. The schema change this doc comment used to defer
    // (Section 10) has now been made: an indexed, GENERATED `tuple_prefix` column on
    // `sports_shadow_source_fills` (see
    // supabase/migrations/20260823070000_sports_shadow_tuple_prefix.sql) lets
    // `countDurableOrdinalFills` count an entire page's distinct prefixes in exactly ONE
    // grouped RPC round trip, regardless of how many there are -- there is no longer a
    // per-poll ceiling on how many distinct prefixes one page's reconciliation can cover,
    // so this residual is eliminated at the root, not merely mitigated.
    const eventsByPageIndex = new Map<number, NormalizedEvent[]>();
    for (const event of allEvents) {
      const pageIdx = pageIndexByRawRow.get(event.raw) ?? 0;
      const list = eventsByPageIndex.get(pageIdx);
      if (list) list.push(event);
      else eventsByPageIndex.set(pageIdx, [event]);
    }
    // pageIndexByRawRow uses the ORIGINAL rawPages indices (0 = newest) -- descending
    // gives oldest-page-first, matching every other ordering decision in this function.
    const pageIndicesOldestFirst = [...eventsByPageIndex.keys()].sort((a, b) => b - a);

    // Task 13G (Codex re-review round 3, P1): a confirmed-complete scan can still have
    // exhausted (or nearly exhausted) the deadline during its OWN last fetch/lease-check
    // iteration -- checked again here, immediately before starting the first page's own
    // work. If already past deadline, none of it starts at all this poll: exactly as safe
    // as any other unconfirmed-scan discard (see scanConfirmedComplete above) -- nothing
    // here has been persisted yet, so nothing is stranded, only deferred to the wallet's
    // next poll.
    // CODEX P1-1: tracks whether EVERY page of THIS window was durably persisted before
    // this poll's deadline -- gates coverage-watermark advancement below. Advancing the
    // watermark past rows this poll only OBSERVED but never actually finished persisting
    // would let a later poll believe a range is durable when part of it is not.
    let allPagesPersistedThisWindow = true;
    if (d.now() >= ingestDeadlineAtMs) {
      result.backlogTruncated = true;
      allPagesPersistedThisWindow = false;
    } else {
      for (const pageIdx of pageIndicesOldestFirst) {
        // Task 13G (Codex re-review round 9, P1): checked before EVERY page's
        // reconcile+persist unit, including the first.
        if (d.now() >= ingestDeadlineAtMs) {
          result.backlogTruncated = true;
          allPagesPersistedThisWindow = false;
          break;
        }
        const pageEvents = eventsByPageIndex.get(pageIdx)!;
        const pageReliable = pageEvents.filter((e) => !e.identityDegraded);
        const pageDegraded = pageEvents.filter((e) => e.identityDegraded);

        let pageExistingReliableKeys: Set<string>;
        try {
          pageExistingReliableKeys = await d.repo.findExistingEventKeys(normalizedWallet, pageReliable.map((e) => e.eventKey));
        } catch (err) {
          // Fail OPEN, not closed: unlike degraded-count reconciliation (where a wrong
          // guess can misidentify a specific ordinal), treating every reliable event as
          // "not yet durable" here is always SAFE -- insertRawFillsBatch's own
          // onConflict/ignoreDuplicates upsert idempotently no-ops any that already exist,
          // never creating a duplicate or corrupting state. Stopping the whole page here
          // instead would sacrifice real progress for no additional safety.
          result.error = result.error ?? `findExistingEventKeys failed: ${err instanceof Error ? err.message : "unknown error"}`;
          pageExistingReliableKeys = new Set();
        }
        const pageNewReliableKeys = new Set(pageReliable.filter((e) => !pageExistingReliableKeys.has(e.eventKey)).map((e) => e.eventKey));
        const pageReliableDuplicates = pageReliable.length - pageNewReliableKeys.size;

        // Task 13G (Codex re-review round 4, P1): re-checked here, immediately before
        // this page's own degraded-event reconciliation -- findExistingEventKeys's own
        // await can run past the deadline.
        if (d.now() >= ingestDeadlineAtMs) {
          result.backlogTruncated = true;
          allPagesPersistedThisWindow = false;
          break;
        }
        const { newDegraded: pageNewDegraded, duplicateCount: pageDegradedDuplicates, error: reconcileError } = await reconcileDegradedEvents(
          pageDegraded,
          normalizedWallet,
          d.repo,
          { now: d.now, deadlineAtMs: ingestDeadlineAtMs },
        );
        if (reconcileError !== null) {
          // Task 13G (Codex re-review round 5, P1): a reconciliation FAILURE (not just a
          // deadline hit) must stop here too, not merely skip this page's degraded half --
          // persisting this page's reliable events while skipping its degraded ones has
          // the exact same partial-page stranding risk as any other partial-page commit.
          result.error = result.error ?? reconcileError;
          result.backlogTruncated = true;
          allPagesPersistedThisWindow = false;
          break;
        }
        result.duplicateRows += pageReliableDuplicates + pageDegradedDuplicates;
        const pageNewDegradedKeys = new Set(pageNewDegraded.map((e) => e.eventKey));
        const pageGenuinelyNew = pageEvents.filter((e) => pageNewReliableKeys.has(e.eventKey) || pageNewDegradedKeys.has(e.eventKey));

        if (pageGenuinelyNew.length === 0) continue; // nothing new on this page -- move on

        // Task 13G / P1-R: checked immediately before this page's persist batch too --
        // reconciliation itself can consume real time.
        if (d.now() >= ingestDeadlineAtMs) {
          result.backlogTruncated = true;
          allPagesPersistedThisWindow = false;
          break;
        }
        const batch = pageGenuinelyNew.map((event) => toRawFillRow(event));
        try {
          const batchResults = await d.repo.insertRawFillsBatch(batch);
          for (const r of batchResults) {
            if (r.inserted) {
              result.newRows += 1;
              insertedThisPoll.add(r.id);
            } else {
              result.duplicateRows += 1;
            }
          }
        } catch (err) {
          // Task 13G / P1-Q (Codex re-review, P1): a failed batch must stop ALL further
          // pages this poll, not just skip to the next one -- pages are processed
          // oldest-first, so continuing past a failure would risk committing a NEWER
          // page while this (older) one's rows stay un-persisted, which a later poll's
          // overlap check could then mistake for full coverage, stranding this page
          // forever. Stopping here guarantees only a CONTIGUOUS prefix of pages, starting
          // from the pre-existing durable boundary forward, is ever committed.
          result.error = result.error ?? `insertRawFillsBatch failed: ${err instanceof Error ? err.message : "unknown error"}`;
          result.invalidRows += pageGenuinelyNew.length;
          result.backlogTruncated = true;
          allPagesPersistedThisWindow = false;
          break;
        }
      }
    }

    // CODEX P1-1: durable coverage-watermark advancement. Only when EVERY fetched page of
    // this window is confirmed both FETCHED (scanConfirmedComplete, already required to
    // reach this block) and durably PERSISTED (allPagesPersistedThisWindow) is it safe to
    // advance covered_through_ts -- otherwise a not-yet-durable row could be silently
    // skipped by a later poll that trusts the watermark. Best-effort: a failure to WRITE
    // the watermark must never fail the poll -- the next poll simply re-verifies the same
    // (already-durable, idempotent-safe) range instead of a strictly new one.
    if (provingCoverage && allPagesPersistedThisWindow) {
      try {
        if (coverageProvenCompleteThisScan) {
          await d.repo.upsertWalletCoverage(normalizedWallet, windowEndTs ?? null, true);
        } else if (ranOutOfPages && allEventsBySourceOrder.length > 0) {
          // Offset ceiling reached within this window without proving completion --
          // allEventsBySourceOrder is sorted ascending by sourceTs (normalizeSourceEvents'
          // own return statement), so its first element is the OLDEST timestamp actually
          // observed. Inclusive boundary, matching shadow.server.ts's own established
          // fetchUntilCheckpointCovered convention: events sharing that exact second are
          // re-fetched (idempotent no-op) rather than risk skipping one on the next window.
          await d.repo.upsertWalletCoverage(normalizedWallet, allEventsBySourceOrder[0]!.sourceTs, false);
        }
      } catch (err) {
        void err;
      }
    }
    result.sourceCoverageComplete = coverageProvenCompleteThisScan || (coverage?.coverageComplete ?? false);
  }

  /*
   * -------------------- Phase 2: retry EVERY currently-pending fill for this wallet --------------------
   * Bounded, oldest source_ts first. Naturally includes fills just inserted above AND any
   * orphaned by an earlier failed/crashed poll — see this module's Task 12D/P1-A doc
   * comment for why re-running this against the same fill is always safe.
   *
   * Task 12F / P1-G: if the lease was already lost during pagination (or the checkpoint
   * below fails immediately), Phase 2 does not even start -- no metadata fetch, no
   * findLatestEpisode, no episode mutation is attempted under a lease this worker can no
   * longer prove it still holds. Every fill that would have been processed simply stays
   * PENDING, safely retryable by whichever worker holds the lease next.
   */
  // Task 13G (Codex re-review round 6, P1): checked before even ENTERING Phase 2 -- if
  // Phase 1's final fetch or persist batch started within budget but returned after the
  // deadline, this skips the lease-renewal RPC and the up-to-500-row pending-fill query
  // entirely rather than starting them anyway. A pure deadline stop here is distinct from
  // lease loss (leaseLost stays false) -- every fill that would have been processed simply
  // stays PENDING, safely retried next poll, exactly like every other deadline stop.
  if (d.now() >= deadlineAtMs) {
    return result;
  }
  if (!result.leaseLost && !(await d.checkpointLease())) {
    result.leaseLost = true;
  }
  if (result.leaseLost) {
    return result;
  }
  // Task 13G (Codex re-review round 6, P1): re-checked immediately after checkpointLease
  // succeeds, before the up-to-500-row pending-fill query -- mirrors the same
  // renewal-latency fix already applied everywhere else this pattern appears.
  if (d.now() >= deadlineAtMs) {
    return result;
  }

  let pendingFills: PendingDownstreamFillRow[];
  try {
    pendingFills = await d.repo.findPendingDownstreamFills(normalizedWallet, MAX_PENDING_FILLS_PER_POLL);
  } catch (err) {
    result.error = result.error ?? `findPendingDownstreamFills failed: ${err instanceof Error ? err.message : "unknown error"}`;
    pendingFills = [];
  }
  result.orphanedFillsRecovered = pendingFills.filter((f) => !insertedThisPoll.has(f.id)).length;

  const positionCache = new Map<string, EpisodeCacheEntry | null>();
  const metadataCache = new Map<string, SourceMarketMetadata>();

  for (const fill of pendingFills) {
    // Task 13F: checked BEFORE every iteration's own (up to 10s) metadata fetch -- once
    // the deadline is reached, the remaining batch is abandoned exactly like a lease loss
    // below: every unprocessed fill simply stays PENDING, re-evaluated identically next
    // poll (Task 12D/P1-A's existing retry contract already makes this fully safe; no new
    // mechanism needed).
    if (d.now() >= deadlineAtMs) break;
    // Task 12F / P1-G: checked at the top of every iteration, BEFORE this fill's own
    // (up to 10s) metadata fetch -- once lost, the entire remaining batch is abandoned
    // (safely PENDING) rather than continuing to spend metadata-fetch budget on fills
    // that could not be safely written anyway.
    if (!(await d.checkpointLease())) {
      result.leaseLost = true;
      break;
    }
    // Task 13G (Codex re-review round 4, P1): checkpointLease can itself perform a real
    // renewal RPC -- re-check the deadline immediately after it returns, before starting
    // this fill's own (up to 10s) metadata fetch or terminal-marker write, so that await's
    // latency can never let the deadline check above become stale.
    if (d.now() >= deadlineAtMs) break;
    if (!fill.conditionId) {
      result.unverifiedRows += 1;
      try {
        await d.repo.markFillTerminal(fill.id, "TERMINAL_INELIGIBLE");
      } catch {
        // Best-effort: a failed terminal-marker write just leaves this fill PENDING,
        // re-evaluated (and re-attempted) identically next poll.
      }
      continue;
    }

    let metadata = metadataCache.get(fill.conditionId);
    if (!metadata) {
      try {
        metadata = await d.fetchSourceMarketMetadata(fill.conditionId);
      } catch (err) {
        result.error = result.error ?? `fetchSourceMarketMetadata failed: ${err instanceof Error ? err.message : "unknown error"}`;
        result.metadataFetchFailures += 1;
        continue; // stays PENDING
      }
      metadataCache.set(fill.conditionId, metadata);
    }

    // Task 13G (Codex re-review round 6, P1): checked immediately after the metadata
    // fetch/cache-lookup above resolves, before ANY of the marker writes below it can
    // start -- fetchSourceMarketMetadata's own await (up to 10s) can run past the deadline
    // even though the check at the top of this iteration passed.
    if (d.now() >= deadlineAtMs) break;
    if (metadata.status === "INELIGIBLE") {
      result.ineligibleRows += 1;
      try {
        await d.repo.markFillTerminal(fill.id, "TERMINAL_INELIGIBLE");
      } catch {
        // Best-effort; stays PENDING and is re-evaluated identically next poll.
      }
      continue;
    }
    if (metadata.status === "UNVERIFIED") {
      result.unverifiedRows += 1;
      // Task 12F / P1-H: retryable (transport/response-availability) reasons stay
      // PENDING exactly as before -- temporary uncertainty is never silently treated as
      // permanent. Terminal (classifier-level, deterministic-given-this-conditionId)
      // reasons are marked TERMINAL_UNVERIFIED so they stop permanently occupying this
      // bounded batch's retry capacity, while durably retaining the reason code as
      // evidence (see eligibility.ts's classifyUnverifiedDisposition for the exact split
      // and rationale).
      if (classifyUnverifiedDisposition(metadata.reasonCode as UnverifiedReasonCode) === "TERMINAL") {
        result.terminalUnverifiedRows += 1;
        try {
          await d.repo.markFillTerminalUnverified(fill.id, metadata.reasonCode as UnverifiedReasonCode);
        } catch {
          // Best-effort; stays PENDING and is re-evaluated identically next poll.
        }
      }
      continue;
    }
    if (!metadata.betType) {
      // Defensive: status claims something other than UNVERIFIED/INELIGIBLE but betType
      // is still null (should never happen for a genuine ELIGIBLE result). Fail closed to
      // PENDING rather than guessing a disposition from a reasonCode that may not even be
      // a real UnverifiedReasonCode in this anomalous state.
      result.unverifiedRows += 1;
      continue;
    }

    const eligibleFill: EligibleFill = {
      eventKey: fill.eventKey,
      wallet: normalizedWallet,
      conditionId: fill.conditionId,
      asset: fill.asset,
      side: fill.side,
      shares: fill.shares,
      price: fill.price,
      sourceTs: fill.sourceTs,
      detectedAt: detectedAtMs,
    };

    if (!isEligibleForEpisodeTrigger(fill.sourceTs, goLiveAtMs)) {
      result.suppressedPreGoLive += 1;
      try {
        await d.repo.markFillComplete(fill.id);
      } catch {
        // Best-effort; stays PENDING and is re-evaluated identically next poll. Task 12E/P1-F:
        // this stays safe under retry because the decision depends ONLY on this fill's own
        // immutable sourceTs and the fixed, durable goLiveAtMs -- never on wallet-history
        // state -- so it is guaranteed to still be false next time.
      }
      continue;
    }

    const positionKey = `${normalizedWallet}:${fill.conditionId}:${fill.asset}`;
    let cacheEntry: EpisodeCacheEntry | null;
    if (positionCache.has(positionKey)) {
      cacheEntry = positionCache.get(positionKey)!;
    } else {
      try {
        cacheEntry = await d.repo.findLatestEpisode(normalizedWallet, fill.conditionId, fill.asset);
      } catch (err) {
        result.error = result.error ?? `findLatestEpisode failed: ${err instanceof Error ? err.message : "unknown error"}`;
        continue; // stays PENDING
      }
      positionCache.set(positionKey, cacheEntry);
    }

    // Task 13G (Codex re-review round 6, P1): checked immediately after findLatestEpisode
    // resolves (or the cache hit that skips it), before any of INVALID_FILL/DUPLICATE_FILL/
    // SELL_RECORDED-with-no-position's marker writes below can start -- that await (when
    // not cached) can run past the deadline even though earlier checks passed.
    if (d.now() >= deadlineAtMs) break;
    const decision = decideFill(eligibleFill, cacheEntry ? cacheEntry.state : null);

    if (decision.kind === "INVALID_FILL") {
      result.invalidRows += 1;
      try {
        await d.repo.markFillTerminal(fill.id, "TERMINAL_INVALID");
      } catch {
        // Best-effort; stays PENDING and is re-evaluated identically next poll.
      }
      continue;
    }
    if (decision.kind === "DUPLICATE_FILL") {
      result.duplicateRows += 1;
      try {
        await d.repo.markFillComplete(fill.id);
      } catch {
        // Best-effort; stays PENDING and is re-evaluated identically next poll.
      }
      continue;
    }
    if (decision.kind === "SELL_RECORDED") {
      result.sellRecordedCount += 1;
      if (decision.nextState && cacheEntry) {
        // Task 12F / P1-G, requirement E: re-verify ownership immediately before the
        // state-changing write, after whatever await (metadata fetch, findLatestEpisode)
        // preceded it this iteration -- a lease that was valid at the top of this
        // iteration may have been lost during that await. Task 13G / P1-R: the deadline
        // is re-checked here too -- CHECK BUDGET immediately before every mutating write,
        // not just at the top of the loop -- even though a fill left un-mutated is always
        // safe (stays PENDING, Task 12D/P1-A), this keeps the route's real worst-case
        // overrun as small as possible.
        if (d.now() >= deadlineAtMs) break;
        if (!(await d.checkpointLease())) {
          result.leaseLost = true;
          break;
        }
        // Task 13G (Codex re-review round 5, P1): checkpointLease can itself perform a
        // real renewal RPC -- re-checked immediately after it succeeds, before this
        // mutating write, so that await's own latency can never let the deadline check
        // above become stale (mirrors the identical fix already applied to the fetch and
        // metadata-fetch call sites).
        if (d.now() >= deadlineAtMs) break;
        try {
          await d.repo.updateEpisodeAtomic(fill.id, cacheEntry.id, decision.nextState, {
            shares: fill.shares,
            price: fill.price,
            notional: fill.price * fill.shares,
            sourceTs: fill.sourceTs,
          });
          positionCache.set(positionKey, { id: cacheEntry.id, state: decision.nextState });
        } catch (err) {
          result.error = result.error ?? `updateEpisodeAtomic (SELL_RECORDED) failed: ${err instanceof Error ? err.message : "unknown error"}`;
          // stays PENDING
        }
      } else {
        // FINAL BUILD Part 5: a sell with no known forward open position (isPreEpoch)
        // -- recorded distinctly (signal_id NULL) rather than silently just marking the
        // fill complete with no ledger evidence at all.
        try {
          if (decision.isPreEpoch) {
            await d.repo.recordPreEpochSell(fill.id, fill.shares, fill.price, fill.price * fill.shares, fill.sourceTs);
          } else {
            await d.repo.markFillComplete(fill.id);
          }
        } catch {
          // Best-effort; stays PENDING and is re-evaluated identically next poll.
        }
      }
      continue;
    }
    if (decision.kind === "AGGREGATED_BUY" || decision.kind === "LATE_RECONCILIATION") {
      if (decision.kind === "AGGREGATED_BUY") result.aggregatedCount += 1;
      else result.lateReconciliationCount += 1;
      if (cacheEntry) {
        // Task 13G / P1-R: CHECK BUDGET immediately before this mutating write too -- see
        // the identical comment on the SELL_RECORDED branch above.
        if (d.now() >= deadlineAtMs) break;
        if (!(await d.checkpointLease())) {
          result.leaseLost = true;
          break;
        }
        // Task 13G (Codex re-review round 5, P1): re-checked immediately after
        // checkpointLease succeeds -- see the identical comment on the SELL_RECORDED
        // branch above.
        if (d.now() >= deadlineAtMs) break;
        try {
          await d.repo.updateEpisodeAtomic(fill.id, cacheEntry.id, decision.nextState);
          positionCache.set(positionKey, { id: cacheEntry.id, state: decision.nextState });
        } catch (err) {
          result.error = result.error ?? `updateEpisodeAtomic failed: ${err instanceof Error ? err.message : "unknown error"}`;
          // stays PENDING
        }
      }
      continue;
    }

    // NEW_EPISODE | NEW_EPISODE_AFTER_30M
    const firstFillAtIso = new Date(fill.sourceTs * 1000).toISOString();
    const newRow: NewSignalRow = {
      episodeKey: decision.episodeKey,
      wallet: normalizedWallet,
      walletHandle: fill.walletHandle,
      conditionId: fill.conditionId,
      asset: fill.asset,
      firstFillAtIso,
      lastFillAtIso: firstFillAtIso,
      vwap: decision.nextState.vwap,
      shares: decision.nextState.totalShares,
      notional: decision.nextState.totalNotional,
      fillCount: decision.nextState.buyFillCount,
      sellSeen: decision.nextState.sellSeen,
      league: metadata.league ?? "MLB",
      scheduledStartAt: metadata.gameStartTime,
      awayTeam: metadata.awayTeam,
      homeTeam: metadata.homeTeam,
      betType: metadata.betType,
      selectedSide: fill.outcome ?? "UNKNOWN",
      line: metadata.line,
      sourceEventSlug: metadata.eventSlug,
      sourceMarketSlug: metadata.marketSlug,
      sourceOutcome: fill.outcome,
      experimentEpochId: d.epochId,
    };
    // Task 13G / P1-R: CHECK BUDGET immediately before this mutating write too -- see the
    // identical comment on the SELL_RECORDED branch above.
    if (d.now() >= deadlineAtMs) break;
    if (!(await d.checkpointLease())) {
      result.leaseLost = true;
      break;
    }
    // Task 13G (Codex re-review round 5, P1): re-checked immediately after
    // checkpointLease succeeds -- see the identical comment on the SELL_RECORDED branch
    // above.
    if (d.now() >= deadlineAtMs) break;
    try {
      const inserted = await d.repo.insertEpisodeAtomic(fill.id, newRow);
      positionCache.set(positionKey, { id: inserted.id, state: decision.nextState });
      result.newSignals.push({
        id: inserted.id,
        episodeKey: decision.episodeKey,
        wallet: normalizedWallet,
        conditionId: fill.conditionId,
        asset: fill.asset,
        betType: metadata.betType,
        selectedSide: newRow.selectedSide,
        line: metadata.line,
        awayTeam: metadata.awayTeam,
        homeTeam: metadata.homeTeam,
        scheduledStartAt: metadata.gameStartTime,
        sourceEventSlug: metadata.eventSlug,
        sourceMarketSlug: metadata.marketSlug,
        vwap: decision.nextState.vwap,
        shares: decision.nextState.totalShares,
        notional: decision.nextState.totalNotional,
        firstFillAtIso,
      });
    } catch (err) {
      result.error = result.error ?? `insertEpisodeAtomic failed: ${err instanceof Error ? err.message : "unknown error"}`;
      // stays PENDING
    }
  }

  return result;
}

function toRawFillRow(event: NormalizedEvent): RawFillRow {
  return {
    eventKey: event.eventKey,
    wallet: event.wallet,
    walletHandle: rawStr(event.raw, "name"),
    conditionId: event.conditionId,
    asset: event.asset,
    marketTitle: event.marketTitle,
    outcome: event.outcome,
    eventSlug: rawStr(event.raw, "eventSlug"),
    marketSlug: event.slug,
    side: event.side,
    shares: event.shares,
    price: event.price,
    sourceTs: event.sourceTs,
    identityBasis: event.identityBasis,
    identityDegraded: event.identityDegraded,
    raw: event.raw,
  };
}

function rawStr(raw: unknown, key: string): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = (raw as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}
