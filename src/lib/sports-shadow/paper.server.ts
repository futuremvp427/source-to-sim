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
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { evaluateNotionalTiers, type DepthWalkResult } from "./depth-walk";
import { computeTakerFee, type FeeResult } from "./fees";
import { routeExecution, type RoutingDecision } from "./router";
import type { DepthLevel, Venue } from "./types";

export type CapturedObservation = {
  id: string;
  signalId: string;
  venue: Venue;
  requestedDelayMs: number;
  stale: boolean;
  errorCode: string | null;
  askDepth: DepthLevel[];
};

export type PaperFillRow = {
  signalId: string;
  observationId: string;
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
};

export type PaperRepository = {
  getObservation(id: string): Promise<CapturedObservation | null>;
  getSiblingObservation(signalId: string, venue: Venue, requestedDelayMs: number): Promise<CapturedObservation | null>;
  insertPaperFills(rows: PaperFillRow[]): Promise<void>;
};

export const supabasePaperRepository: PaperRepository = {
  async getObservation(id) {
    const { data, error } = await supabaseAdmin
      .from("sports_quote_observations" as never)
      .select("id, signal_id, venue, requested_delay_ms, stale, error_code, ask_depth")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as unknown as { id: string; signal_id: string; venue: Venue; requested_delay_ms: number; stale: boolean; error_code: string | null; ask_depth: DepthLevel[] | null };
    return { id: row.id, signalId: row.signal_id, venue: row.venue, requestedDelayMs: row.requested_delay_ms, stale: row.stale, errorCode: row.error_code, askDepth: row.ask_depth ?? [] };
  },

  async getSiblingObservation(signalId, venue, requestedDelayMs) {
    const { data, error } = await supabaseAdmin
      .from("sports_quote_observations" as never)
      .select("id, signal_id, venue, requested_delay_ms, stale, error_code, ask_depth")
      .eq("signal_id", signalId)
      .eq("venue", venue)
      .eq("requested_delay_ms", requestedDelayMs)
      .not("observed_at", "is", null) // only a genuinely CAPTURED sibling counts -- a still-pending row is "not yet available", not a usable counterfactual
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as unknown as { id: string; signal_id: string; venue: Venue; requested_delay_ms: number; stale: boolean; error_code: string | null; ask_depth: DepthLevel[] | null };
    return { id: row.id, signalId: row.signal_id, venue: row.venue, requestedDelayMs: row.requested_delay_ms, stale: row.stale, errorCode: row.error_code, askDepth: row.ask_depth ?? [] };
  },

  async insertPaperFills(rows) {
    if (rows.length === 0) return;
    const { error } = await supabaseAdmin.from("sports_shadow_paper_fills" as never).upsert(
      rows.map((r) => ({
        signal_id: r.signalId,
        observation_id: r.observationId,
        side: r.side,
        notional_tier_usd: r.notionalTierUsd,
        routing_timestamp: new Date(r.routingTimestampMs).toISOString(),
        pmus_result: r.pmusResult,
        kalshi_result: r.kalshiResult,
        chosen_venue: r.chosenVenue,
        fill_status: r.fillStatus,
        contracts: r.contracts,
        vwap: r.vwap,
        fee_usd: r.feeUsd,
        fee_model_version: r.feeModelVersion,
        fee_valid: r.feeValid,
        all_in_cost_usd: r.allInCostUsd,
        reject_reason: r.rejectReason,
      })) as never,
      { onConflict: "observation_id,notional_tier_usd", ignoreDuplicates: true },
    );
    if (error) throw new Error(error.message);
  },
};

export type PaperDeps = { repo: PaperRepository; now: () => number };
const defaultDeps: PaperDeps = { repo: supabasePaperRepository, now: () => Date.now() };

function evaluateVenue(venue: Venue, obs: CapturedObservation | null): { available: boolean; depthWalk: Record<number, DepthWalkResult>; fees: Record<number, FeeResult> } {
  if (!obs || obs.stale || obs.errorCode !== null) {
    return { available: false, depthWalk: {}, fees: {} };
  }
  const depthWalk = evaluateNotionalTiers(obs.askDepth);
  const fees: Record<number, FeeResult> = {};
  for (const [tier, dw] of Object.entries(depthWalk)) {
    fees[Number(tier)] = dw.contractsFilled > 0 && dw.averageExecutionPrice !== null ? computeTakerFee(venue, dw.contractsFilled, dw.averageExecutionPrice) : { feeUsd: 0, valid: false, reason: "no contracts filled", feeModelVersion: "n/a", effectiveDate: "n/a" };
  }
  return { available: true, depthWalk, fees };
}

function toRow(signalId: string, observationId: string, tier: number, decision: RoutingDecision): PaperFillRow {
  const chosen = decision.chosenVenue === "PMUS" ? decision.pmus : decision.chosenVenue === "KALSHI" ? decision.kalshi : null;
  return {
    signalId,
    observationId,
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
  };
}

/**
 * Triggered once per successfully-captured observation (both success AND real-failure
 * captures reach this -- the stale/errorCode check below is what actually gates
 * whether any paper fill is produced, per Section 13's stale-book rule). Idempotent:
 * `sports_shadow_paper_fills`'s UNIQUE(observation_id, notional_tier_usd) plus
 * ignoreDuplicates make a retried call for the identical observation a harmless no-op.
 */
export async function computePaperFillsForObservation(observationId: string, deps: Partial<PaperDeps> = {}): Promise<PaperFillRow[]> {
  const d: PaperDeps = { ...defaultDeps, ...deps };
  const obs = await d.repo.getObservation(observationId);
  if (!obs) return [];
  // Section 13: a stale or genuinely-failed observation is NEVER converted into a bad
  // fill -- this venue simply contributes nothing for this observation event.
  if (obs.stale || obs.errorCode !== null) return [];

  const otherVenue: Venue = obs.venue === "PMUS" ? "KALSHI" : "PMUS";
  const sibling = await d.repo.getSiblingObservation(obs.signalId, otherVenue, obs.requestedDelayMs);

  const thisEval = evaluateVenue(obs.venue, obs);
  const otherEval = evaluateVenue(otherVenue, sibling);

  const now = d.now();
  const rows: PaperFillRow[] = [];
  for (const tier of Object.keys(thisEval.depthWalk).map(Number)) {
    const thisSide = { available: thisEval.available, depthWalk: thisEval.depthWalk[tier] ?? null, fee: thisEval.fees[tier] ?? null };
    const otherSide = { available: otherEval.available, depthWalk: otherEval.depthWalk[tier] ?? null, fee: otherEval.fees[tier] ?? null };
    const pmusInput = obs.venue === "PMUS" ? thisSide : otherSide;
    const kalshiInput = obs.venue === "KALSHI" ? thisSide : otherSide;
    const decision = routeExecution(tier, pmusInput, kalshiInput, now);
    rows.push(toRow(obs.signalId, observationId, tier, decision));
  }

  await d.repo.insertPaperFills(rows);
  return rows;
}
