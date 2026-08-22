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

import { evaluateNotionalTiers, SPORTS_SHADOW_NOTIONALS_USD, type DepthWalkResult } from "./depth-walk";
import { computeTakerFee, type FeeResult } from "./fees";
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
};

export type RoutingProvenance = {
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

export type PaperRepository = {
  getObservation(id: string): Promise<CapturedObservation | null>;
  getObservationForVenue(signalId: string, venue: Venue, requestedDelayMs: number): Promise<CapturedObservation | null>;
  getSignalProvenance(signalId: string): Promise<SignalProvenance | null>;
  getVenueMatch(signalId: string, venue: Venue): Promise<VenueMatchProvenance | null>;
  /** Step 1 of the two-step protocol -- see this module's own P1-2 doc comment. */
  recordRoutingProvenance(signalId: string, requestedDelayMs: number, notionalTierUsd: number, venue: Venue, observationId: string, fireAtMs: number): Promise<RoutingProvenance>;
  /** Step 2 -- returns true only if THIS call actually won the decision (decided_at was NULL beforehand). */
  finalizeRoutingDecision(signalId: string, requestedDelayMs: number, notionalTierUsd: number, row: PaperFillRow, decidedAtMs: number): Promise<boolean>;
  /** Bounded: rows whose cutoff window has expired without ever being decided -- see maybeDecideExpiredRoutingCutoffs. */
  findExpiredPendingRoutingRows(cutoffAtMs: number, limit: number): Promise<{ signalId: string; requestedDelayMs: number; notionalTierUsd: number; pmusObservationId: string | null; kalshiObservationId: string | null }[]>;
};

export const supabasePaperRepository: PaperRepository = {
  async getObservation(id) {
    const { data, error } = await supabaseAdmin
      .from("sports_quote_observations" as never)
      .select("id, signal_id, venue, requested_delay_ms, fire_at, observed_at, stale, error_code, ask_depth")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return rowToObservation(data);
  },

  async getObservationForVenue(signalId, venue, requestedDelayMs) {
    const { data, error } = await supabaseAdmin
      .from("sports_quote_observations" as never)
      .select("id, signal_id, venue, requested_delay_ms, fire_at, observed_at, stale, error_code, ask_depth")
      .eq("signal_id", signalId)
      .eq("venue", venue)
      .eq("requested_delay_ms", requestedDelayMs)
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

  async recordRoutingProvenance(signalId, requestedDelayMs, notionalTierUsd, venue, observationId, fireAtMs) {
    const { data, error } = await supabaseAdmin.rpc("record_sports_shadow_routing_provenance" as never, {
      p_signal_id: signalId,
      p_requested_delay_ms: requestedDelayMs,
      p_notional_tier_usd: notionalTierUsd,
      p_venue: venue,
      p_observation_id: observationId,
      p_fire_at: new Date(fireAtMs).toISOString(),
    } as never);
    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : data) as unknown as { pmus_observation_id: string | null; kalshi_observation_id: string | null; decided_at: string | null; fire_at: string };
    return { pmusObservationId: row.pmus_observation_id, kalshiObservationId: row.kalshi_observation_id, decidedAt: row.decided_at, fireAtMs: Date.parse(row.fire_at) };
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
    fees[Number(tier)] = dw.contractsFilled > 0 && dw.averageExecutionPrice !== null ? computeTakerFee(venue, dw.contractsFilled, dw.averageExecutionPrice) : { feeUsd: 0, valid: false, reason: "no contracts filled", feeModelVersion: "n/a", effectiveDate: "n/a" };
  }
  return { available: true, depthWalk, fees };
}

/**
 * Builds the full row for one notional tier's decision, including P1-4's direct
 * target_market_id/selected_side provenance (the CHOSEN venue's own match row -- never
 * inferred later via an ambiguous signal_id-only join) and P2-3's epoch/source
 * provenance. `side` is currently always "ENTRY" -- see episode.ts/CODEX P1-7 for the
 * source-side inventory lifecycle this would need to mirror for ADD/EXIT; this routing
 * engine already accepts any `side` value and is not itself the P1-7 gap.
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
 */
export async function computePaperFillsForObservation(observationId: string, deps: Partial<PaperDeps> = {}): Promise<PaperFillRow[]> {
  const d: PaperDeps = { ...defaultDeps, ...deps };
  const obs = await d.repo.getObservation(observationId);
  if (!obs) return [];

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

  // Provenance is recorded (and a decision attempted) for all five canonical tiers
  // regardless of whether THIS venue's own capture succeeded -- a failed/stale capture
  // is still real evidence ("this venue is known, and unavailable") that the sibling
  // venue's own eventual call needs to see via the SAME (signal, delay, tier) row.
  const decided: PaperFillRow[] = [];
  for (const tier of SPORTS_SHADOW_NOTIONALS_USD) {
    let provenance = await d.repo.recordRoutingProvenance(obs.signalId, obs.requestedDelayMs, tier, obs.venue, observationId, obs.fireAtMs);
    if (siblingObs?.observed) {
      provenance = await d.repo.recordRoutingProvenance(obs.signalId, obs.requestedDelayMs, tier, otherVenue, siblingObs.id, obs.fireAtMs);
    }
    if (provenance.decidedAt !== null) continue; // no-hindsight: already decided, this call changes nothing

    const bothKnown = provenance.pmusObservationId !== null && provenance.kalshiObservationId !== null;
    const now = d.now();
    const cutoffExpired = now - provenance.fireAtMs >= ROUTING_DECISION_CUTOFF_MS;
    if (!bothKnown && !cutoffExpired) continue; // wait for the sibling or a later cutoff sweep

    const row = await decideOneTier(obs.signalId, obs.requestedDelayMs, tier, provenance, obs, otherVenue, signalProvenance, bothKnown ? "BOTH_COMPLETE" : "CUTOFF_EXPIRED", d);
    if (row) decided.push(row);
  }
  return decided;
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
        const row = await decideOneTier(pending.signalId, pending.requestedDelayMs, pending.notionalTierUsd, { pmusObservationId: pending.pmusObservationId, kalshiObservationId: pending.kalshiObservationId, decidedAt: null, fireAtMs: cutoffAtMs }, obs, otherVenue, signalProvenance, "CUTOFF_EXPIRED", d);
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
