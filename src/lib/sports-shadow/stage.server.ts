/**
 * FINAL BUILD Parts 18-21: durable stage-transition orchestration — SERVER (DB) layer.
 * Wires stage.ts's pure state machine to the current epoch's real, persisted
 * timestamps and independent-settled-episode counts, and applies any resulting
 * transition via epoch.server.ts. Called once per cycle (best-effort, like
 * onCycleComplete) -- a failure here must never break the cycle it was evaluated from.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import type { ExperimentEpoch } from "./epoch";
import { supabaseEpochRepository } from "./epoch.server";
import { evaluateStageTransition, type StageEpochState } from "./stage";

export type StageRepository = {
  getCurrentEpoch(): Promise<ExperimentEpoch | null>;
  /** Independent (clustered) episodes SETTLED since the given ISO timestamp -- reuses cluster_key already persisted at signal-creation time (Part 16), never recomputed here. */
  countIndependentSettledSince(sinceIso: string): Promise<number>;
  transitionStage(epochId: string, stage: StageEpochState["stage"]): Promise<void>;
};

export const supabaseStageRepository: StageRepository = {
  getCurrentEpoch: () => supabaseEpochRepository.getCurrentEpoch(),

  async countIndependentSettledSince(sinceIso) {
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_signals" as never)
      .select("cluster_key, source_wallet, created_at")
      .gte("created_at", sinceIso)
      .in("status", ["SETTLED_WIN", "SETTLED_LOSS", "SETTLED_PUSH"]);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as { cluster_key: string | null; source_wallet: string; created_at: string }[];
    const clusters = new Set(rows.map((r) => r.cluster_key ?? `__unclustered_${r.source_wallet}_${r.created_at}`));
    return clusters.size;
  },

  transitionStage: (epochId, stage) => supabaseEpochRepository.transitionStage(epochId, stage),
};

export type StageEvaluationOutcome = { epochId: string; previousStage: string; nextStage: string | null; reason: string };

/**
 * Part 18's soak health gate is evaluated by the CALLER (worker.server.ts has the
 * telemetry/integrity signals this module does not query itself) and passed in --
 * this function never fabricates a health verdict on its own.
 */
export async function evaluateAndApplyStageTransition(soakHealthPassed: boolean, now: () => number = Date.now, repo: StageRepository = supabaseStageRepository): Promise<StageEvaluationOutcome | null> {
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

  // Only the counter relevant to the CURRENT stage is worth a real query -- avoids an
  // unnecessary DB round trip for the common case (still in soak, or terminal).
  const independentSettledSinceCalibrationStart =
    epoch.stage === "CALIBRATION" && epoch.calibrationStartedAtIso ? await repo.countIndependentSettledSince(epoch.calibrationStartedAtIso) : 0;
  const independentSettledSinceOosStart = epoch.stage === "OUT_OF_SAMPLE" && epoch.oosStartedAtIso ? await repo.countIndependentSettledSince(epoch.oosStartedAtIso) : 0;

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

  return { epochId: epoch.id, previousStage: epoch.stage, nextStage: transition.nextStage, reason: transition.reason };
}
