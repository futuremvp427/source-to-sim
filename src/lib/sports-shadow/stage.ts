/**
 * FINAL BUILD Parts 18-21: research stage state machine — PURE logic only.
 *
 * Transitions are computed from durable, restart-safe inputs (epoch timestamps +
 * independent-episode counts the caller already persisted) -- nothing here depends on
 * this process staying alive between evaluations. Called once per cycle from
 * worker.server.ts; a missed cycle or a full restart simply re-evaluates from the same
 * durable state and reaches the identical conclusion.
 */

import type { ExperimentStage } from "./epoch";

export const SOAK_DURATION_MS = 72 * 60 * 60 * 1000;
export const CALIBRATION_MIN_DURATION_MS = 14 * 24 * 60 * 60 * 1000;
export const CALIBRATION_MIN_INDEPENDENT_EPISODES = 100;
export const OOS_MIN_DURATION_MS = 14 * 24 * 60 * 60 * 1000;
export const OOS_MIN_INDEPENDENT_EPISODES = 200;

export type StageEpochState = {
  stage: ExperimentStage;
  soakStartedAtMs: number | null;
  calibrationStartedAtMs: number | null;
  oosStartedAtMs: number | null;
};

export type StageTransitionInput = {
  epoch: StageEpochState;
  nowMs: number;
  /** Independent (clustered) episodes SETTLED since calibration began -- never raw fill/episode count. */
  independentSettledSinceCalibrationStart: number;
  /** Independent episodes settled since OOS specifically began (a SEPARATE counter from calibration's -- Part 21's "collect 200 ADDITIONAL"). */
  independentSettledSinceOosStart: number;
  /** Part 18's soak success gate (no coverage gap, no corruption, no sustained backlog, etc.) -- evaluated by the caller from telemetry/integrity results, never computed here. */
  soakHealthPassed: boolean;
  /**
   * The REAL promotion decision (classification.ts), evaluated by the caller ONLY once
   * the OOS sample/duration minimums below are already met (an expensive analytics run
   * every OOS cycle would be wasteful otherwise). null/undefined means "not yet
   * evaluated this cycle" and is treated identically to CONTINUE_RESEARCH -- reaching
   * the sample/duration floor is NECESSARY but never sufficient on its own to reach
   * LIVE_PILOT_REVIEW_READY; the full checklist (positive expectancy, stress survival,
   * drawdown, liquidity, integrity, confidence, ...) must also pass.
   */
  oosClassification?: "KILL" | "CONTINUE_RESEARCH" | "NEW_EPOCH_REQUIRED" | "LIVE_PILOT_REVIEW_READY" | null;
};

export type StageTransition = {
  /** null = stay in the current stage this cycle. */
  nextStage: ExperimentStage | null;
  reason: string;
};

/**
 * Never transitions OUT of a terminal stage (FAILED/PAUSED/LIVE_PILOT_REVIEW_READY) --
 * those require an explicit human/operator action (Part 20/24's own "never
 * auto-enable a live pilot" rule), not an automatic re-evaluation.
 */
export function evaluateStageTransition(input: StageTransitionInput): StageTransition {
  const { epoch, nowMs } = input;
  switch (epoch.stage) {
    case "PRE_SOAK":
      return { nextStage: "OPERATIONAL_SOAK", reason: "epoch created -- soak begins immediately" };

    case "OPERATIONAL_SOAK": {
      const elapsed = nowMs - (epoch.soakStartedAtMs ?? nowMs);
      if (elapsed < SOAK_DURATION_MS) {
        return { nextStage: null, reason: `soak in progress: ${Math.round(elapsed / 3_600_000)}h / ${SOAK_DURATION_MS / 3_600_000}h` };
      }
      if (!input.soakHealthPassed) {
        return { nextStage: "FAILED", reason: "72h soak duration elapsed but the health gate did not pass" };
      }
      return { nextStage: "CALIBRATION", reason: "72h soak duration elapsed and health gate passed" };
    }

    case "CALIBRATION": {
      const elapsed = nowMs - (epoch.calibrationStartedAtMs ?? nowMs);
      const durationOk = elapsed >= CALIBRATION_MIN_DURATION_MS;
      const countOk = input.independentSettledSinceCalibrationStart >= CALIBRATION_MIN_INDEPENDENT_EPISODES;
      if (durationOk && countOk) return { nextStage: "OUT_OF_SAMPLE", reason: "calibration minimums met (>=14 days AND >=100 independent settled episodes)" };
      return {
        nextStage: null,
        reason: `calibration in progress: ${input.independentSettledSinceCalibrationStart}/${CALIBRATION_MIN_INDEPENDENT_EPISODES} independent, ${Math.round(elapsed / 86_400_000)}/${CALIBRATION_MIN_DURATION_MS / 86_400_000} days`,
      };
    }

    case "OUT_OF_SAMPLE": {
      const elapsed = nowMs - (epoch.oosStartedAtMs ?? nowMs);
      const durationOk = elapsed >= OOS_MIN_DURATION_MS;
      const countOk = input.independentSettledSinceOosStart >= OOS_MIN_INDEPENDENT_EPISODES;
      if (durationOk && countOk) {
        // Reaching the sample/duration floor is necessary but NEVER sufficient on its
        // own -- the mission's own explicit rule. Only the real classification decision
        // (computed by the caller from actual analytics) may promote or kill from here.
        if (input.oosClassification === "LIVE_PILOT_REVIEW_READY") return { nextStage: "LIVE_PILOT_REVIEW_READY", reason: "OOS minimums met AND the full promotion checklist passed" };
        if (input.oosClassification === "KILL") return { nextStage: "FAILED", reason: "OOS minimums met but classification is KILL (net expectancy not positive)" };
        return { nextStage: null, reason: `OOS minimums met but classification is ${input.oosClassification ?? "not yet evaluated"} -- continuing research, not yet promotable` };
      }
      return {
        nextStage: null,
        reason: `OOS in progress: ${input.independentSettledSinceOosStart}/${OOS_MIN_INDEPENDENT_EPISODES} independent, ${Math.round(elapsed / 86_400_000)}/${OOS_MIN_DURATION_MS / 86_400_000} days`,
      };
    }

    case "LIVE_PILOT_REVIEW_READY":
    case "FAILED":
    case "PAUSED":
      return { nextStage: null, reason: `terminal stage ${epoch.stage} -- requires explicit human/operator action to leave` };
  }
}
