/**
 * FINAL BUILD Part 12: no-hindsight router — PURE math only, no network/Supabase/clock
 * access (the caller supplies `nowMs` and both venues' ALREADY-CAPTURED depth-walk +
 * fee results; this module never fetches anything itself). Combines Task 10's
 * depth-walk.ts result and fees.ts's fee result for PM-US and Kalshi, evaluated at the
 * SAME notional tier, and picks the better executable economics under one fixed,
 * deterministic rule — never by peeking at either venue's LATER quotes, settlement, or
 * price movement (Part 12's explicit "no hindsight" requirement). Both venues' full
 * results (including the REJECTED one) are always returned so later research can
 * reconstruct PM-US-only, Kalshi-only, and routed performance without re-deriving
 * history (Part 12's "preserve venue-specific counterfactuals").
 */

import type { DepthWalkResult } from "./depth-walk";
import type { FeeResult } from "./fees";
import type { Venue } from "./types";

export type VenueExecutionCandidate = {
  venue: Venue;
  /** False if this venue's book could not even be evaluated this cycle (capability unavailable, deadline exhaustion, stale/health-gate rejection upstream) -- see Section 13's stale-book gates, applied by the CALLER before this module ever sees the candidate. */
  available: boolean;
  depthWalk: DepthWalkResult | null;
  fee: FeeResult | null;
  /** filledNotionalUsd + feeUsd for a QUALIFYING candidate; null otherwise. Never fee-free. */
  allInCostUsd: number | null;
  /** Blended cost per contract actually filled: allInCostUsd / contractsFilled. The router's own ranking metric -- lower is better. null unless qualifying. */
  effectiveCostPerContract: number | null;
  /** Non-null whenever this candidate did NOT qualify for routing (unavailable, NONE/INVALID depth, invalid/UNVERIFIED fee) -- explains why, for the audit trail even when the other venue was chosen. */
  disqualifiedReason: string | null;
};

export type RoutingDecision = {
  notionalTierUsd: number;
  pmus: VenueExecutionCandidate;
  kalshi: VenueExecutionCandidate;
  /** null means REJECT -- neither venue qualified. */
  chosenVenue: Venue | null;
  routingTimestampMs: number;
  rejectReason: string | null;
};

function buildCandidate(venue: Venue, available: boolean, depthWalk: DepthWalkResult | null, fee: FeeResult | null): VenueExecutionCandidate {
  if (!available) {
    return { venue, available: false, depthWalk, fee, allInCostUsd: null, effectiveCostPerContract: null, disqualifiedReason: `${venue} capability unavailable this cycle` };
  }
  if (depthWalk === null) {
    return { venue, available, depthWalk, fee, allInCostUsd: null, effectiveCostPerContract: null, disqualifiedReason: `${venue} has no depth-walk result` };
  }
  if (depthWalk.status !== "FULL" && depthWalk.status !== "PARTIAL") {
    return { venue, available, depthWalk, fee, allInCostUsd: null, effectiveCostPerContract: null, disqualifiedReason: `${venue} depth-walk status ${depthWalk.status}${depthWalk.invalidReason ? `: ${depthWalk.invalidReason}` : ""}` };
  }
  if (fee === null || !fee.valid) {
    return { venue, available, depthWalk, fee, allInCostUsd: null, effectiveCostPerContract: null, disqualifiedReason: `${venue} fee UNVERIFIED${fee?.reason ? `: ${fee.reason}` : ""}` };
  }
  const allInCostUsd = depthWalk.filledNotionalUsd + fee.feeUsd;
  const effectiveCostPerContract = depthWalk.contractsFilled > 0 ? allInCostUsd / depthWalk.contractsFilled : null;
  if (effectiveCostPerContract === null) {
    return { venue, available, depthWalk, fee, allInCostUsd: null, effectiveCostPerContract: null, disqualifiedReason: `${venue} filled zero contracts` };
  }
  return { venue, available, depthWalk, fee, allInCostUsd, effectiveCostPerContract, disqualifiedReason: null };
}

/**
 * Deterministic ranking rule (fixed, never randomized, never venue-order-dependent):
 * 1. Higher fillRatio wins (more of the requested notional actually executable beats a
 *    cheaper-per-contract but mostly-unfilled quote — Part 32's capacity concern).
 * 2. Among equal fillRatio, lower effectiveCostPerContract wins (genuinely better
 *    all-in economics for the same amount of exposure).
 * 3. Exact tie (fillRatio AND effectiveCostPerContract both equal, or both candidates
 *    identically absent) -- PM-US is preferred, stated here explicitly rather than left
 *    to object/array iteration order or Math.random. This tie-break is never expected
 *    to matter in practice (real quotes essentially never land on an exact tie) but
 *    must still be deterministic and reproducible for OOS analysis.
 */
function isBetter(a: VenueExecutionCandidate, b: VenueExecutionCandidate): boolean {
  const aFillRatio = a.depthWalk?.fillRatio ?? -1;
  const bFillRatio = b.depthWalk?.fillRatio ?? -1;
  if (aFillRatio !== bFillRatio) return aFillRatio > bFillRatio;
  const aCost = a.effectiveCostPerContract ?? Number.POSITIVE_INFINITY;
  const bCost = b.effectiveCostPerContract ?? Number.POSITIVE_INFINITY;
  if (aCost !== bCost) return aCost < bCost;
  return a.venue === "PMUS"; // deterministic tie-break
}

/**
 * Routes ONE notional tier's decision. Called once per tier (Part 9's $5/$10/$25/$50/
 * $100 ladder) -- each tier is routed independently, since a venue with insufficient
 * depth for $100 may still fully fill $5.
 */
export function routeExecution(
  notionalTierUsd: number,
  pmus: { available: boolean; depthWalk: DepthWalkResult | null; fee: FeeResult | null },
  kalshi: { available: boolean; depthWalk: DepthWalkResult | null; fee: FeeResult | null },
  nowMs: number,
): RoutingDecision {
  const pmusCandidate = buildCandidate("PMUS", pmus.available, pmus.depthWalk, pmus.fee);
  const kalshiCandidate = buildCandidate("KALSHI", kalshi.available, kalshi.depthWalk, kalshi.fee);

  const pmusQualifies = pmusCandidate.disqualifiedReason === null;
  const kalshiQualifies = kalshiCandidate.disqualifiedReason === null;

  let chosenVenue: Venue | null = null;
  let rejectReason: string | null = null;
  if (pmusQualifies && kalshiQualifies) {
    chosenVenue = isBetter(pmusCandidate, kalshiCandidate) ? "PMUS" : "KALSHI";
  } else if (pmusQualifies) {
    chosenVenue = "PMUS";
  } else if (kalshiQualifies) {
    chosenVenue = "KALSHI";
  } else {
    rejectReason = `neither venue qualified -- PMUS: ${pmusCandidate.disqualifiedReason}; KALSHI: ${kalshiCandidate.disqualifiedReason}`;
  }

  return {
    notionalTierUsd,
    pmus: pmusCandidate,
    kalshi: kalshiCandidate,
    chosenVenue,
    routingTimestampMs: nowMs,
    rejectReason,
  };
}
