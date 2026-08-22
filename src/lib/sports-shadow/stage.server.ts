/**
 * FINAL BUILD Parts 18-21: durable stage-transition orchestration — SERVER (DB) layer.
 * Wires stage.ts's pure state machine to the current epoch's real, persisted
 * timestamps and independent-settled-episode counts, and applies any resulting
 * transition via epoch.server.ts. Called once per cycle (best-effort, like
 * onCycleComplete) -- a failure here must never break the cycle it was evaluated from.
 */

import type { ExperimentEpoch } from "./epoch";
import { supabaseEpochRepository } from "./epoch.server";
import { evaluateStageTransition, type StageEpochState } from "./stage";

export type StageRepository = {
  getCurrentEpoch(): Promise<ExperimentEpoch | null>;
  /** Independent (clustered) episodes SETTLED since either the epoch's calibration_started_at or oos_started_at, whichever `stage` names -- backed by the SAME authoritative get_sports_shadow_epoch_counters RPC the dashboard uses (Part 7), so stage transitions and the dashboard's milestone counts can never silently disagree, and neither is bounded to a recent-row window. */
  countIndependentSettledSince(epochId: string, stage: "CALIBRATION" | "OUT_OF_SAMPLE"): Promise<number>;
  /** FINAL BUILD Part 6: the REAL, multi-cycle, restart-safe soak health rollup (soak.server.ts) -- replaces the old single-cycle `summary.errors.length === 0` heuristic. Only ever called while epoch.stage === OPERATIONAL_SOAK. */
  computeSoakHealth(epochId: string, soakStartedAtIso: string, nowMs: number): Promise<{ passed: boolean; failedChecks: string[] }>;
  transitionStage(epochId: string, stage: StageEpochState["stage"]): Promise<void>;
};

export const supabaseStageRepository: StageRepository = {
  getCurrentEpoch: () => supabaseEpochRepository.getCurrentEpoch(),

  async countIndependentSettledSince(epochId, stage) {
    const { getEpochCounters } = await import("./counters.server");
    const counters = await getEpochCounters(epochId);
    return stage === "CALIBRATION" ? counters.calibrationIndependentSettledCount : counters.oosIndependentSettledCount;
  },

  async computeSoakHealth(epochId, soakStartedAtIso, nowMs) {
    const { computeSoakHealthRollup } = await import("./soak.server");
    return computeSoakHealthRollup(epochId, soakStartedAtIso, nowMs);
  },

  transitionStage: (epochId, stage) => supabaseEpochRepository.transitionStage(epochId, stage),
};

export type StageEvaluationOutcome = { epochId: string; previousStage: string; nextStage: string | null; reason: string; soakFailedChecks: string[] };

/**
 * The soak health gate (Part 6) is computed HERE, not passed in by the caller -- unlike
 * the old single-cycle heuristic, it needs a real multi-cycle rollup query, which only
 * makes sense (and is only worth the round trip) while the epoch is actually in
 * OPERATIONAL_SOAK; every other stage skips it entirely, matching the same
 * "only query what's relevant to the current stage" discipline already used for the
 * independent-settled counters below.
 */
export async function evaluateAndApplyStageTransition(now: () => number = Date.now, repo: StageRepository = supabaseStageRepository): Promise<StageEvaluationOutcome | null> {
  const epoch = await repo.getCurrentEpoch();
  if (!epoch) return null;

  const nowMs = now();
  const epochState: StageEpochState = {
    stage: epoch.stage,
    // soak_started_at is set once, at the moment PRE_SOAK -> OPERATIONAL_SOAK actually
    // happens (epoch.server.ts's transitionStage) -- stageEnteredAtIso is the correct
    // fallback ONLY while still in PRE_SOAK itself (soak has not started yet).
    soakStartedAtMs: epoch.soakStartedAtIso ? Date.parse(epoch.soakStartedAtIso) : null,
    calibrationStartedAtMs: epoch.calibrationStartedAtIso ? Date.parse(epoch.calibrationStartedAtIso) : null,
    oosStartedAtMs: epoch.oosStartedAtIso ? Date.parse(epoch.oosStartedAtIso) : null,
  };

  // Only the counter/health check relevant to the CURRENT stage is worth a real query --
  // avoids unnecessary DB round trips for the common case (calibration, OOS, terminal).
  const independentSettledSinceCalibrationStart =
    epoch.stage === "CALIBRATION" && epoch.calibrationStartedAtIso ? await repo.countIndependentSettledSince(epoch.id, "CALIBRATION") : 0;
  const independentSettledSinceOosStart = epoch.stage === "OUT_OF_SAMPLE" && epoch.oosStartedAtIso ? await repo.countIndependentSettledSince(epoch.id, "OUT_OF_SAMPLE") : 0;

  let soakHealthPassed = true;
  let soakFailedChecks: string[] = [];
  if (epoch.stage === "OPERATIONAL_SOAK" && epoch.soakStartedAtIso) {
    const health = await repo.computeSoakHealth(epoch.id, epoch.soakStartedAtIso, nowMs);
    soakHealthPassed = health.passed;
    soakFailedChecks = health.failedChecks;
  }

  const transition = evaluateStageTransition({
    epoch: epochState,
    nowMs,
    independentSettledSinceCalibrationStart,
    independentSettledSinceOosStart,
    soakHealthPassed,
  });

  if (transition.nextStage !== null) {
    await repo.transitionStage(epoch.id, transition.nextStage);
  }

  return { epochId: epoch.id, previousStage: epoch.stage, nextStage: transition.nextStage, reason: transition.reason, soakFailedChecks };
}
