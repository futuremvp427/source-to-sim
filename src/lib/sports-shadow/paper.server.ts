/**
 * FINAL BUILD Parts 9, 10, 12, 13: paper execution orchestrator — SERVER (DB) layer.
 *
 * Wires together three already-built, independently-tested pure modules that had never
 * been connected to a live path before this task: depth-walk.ts (Task 10, executable
 * depth simulation), fees.ts (versioned fee engines), and router.ts (no-hindsight
 * venue selection). Triggered once per successfully-captured quote observation
 * (see observation.server.ts's call site) -- reads BOTH venues' ALREADY-PERSISTED
 * ask-depth for the SAME (signal, requested_delay_ms) pair, evaluates all five
 * canonical notional tiers, and persists one routing decision per tier.
 *
 * Never fabricates a fill from a stale/failed observation (Section 13's stale-book
 * gate): a genuinely captured observation with a real errorCode/stale=true produces NO
 * paper fill rows for that venue at all -- missing data is never converted into a bad
 * fill. If the SIBLING venue's observation for the identical (signal, delay) has not
 * yet been captured (still pending) or failed, that venue is simply `available:false`
 * for the router -- exactly router.ts's own documented single-venue-available path,
 * never a reason to skip the venue that DID capture successfully.
 *
 * ============ CODEX P1-2: ONE DETERMINISTIC ROUTING DECISION, NEVER "FIRST CALLBACK WINS" ============
 * PROVEN root cause: this module used to be triggered by, and keyed to, a single physical
 * observation_id. If PM-US's +0 observation completed first, this function ran with
 * Kalshi's sibling still "not yet available" and persisted a PM-US-informed row keyed by
 * PM-US's own observation_id; when Kalshi's +0 observation completed moments later, the
 * SAME function ran again and persisted a SECOND, independent row keyed by Kalshi's own
 * observation_id -- two rows for what should be exactly one (signal, delay, tier) routing
 * decision, with nothing preventing it and no record of which one "won."
 *
 * FIX: routing is now keyed by the LOGICAL opportunity (signal_id, requested_delay_ms,
 * notional_tier_usd), decided via a two-step, DB-enforced protocol
 * (record_sports_shadow_routing_provenance / finalize_sports_shadow_routing_decision --
 * see the migration's own doc comment for the exact atomicity argument):
 *   1. Every observation capture (either venue) records its OWN observation_id as
 *      provenance for that (signal, delay, tier) row -- idempotent, never overwrites an
 *      already-recorded venue's id.
 *   2. A decision is made ONLY once a no-hindsight cutoff condition holds: BOTH venues'
 *      observations are now known (captured, successfully or not), OR the row's own
 *      cutoff window (ROUTING_DECISION_CUTOFF_MS past its fire_at) has expired -- the
 *      only two ways this function is ever willing to stop waiting for a sibling.
 *   3. finalize_sports_shadow_routing_decision's `WHERE decided_at IS NULL` guard is the
 *      ENFORCED single-writer invariant: once any call wins, every later call (a
 *      sibling's own capture, OR a later delay's periodic cutoff sweep) is a no-op --
 *      "no later +5/+10 quote can ever alter a +0 decision" is a DB-level fact, not an
 *      application-level convention.
 * A routing opportunity where only ONE venue was ever schedulable (the common case --
 * most signals are not EXACT-matched on both venues) would otherwise wait forever for a
 * sibling that will never arrive; `maybeDecideExpiredRoutingCutoffs` is the periodic sweep
 * that closes exactly that gap (see its own doc comment, wired into worker.server.ts's
 * onCycleComplete).
 * ================================================================================
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { evaluateNotionalTiers, SPORTS_SHADOW_NOTIONALS_USD, walkBuyDepth, walkSellDepth, type DepthWalkResult, type ExitDepthWalkResult } from "./depth-walk";
import { computeTakerFeeForFills, type FeeResult } from "./fees";
import { routeExecution, type RoutingDecision } from "./router";
import type { DepthLevel, Venue } from "./types";

export type CapturedObservation = {
  id: string;
  signalId: string;
  venue: Venue;
  requestedDelayMs: number;
  fireAtMs: number;
  observed: boolean;
  stale: boolean;
  errorCode: string | null;
  askDepth: DepthLevel[];
  /** CODEX P1-3 (follower lifecycle): EXIT's own bid-side depth walk -- already fully captured/persisted end-to-end (observation.ts's buildPmusObservationPatch/buildKalshiObservationPatch), simply never read by this module before now. */
  bidDepth: DepthLevel[];
  /** CODEX P1-3: null = this is an ENTRY observation; set = a lifecycle (ADD/EXIT) reaction observation for that specific source fill. */
  triggerSourceFillId: string | null;
};

export type RoutingProvenance = {
  notionalTierUsd: number;
  pmusObservationId: string | null;
  kalshiObservationId: string | null;
  decidedAt: string | null;
  fireAtMs: number;
};

export type SignalProvenance = { experimentEpochId: string | null; firstFillId: string };

export type VenueMatchProvenance = { targetMarketId: string | null; selectedSide: string | null };

export type PaperFillRow = {
  signalId: string;
  requestedDelayMs: number;
  side: "ENTRY" | "ADD" | "EXIT";
  notionalTierUsd: number;
  routingTimestampMs: number;
  pmusResult: { depthWalk: DepthWalkResult | null; fee: FeeResult | null; available: boolean };
  kalshiResult: { depthWalk: DepthWalkResult | null; fee: FeeResult | null; available: boolean };
  chosenVenue: Venue | null;
  fillStatus: "FULL" | "PARTIAL" | "NONE" | "INVALID" | "REJECTED";
  contracts: number;
  vwap: number | null;
  feeUsd: number | null;
  feeModelVersion: string | null;
  feeValid: boolean;
  allInCostUsd: number | null;
  rejectReason: string | null;
  cutoffReason: "BOTH_COMPLETE" | "CUTOFF_EXPIRED";
  targetMarketId: string | null;
  selectedSide: string | null;
  sourceFillId: string;
  experimentEpochId: string | null;
};

/** CODEX P1-3 (follower lifecycle): durable per-tier follower state, read before deciding an ADD/EXIT. */
export type OpenPosition = { contractsOpen: number; avgEntryPrice: number | null };

/** CODEX P1-3: the recorded "this fill requires a follower reaction" fact -- see source-poll.server.ts's own doc comment for how/when it's created. */
export type LifecycleTrigger = { signalId: string; triggerType: "ADD" | "EXIT"; trackedShares: number; exitFraction: number | null; addFraction: number | null; price: number; sourceTs: number };

export type PaperRepository = {
  getObservation(id: string): Promise<CapturedObservation | null>;
  getObservationForVenue(signalId: string, venue: Venue, requestedDelayMs: number): Promise<CapturedObservation | null>;
  getSignalProvenance(signalId: string): Promise<SignalProvenance | null>;
  getVenueMatch(signalId: string, venue: Venue): Promise<VenueMatchProvenance | null>;
  /** CODEX P1-3: null when no OPEN position exists for this (signal, venue, tier) -- an ADD/EXIT with nothing to react to for this specific venue/tier is simply skipped, never fabricated. */
  getOpenPosition(signalId: string, venue: Venue, notionalTierUsd: number): Promise<OpenPosition | null>;
  getLifecycleTrigger(triggerId: string): Promise<LifecycleTrigger | null>;
  /**
   * Decides an ADD or EXIT DIRECTLY -- no separate provenance-then-finalize race (an
   * ADD/EXIT is always scoped to the ONE venue the position is already open in, never
   * a second venue to wait for). Returns true only if THIS call actually won (a
   * retried/duplicate call for the identical (signal, delay, tier, trigger) is a safe
   * no-op). Atomically mutates the position (weighted-average for ADD, proportional
   * realized P&L for EXIT) in the SAME transaction -- see the migration's own doc
   * comment on finalize_sports_shadow_lifecycle_decision.
   */
  finalizeLifecycleDecision(signalId: string, requestedDelayMs: number, notionalTierUsd: number, triggerSourceFillId: string, observationId: string, decidedAtMs: number, venue: Venue, row: PaperFillRow): Promise<boolean>;
  /**
   * Step 1 of the two-step protocol -- see this module's own P1-2 doc comment. CODEX P1-2
   * (round 2): creates/updates the COMPLETE 5-tier ladder for (signalId, requestedDelayMs)
   * in ONE bounded, idempotent round trip -- returned in canonical tier order (matches
   * SPORTS_SHADOW_NOTIONALS_USD) -- rather than one RPC call per tier, so a deadline
   * firing partway through the caller's own per-tier evaluation loop can never leave a
   * later tier with no durable row at all.
   */
  recordRoutingProvenanceLadder(signalId: string, requestedDelayMs: number, venue: Venue, observationId: string, fireAtMs: number): Promise<RoutingProvenance[]>;
  /** Step 2 -- returns true only if THIS call actually won the decision (decided_at was NULL beforehand). */
  finalizeRoutingDecision(signalId: string, requestedDelayMs: number, notionalTierUsd: number, row: PaperFillRow, decidedAtMs: number): Promise<boolean>;
  /** Bounded: rows whose cutoff window has expired without ever being decided -- see maybeDecideExpiredRoutingCutoffs. */
  findExpiredPendingRoutingRows(cutoffAtMs: number, limit: number): Promise<{ signalId: string; requestedDelayMs: number; notionalTierUsd: number; pmusObservationId: string | null; kalshiObservationId: string | null }[]>;
};

export const supabasePaperRepository: PaperRepository = {
  async getObservation(id) {
    const { data, error } = await supabaseAdmin
      .from("sports_quote_observations" as never)
      .select("id, signal_id, venue, requested_delay_ms, fire_at, observed_at, stale, error_code, ask_depth, bid_depth, trigger_source_fill_id")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return rowToObservation(data);
  },

  async getObservationForVenue(signalId, venue, requestedDelayMs) {
    // CODEX P1-3: scoped to the ENTRY plan specifically (trigger_source_fill_id IS
    // NULL) -- this is only ever used for ENTRY's own sibling-venue check. A
    // lifecycle-reaction row can share the identical (signal_id, venue,
    // requested_delay_ms) with the entry row (they are distinguished ONLY by
    // trigger_source_fill_id under the table's new UNIQUE NULLS NOT DISTINCT
    // constraint) -- without this filter, .maybeSingle() could error or return either
    // row non-deterministically once a lifecycle reaction row exists.
    const { data, error } = await supabaseAdmin
      .from("sports_quote_observations" as never)
      .select("id, signal_id, venue, requested_delay_ms, fire_at, observed_at, stale, error_code, ask_depth, bid_depth, trigger_source_fill_id")
      .eq("signal_id", signalId)
      .eq("venue", venue)
      .eq("requested_delay_ms", requestedDelayMs)
      .is("trigger_source_fill_id", null)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return rowToObservation(data);
  },

  async getSignalProvenance(signalId) {
    const { data, error } = await supabaseAdmin.from("sports_shadow_signals" as never).select("experiment_epoch_id, first_fill_id").eq("id", signalId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as unknown as { experiment_epoch_id: string | null; first_fill_id: string };
    return { experimentEpochId: row.experiment_epoch_id, firstFillId: row.first_fill_id };
  },

  async getVenueMatch(signalId, venue) {
    const { data, error } = await supabaseAdmin
      .from("sports_market_matches" as never)
      .select("target_market_id, selected_side")
      .eq("signal_id", signalId)
      .eq("venue", venue)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as unknown as { target_market_id: string | null; selected_side: string | null };
    return { targetMarketId: row.target_market_id, selectedSide: row.selected_side };
  },

  async recordRoutingProvenanceLadder(signalId, requestedDelayMs, venue, observationId, fireAtMs) {
    const { data, error } = await supabaseAdmin.rpc("record_sports_shadow_routing_provenance_ladder" as never, {
      p_signal_id: signalId,
      p_requested_delay_ms: requestedDelayMs,
      p_venue: venue,
      p_observation_id: observationId,
      p_fire_at: new Date(fireAtMs).toISOString(),
    } as never);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as { notional_tier_usd: number; pmus_observation_id: string | null; kalshi_observation_id: string | null; decided_at: string | null; fire_at: string }[];
    return rows.map((row) => ({
      notionalTierUsd: row.notional_tier_usd,
      pmusObservationId: row.pmus_observation_id,
      kalshiObservationId: row.kalshi_observation_id,
      decidedAt: row.decided_at,
      fireAtMs: Date.parse(row.fire_at),
    }));
  },

  async finalizeRoutingDecision(signalId, requestedDelayMs, notionalTierUsd, row, decidedAtMs) {
    const { data, error } = await supabaseAdmin.rpc("finalize_sports_shadow_routing_decision" as never, {
      p_signal_id: signalId,
      p_requested_delay_ms: requestedDelayMs,
      p_notional_tier_usd: notionalTierUsd,
      p_decided_at: new Date(decidedAtMs).toISOString(),
      p_cutoff_reason: row.cutoffReason,
      p_chosen_venue: row.chosenVenue,
      p_fill_status: row.fillStatus,
      p_contracts: row.contracts,
      p_vwap: row.vwap,
      p_fee_usd: row.feeUsd,
      p_fee_model_version: row.feeModelVersion,
      p_fee_valid: row.feeValid,
      p_all_in_cost_usd: row.allInCostUsd,
      p_reject_reason: row.rejectReason,
      p_pmus_result: row.pmusResult,
      p_kalshi_result: row.kalshiResult,
      p_target_market_id: row.targetMarketId,
      p_selected_side: row.selectedSide,
      p_side: row.side,
      p_source_fill_id: row.sourceFillId,
      p_experiment_epoch_id: row.experimentEpochId,
    } as never);
    if (error) throw new Error(error.message);
    return data === true;
  },

  async findExpiredPendingRoutingRows(cutoffAtMs, limit) {
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_paper_fills" as never)
      .select("signal_id, requested_delay_ms, notional_tier_usd, pmus_observation_id, kalshi_observation_id")
      .is("decided_at", null)
      .lte("fire_at", new Date(cutoffAtMs).toISOString())
      .limit(limit);
    if (error) throw new Error(error.message);
    return ((data ?? []) as unknown as { signal_id: string; requested_delay_ms: number; notional_tier_usd: number; pmus_observation_id: string | null; kalshi_observation_id: string | null }[]).map((r) => ({
      signalId: r.signal_id,
      requestedDelayMs: r.requested_delay_ms,
      notionalTierUsd: r.notional_tier_usd,
      pmusObservationId: r.pmus_observation_id,
      kalshiObservationId: r.kalshi_observation_id,
    }));
  },

  async getOpenPosition(signalId, venue, notionalTierUsd) {
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_paper_positions" as never)
      .select("contracts_open, avg_entry_price")
      .eq("signal_id", signalId)
      .eq("venue", venue)
      .eq("notional_tier_usd", notionalTierUsd)
      .eq("status", "OPEN")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as unknown as { contracts_open: number; avg_entry_price: number | null };
    if (row.contracts_open <= 0) return null;
    return { contractsOpen: row.contracts_open, avgEntryPrice: row.avg_entry_price };
  },

  async getLifecycleTrigger(triggerId) {
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_lifecycle_triggers" as never)
      .select("signal_id, trigger_type, tracked_shares, exit_fraction, add_fraction, price, source_ts")
      .eq("id", triggerId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as unknown as { signal_id: string; trigger_type: "ADD" | "EXIT"; tracked_shares: number; exit_fraction: number | null; add_fraction: number | null; price: number; source_ts: number };
    return { signalId: row.signal_id, triggerType: row.trigger_type, trackedShares: row.tracked_shares, exitFraction: row.exit_fraction, addFraction: row.add_fraction, price: row.price, sourceTs: row.source_ts };
  },

  async finalizeLifecycleDecision(signalId, requestedDelayMs, notionalTierUsd, triggerSourceFillId, observationId, decidedAtMs, venue, row) {
    const venueResult = row.pmusResult.available || row.pmusResult.depthWalk !== null || row.pmusResult.fee !== null ? row.pmusResult : row.kalshiResult;
    const { data, error } = await supabaseAdmin.rpc("finalize_sports_shadow_lifecycle_decision" as never, {
      p_signal_id: signalId,
      p_requested_delay_ms: requestedDelayMs,
      p_notional_tier_usd: notionalTierUsd,
      p_trigger_source_fill_id: triggerSourceFillId,
      p_observation_id: observationId,
      p_decided_at: new Date(decidedAtMs).toISOString(),
      p_venue: venue,
      p_side: row.side,
      p_fill_status: row.fillStatus,
      p_contracts: row.contracts,
      p_vwap: row.vwap,
      p_fee_usd: row.feeUsd,
      p_fee_model_version: row.feeModelVersion,
      p_fee_valid: row.feeValid,
      p_all_in_cost_usd: row.allInCostUsd,
      p_reject_reason: row.rejectReason,
      p_venue_result: venueResult,
      p_target_market_id: row.targetMarketId,
      p_selected_side: row.selectedSide,
      p_source_fill_id: row.sourceFillId,
      p_experiment_epoch_id: row.experimentEpochId,
    } as never);
    if (error) throw new Error(error.message);
    return data === true;
  },
};

function rowToObservation(data: unknown): CapturedObservation {
  const row = data as unknown as {
    id: string;
    signal_id: string;
    venue: Venue;
    requested_delay_ms: number;
    fire_at: string;
    observed_at: string | null;
    stale: boolean;
    error_code: string | null;
    ask_depth: DepthLevel[] | null;
    bid_depth: DepthLevel[] | null;
    trigger_source_fill_id: string | null;
  };
  return {
    id: row.id,
    signalId: row.signal_id,
    venue: row.venue,
    requestedDelayMs: row.requested_delay_ms,
    fireAtMs: Date.parse(row.fire_at),
    observed: row.observed_at !== null,
    stale: row.stale,
    errorCode: row.error_code,
    askDepth: row.ask_depth ?? [],
    bidDepth: row.bid_depth ?? [],
    triggerSourceFillId: row.trigger_source_fill_id,
  };
}

/**
 * CODEX P1-2: how long this module is willing to wait for a sibling venue's observation
 * before deciding with only one venue's data. Justified against the scheduler's own ~30s
 * cadence (worker.server.ts's SOURCE_LANE_BUDGET_MS): 5 minutes is ~10 scheduler cycles --
 * ample time for BOTH matching (resolveVenuePending) and observation capture to complete
 * if the sibling venue was ever going to be schedulable at all, while not indefinitely
 * blocking the (common, expected -- router.ts's own documented single-venue-available
 * path) case of a signal that is EXACT-matched on only one venue, which will otherwise
 * never accumulate a sibling observation_id at all.
 */
export const ROUTING_DECISION_CUTOFF_MS = 5 * 60 * 1000;

export type PaperDeps = { repo: PaperRepository; now: () => number };
const defaultDeps: PaperDeps = { repo: supabasePaperRepository, now: () => Date.now() };

function evaluateVenue(venue: Venue, obs: CapturedObservation | null): { available: boolean; depthWalk: Record<number, DepthWalkResult>; fees: Record<number, FeeResult> } {
  if (!obs || !obs.observed || obs.stale || obs.errorCode !== null) {
    return { available: false, depthWalk: {}, fees: {} };
  }
  const depthWalk = evaluateNotionalTiers(obs.askDepth);
  const fees: Record<number, FeeResult> = {};
  for (const [tier, dw] of Object.entries(depthWalk)) {
    // CODEX P1-5: computed PER PRICE LEVEL actually consumed (dw.fills), never against
    // the blended averageExecutionPrice -- see fees.ts's computeTakerFeeForFills doc
    // comment for why those are mathematically different numbers, not a rounding nuance.
    fees[Number(tier)] =
      dw.contractsFilled > 0 && dw.fills.length > 0
        ? computeTakerFeeForFills(venue, dw.fills)
        : { feeUsd: 0, valid: false, netFeeComplete: true, reason: "no contracts filled", feeModelVersion: "n/a", effectiveDate: "n/a" };
  }
  return { available: true, depthWalk, fees };
}

/**
 * Builds the full row for one notional tier's ENTRY decision, including P1-4's direct
 * target_market_id/selected_side provenance (the CHOSEN venue's own match row -- never
 * inferred later via an ambiguous signal_id-only join) and P2-3's epoch/source
 * provenance. ADD/EXIT decisions are built separately by decideLifecycleTier below --
 * see this module's own CODEX P1-3 doc comment for why they never re-run this
 * function's own cross-venue routing race.
 */
async function buildDecisionRow(
  signalId: string,
  requestedDelayMs: number,
  tier: number,
  decision: RoutingDecision,
  cutoffReason: "BOTH_COMPLETE" | "CUTOFF_EXPIRED",
  signalProvenance: SignalProvenance,
  d: PaperDeps,
): Promise<PaperFillRow> {
  const chosen = decision.chosenVenue === "PMUS" ? decision.pmus : decision.chosenVenue === "KALSHI" ? decision.kalshi : null;
  const match = decision.chosenVenue ? await d.repo.getVenueMatch(signalId, decision.chosenVenue) : null;
  return {
    signalId,
    requestedDelayMs,
    side: "ENTRY",
    notionalTierUsd: tier,
    routingTimestampMs: decision.routingTimestampMs,
    pmusResult: { depthWalk: decision.pmus.depthWalk, fee: decision.pmus.fee, available: decision.pmus.available },
    kalshiResult: { depthWalk: decision.kalshi.depthWalk, fee: decision.kalshi.fee, available: decision.kalshi.available },
    chosenVenue: decision.chosenVenue,
    fillStatus: chosen?.depthWalk?.status ?? "REJECTED",
    contracts: chosen?.depthWalk?.contractsFilled ?? 0,
    vwap: chosen?.depthWalk?.averageExecutionPrice ?? null,
    feeUsd: chosen?.fee?.feeUsd ?? null,
    feeModelVersion: chosen?.fee?.feeModelVersion ?? null,
    feeValid: chosen?.fee?.valid ?? false,
    allInCostUsd: chosen?.allInCostUsd ?? null,
    rejectReason: decision.rejectReason,
    cutoffReason,
    targetMarketId: match?.targetMarketId ?? null,
    selectedSide: match?.selectedSide ?? null,
    sourceFillId: signalProvenance.firstFillId,
    experimentEpochId: signalProvenance.experimentEpochId,
  };
}

/**
 * Triggered once per successfully-captured observation (both success AND real-failure
 * captures reach this -- the stale/errorCode check below is what actually gates whether
 * this venue's own data is usable, per Section 13's stale-book rule). ALWAYS records this
 * venue's provenance first (idempotent); only proceeds to attempt a decision when the
 * no-hindsight cutoff condition (this module's own P1-2 doc comment) actually holds --
 * otherwise returns immediately, leaving the row pending for the sibling or the periodic
 * cutoff sweep. Never decided twice: finalizeRoutingDecision's own DB-level guard makes a
 * second/concurrent attempt a safe no-op.
 *
 * CODEX P2-6: `deadlineAtMs` (optional; observation.server.ts threads through the SAME
 * absolute deadline its own due-observation loop was given) is checked between each of
 * the five canonical tiers -- confirmed during the full-route timing analysis that this
 * function's per-tier RPC round trips (recordRoutingProvenance + finalizeRoutingDecision)
 * had no deadline of their own, so a slow/backed-up Postgres could extend ONE row's
 * already-awaited onObservationClaimed call well beyond what
 * OBSERVATION_STAGE_DEADLINE_MS's own worst-case bound assumed, uncounted by the calling
 * loop's own between-ROW deadline check. Stopping early here is always safe: an
 * un-attempted tier's decision is simply left pending for the sibling's own eventual
 * call or the periodic cutoff sweep (maybeDecideExpiredRoutingCutoffs) -- never a lost
 * or corrupted decision, exactly like every other deadline-truncation in this codebase.
 */
export async function computePaperFillsForObservation(observationId: string, deps: Partial<PaperDeps> = {}, deadlineAtMs?: number): Promise<PaperFillRow[]> {
  const d: PaperDeps = { ...defaultDeps, ...deps };
  const obs = await d.repo.getObservation(observationId);
  if (!obs) return [];

  // CODEX P1-3 (follower lifecycle): a lifecycle-reaction observation (ADD/EXIT) is
  // handled by an entirely separate path -- see computeLifecycleFillsForObservation's
  // own doc comment for why it never re-runs this function's cross-venue routing race
  // (an ADD/EXIT is always scoped to the ONE venue the position is already open in).
  if (obs.triggerSourceFillId !== null) {
    return computeLifecycleFillsForObservation(obs, d, deadlineAtMs);
  }

  const otherVenue: Venue = obs.venue === "PMUS" ? "KALSHI" : "PMUS";
  // Crash-safety / robustness: the sibling's own onObservationClaimed callback is the
  // NORMAL way its provenance gets recorded, but a captured sibling observation might
  // already exist (e.g. its own callback crashed after the CAS claim but before running,
  // or -- as in a bounded backfill/replay -- both happened to already be captured before
  // either callback fired). Opportunistically recording it here too is idempotent
  // (recordRoutingProvenance never overwrites an already-known venue's id) and closes
  // that gap rather than leaving a decision waiting on a callback that will never re-run.
  const siblingObs = await d.repo.getObservationForVenue(obs.signalId, otherVenue, obs.requestedDelayMs);

  const signalProvenance = await d.repo.getSignalProvenance(obs.signalId);
  if (!signalProvenance) return [];

  // CODEX P1-2 (round 2): the COMPLETE 5-tier ladder is created/updated in ONE bounded,
  // idempotent round trip PER known venue, entirely BEFORE any expensive per-tier
  // evaluation begins below -- never one RPC call per tier interleaved with that
  // evaluation. Even if the deadline fires immediately after this, every tier already
  // has a durable row (this call's own venue's observation recorded as provenance), so
  // maybeDecideExpiredRoutingCutoffs can still find and eventually terminalize EVERY
  // tier -- a missing DB row can no longer mean a silently missing experiment
  // opportunity. Provenance is recorded regardless of whether THIS venue's own capture
  // succeeded -- a failed/stale capture is still real evidence ("this venue is known,
  // and unavailable") that the sibling venue's own eventual call needs to see.
  let ladder = await d.repo.recordRoutingProvenanceLadder(obs.signalId, obs.requestedDelayMs, obs.venue, observationId, obs.fireAtMs);
  if (siblingObs?.observed) {
    ladder = await d.repo.recordRoutingProvenanceLadder(obs.signalId, obs.requestedDelayMs, otherVenue, siblingObs.id, obs.fireAtMs);
  }

  const decided: PaperFillRow[] = [];
  for (const provenance of ladder) {
    // CODEX P2-6: checked BEFORE each tier's own expensive evaluation -- an already-
    // exhausted deadline stops here, leaving this and every remaining tier's decision
    // untouched this call. Safe: every tier's own durable row already exists (created
    // above), so an untouched tier is simply left pending for the sibling's own eventual
    // call or the periodic cutoff sweep, never a lost or corrupted decision.
    if (deadlineAtMs !== undefined && d.now() >= deadlineAtMs) break;
    if (provenance.decidedAt !== null) continue; // no-hindsight: already decided, this call changes nothing

    const bothKnown = provenance.pmusObservationId !== null && provenance.kalshiObservationId !== null;
    const now = d.now();
    const cutoffExpired = now - provenance.fireAtMs >= ROUTING_DECISION_CUTOFF_MS;
    if (!bothKnown && !cutoffExpired) continue; // wait for the sibling or a later cutoff sweep

    const row = await decideOneTier(obs.signalId, obs.requestedDelayMs, provenance.notionalTierUsd, provenance, obs, otherVenue, signalProvenance, bothKnown ? "BOTH_COMPLETE" : "CUTOFF_EXPIRED", d);
    if (row) decided.push(row);
  }
  return decided;
}

/**
 * ============ CODEX P1-3: FOLLOWER PAPER LIFECYCLE (ENTRY-only -> ENTRY/ADD/EXIT) ============
 * PROVEN root cause: this module previously hardcoded side='ENTRY' for every routing
 * decision -- episode.ts's own AGGREGATED_BUY/LATE_RECONCILIATION (a source DCA buy)
 * and SELL_RECORDED-against-an-open-episode (a source partial/full sell) never
 * triggered ANY follower reaction. The paper simulator only ever bought the source's
 * FIRST entry and held every tier to resolution, never following the source's actual
 * trade lifecycle -- unacceptable for a system whose whole purpose is evaluating
 * copy-following that lifecycle.
 *
 * FIX: source-poll.server.ts now records a durable sports_shadow_lifecycle_triggers
 * row for every DCA buy / tracked sell against an open episode; observation.server.ts
 * schedules a 5-tier observation-capture burst for it (tagged with
 * trigger_source_fill_id); THIS function decides each of those tiers once its own
 * observation is captured.
 *
 * Unlike ENTRY, an ADD/EXIT NEVER races two venues: the follower's position is already
 * open in exactly one venue (or not open at all, for a given tier), so there is no
 * "wait for the sibling, or the cutoff" protocol here at all -- a lifecycle observation
 * decides IMMEDIATELY once captured, always contemporaneous evidence (the book state at
 * the moment the reaction was scheduled), never a later observation retroactively
 * simulating an earlier source action.
 *
 * Per tier, independently:
 *   - No OPEN position for (signal, THIS observation's venue, tier) -- SKIPPED, not
 *     rejected: there is no logical opportunity here at all (either this tier never
 *     entered, or it entered via the OTHER venue -- observations are scheduled for
 *     every EXACT-matched venue, not only whichever one ends up holding a position).
 *   - ADD: the reporting tier remains fixed, but executable size is scaled by the
 *     source DCA fraction recorded with the trigger (new source shares divided by
 *     remaining source inventory before the DCA). A 1% source DCA therefore adds 1% of
 *     the tier, not a fresh full-tier buy.
 *   - EXIT: sells contracts_open * trigger.exitFraction contracts (this tier's own
 *     remaining inventory, proportional to how much of the source's OWN tracked
 *     position this sell represents) against the CURRENT bid depth
 *     (walkSellDepth) -- realized P&L computed against the position's own recorded
 *     avg_entry_price, atomically, in the same RPC.
 *   - Rejected (no exact target / stale quote / insufficient depth / unavailable
 *     venue / unknown fee) is persisted as a legitimate research outcome, exactly like
 *     ENTRY's own REJECTED/NONE/INVALID handling -- never silently dropped.
 * ================================================================================
 */
async function computeLifecycleFillsForObservation(obs: CapturedObservation, d: PaperDeps, deadlineAtMs?: number): Promise<PaperFillRow[]> {
  const trigger = await d.repo.getLifecycleTrigger(obs.triggerSourceFillId!);
  if (!trigger) return [];
  const signalProvenance = await d.repo.getSignalProvenance(trigger.signalId);
  if (!signalProvenance) return [];

  const decided: PaperFillRow[] = [];
  for (const tier of SPORTS_SHADOW_NOTIONALS_USD) {
    if (deadlineAtMs !== undefined && d.now() >= deadlineAtMs) break;

    const position = await d.repo.getOpenPosition(trigger.signalId, obs.venue, tier);
    if (!position) continue; // no logical opportunity for this venue/tier -- never fabricated

    const row =
      trigger.triggerType === "ADD"
        ? buildAddDecisionRow(trigger.signalId, obs, tier, trigger, signalProvenance)
        : buildExitDecisionRow(trigger.signalId, obs, tier, trigger, position, signalProvenance);

    const won = await d.repo.finalizeLifecycleDecision(trigger.signalId, obs.requestedDelayMs, tier, obs.triggerSourceFillId!, obs.id, d.now(), obs.venue, row);
    if (won) decided.push(row);
  }
  return decided;
}

function unavailableLifecycleReason(obs: CapturedObservation): string | null {
  if (!obs.observed) return `${obs.venue} observation was never captured`;
  if (obs.stale) return `${obs.venue} book is stale`;
  if (obs.errorCode !== null) return `${obs.venue} capture failed: ${obs.errorCode}`;
  return null;
}

function buildAddDecisionRow(signalId: string, obs: CapturedObservation, tier: number, trigger: LifecycleTrigger, signalProvenance: SignalProvenance): PaperFillRow {
  const unavailable = unavailableLifecycleReason(obs);
  const requestedNotionalUsd = trigger.addFraction !== null && Number.isFinite(trigger.addFraction) && trigger.addFraction > 0 ? tier * trigger.addFraction : 0;
  const depthWalk = unavailable || requestedNotionalUsd <= 0 ? null : walkBuyDepth(obs.askDepth, requestedNotionalUsd);
  const fee = depthWalk && depthWalk.contractsFilled > 0 && depthWalk.fills.length > 0 ? computeTakerFeeForFills(obs.venue, depthWalk.fills) : null;

  let fillStatus: PaperFillRow["fillStatus"];
  let rejectReason: string | null;
  let contracts = 0;
  let vwap: number | null = null;
  let allInCostUsd: number | null = null;

  if (unavailable) {
    fillStatus = "REJECTED";
    rejectReason = `${obs.venue} capability unavailable this cycle: ${unavailable}`;
  } else if (requestedNotionalUsd <= 0) {
    fillStatus = "REJECTED";
    rejectReason = "invalid source ADD fraction";
  } else if (depthWalk === null || (depthWalk.status !== "FULL" && depthWalk.status !== "PARTIAL")) {
    fillStatus = "REJECTED";
    rejectReason = `${obs.venue} depth-walk status ${depthWalk?.status ?? "NONE"}${depthWalk?.invalidReason ? `: ${depthWalk.invalidReason}` : ""}`;
  } else if (fee === null || !fee.valid) {
    fillStatus = "REJECTED";
    rejectReason = `${obs.venue} fee UNVERIFIED${fee?.reason ? `: ${fee.reason}` : ""}`;
  } else {
    fillStatus = depthWalk.status;
    contracts = depthWalk.contractsFilled;
    vwap = depthWalk.averageExecutionPrice;
    allInCostUsd = depthWalk.filledNotionalUsd + fee.feeUsd;
    rejectReason = null;
  }

  const venueResult = { depthWalk, fee, available: !unavailable };
  return {
    signalId,
    requestedDelayMs: obs.requestedDelayMs,
    side: "ADD",
    notionalTierUsd: tier,
    routingTimestampMs: Date.now(),
    pmusResult: obs.venue === "PMUS" ? venueResult : { depthWalk: null, fee: null, available: false },
    kalshiResult: obs.venue === "KALSHI" ? venueResult : { depthWalk: null, fee: null, available: false },
    chosenVenue: fillStatus === "REJECTED" ? null : obs.venue,
    fillStatus,
    contracts,
    vwap,
    feeUsd: fee?.feeUsd ?? null,
    feeModelVersion: fee?.feeModelVersion ?? null,
    feeValid: fee?.valid ?? false,
    allInCostUsd,
    rejectReason,
    cutoffReason: "BOTH_COMPLETE", // no sibling to race -- this observation alone is always the complete picture for a single-venue lifecycle decision
    targetMarketId: null, // unchanged from the position's own ENTRY-time provenance -- ADD never re-derives it
    selectedSide: null,
    sourceFillId: signalProvenance.firstFillId,
    experimentEpochId: signalProvenance.experimentEpochId,
  };
}

function buildExitDecisionRow(signalId: string, obs: CapturedObservation, tier: number, trigger: LifecycleTrigger, position: OpenPosition, signalProvenance: SignalProvenance): PaperFillRow {
  const unavailable = unavailableLifecycleReason(obs);
  // CODEX P1-3: never exits more than currently open -- exitFraction is computed from
  // SOURCE-side inventory (episode.ts) and can drift slightly from this specific
  // tier's own follower contracts_open; capped here defensively (the RPC's own final
  // GREATEST(0, ...) guard is the authoritative enforcement of this invariant, this is
  // belt-and-suspenders at the point the request is even constructed).
  const requestedContracts = Math.min(position.contractsOpen, position.contractsOpen * (trigger.exitFraction ?? 1));
  const exitWalk: ExitDepthWalkResult | null = unavailable || requestedContracts <= 0 ? null : walkSellDepth(obs.bidDepth, requestedContracts);
  const fee = exitWalk && exitWalk.filledContracts > 0 && exitWalk.fills.length > 0 ? computeTakerFeeForFills(obs.venue, exitWalk.fills) : null;

  let fillStatus: PaperFillRow["fillStatus"];
  let rejectReason: string | null;
  let contracts = 0;
  let vwap: number | null = null;
  let allInCostUsd: number | null = null; // NET PROCEEDS for an EXIT row (proceeds minus fee) -- see this module's own doc comment on the reused column name

  if (unavailable) {
    fillStatus = "REJECTED";
    rejectReason = `${obs.venue} capability unavailable this cycle: ${unavailable}`;
  } else if (requestedContracts <= 0) {
    fillStatus = "REJECTED";
    rejectReason = "no remaining follower inventory to exit for this tier";
  } else if (exitWalk === null || (exitWalk.status !== "FULL" && exitWalk.status !== "PARTIAL")) {
    fillStatus = "REJECTED";
    rejectReason = `${obs.venue} bid depth-walk status ${exitWalk?.status ?? "NONE"}${exitWalk?.invalidReason ? `: ${exitWalk.invalidReason}` : ""}`;
  } else if (fee === null || !fee.valid) {
    fillStatus = "REJECTED";
    rejectReason = `${obs.venue} fee UNVERIFIED${fee?.reason ? `: ${fee.reason}` : ""}`;
  } else {
    fillStatus = exitWalk.status;
    contracts = exitWalk.filledContracts;
    vwap = exitWalk.averageExecutionPrice;
    allInCostUsd = exitWalk.proceedsUsd - fee.feeUsd;
    rejectReason = null;
  }

  // depth-walk.ts's ExitDepthWalkResult is not the same shape as DepthWalkResult --
  // pmusResult/kalshiResult's own depthWalk field carries an ENTRY/ADD-shaped result
  // by type; an EXIT's own walk is preserved here for audit purposes via a structural
  // cast rather than widening PaperFillRow's own type for one field only EXIT rows use
  // differently (contracts/proceeds instead of notional).
  const venueResult = { depthWalk: exitWalk as unknown as DepthWalkResult | null, fee, available: !unavailable };
  return {
    signalId,
    requestedDelayMs: obs.requestedDelayMs,
    side: "EXIT",
    notionalTierUsd: tier,
    routingTimestampMs: Date.now(),
    pmusResult: obs.venue === "PMUS" ? venueResult : { depthWalk: null, fee: null, available: false },
    kalshiResult: obs.venue === "KALSHI" ? venueResult : { depthWalk: null, fee: null, available: false },
    chosenVenue: fillStatus === "REJECTED" ? null : obs.venue,
    fillStatus,
    contracts,
    vwap,
    feeUsd: fee?.feeUsd ?? null,
    feeModelVersion: fee?.feeModelVersion ?? null,
    feeValid: fee?.valid ?? false,
    allInCostUsd,
    rejectReason,
    cutoffReason: "BOTH_COMPLETE",
    targetMarketId: null,
    selectedSide: null,
    sourceFillId: signalProvenance.firstFillId,
    experimentEpochId: signalProvenance.experimentEpochId,
  };
}

async function decideOneTier(
  signalId: string,
  requestedDelayMs: number,
  tier: number,
  provenance: RoutingProvenance,
  thisObs: CapturedObservation,
  otherVenue: Venue,
  signalProvenance: SignalProvenance,
  cutoffReason: "BOTH_COMPLETE" | "CUTOFF_EXPIRED",
  d: PaperDeps,
): Promise<PaperFillRow | null> {
  const otherObservationId = thisObs.venue === "PMUS" ? provenance.kalshiObservationId : provenance.pmusObservationId;
  const otherObs = otherObservationId ? await d.repo.getObservationForVenue(signalId, otherVenue, requestedDelayMs) : null;

  const thisEval = evaluateVenue(thisObs.venue, thisObs);
  const otherEval = evaluateVenue(otherVenue, otherObs);
  const thisSide = { available: thisEval.available, depthWalk: thisEval.depthWalk[tier] ?? null, fee: thisEval.fees[tier] ?? null };
  const otherSide = { available: otherEval.available, depthWalk: otherEval.depthWalk[tier] ?? null, fee: otherEval.fees[tier] ?? null };
  const pmusInput = thisObs.venue === "PMUS" ? thisSide : otherSide;
  const kalshiInput = thisObs.venue === "KALSHI" ? thisSide : otherSide;

  const decision = routeExecution(tier, pmusInput, kalshiInput, d.now());
  const row = await buildDecisionRow(signalId, requestedDelayMs, tier, decision, cutoffReason, signalProvenance, d);
  const won = await d.repo.finalizeRoutingDecision(signalId, requestedDelayMs, tier, row, d.now());
  return won ? row : null; // lost the race to a concurrent decider (e.g. the sibling's own call, or the cutoff sweep) -- that call's row is authoritative, not this one
}

/**
 * CODEX P1-2: periodic sweep closing the "sibling never arrives" gap -- a routing
 * opportunity where only ONE venue was ever schedulable (not EXACT-matched on the other)
 * would otherwise never accumulate a second observation_id and so never satisfy the
 * `bothKnown` cutoff condition in computePaperFillsForObservation. Bounded, idempotent
 * (finalizeRoutingDecision's own DB-level guard), best-effort. Wired into
 * worker.server.ts's onCycleComplete, same maintenance-task pattern as capability probes
 * and the integrity audit.
 */
export async function maybeDecideExpiredRoutingCutoffs(deps: Partial<PaperDeps> = {}, limit = 100): Promise<number> {
  const d: PaperDeps = { ...defaultDeps, ...deps };
  let decided = 0;
  try {
    const cutoffAtMs = d.now() - ROUTING_DECISION_CUTOFF_MS;
    const expired = await d.repo.findExpiredPendingRoutingRows(cutoffAtMs, limit);
    for (const pending of expired) {
      try {
        const knownVenue: Venue | null = pending.pmusObservationId ? "PMUS" : pending.kalshiObservationId ? "KALSHI" : null;
        if (knownVenue === null) continue; // should not happen -- a row only exists once at least one venue recorded provenance
        const knownObservationId = knownVenue === "PMUS" ? pending.pmusObservationId! : pending.kalshiObservationId!;
        const obs = await d.repo.getObservation(knownObservationId);
        if (!obs) continue;
        const signalProvenance = await d.repo.getSignalProvenance(pending.signalId);
        if (!signalProvenance) continue;
        const otherVenue: Venue = knownVenue === "PMUS" ? "KALSHI" : "PMUS";
        const row = await decideOneTier(
          pending.signalId,
          pending.requestedDelayMs,
          pending.notionalTierUsd,
          { notionalTierUsd: pending.notionalTierUsd, pmusObservationId: pending.pmusObservationId, kalshiObservationId: pending.kalshiObservationId, decidedAt: null, fireAtMs: cutoffAtMs },
          obs,
          otherVenue,
          signalProvenance,
          "CUTOFF_EXPIRED",
          d,
        );
        if (row) decided += 1;
      } catch {
        // Per-row best-effort: one bad row must not block the rest of the sweep.
      }
    }
  } catch {
    // Best-effort by design -- see this function's own doc comment.
  }
  return decided;
}
