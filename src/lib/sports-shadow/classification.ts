/**
 * FINAL BUILD Part 5: promotion classification engine — PURE math only.
 *
 * Deterministic, research-only labels. NEVER enables live trading -- this module has no
 * side effects and touches no execution path; it only names what the evidence currently
 * supports, for a human to read. CALIBRATION never reaches PROVEN_PROFITABLE (that label
 * does not exist anywhere in this codebase); OOS's strongest label,
 * LIVE_PILOT_REVIEW_READY, still only means "ready for a HUMAN review of a live pilot",
 * never "approved" or "trading enabled".
 */

import { CALIBRATION_MIN_INDEPENDENT_EPISODES, OOS_MIN_INDEPENDENT_EPISODES } from "./stage";

export type CalibrationClassification = "NO_EVIDENCE" | "INSUFFICIENT_DATA" | "INTERESTING" | "CANDIDATE_FOR_OOS";
export type OosClassification = "KILL" | "CONTINUE_RESEARCH" | "NEW_EPOCH_REQUIRED" | "LIVE_PILOT_REVIEW_READY";

/** The statistical-confidence bar named in the mission ("~90-95%"), applied to bootstrap.ts's probabilityPositive. */
export const CANDIDATE_FOR_OOS_CONFIDENCE_THRESHOLD = 0.75;
export const LIVE_PILOT_CONFIDENCE_THRESHOLD = 0.9;
/** Max acceptable drawdown as a fraction of capital deployed -- a research-stage guardrail, not a live-trading risk limit (none exists; no trading is implemented anywhere in this codebase). */
export const LIVE_PILOT_MAX_DRAWDOWN_FRACTION = 0.5;
export const LIVE_PILOT_MIN_MATCH_RATE = 0.7;

export function classifyCalibration(input: {
  independentSettledCount: number;
  expectancyPerIndependentEpisodeUsd: number;
  bootstrapProbabilityPositive: number;
}): CalibrationClassification {
  if (input.independentSettledCount === 0) return "NO_EVIDENCE";
  if (input.independentSettledCount < CALIBRATION_MIN_INDEPENDENT_EPISODES) return "INSUFFICIENT_DATA";
  if (input.expectancyPerIndependentEpisodeUsd > 0 && input.bootstrapProbabilityPositive >= CANDIDATE_FOR_OOS_CONFIDENCE_THRESHOLD) {
    return "CANDIDATE_FOR_OOS";
  }
  return "INTERESTING";
}

export type LivePilotGateInput = {
  oosSampleAndDurationMet: boolean;
  oosExpectancyPerIndependentEpisodeUsd: number;
  oneCentStressExpectancyPerIndependentEpisodeUsd: number;
  /** Not gating on its own (the mission asks only that this be "explicitly reported") -- carried through purely for the report/dashboard. */
  twoCentStressExpectancyPerIndependentEpisodeUsd: number;
  topFiveWinsRemovedExpectancyPerIndependentEpisodeUsd: number;
  maxDrawdownUsd: number;
  capitalDeployedUsd: number;
  matchRateAtDeclaredTier: number;
  integrityAuditPassed: boolean;
  epochContaminationDetected: boolean;
  unresolvedMatchingIssues: boolean;
  operationalHealthAcceptable: boolean;
  bootstrapProbabilityPositive: number;
};

export type LivePilotGateResult = { ready: boolean; blockedReasons: string[] };

/** Every reason LIVE_PILOT_REVIEW_READY is currently blocked -- Part 9's dashboard requirement to show this explicitly, not just a boolean. Order is deterministic (declaration order below), not severity-sorted -- callers wanting a specific display order should sort themselves. */
export function evaluateLivePilotGate(input: LivePilotGateInput): LivePilotGateResult {
  const reasons: string[] = [];
  if (input.epochContaminationDetected) reasons.push("epoch version/config contamination detected -- a new epoch is required, this one can never reach LIVE_PILOT_REVIEW_READY");
  if (!input.oosSampleAndDurationMet) reasons.push(`OOS minimum sample/duration not yet reached (needs >= ${OOS_MIN_INDEPENDENT_EPISODES} additional independent settled episodes and the minimum OOS duration)`);
  if (input.oosExpectancyPerIndependentEpisodeUsd <= 0) reasons.push("OOS net expectancy per independent episode is not positive");
  if (input.oneCentStressExpectancyPerIndependentEpisodeUsd <= 0) reasons.push("does not survive a +1 cent adverse execution stress");
  if (input.topFiveWinsRemovedExpectancyPerIndependentEpisodeUsd <= 0) reasons.push("result depends on the top 5 wins -- not positive with them removed");
  const drawdownFraction = input.capitalDeployedUsd > 0 ? input.maxDrawdownUsd / input.capitalDeployedUsd : 0;
  if (drawdownFraction > LIVE_PILOT_MAX_DRAWDOWN_FRACTION) reasons.push(`max drawdown (${(drawdownFraction * 100).toFixed(1)}% of capital deployed) exceeds the ${(LIVE_PILOT_MAX_DRAWDOWN_FRACTION * 100).toFixed(0)}% acceptable threshold`);
  if (input.matchRateAtDeclaredTier < LIVE_PILOT_MIN_MATCH_RATE) reasons.push(`match rate at the declared strategy tier (${(input.matchRateAtDeclaredTier * 100).toFixed(1)}%) is below the ${(LIVE_PILOT_MIN_MATCH_RATE * 100).toFixed(0)}% liquidity-sufficiency threshold`);
  if (!input.integrityAuditPassed) reasons.push("integrity audit is not currently clean");
  if (input.unresolvedMatchingIssues) reasons.push("unresolved venue-matching issues remain outstanding");
  if (!input.operationalHealthAcceptable) reasons.push("operational health is not currently acceptable");
  if (input.bootstrapProbabilityPositive < LIVE_PILOT_CONFIDENCE_THRESHOLD) {
    reasons.push(`statistical confidence of positive net expectancy (${(input.bootstrapProbabilityPositive * 100).toFixed(1)}%) is below the ${(LIVE_PILOT_CONFIDENCE_THRESHOLD * 100).toFixed(0)}% threshold`);
  }
  return { ready: reasons.length === 0, blockedReasons: reasons };
}

export function classifyOos(input: LivePilotGateInput): OosClassification {
  if (!input.oosSampleAndDurationMet) return "CONTINUE_RESEARCH";
  if (input.epochContaminationDetected) return "NEW_EPOCH_REQUIRED";
  const gate = evaluateLivePilotGate(input);
  if (gate.ready) return "LIVE_PILOT_REVIEW_READY";
  if (input.oosExpectancyPerIndependentEpisodeUsd <= 0) return "KILL";
  return "CONTINUE_RESEARCH";
}
