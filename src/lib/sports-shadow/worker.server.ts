/**
 * Sports Forward Shadow bounded worker orchestration — SERVER (DB/network) layer.
 *
 * One bounded, one-shot cycle (`runSportsShadowCycle`) meant to be invoked repeatedly by
 * an external scheduler at sub-minute cadence (see the route in
 * src/routes/api/public/hooks/sports-shadow.ts). No loop, no timer, no daemon lives here
 * — every call does a fixed, bounded amount of work and returns.
 *
 * Three independent lanes, each behind its own lease (see sports-lease.server.ts), so a
 * slow source/discovery pass can never block a later invocation's time-critical
 * observation capture, and (Task 12H/P1-N) so a slow/backlogged venue's observation work
 * can never block the other venue's:
 *   - OBSERVATION lanes, one PER VENUE (`OBSERVATION_LOCK_ID_PMUS` /
 *     `OBSERVATION_LOCK_ID_KALSHI`): each drains Task 8's existing durable due queue
 *     scoped to its own venue, bounded to a small row count so worst-case wall time
 *     stays comfortably inside its own lease TTL; run with bounded (exactly two calls)
 *     concurrency.
 *   - SOURCE/MATCHING lane (`SOURCE_LOCK_ID`): polls each configured wallet (fairly
 *     rotated — see Task 12D/P1-B below) through the EXISTING Task 10 poller, then
 *     recovers and resolves any signal (from this cycle OR any earlier, possibly
 *     crashed, cycle) still missing a PM-US or Kalshi match, independently PER VENUE
 *     (see Task 12D/P1-C below).
 *
 * Never imports depth-walk.ts (Task 9) — nothing here consumes it; no direct contract
 * requires it. Never writes observation rows directly — that remains exclusively Task
 * 8's job via persistVenueMatch/takeDueSportsShadowObservations.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import type { SportsShadowConfig } from "./config";
import { discoverKalshiMlbMarkets } from "./kalshi.server";
import type { KalshiCandidate } from "./kalshi";
import { persistVenueMatch, takeDueSportsShadowObservations, type ObservationDeps } from "./observation.server";
import { discoverPmusMlbMarkets } from "./pmus.server";
import type { PmusCandidate } from "./pmus";
import { resolveKalshiMatch, resolvePmusMatch, type MatchStatus, type VenueMatchResult } from "./resolver";
import {
  acquireSportsLease,
  createLeaseCheckpoint,
  releaseSportsLease,
  supabaseSportsLeaseRepository,
  type LeaseCheckpoint,
  type SportsLeaseRepository,
} from "./sports-lease.server";
import { pollSportsShadowWallet, supabasePollRepository, type WalletPollDeps, type WalletPollResult } from "./source-poll.server";
import type { BetType, Venue } from "./types";
import { PENDING_BATCH_SIZE, budgetExceeded, detectedAtMsFromSignal, nextRotationIndex, rotateWallets, toSourceSignal, type PendingSignal } from "./worker";

/** Task 12H / P1-N: split into per-venue lease ids — see runObservationLane's doc comment. */
export const OBSERVATION_LOCK_ID_PMUS = "sports_shadow_observations_pmus";
export const OBSERVATION_LOCK_ID_KALSHI = "sports_shadow_observations_kalshi";
export const SOURCE_LOCK_ID = "sports_shadow_source";

/**
 * ============================== OBSERVATION-LANE LATENCY AUDIT ==============================
 * takeDueSportsShadowObservations processes its bounded row batch strictly SEQUENTIALLY
 * (Task 8's own explicit design — never Promise.all), and each row's fetchPmusBook/
 * fetchKalshiBook call owns a fixed internal ~12s AbortController this module cannot
 * reach in from outside. Row COUNT alone (maxRows) therefore cannot bound worst-case
 * lane-hold time: 5 rows x up to ~12s each is genuinely up to ~60-65s, which would let
 * one slow pass monopolize its venue's observation lease for roughly a minute against a
 * scheduler intended to call this route every ~5s — unacceptable (this was the
 * mission's own TIMING_GATE finding; the original 90s-TTL/5-row design FAILED it).
 *
 * FIX: takeDueSportsShadowObservations was given an additive `deadlineAtMs` parameter
 * (checked ONLY between rows, never mid-fetch, so it cannot preempt a row already in
 * flight — see its own doc comment in observation.server.ts). What it bounds is the
 * NUMBER of further rows a pass STARTS once wall time is exhausted; anything not yet
 * reached is left completely untouched (observed_at stays null — the same
 * already-established "safe to retry" contract as a lost-CAS `skipped` row, never a
 * fabricated terminal failure). This turns the worst-case lane-hold time into
 * `OBSERVATION_STAGE_DEADLINE_MS + (one row's own worst-case ~12s)`, independent of
 * maxRows, instead of `maxRows * ~12s`.
 *
 * OBSERVATION_STAGE_DEADLINE_MS = 4s: real per-row latency is milliseconds (Task 8's own
 * measured ~350ms for dozens of concurrent books), so a normal fast pass still comfortably
 * processes all OBSERVATION_STAGE_MAX_ROWS rows inside 4s — this changes nothing about the
 * common case. It only caps the PATHOLOGICAL slow-network case: worst-case total hold
 * time is now ~4s + ~12s = ~16s, not ~60s.
 * OBSERVATION_LEASE_TTL_SECONDS = 25s: ~56% margin over that ~16s worst case (down from
 * the prior 90s, which was sized for the now-eliminated ~60s worst case).
 * ================================================================================
 */
export const OBSERVATION_LEASE_TTL_SECONDS = 25;
export const OBSERVATION_STAGE_MAX_ROWS = 5;
export const OBSERVATION_STAGE_DEADLINE_MS = 4_000;
/** Smaller cap and tighter deadline for the end-of-cycle "+0 catch" pass — a genuinely fresh +0 row is rare in any single invocation at sub-minute cadence, and this pass must not itself become a second ~16s worst-case hold. */
const FINAL_OBSERVATION_STAGE_MAX_ROWS = 3;
const FINAL_OBSERVATION_STAGE_DEADLINE_MS = 2_000;
/** Test-only alias so the final-pass deadline constant can be asserted directly. */
export const FINAL_OBSERVATION_STAGE_DEADLINE_MS_FOR_TEST = FINAL_OBSERVATION_STAGE_DEADLINE_MS;

/**
 * Typical steady-state completion (a short/empty page per wallet, or one reliable-key
 * overlap match) is fast. The 30s budget stops SCHEDULING further wallets once elapsed
 * exceeds it, leaving the remainder durable for the next cycle.
 *
 * Task 13F: this SAME deadline (laneStartMs + SOURCE_LANE_BUDGET_MS) is now ALSO threaded
 * into `pollSportsShadowWallet` as `deadlineAtMs` and checked between every page (Phase 1)
 * and every pending fill (Phase 2) WITHIN one wallet's own poll -- closing the gap a
 * production canary exposed: an already-in-flight wallet poll against a wallet with
 * substantial real trade history could previously run for 60-90+ real seconds, because
 * the 30s budget was only ever checked BETWEEN wallets, never within one. Stopping a
 * wallet's poll early this way is safe, not merely tolerated -- exactly like a lease
 * expiring mid-poll always was: Task 10's idempotent reconciliation against durable state
 * (see its own STABLE EVENT-KEY WINDOW-SHIFT AUDIT) means an interrupted poll's
 * already-fetched pages are durably persisted and safely picked back up (via the existing
 * overlap-detection mechanism) on the wallet's next rotation turn -- no new schema, no new
 * continuation cursor, just the same deadline this constant already represents, enforced
 * at a finer grain. This is still not a hard AbortSignal mid-single-HTTP-request (a page
 * fetch or metadata fetch already in flight when the deadline is noticed still completes,
 * up to its own 12s/10s timeout).
 *
 * Task 13G / P1-R (CORRECTED): the formula above (SOURCE_LANE_BUDGET_MS + one in-flight
 * request) was Codex-flagged as INCOMPLETE -- it ignored Phase 1's raw-fill persistence
 * step (previously unbounded sequential inserts) entirely. source-poll.server.ts now (a)
 * gates ALL persistence on `scanConfirmedComplete` -- an interrupted (deadline/lease-loss)
 * scan persists nothing, so it contributes ZERO wall time beyond the fetch phase's own
 * overrun; and (b) chunks a CONFIRMED-COMPLETE scan's persistence into PERSIST_BATCH_SIZE
 * (250-row) batches with a deadline check between batches. Because Phase 1's fetch loop,
 * Phase 1's persist loop, and Phase 2's pending-fill loop run SEQUENTIALLY within one
 * wallet's poll and each phase's own top-of-loop check sees the SAME already-passed
 * deadline once it fires, at most ONE of the three phases can have an operation in flight
 * when the shared laneDeadlineAtMs is reached -- their overruns do not stack. The real
 * worst-case PER-WALLET overrun beyond deadlineAtMs is therefore
 * max(one trades-page fetch ~12s, one PERSIST_BATCH_SIZE upsert round trip ~low seconds,
 * one metadata fetch ~10s) ~= 12s (the page-fetch timeout dominates), and since all wallets
 * in one lane share ONE deadline, only the wallet in flight when it fires can overrun --
 * earlier/later wallets' own top-of-poll checks stop them at/before the shared deadline.
 * DEFENSIBLE WORST CASE for the WALLET-POLLING PORTION of the source lane:
 * SOURCE_LANE_BUDGET_MS + ~12s ~= 42s. NORMAL EXPECTED runtime (steady-state, short
 * per-wallet gaps): low single-digit seconds for all 3 wallets combined.
 *
 * Task 13G / P1-Q (Codex re-review): bootstrap (a wallet's first-ever poll) is no longer a
 * fixed one-page operation -- it now shares the exact same MAX_PAGES_PER_WALLET ceiling as
 * steady-state resumption, walking as many pages as needed to prove the go-live boundary
 * has been crossed (see source-poll.server.ts's "FORWARD-ONLY BOOTSTRAP" doc comment).
 * This does NOT change the formula above: this deadline is checked before every page for
 * bootstrap and steady-state alike, so the same "at most one operation in flight when the
 * shared deadline fires" reasoning applies unchanged regardless of which of the two a
 * given wallet's poll happens to be.
 *
 * CONFIRMED, CREDIBLE, NOT YET FIXED (Codex re-review round 7) -- OUT OF TASK 13G's SCOPE:
 * `runSourceLane` does not end when the wallet-polling loop above does -- it goes on to
 * call `resolveVenuePending` for BOTH PMUS and KALSHI (see below), and NEITHER of those
 * calls receives `laneDeadlineAtMs` at all. `resolveVenuePending`'s own PM-US/Kalshi
 * discovery passes (pmus.server.ts/kalshi.server.ts, established in Task 12F/P1-G/P1-I)
 * can each walk multiple pages at up to ~12s per page, bounded only by LEASE ownership,
 * never by wall-clock deadline. This means the ~42s figure above is NOT the true worst
 * case for the full `runSourceLane` invocation -- venue matching afterward is a real,
 * currently-unbounded-by-deadline contributor that can add substantially more wall time.
 * Task 13G's own mission scope is specifically the SOURCE lane's completeness/timing
 * (source-poll.server.ts's P1-Q/P1-R) -- threading a deadline through `resolveVenuePending`
 * and the PM-US/Kalshi discovery functions in their own separate, already-tested files is a
 * distinct, differently-scoped change (analogous to Task 13F's original problem, but in a
 * different subsystem) deliberately left for a dedicated follow-up task rather than
 * expanded into here without the same care this task gave the source lane itself.
 */
export const SOURCE_LANE_BUDGET_MS = 30_000;
export const SOURCE_LEASE_TTL_SECONDS = 60;

const WALLET_CURSOR_ID = "source_wallet_rotation";

/* ------------------------------------------------------------------ */
/* Repository — Task 11B pending RPC (now per-venue, Task 12D/P1-C)      */
/* and the Task 12D/P1-B wallet rotation cursor                         */
/* ------------------------------------------------------------------ */

export type WorkerRepository = {
  /**
   * Backed by find_pending_sports_shadow_signals(p_venue, p_limit) — see
   * supabase/migrations/20260820230000_sports_shadow_pending_signals_rpc.sql. Returns
   * ONLY signals missing the ONE requested venue, ordered (created_at ASC, id ASC),
   * clamped. Calling this once per venue (never combined) is what makes a stuck/failing
   * venue's backlog structurally unable to consume the other venue's batch slots — see
   * this module's Task 12D/P1-C doc comment.
   */
  findPendingSignalsForVenue(venue: Venue, limit: number): Promise<PendingSignal[]>;
  /** Durable wallet-rotation cursor read, fresh every cycle — see Task 12D/P1-B. */
  getWalletCursor(): Promise<number>;
  /** Best-effort durable advance of the rotation cursor for the next cycle. */
  setWalletCursor(next: number): Promise<void>;
};

type RawPendingSignalRow = {
  id: string;
  created_at: string;
  source_first_fill_at: string;
  source_wallet: string;
  source_condition_id: string | null;
  source_asset: string;
  bet_type: BetType;
  away_team: string | null;
  home_team: string | null;
  scheduled_start_at: string | null;
  line: number | null;
  selected_side: string;
  source_event_slug: string | null;
  source_market_slug: string | null;
  missing_pmus: boolean;
  missing_kalshi: boolean;
};

/**
 * Cast `as never` on both the RPC name and params, and on the new sports_shadow_wallet_cursor
 * table — same established pattern as reserve_http_request_slot/record_http_rate_limit/
 * acquire_worker_lease: generated Supabase types lag these unapplied migrations.
 */
export const supabaseWorkerRepository: WorkerRepository = {
  async findPendingSignalsForVenue(venue, limit) {
    const { data, error } = await supabaseAdmin.rpc("find_pending_sports_shadow_signals" as never, { p_venue: venue, p_limit: limit } as never);
    if (error) throw new Error(error.message);
    return ((data ?? []) as unknown as RawPendingSignalRow[]).map((r) => ({
      id: r.id,
      createdAtIso: r.created_at,
      sourceFirstFillAtIso: r.source_first_fill_at,
      wallet: r.source_wallet,
      conditionId: r.source_condition_id,
      asset: r.source_asset,
      betType: r.bet_type,
      awayTeam: r.away_team,
      homeTeam: r.home_team,
      scheduledStartAt: r.scheduled_start_at,
      line: r.line,
      selectedOutcomeRaw: r.selected_side,
      eventSlug: r.source_event_slug,
      marketSlug: r.source_market_slug,
      missingPmus: r.missing_pmus,
      missingKalshi: r.missing_kalshi,
    }));
  },

  async getWalletCursor() {
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_wallet_cursor" as never)
      .select("next_wallet_index")
      .eq("id", WALLET_CURSOR_ID)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as unknown as { next_wallet_index: number } | null)?.next_wallet_index ?? 0;
  },

  async setWalletCursor(next) {
    const { error } = await supabaseAdmin
      .from("sports_shadow_wallet_cursor" as never)
      .update({ next_wallet_index: next, updated_at: new Date().toISOString() } as never)
      .eq("id", WALLET_CURSOR_ID);
    if (error) throw new Error(error.message);
  },
};

/* ------------------------------------------------------------------ */
/* Deps                                                                 */
/* ------------------------------------------------------------------ */

export type SportsShadowWorkerDeps = {
  leaseRepo: SportsLeaseRepository;
  workerRepo: WorkerRepository;
  observationDeps: Partial<ObservationDeps>;
  sourcePollDeps: Partial<WalletPollDeps>;
  discoverPmus: typeof discoverPmusMlbMarkets;
  discoverKalshi: typeof discoverKalshiMlbMarkets;
  persistVenueMatch: typeof persistVenueMatch;
  takeDueSportsShadowObservations: typeof takeDueSportsShadowObservations;
  pollSportsShadowWallet: typeof pollSportsShadowWallet;
  now: () => number;
};

const defaultDeps: SportsShadowWorkerDeps = {
  leaseRepo: supabaseSportsLeaseRepository,
  workerRepo: supabaseWorkerRepository,
  observationDeps: {},
  sourcePollDeps: { repo: supabasePollRepository },
  discoverPmus: discoverPmusMlbMarkets,
  discoverKalshi: discoverKalshiMlbMarkets,
  persistVenueMatch,
  takeDueSportsShadowObservations,
  pollSportsShadowWallet,
  now: () => Date.now(),
};

/* ------------------------------------------------------------------ */
/* Telemetry shapes                                                     */
/* ------------------------------------------------------------------ */

export type ObservationLaneResult = {
  acquired: boolean;
  attempted: number;
  captured: number;
  failed: number;
  skipped: number;
};

/** Task 12H / P1-N: per-venue observation lane results — see runObservationLane's doc comment for why PM-US and Kalshi each get their own independent lane. */
export type PerVenueObservationResult = { pmus: ObservationLaneResult; kalshi: ObservationLaneResult };

export type WalletSummary = {
  wallet: string;
  isBootstrap: boolean;
  newSignals: number;
  backlogTruncated: boolean;
  orphanedFillsRecovered: number;
  error: string | null;
};

export type VenueResolutionSummary = {
  pendingFound: number;
  pendingProcessed: number;
  /** True when pendingFound === the bounded per-venue batch size — more pending work for THIS venue may exist beyond this cycle's batch. */
  pendingRemainingHint: boolean;
  attempted: number;
  exact: number;
  near: number;
  none: number;
  unverified: number;
  discoveryFailed: boolean;
  errors: number;
  /** Task 12F / P1-G: true when the source lease checkpoint reported the lease lost partway through this venue's resolution — remaining pending signals for this venue were left untouched this cycle, safely retryable. */
  leaseLost: boolean;
};

export type SourceLaneResult = {
  acquired: boolean;
  /** The durable rotation cursor value this cycle started from — see Task 12D/P1-B. */
  walletRotationStartIndex: number;
  walletsAttempted: number;
  walletSummaries: WalletSummary[];
  newSignalsCreated: number;
  pmus: VenueResolutionSummary;
  kalshi: VenueResolutionSummary;
  /** Task 12F / P1-G: true when the source lease was lost at any point this cycle (during a wallet poll or venue resolution) — the lane stopped starting new work immediately once detected. */
  leaseLost: boolean;
};

export type SportsShadowCycleSummary = {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  configEnabled: boolean;
  walletCount: number;
  observationLane: PerVenueObservationResult;
  sourceLane: SourceLaneResult | null;
  finalObservationPass: PerVenueObservationResult;
  errors: string[];
};

function emptyObservationResult(): ObservationLaneResult {
  return { acquired: false, attempted: 0, captured: 0, failed: 0, skipped: 0 };
}

function emptyPerVenueObservationResult(): PerVenueObservationResult {
  return { pmus: emptyObservationResult(), kalshi: emptyObservationResult() };
}

function emptyVenueSummary(): VenueResolutionSummary {
  return { pendingFound: 0, pendingProcessed: 0, pendingRemainingHint: false, attempted: 0, exact: 0, near: 0, none: 0, unverified: 0, discoveryFailed: false, errors: 0, leaseLost: false };
}

function emptySourceLaneResult(acquired: boolean): SourceLaneResult {
  return {
    acquired,
    walletRotationStartIndex: 0,
    walletsAttempted: 0,
    walletSummaries: [],
    newSignalsCreated: 0,
    pmus: emptyVenueSummary(),
    kalshi: emptyVenueSummary(),
    leaseLost: false,
  };
}

function tallyVenue(summary: VenueResolutionSummary, status: MatchStatus): void {
  if (status === "EXACT") summary.exact += 1;
  else if (status === "NEAR") summary.near += 1;
  else if (status === "NONE") summary.none += 1;
  else summary.unverified += 1;
}

function randomWorkerId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ------------------------------------------------------------------ */
/* Observation lane                                                     */
/* ------------------------------------------------------------------ */

/**
 * ============================== TASK 12H / P1-N: PER-VENUE OBSERVATION ISOLATION ==============================
 * ROOT CAUSE (Codex P1 finding): a single shared OBSERVATION_LOCK_ID/due-query pooled
 * PM-US and Kalshi rows into one globally-bounded batch. A backlog of old PM-US rows
 * (each up to a 12s fetch timeout) could fill the whole batch and/or exhaust the whole
 * per-pass deadline before a healthy, due Kalshi row was ever reached -- inflating
 * Kalshi's recorded lateness for a reason having nothing to do with Kalshi itself.
 *
 * FIX: PM-US and Kalshi each get their OWN fenced lease (OBSERVATION_LOCK_ID_PMUS /
 * OBSERVATION_LOCK_ID_KALSHI) and their OWN bounded due-observation query (see
 * observation.server.ts's findDueObservations(venue, ...)), invoked here as exactly two
 * fixed, known calls via Promise.all -- bounded by construction, never an unbounded fan-out
 * -- so a slow/backlogged PM-US lane can never delay Kalshi's lane from even starting.
 * WITHIN each venue's own lane, rows are still processed strictly sequentially (Task 8's
 * own explicit design, unchanged) -- only the cross-venue relationship changed.
 * ================================================================================
 */
async function runObservationLane(venue: Venue, lockId: string, d: SportsShadowWorkerDeps, maxRows: number, deadlineBudgetMs: number, errors: string[]): Promise<ObservationLaneResult> {
  const lease = await acquireSportsLease(lockId, randomWorkerId(`sports-obs-${venue.toLowerCase()}`), OBSERVATION_LEASE_TTL_SECONDS, d.leaseRepo);
  if (lease === null) {
    // Lock held by another still-live invocation. Never wait, never bypass -- just skip
    // this pass; a subsequent scheduler tick handles it, with real lateness reflected in
    // observed_at (Task 8 owns that, not this module).
    return emptyObservationResult();
  }
  try {
    const deadlineAtMs = d.now() + deadlineBudgetMs;
    const result = await d.takeDueSportsShadowObservations(venue, d.observationDeps, maxRows, deadlineAtMs);
    await releaseSportsLease(lease, { state: "idle", lastError: null }, d.leaseRepo);
    return { acquired: true, attempted: result.captured + result.failed + result.skipped, captured: result.captured, failed: result.failed, skipped: result.skipped };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    errors.push(`${venue} observation lane failed: ${message}`);
    await releaseSportsLease(lease, { state: "error", lastError: message }, d.leaseRepo);
    return { acquired: true, attempted: 0, captured: 0, failed: 0, skipped: 0 };
  }
}

/** Runs BOTH venues' observation lanes with bounded (exactly-two-call) concurrency, so a slow PM-US lane can never delay Kalshi's lane from starting -- see runObservationLane's own doc comment. */
async function runObservationLanesForBothVenues(d: SportsShadowWorkerDeps, maxRows: number, deadlineBudgetMs: number, errors: string[]): Promise<PerVenueObservationResult> {
  const [pmus, kalshi] = await Promise.all([
    runObservationLane("PMUS", OBSERVATION_LOCK_ID_PMUS, d, maxRows, deadlineBudgetMs, errors),
    runObservationLane("KALSHI", OBSERVATION_LOCK_ID_KALSHI, d, maxRows, deadlineBudgetMs, errors),
  ]);
  return { pmus, kalshi };
}

/* ------------------------------------------------------------------ */
/* Source / matching lane                                              */
/* ------------------------------------------------------------------ */

/**
 * ============================== TASK 12D / P1-C: PER-VENUE PENDING FAIRNESS ==============================
 * ROOT CAUSE (Codex P1 finding): the original combined query
 * (`WHERE pmus_match.id IS NULL OR kalshi_match.id IS NULL`) pooled both venues into ONE
 * globally-bounded batch. A sustained PMUS outage meant the oldest PMUS-missing signals
 * occupied every one of the batch's slots, cycle after cycle — even though NEWER signals
 * only missing Kalshi could resolve right now, independently. Structurally identical to
 * the #201 starvation defect Task 11B fixed, recurring one level down.
 *
 * FIX: resolveVenuePending is called ONCE PER VENUE, each backed by its own bounded
 * `findPendingSignalsForVenue` call and its own independent discovery/resolve/persist
 * pass. A PMUS discovery failure returns early for PMUS ONLY (nothing for PMUS is
 * resolved or persisted this cycle, left retryable) and never touches Kalshi's
 * processing at all — the two are fully separate, sequential calls with no shared
 * short-circuit between them.
 * ================================================================================
 */
async function resolveVenuePending(venue: Venue, d: SportsShadowWorkerDeps, errors: string[], checkpoint: LeaseCheckpoint): Promise<VenueResolutionSummary> {
  const summary = emptyVenueSummary();

  // Task 12F / P1-G: do not even query pending work once the lease is already known lost
  // — "stop starting new source/matching work immediately" applies to PM-US/Kalshi
  // resolution exactly as it does to wallet polling.
  if (!(await checkpoint())) {
    summary.leaseLost = true;
    return summary;
  }

  let pending: PendingSignal[];
  try {
    pending = await d.workerRepo.findPendingSignalsForVenue(venue, PENDING_BATCH_SIZE);
  } catch (err) {
    errors.push(`${venue} pending query failed: ${err instanceof Error ? err.message : "unknown error"}`);
    return summary;
  }
  summary.pendingFound = pending.length;
  summary.pendingRemainingHint = pending.length >= PENDING_BATCH_SIZE;
  if (pending.length === 0) return summary;

  let pmusCandidates: PmusCandidate[] = [];
  let kalshiCandidates: KalshiCandidate[] = [];
  try {
    // Task 12F / P1-G: threaded into discovery so a slow multi-page PM-US/Kalshi
    // discovery pass (up to 12s per page) checks ownership between pages too, not just
    // at this call boundary. Task 12F / P1-I: a malformed discovery envelope now THROWS
    // (see pmus.server.ts/kalshi.server.ts) rather than silently degrading to an empty
    // catalog, which this existing catch already correctly treats as discoveryFailed --
    // the entire venue left retryable, never converted into a semantic NONE.
    if (venue === "PMUS") pmusCandidates = await d.discoverPmus({ checkpointLease: checkpoint });
    else kalshiCandidates = await d.discoverKalshi({ checkpointLease: checkpoint });
  } catch (err) {
    summary.discoveryFailed = true;
    errors.push(`${venue} discovery failed: ${err instanceof Error ? err.message : "unknown error"}`);
    return summary; // entire venue left retryable this cycle -- never converted into a semantic NONE
  }

  for (const signal of pending) {
    // Task 12F / P1-G: checked before EACH signal's persist -- the exact same
    // "verify ownership again after a potentially long await" requirement as
    // source-poll.server.ts's phase-2 loop.
    if (!(await checkpoint())) {
      summary.leaseLost = true;
      break;
    }
    const source = toSourceSignal(signal);
    if (!source) continue; // missing conditionId -- should not happen for a Task-10-persisted signal; left pending rather than fabricated
    const detectedAtMs = detectedAtMsFromSignal(signal);
    summary.attempted += 1;
    try {
      const result: VenueMatchResult = venue === "PMUS" ? resolvePmusMatch(source, pmusCandidates) : resolveKalshiMatch(source, kalshiCandidates);
      await d.persistVenueMatch(signal.id, result, detectedAtMs, signal.sourceFirstFillAtIso, signal.scheduledStartAt, d.observationDeps);
      tallyVenue(summary, result.status);
      summary.pendingProcessed += 1;
    } catch (err) {
      summary.errors += 1;
      errors.push(`signal ${signal.id} ${venue} resolve/persist failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  return summary;
}

async function runSourceLane(config: SportsShadowConfig, d: SportsShadowWorkerDeps, errors: string[], checkpoint: LeaseCheckpoint): Promise<SourceLaneResult> {
  let startIndex = 0;
  try {
    startIndex = await d.workerRepo.getWalletCursor();
  } catch (err) {
    errors.push(`wallet cursor read failed: ${err instanceof Error ? err.message : "unknown error"}`); // falls back to 0 -- safe, just temporarily less fair
  }
  const orderedWallets = rotateWallets(config.wallets, startIndex);

  const walletSummaries: WalletSummary[] = [];
  let newSignalsCreated = 0;
  let walletsAttempted = 0;
  let leaseLost = false;
  const laneStartMs = d.now();
  // Task 13F: the SAME lane-level deadline now bounds each wallet's OWN poll internally
  // too (see SOURCE_LANE_BUDGET_MS's doc comment) -- not just whether to start the next one.
  const laneDeadlineAtMs = laneStartMs + SOURCE_LANE_BUDGET_MS;

  for (const wallet of orderedWallets) {
    if (budgetExceeded(d.now() - laneStartMs, SOURCE_LANE_BUDGET_MS)) break; // remaining wallets stay durable for the next cycle -- and the rotation cursor below advances only past what WAS attempted, so they are tried FIRST next cycle
    // Task 12F / P1-G: "do not continue another wallet" once the lease is lost.
    if (!(await checkpoint())) {
      leaseLost = true;
      break;
    }
    // Task 13G (Codex re-review round 7, P1): checkpoint() can itself perform a real
    // lease-renewal RPC -- re-checked immediately after it succeeds, before starting the
    // next wallet's poll (whose own first operation, hasAnyFillsForWallet, is a DB call
    // with no deadline check of its own before it), mirroring the identical renewal-
    // latency fix already applied throughout source-poll.server.ts.
    if (budgetExceeded(d.now() - laneStartMs, SOURCE_LANE_BUDGET_MS)) break;
    try {
      const result: WalletPollResult = await d.pollSportsShadowWallet(wallet, config.goLiveAtMs, { ...d.sourcePollDeps, checkpointLease: checkpoint }, laneDeadlineAtMs);
      newSignalsCreated += result.newSignals.length;
      walletSummaries.push({
        wallet: result.wallet,
        isBootstrap: result.isBootstrap,
        newSignals: result.newSignals.length,
        backlogTruncated: result.backlogTruncated,
        orphanedFillsRecovered: result.orphanedFillsRecovered,
        error: result.error,
      });
      if (result.error) errors.push(`wallet ${wallet}: ${result.error}`);
      walletsAttempted += 1;
      if (result.leaseLost) {
        leaseLost = true;
        break; // do not continue another wallet
      }
    } catch (err) {
      // One bad wallet must not prevent the next wallet when budget allows.
      const message = err instanceof Error ? err.message : "unknown error";
      walletSummaries.push({ wallet, isBootstrap: false, newSignals: 0, backlogTruncated: false, orphanedFillsRecovered: 0, error: message });
      errors.push(`wallet ${wallet} poll threw: ${message}`);
      walletsAttempted += 1;
    }
  }

  try {
    const next = nextRotationIndex(startIndex, walletsAttempted, config.wallets.length);
    await d.workerRepo.setWalletCursor(next);
  } catch (err) {
    // Best-effort: a failed cursor write just means fairness does not advance THIS
    // cycle -- the next cycle reads the same (stale) startIndex and tries again, no
    // worse than the pre-Task-12D behavior, never a crash or lost work. Cursor
    // advancement itself is idempotent-safe bookkeeping, not an episode mutation, so it
    // is written regardless of leaseLost -- it only ever reflects how many wallets were
    // ATTEMPTED, which remains true even if the lease was lost partway through.
    errors.push(`wallet cursor write failed: ${err instanceof Error ? err.message : "unknown error"}`);
  }

  // Task 12F / P1-G: "do not continue PM-US/Kalshi resolution" once the lease is lost --
  // resolveVenuePending's own leading checkpoint would catch this too, but skipping the
  // calls entirely avoids two pointless DB round trips when the outcome is already known.
  const pmus = leaseLost ? emptyVenueSummary() : await resolveVenuePending("PMUS", d, errors, checkpoint);
  if (pmus.leaseLost) leaseLost = true;
  const kalshi = leaseLost ? emptyVenueSummary() : await resolveVenuePending("KALSHI", d, errors, checkpoint);
  if (kalshi.leaseLost) leaseLost = true;

  return {
    acquired: true,
    walletRotationStartIndex: startIndex,
    walletsAttempted,
    walletSummaries,
    newSignalsCreated,
    pmus,
    kalshi,
    leaseLost,
  };
}

/* ------------------------------------------------------------------ */
/* Cycle orchestration                                                  */
/* ------------------------------------------------------------------ */

/**
 * One bounded sports-shadow cycle. Config is validated by the caller (see the route)
 * BEFORE this is invoked — an already-invalid config never reaches here; `config.enabled
 * === false` is the only "do nothing" path handled internally, so this function is safe
 * to call directly from tests with a hand-built config.
 */
export async function runSportsShadowCycle(config: SportsShadowConfig, deps: Partial<SportsShadowWorkerDeps> = {}): Promise<SportsShadowCycleSummary> {
  const d: SportsShadowWorkerDeps = { ...defaultDeps, ...deps };
  const startedAtMs = d.now();
  const errors: string[] = [];

  if (!config.enabled) {
    const completedAtMs = d.now();
    return {
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: completedAtMs - startedAtMs,
      configEnabled: false,
      walletCount: 0,
      observationLane: emptyPerVenueObservationResult(),
      sourceLane: null,
      finalObservationPass: emptyPerVenueObservationResult(),
      errors,
    };
  }

  // LANE A: observation, highest priority, always attempted first. Task 12H/P1-N: both
  // venues run with bounded (exactly-two-call) concurrency so neither can delay the other.
  const observationLane = await runObservationLanesForBothVenues(d, OBSERVATION_STAGE_MAX_ROWS, OBSERVATION_STAGE_DEADLINE_MS, errors);

  // LANE B: source/matching, behind its own independent lease.
  let sourceLane: SourceLaneResult;
  const sourceLease = await acquireSportsLease(SOURCE_LOCK_ID, randomWorkerId("sports-source"), SOURCE_LEASE_TTL_SECONDS, d.leaseRepo);
  if (sourceLease === null) {
    sourceLane = emptySourceLaneResult(false);
  } else {
    // Task 12F / P1-G: one checkpoint, created fresh from THIS cycle's freshly-acquired
    // lease/fence, shared across the entire source lane (every wallet poll + both venues'
    // resolution) so its "time since last renewal" state is meaningful lane-wide, not
    // reset per wallet.
    const checkpoint = createLeaseCheckpoint(sourceLease, SOURCE_LEASE_TTL_SECONDS, d.leaseRepo, d.now);
    try {
      sourceLane = await runSourceLane(config, d, errors, checkpoint);
      await releaseSportsLease(sourceLease, { state: "idle", lastError: null }, d.leaseRepo);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      errors.push(`source lane failed: ${message}`);
      await releaseSportsLease(sourceLease, { state: "error", lastError: message }, d.leaseRepo);
      sourceLane = emptySourceLaneResult(true);
    }
  }

  // Final +0 catch pass: an EXACT match may have just scheduled its +0 row. If a venue's
  // observation lease is held elsewhere, that venue simply returns without waiting/bypassing.
  const finalObservationPass = await runObservationLanesForBothVenues(d, FINAL_OBSERVATION_STAGE_MAX_ROWS, FINAL_OBSERVATION_STAGE_DEADLINE_MS, errors);

  const completedAtMs = d.now();
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: completedAtMs - startedAtMs,
    configEnabled: true,
    walletCount: config.wallets.length,
    observationLane,
    sourceLane,
    finalObservationPass,
    errors,
  };
}
