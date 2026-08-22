/**
 * FINAL BUILD Parts 18-21 + 6 + 8 + 10: durable stage-transition orchestration —
 * SERVER (DB) layer. Wires stage.ts's pure state machine to the current epoch's real,
 * persisted timestamps and independent-settled-episode counts, applies any resulting
 * transition via epoch.server.ts, persists milestone snapshots at the moment their gate
 * is reached (Part 8), and fires the corresponding Telegram-integrated milestone alerts
 * (Part 10). Called once per cycle (best-effort, like onCycleComplete) -- a failure here
 * must never break the cycle it was evaluated from.
 */

import type { ExperimentEpoch } from "./epoch";
import { supabaseEpochRepository } from "./epoch.server";
import { CALIBRATION_MIN_DURATION_MS, CALIBRATION_MIN_INDEPENDENT_EPISODES, evaluateStageTransition, OOS_MIN_DURATION_MS, OOS_MIN_INDEPENDENT_EPISODES, type StageEpochState } from "./stage";

export type StageRepository = {
  getCurrentEpoch(): Promise<ExperimentEpoch | null>;
  /** Independent (clustered) episodes SETTLED since either the epoch's calibration_started_at or oos_started_at, whichever `stage` names -- backed by the SAME authoritative get_sports_shadow_epoch_counters RPC the dashboard uses (Part 7), so stage transitions and the dashboard's milestone counts can never silently disagree, and neither is bounded to a recent-row window. */
  countIndependentSettledSince(epochId: string, stage: "CALIBRATION" | "OUT_OF_SAMPLE"): Promise<number>;
  /** FINAL BUILD Part 6: the REAL, multi-cycle, restart-safe soak health rollup (soak.server.ts) -- replaces the old single-cycle `summary.errors.length === 0` heuristic. Only ever called while epoch.stage === OPERATIONAL_SOAK. */
  computeSoakHealth(epochId: string, soakStartedAtIso: string, nowMs: number): Promise<{ passed: boolean; failedChecks: string[] }>;
  /** FINAL BUILD Part 5/8: the real promotion decision, computed ONLY once the OOS sample/duration floor is already met. */
  evaluateOosClassification(epochId: string, oosStartedAtIso: string, oosSampleAndDurationMet: boolean): Promise<"KILL" | "CONTINUE_RESEARCH" | "NEW_EPOCH_REQUIRED" | "LIVE_PILOT_REVIEW_READY">;
  /** FINAL BUILD Part 8: insert-only, idempotent -- a no-op if a snapshot for this (epoch, kind, version) already exists. */
  persistCalibrationSnapshot(epoch: ExperimentEpoch): Promise<void>;
  persistFinalOosSnapshot(epoch: ExperimentEpoch, oosSampleAndDurationMet: boolean): Promise<void>;
  /** FINAL BUILD Part 10: delivers via the existing Telegram adapter with a permanent per-epoch dedup key -- see alerts.server.ts's raiseMilestoneAlert. */
  notifyMilestone(epochId: string, kind: string, message: string): Promise<void>;
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

  async evaluateOosClassification(epochId, oosStartedAtIso, oosSampleAndDurationMet) {
    const { evaluateOosClassification } = await import("./classification.server");
    const result = await evaluateOosClassification(epochId, oosStartedAtIso, oosSampleAndDurationMet);
    return result.classification;
  },

  async persistCalibrationSnapshot(epoch) {
    const { persistCalibrationSnapshotIfNeeded } = await import("./snapshot.server");
    await persistCalibrationSnapshotIfNeeded(epoch);
  },

  async persistFinalOosSnapshot(epoch, oosSampleAndDurationMet) {
    const { persistFinalOosSnapshotIfNeeded } = await import("./snapshot.server");
    await persistFinalOosSnapshotIfNeeded(epoch, oosSampleAndDurationMet);
  },

  async notifyMilestone(epochId, kind, message) {
    const { raiseMilestoneAlert } = await import("./alerts.server");
    await raiseMilestoneAlert(epochId, kind as never, message);
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
 *
 * Milestone snapshots (Part 8) and their Telegram alerts (Part 10) fire at the moment a
 * gate is reached, independent of what the STAGE transition itself ends up doing --
 * reaching calibration's gate always snapshots+transitions together (stage.ts's
 * CALIBRATION branch has no other outcome once the gate is met); reaching OOS's gate
 * always snapshots+alerts, but the STAGE only transitions if classification actually
 * says LIVE_PILOT_REVIEW_READY or KILL.
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

  // FINAL BUILD Part 8: CALIBRATION's gate has exactly one outcome once reached (always
  // transitions to OUT_OF_SAMPLE -- see stage.ts), so it's safe to snapshot BEFORE
  // computing the transition below; nothing about the transition depends on the snapshot.
  const calibrationGateMet =
    epoch.stage === "CALIBRATION" &&
    epoch.calibrationStartedAtIso !== null &&
    nowMs - Date.parse(epoch.calibrationStartedAtIso) >= CALIBRATION_MIN_DURATION_MS &&
    independentSettledSinceCalibrationStart >= CALIBRATION_MIN_INDEPENDENT_EPISODES;
  if (calibrationGateMet) {
    await repo.persistCalibrationSnapshot(epoch);
    await repo.notifyMilestone(epoch.id, "sports_shadow_calibration_100", `Epoch ${epoch.id}: calibration reached ${independentSettledSinceCalibrationStart} independent settled episodes and its 14-day minimum.`);
  }

  // FINAL BUILD Part 5/8: OOS's gate reaching sample/duration does NOT by itself decide
  // the stage transition (see stage.ts's own doc comment) -- the real classification
  // must be computed first, which ALSO doubles as the FINAL_OOS snapshot's content.
  const oosGateMet =
    epoch.stage === "OUT_OF_SAMPLE" &&
    epoch.oosStartedAtIso !== null &&
    nowMs - Date.parse(epoch.oosStartedAtIso) >= OOS_MIN_DURATION_MS &&
    independentSettledSinceOosStart >= OOS_MIN_INDEPENDENT_EPISODES;
  let oosClassification: "KILL" | "CONTINUE_RESEARCH" | "NEW_EPOCH_REQUIRED" | "LIVE_PILOT_REVIEW_READY" | null = null;
  if (oosGateMet && epoch.oosStartedAtIso) {
    oosClassification = await repo.evaluateOosClassification(epoch.id, epoch.oosStartedAtIso, oosGateMet);
    await repo.persistFinalOosSnapshot(epoch, oosGateMet);
    await repo.notifyMilestone(epoch.id, "sports_shadow_oos_300", `Epoch ${epoch.id}: OOS reached ${independentSettledSinceOosStart} additional independent settled episodes and its 14-day minimum. Classification: ${oosClassification}.`);
    if (oosClassification === "LIVE_PILOT_REVIEW_READY") {
      await repo.notifyMilestone(epoch.id, "sports_shadow_live_pilot_review_ready", `Epoch ${epoch.id} is LIVE_PILOT_REVIEW_READY -- research classification only, no trading is enabled by this label.`);
    }
  }

  const transition = evaluateStageTransition({
    epoch: epochState,
    nowMs,
    independentSettledSinceCalibrationStart,
    independentSettledSinceOosStart,
    soakHealthPassed,
    oosClassification,
  });

  if (transition.nextStage !== null) {
    await repo.transitionStage(epoch.id, transition.nextStage);
    if (epoch.stage === "OPERATIONAL_SOAK") {
      await repo.notifyMilestone(epoch.id, transition.nextStage === "FAILED" ? "sports_shadow_soak_failed" : "sports_shadow_soak_passed", `Epoch ${epoch.id}: soak ${transition.nextStage === "FAILED" ? "FAILED" : "PASSED"} -- ${transition.reason}`);
    }
  }

  return { epochId: epoch.id, previousStage: epoch.stage, nextStage: transition.nextStage, reason: transition.reason, soakFailedChecks };
}
