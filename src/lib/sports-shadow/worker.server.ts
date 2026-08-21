/**
 * Sports Forward Shadow bounded worker orchestration — SERVER (DB/network) layer.
 *
 * One bounded, one-shot cycle (`runSportsShadowCycle`) meant to be invoked repeatedly by
 * an external scheduler at sub-minute cadence (see the route in
 * src/routes/api/public/hooks/sports-shadow.ts). No loop, no timer, no daemon lives here
 * — every call does a fixed, bounded amount of work and returns.
 *
 * Two independent lanes, each behind its own lease (see sports-lease.server.ts), so a
 * slow source/discovery pass can never block a later invocation's time-critical
 * observation capture:
 *   - OBSERVATION lane (`OBSERVATION_LOCK_ID`): drains Task 8's existing durable due
 *     queue, bounded to a small row count so its worst-case wall time stays comfortably
 *     inside its own lease TTL.
 *   - SOURCE/MATCHING lane (`SOURCE_LOCK_ID`): polls each configured wallet through the
 *     EXISTING Task 10 poller, then recovers and resolves any signal (from this cycle OR
 *     any earlier, possibly crashed, cycle) still missing a PM-US or Kalshi match.
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
import { resolveKalshiMatch, resolvePmusMatch, type MatchStatus } from "./resolver";
import { acquireSportsLease, releaseSportsLease, supabaseSportsLeaseRepository, type SportsLeaseRepository } from "./sports-lease.server";
import { pollSportsShadowWallet, supabasePollRepository, type WalletPollDeps, type WalletPollResult } from "./source-poll.server";
import type { BetType, Venue } from "./types";
import {
  PENDING_BATCH_SIZE,
  PENDING_SCAN_WINDOW,
  budgetExceeded,
  derivePendingSignals,
  detectedAtMsFromSignal,
  toSourceSignal,
  type ExistingMatchRow,
  type PendingSignal,
  type SignalRow,
} from "./worker";

export const OBSERVATION_LOCK_ID = "sports_shadow_observations";
export const SOURCE_LOCK_ID = "sports_shadow_source";

/**
 * ============================== OBSERVATION-LANE LATENCY AUDIT ==============================
 * takeDueSportsShadowObservations processes its bounded row batch strictly SEQUENTIALLY
 * (Task 8's own explicit design — never Promise.all), and each row's fetchPmusBook/
 * fetchKalshiBook call owns a fixed internal ~12s AbortController this module cannot
 * reach in from outside. Row COUNT alone (maxRows) therefore cannot bound worst-case
 * lane-hold time: 5 rows x up to ~12s each is genuinely up to ~60-65s, which would let
 * one slow pass monopolize `OBSERVATION_LOCK_ID` for roughly a minute against a
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
 * overlap match) is fast. The 30s inter-wallet budget only stops SCHEDULING further
 * wallets once elapsed exceeds it, leaving the remainder durable for the next cycle — it
 * cannot abort a wallet poll already in flight (pollSportsShadowWallet has no internal
 * AbortSignal). That is safe, not merely tolerated: Task 10 is explicitly designed so an
 * overlapping/duplicated poll reconciles idempotently against durable state (see its own
 * STABLE EVENT-KEY WINDOW-SHIFT AUDIT), so even a lease expiring mid-poll never corrupts
 * anything — the worst outcome is wasted duplicate work, never a wrong result.
 */
export const SOURCE_LANE_BUDGET_MS = 30_000;
export const SOURCE_LEASE_TTL_SECONDS = 60;

/* ------------------------------------------------------------------ */
/* Pending-signal repository (raw durable reads, delegates derivation to worker.ts) */
/* ------------------------------------------------------------------ */

export type WorkerRepository = {
  fetchRecentSignals(scanWindow: number): Promise<SignalRow[]>;
  fetchExistingMatches(signalIds: string[]): Promise<ExistingMatchRow[]>;
};

type RawSignalRow = {
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
};

/**
 * Two flat, straightforward queries (never an embedded PostgREST join, per the mission's
 * explicit "given the existing standing integration risk around complex embedded joins,
 * use straightforward queries if possible"). No new table: durable pending work is fully
 * expressible as "a signal in sports_shadow_signals with no corresponding row in
 * sports_market_matches for a given venue."
 */
export const supabaseWorkerRepository: WorkerRepository = {
  async fetchRecentSignals(scanWindow) {
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_signals" as never)
      .select(
        "id, created_at, source_first_fill_at, source_wallet, source_condition_id, source_asset, bet_type, away_team, home_team, scheduled_start_at, line, selected_side, source_event_slug, source_market_slug",
      )
      .order("created_at", { ascending: true })
      .limit(scanWindow);
    if (error) throw new Error(error.message);
    return ((data ?? []) as unknown as RawSignalRow[]).map((r) => ({
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
    }));
  },

  async fetchExistingMatches(signalIds) {
    if (signalIds.length === 0) return [];
    const { data, error } = await supabaseAdmin
      .from("sports_market_matches" as never)
      .select("signal_id, venue")
      .in("signal_id", signalIds);
    if (error) throw new Error(error.message);
    return ((data ?? []) as unknown as { signal_id: string; venue: Venue }[]).map((r) => ({ signalId: r.signal_id, venue: r.venue }));
  },
};

export async function findPendingSignals(
  repo: WorkerRepository,
  scanWindow: number = PENDING_SCAN_WINDOW,
  batchSize: number = PENDING_BATCH_SIZE,
): Promise<PendingSignal[]> {
  const signals = await repo.fetchRecentSignals(scanWindow);
  const matches = await repo.fetchExistingMatches(signals.map((s) => s.id));
  return derivePendingSignals(signals, matches, batchSize);
}

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

export type WalletSummary = {
  wallet: string;
  isBootstrap: boolean;
  newSignals: number;
  backlogTruncated: boolean;
  error: string | null;
};

export type VenueResolutionSummary = {
  attempted: number;
  exact: number;
  near: number;
  none: number;
  unverified: number;
  discoveryFailed: boolean;
  errors: number;
};

export type SourceLaneResult = {
  acquired: boolean;
  walletsAttempted: number;
  walletSummaries: WalletSummary[];
  newSignalsCreated: number;
  pendingFound: number;
  pendingProcessed: number;
  /** True when pendingFound === the bounded batch size — more pending work may exist beyond this cycle's batch. */
  pendingRemainingHint: boolean;
  pmus: VenueResolutionSummary;
  kalshi: VenueResolutionSummary;
};

export type SportsShadowCycleSummary = {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  configEnabled: boolean;
  walletCount: number;
  observationLane: ObservationLaneResult;
  sourceLane: SourceLaneResult | null;
  finalObservationPass: ObservationLaneResult;
  errors: string[];
};

function emptyObservationResult(): ObservationLaneResult {
  return { acquired: false, attempted: 0, captured: 0, failed: 0, skipped: 0 };
}

function emptyVenueSummary(): VenueResolutionSummary {
  return { attempted: 0, exact: 0, near: 0, none: 0, unverified: 0, discoveryFailed: false, errors: 0 };
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

async function runObservationLane(d: SportsShadowWorkerDeps, maxRows: number, deadlineBudgetMs: number, errors: string[]): Promise<ObservationLaneResult> {
  const lease = await acquireSportsLease(OBSERVATION_LOCK_ID, randomWorkerId("sports-obs"), OBSERVATION_LEASE_TTL_SECONDS, d.leaseRepo);
  if (lease === null) {
    // Lock held by another still-live invocation. Never wait, never bypass -- just skip
    // this pass; a subsequent scheduler tick handles it, with real lateness reflected in
    // observed_at (Task 8 owns that, not this module).
    return emptyObservationResult();
  }
  try {
    const deadlineAtMs = d.now() + deadlineBudgetMs;
    const result = await d.takeDueSportsShadowObservations(d.observationDeps, maxRows, deadlineAtMs);
    await releaseSportsLease(lease, { state: "idle", lastError: null }, d.leaseRepo);
    return { acquired: true, attempted: result.captured + result.failed + result.skipped, captured: result.captured, failed: result.failed, skipped: result.skipped };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    errors.push(`observation lane failed: ${message}`);
    await releaseSportsLease(lease, { state: "error", lastError: message }, d.leaseRepo);
    return { acquired: true, attempted: 0, captured: 0, failed: 0, skipped: 0 };
  }
}

/* ------------------------------------------------------------------ */
/* Source / matching lane                                              */
/* ------------------------------------------------------------------ */

async function runSourceLane(config: SportsShadowConfig, d: SportsShadowWorkerDeps, errors: string[]): Promise<SourceLaneResult> {
  const walletSummaries: WalletSummary[] = [];
  let newSignalsCreated = 0;
  const laneStartMs = d.now();

  for (const wallet of config.wallets) {
    if (budgetExceeded(d.now() - laneStartMs, SOURCE_LANE_BUDGET_MS)) break; // remaining wallets stay durable for the next cycle
    try {
      const result: WalletPollResult = await d.pollSportsShadowWallet(wallet, config.goLiveAtMs, d.sourcePollDeps);
      newSignalsCreated += result.newSignals.length;
      walletSummaries.push({ wallet: result.wallet, isBootstrap: result.isBootstrap, newSignals: result.newSignals.length, backlogTruncated: result.backlogTruncated, error: result.error });
      if (result.error) errors.push(`wallet ${wallet}: ${result.error}`);
    } catch (err) {
      // One bad wallet must not prevent the next wallet when budget allows.
      const message = err instanceof Error ? err.message : "unknown error";
      walletSummaries.push({ wallet, isBootstrap: false, newSignals: 0, backlogTruncated: false, error: message });
      errors.push(`wallet ${wallet} poll threw: ${message}`);
    }
  }

  // Durable pending-signal recovery: re-derived fresh from the database every cycle, so
  // a signal orphaned by a crash between persist and resolution (this cycle's OR any
  // earlier cycle's) is found here exactly the same way a same-cycle new signal is.
  const pending = await findPendingSignals(d.workerRepo, PENDING_SCAN_WINDOW, PENDING_BATCH_SIZE);

  const needsPmus = pending.some((p) => p.missingPmus);
  const needsKalshi = pending.some((p) => p.missingKalshi);

  let pmusCandidates: PmusCandidate[] = [];
  let pmusDiscoveryFailed = false;
  if (needsPmus) {
    try {
      pmusCandidates = await d.discoverPmus();
    } catch (err) {
      pmusDiscoveryFailed = true;
      errors.push(`PMUS discovery failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  let kalshiCandidates: KalshiCandidate[] = [];
  let kalshiDiscoveryFailed = false;
  if (needsKalshi) {
    try {
      kalshiCandidates = await d.discoverKalshi();
    } catch (err) {
      kalshiDiscoveryFailed = true;
      errors.push(`Kalshi discovery failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  const pmus = emptyVenueSummary();
  pmus.discoveryFailed = pmusDiscoveryFailed;
  const kalshi = emptyVenueSummary();
  kalshi.discoveryFailed = kalshiDiscoveryFailed;

  let pendingProcessed = 0;
  for (const signal of pending) {
    const source = toSourceSignal(signal);
    if (!source) continue; // missing conditionId -- should not happen for a Task-10-persisted signal; left pending rather than fabricated
    const detectedAtMs = detectedAtMsFromSignal(signal);
    let touchedThisSignal = false;

    // PMUS and Kalshi are resolved and persisted fully independently: a PMUS failure
    // must never prevent a Kalshi result for the same signal, and vice versa.
    if (signal.missingPmus && !pmusDiscoveryFailed) {
      touchedThisSignal = true;
      pmus.attempted += 1;
      try {
        const result = resolvePmusMatch(source, pmusCandidates);
        await d.persistVenueMatch(signal.id, result, detectedAtMs, signal.sourceFirstFillAtIso, d.observationDeps);
        tallyVenue(pmus, result.status);
      } catch (err) {
        pmus.errors += 1;
        errors.push(`signal ${signal.id} PMUS resolve/persist failed: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }

    if (signal.missingKalshi && !kalshiDiscoveryFailed) {
      touchedThisSignal = true;
      kalshi.attempted += 1;
      try {
        const result = resolveKalshiMatch(source, kalshiCandidates);
        await d.persistVenueMatch(signal.id, result, detectedAtMs, signal.sourceFirstFillAtIso, d.observationDeps);
        tallyVenue(kalshi, result.status);
      } catch (err) {
        kalshi.errors += 1;
        errors.push(`signal ${signal.id} Kalshi resolve/persist failed: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }

    if (touchedThisSignal) pendingProcessed += 1;
  }

  return {
    acquired: true,
    walletsAttempted: walletSummaries.length,
    walletSummaries,
    newSignalsCreated,
    pendingFound: pending.length,
    pendingProcessed,
    pendingRemainingHint: pending.length >= PENDING_BATCH_SIZE,
    pmus,
    kalshi,
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
      observationLane: emptyObservationResult(),
      sourceLane: null,
      finalObservationPass: emptyObservationResult(),
      errors,
    };
  }

  // LANE A: observation, highest priority, always attempted first.
  const observationLane = await runObservationLane(d, OBSERVATION_STAGE_MAX_ROWS, OBSERVATION_STAGE_DEADLINE_MS, errors);

  // LANE B: source/matching, behind its own independent lease.
  let sourceLane: SourceLaneResult;
  const sourceLease = await acquireSportsLease(SOURCE_LOCK_ID, randomWorkerId("sports-source"), SOURCE_LEASE_TTL_SECONDS, d.leaseRepo);
  if (sourceLease === null) {
    sourceLane = {
      acquired: false,
      walletsAttempted: 0,
      walletSummaries: [],
      newSignalsCreated: 0,
      pendingFound: 0,
      pendingProcessed: 0,
      pendingRemainingHint: false,
      pmus: emptyVenueSummary(),
      kalshi: emptyVenueSummary(),
    };
  } else {
    try {
      sourceLane = await runSourceLane(config, d, errors);
      await releaseSportsLease(sourceLease, { state: "idle", lastError: null }, d.leaseRepo);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      errors.push(`source lane failed: ${message}`);
      await releaseSportsLease(sourceLease, { state: "error", lastError: message }, d.leaseRepo);
      sourceLane = {
        acquired: true,
        walletsAttempted: 0,
        walletSummaries: [],
        newSignalsCreated: 0,
        pendingFound: 0,
        pendingProcessed: 0,
        pendingRemainingHint: false,
        pmus: emptyVenueSummary(),
        kalshi: emptyVenueSummary(),
      };
    }
  }

  // Final +0 catch pass: an EXACT match may have just scheduled its +0 row. If the
  // observation lease is held elsewhere, this simply returns without waiting/bypassing.
  const finalObservationPass = await runObservationLane(d, FINAL_OBSERVATION_STAGE_MAX_ROWS, FINAL_OBSERVATION_STAGE_DEADLINE_MS, errors);

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
