/**
 * FINAL BUILD Part 8: durable, versioned milestone snapshots — SERVER (DB) layer.
 *
 * A snapshot is written EXACTLY ONCE per (epoch, milestone kind, code version) --
 * insert-only, checked-before-insert, never an upsert/overwrite. The mission's own rule
 * ("do not recompute old milestone snapshots under later code/rule versions without
 * explicitly creating a new version") is enforced structurally: bumping
 * SNAPSHOT_VERSION is the only way a milestone can ever be re-evaluated, and doing so
 * always ADDS a new row rather than replacing the old one.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { evaluateCalibrationClassification, evaluateOosClassification } from "./classification.server";
import type { ExperimentEpoch } from "./epoch";

/** Bump this ONLY when the analysis methodology itself changes (new metric, changed threshold, fixed bug in a calculation) -- never to force a re-snapshot of unchanged logic. */
export const SNAPSHOT_VERSION = "SNAPSHOT_V1";

async function snapshotExists(epochId: string, milestoneKind: "CALIBRATION" | "FINAL_OOS"): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("sports_shadow_milestone_snapshots" as never)
    .select("id")
    .eq("experiment_epoch_id", epochId)
    .eq("milestone_kind", milestoneKind)
    .eq("snapshot_version", SNAPSHOT_VERSION)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data !== null;
}

async function insertSnapshot(epoch: ExperimentEpoch, milestoneKind: "CALIBRATION" | "FINAL_OOS", classification: string, report: unknown): Promise<void> {
  const frozenConfig = { versions: epoch.versions, configHash: epoch.configHash, gitSha: epoch.gitSha, walletCohort: epoch.walletCohort };
  const { error } = await supabaseAdmin.from("sports_shadow_milestone_snapshots" as never).insert({
    experiment_epoch_id: epoch.id,
    milestone_kind: milestoneKind,
    snapshot_version: SNAPSHOT_VERSION,
    frozen_config: frozenConfig,
    report,
    classification,
  } as never);
  // A unique-constraint conflict here means a CONCURRENT evaluation already inserted the
  // identical (epoch, kind, version) snapshot between this call's existence check and its
  // insert -- the milestone is still recorded exactly once either way, so this is a
  // benign race, not a failure, and is deliberately swallowed rather than surfaced as an
  // error that would otherwise break the caller's stage-transition cycle.
  if (error && error.code !== "23505") throw new Error(error.message);
}

/**
 * Idempotent: safe to call every cycle once CALIBRATION's gate is met -- a snapshot is
 * only ever actually written the first time this is called after the gate is reached
 * (or after the current SNAPSHOT_VERSION changes).
 */
export async function persistCalibrationSnapshotIfNeeded(epoch: ExperimentEpoch): Promise<void> {
  if (!epoch.calibrationStartedAtIso) return;
  if (await snapshotExists(epoch.id, "CALIBRATION")) return;
  const { classification, report } = await evaluateCalibrationClassification(epoch.id, epoch.calibrationStartedAtIso);
  await insertSnapshot(epoch, "CALIBRATION", classification, report);
}

export async function persistFinalOosSnapshotIfNeeded(epoch: ExperimentEpoch, oosSampleAndDurationMet: boolean): Promise<void> {
  if (!epoch.oosStartedAtIso) return;
  if (await snapshotExists(epoch.id, "FINAL_OOS")) return;
  const { classification, report } = await evaluateOosClassification(epoch.id, epoch.oosStartedAtIso, oosSampleAndDurationMet);
  await insertSnapshot(epoch, "FINAL_OOS", classification, report);
}
