/**
 * Pure, dependency-free logic for the live-capability safety layer.
 *
 * Nothing in this file (or anywhere in this project) can submit a real order.
 * LIVE_EXECUTION_IMPLEMENTED is a hard constant: while it is false, the
 * effective live allocation is always $0 no matter what state the operator
 * puts the system into. Qualification, allocation, kill switch and two-step
 * activation are all evaluated deterministically from persisted paper data.
 */

import { roundUsd } from "../shadow-core";

/** No live execution path exists in this codebase. Paper simulation only. */
export const LIVE_EXECUTION_IMPLEMENTED = false;

export type ActivationStage = "locked" | "armed" | "activated";

export type LiveSafetyState = {
  killSwitchEngaged: boolean;
  activationStage: ActivationStage;
  armedAt: string | null;
  activatedAt: string | null;
  maxLiveNotionalUsd: number;
  maxLiveExposureUsd: number;
};

/* ------------------------------------------------------------------ */
/* Qualification                                                       */
/* ------------------------------------------------------------------ */

export const QUALIFICATION = {
  minSettledMarkets: 25,
  minRoiPct: 0,
  minMarkCoveragePct: 80,
  maxInsufficientCashSkipRate: 0.2,
} as const;

export type QualificationInput = {
  id: string;
  name: string;
  cohort: string;
  handle: string;
  settledMarkets: number;
  roi: number | null;
  markCoveragePct: number | null;
  buys: number;
  insufficientCashSkips: number;
};

export type QualificationCheck = { label: string; pass: boolean; detail: string };

export type QualificationResult = {
  id: string;
  name: string;
  cohort: string;
  handle: string;
  /** qualified only when every check passes on verifiable data. */
  status: "qualified" | "not_qualified" | "insufficient_evidence";
  checks: QualificationCheck[];
  blockingReasons: string[];
};

/** Deterministic per-experiment qualification. Unknown data never passes. */
export function evaluateQualification(input: QualificationInput): QualificationResult {
  const attempts = input.buys + input.insufficientCashSkips;
  const skipRate = attempts > 0 ? input.insufficientCashSkips / attempts : 0;

  const checks: QualificationCheck[] = [
    {
      label: `Settled markets >= ${QUALIFICATION.minSettledMarkets}`,
      pass: input.settledMarkets >= QUALIFICATION.minSettledMarkets,
      detail: `${input.settledMarkets} settled`,
    },
    {
      label: "Simulated ROI positive",
      pass: input.roi !== null && input.roi > QUALIFICATION.minRoiPct,
      detail: input.roi === null ? "Unavailable" : `${input.roi.toFixed(2)}%`,
    },
    {
      label: `Mark coverage >= ${QUALIFICATION.minMarkCoveragePct}%`,
      pass:
        input.markCoveragePct !== null &&
        input.markCoveragePct >= QUALIFICATION.minMarkCoveragePct,
      detail: input.markCoveragePct === null ? "Unavailable" : `${input.markCoveragePct.toFixed(0)}%`,
    },
    {
      label: `Cash-starved skip rate <= ${QUALIFICATION.maxInsufficientCashSkipRate * 100}%`,
      pass: skipRate <= QUALIFICATION.maxInsufficientCashSkipRate,
      detail: `${(skipRate * 100).toFixed(1)}%`,
    },
  ];

  const unknown = input.roi === null || input.markCoveragePct === null;
  const blockingReasons = checks.filter((c) => !c.pass).map((c) => `${c.label} (${c.detail})`);
  const status: QualificationResult["status"] =
    blockingReasons.length === 0 ? "qualified" : unknown ? "insufficient_evidence" : "not_qualified";

  return {
    id: input.id,
    name: input.name,
    cohort: input.cohort,
    handle: input.handle,
    status,
    checks,
    blockingReasons,
  };
}

/* ------------------------------------------------------------------ */
/* Two-step activation + kill switch                                   */
/* ------------------------------------------------------------------ */

export type ActivationGate = { allowed: boolean; reason: string };

/** Step 1 of 2. Arming requires a disengaged kill switch and real evidence. */
export function canArm(state: LiveSafetyState, qualified: number): ActivationGate {
  if (state.killSwitchEngaged) return { allowed: false, reason: "Kill switch is engaged." };
  if (state.activationStage !== "locked")
    return { allowed: false, reason: `Already ${state.activationStage}.` };
  if (qualified < 1)
    return { allowed: false, reason: "No experiment currently meets the qualification criteria." };
  return { allowed: true, reason: "Arming allowed (step 1 of 2)." };
}

/** Step 2 of 2. A separate, explicit confirmation from an admin. */
export const ACTIVATION_CONFIRM_PHRASE = "ACTIVATE LIVE ALLOCATION";

export function canActivate(
  state: LiveSafetyState,
  qualified: number,
  confirmPhrase: string,
): ActivationGate {
  if (state.killSwitchEngaged) return { allowed: false, reason: "Kill switch is engaged." };
  if (state.activationStage !== "armed")
    return { allowed: false, reason: "System must be armed first (step 1 of 2)." };
  if (qualified < 1) return { allowed: false, reason: "Qualification lapsed since arming." };
  if (confirmPhrase.trim() !== ACTIVATION_CONFIRM_PHRASE)
    return { allowed: false, reason: "Confirmation phrase does not match." };
  return { allowed: true, reason: "Two-step activation complete." };
}

/* ------------------------------------------------------------------ */
/* Live allocation                                                     */
/* ------------------------------------------------------------------ */

export type AllocationInput = {
  state: LiveSafetyState;
  /** Live account equity in USD, or null when it cannot be verified. */
  liveEquityUsd: number | null;
  /** Current simulated open exposure at fresh marks, null when unavailable. */
  exposureUsd: number | null;
  /** True only when every open position carries a fresh, trustworthy mark. */
  marksComplete: boolean;
  qualifiedExperiments: number;
};

export type AllocationResult = {
  allocationUsd: number;
  perOrderNotionalUsd: number;
  blocked: boolean;
  reasons: string[];
};

/**
 * The allocation is fail-closed: any missing input, any stale mark, an engaged
 * kill switch, a non-activated stage, or the absence of a live execution path
 * produces $0. It never guesses equity or exposure.
 */
export function computeLiveAllocation(input: AllocationInput): AllocationResult {
  const reasons: string[] = [];
  const { state } = input;

  if (!LIVE_EXECUTION_IMPLEMENTED)
    reasons.push("No live execution path exists — paper simulation only.");
  if (state.killSwitchEngaged) reasons.push("Kill switch engaged.");
  if (state.activationStage !== "activated")
    reasons.push(`Activation stage is ${state.activationStage}, not activated.`);
  if (input.qualifiedExperiments < 1) reasons.push("No qualified experiment.");
  if (input.liveEquityUsd === null) reasons.push("Live equity unavailable.");
  if (input.exposureUsd === null || !input.marksComplete)
    reasons.push("Open exposure unavailable: marks are incomplete or stale.");
  if (!(state.maxLiveExposureUsd > 0) || !(state.maxLiveNotionalUsd > 0))
    reasons.push("Allocation caps are $0.");

  if (reasons.length > 0)
    return { allocationUsd: 0, perOrderNotionalUsd: 0, blocked: true, reasons };

  const headroom = Math.max(0, state.maxLiveExposureUsd - (input.exposureUsd ?? 0));
  const allocationUsd = roundUsd(Math.min(headroom, input.liveEquityUsd ?? 0));
  return {
    allocationUsd,
    perOrderNotionalUsd: roundUsd(Math.min(state.maxLiveNotionalUsd, allocationUsd)),
    blocked: allocationUsd <= 0,
    reasons: allocationUsd <= 0 ? ["No exposure headroom remaining."] : [],
  };
}
