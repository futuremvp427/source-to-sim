/**
 * FINAL BUILD Part 17: durable experiment-epoch persistence — SERVER (DB) layer.
 * epoch.ts's version constants/config-hash are pure; this module is the Supabase-backed
 * repository that makes them durable and gives every evaluated row an epoch to
 * reference.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { computeConfigHash, currentEpochVersions, requiresNewEpoch, type ExperimentEpoch, type ExperimentEpochVersions, type ExperimentStage } from "./epoch";
import { KALSHI_FEE_MODEL_VERSION, PMUS_FEE_MODEL_VERSION } from "./fees";

/** Fields a caller never supplies directly -- always server-defaulted at creation (stage_entered_at = now(), the per-stage started_at columns stay null until transitionStage actually sets them). */
type EpochServerDefaultedFields = "id" | "createdAtIso" | "stageEnteredAtIso" | "soakStartedAtIso" | "calibrationStartedAtIso" | "oosStartedAtIso";

export type EpochRepository = {
  getCurrentEpoch(): Promise<ExperimentEpoch | null>;
  createEpoch(epoch: Omit<ExperimentEpoch, EpochServerDefaultedFields>): Promise<ExperimentEpoch>;
  /** Atomically flips the current epoch (if any) to is_current=false and inserts the new one as current -- never two is_current rows at once (DB-enforced, see the partial unique index). */
  startNewEpoch(epoch: Omit<ExperimentEpoch, EpochServerDefaultedFields | "stage" | "frozenAtIso">): Promise<ExperimentEpoch>;
  transitionStage(epochId: string, stage: ExperimentStage): Promise<void>;
  freezeEpoch(epochId: string, frozenConfig: Record<string, unknown>): Promise<void>;
};

type RawEpochRow = {
  id: string;
  created_at: string;
  go_live_at: string;
  wallet_cohort: string[];
  git_sha: string;
  config_hash: string;
  classifier_version: string;
  episode_version: string;
  resolver_version: string;
  router_version: string;
  pmus_fee_model_version: string;
  kalshi_fee_model_version: string;
  execution_simulator_version: string;
  settlement_version: string;
  stage: ExperimentStage;
  stage_entered_at: string;
  soak_started_at: string | null;
  calibration_started_at: string | null;
  oos_started_at: string | null;
  frozen_at: string | null;
};

function fromRow(row: RawEpochRow): ExperimentEpoch {
  return {
    id: row.id,
    createdAtIso: row.created_at,
    goLiveAtIso: row.go_live_at,
    walletCohort: row.wallet_cohort,
    gitSha: row.git_sha,
    configHash: row.config_hash,
    versions: {
      classifierVersion: row.classifier_version,
      episodeVersion: row.episode_version,
      resolverVersion: row.resolver_version,
      routerVersion: row.router_version,
      pmusFeeModelVersion: row.pmus_fee_model_version,
      kalshiFeeModelVersion: row.kalshi_fee_model_version,
      executionSimulatorVersion: row.execution_simulator_version,
      settlementVersion: row.settlement_version,
    },
    stage: row.stage,
    stageEnteredAtIso: row.stage_entered_at,
    soakStartedAtIso: row.soak_started_at,
    calibrationStartedAtIso: row.calibration_started_at,
    oosStartedAtIso: row.oos_started_at,
    frozenAtIso: row.frozen_at,
  };
}

export const supabaseEpochRepository: EpochRepository = {
  async getCurrentEpoch() {
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_experiment_epochs" as never)
      .select("*")
      .eq("is_current", true)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? fromRow(data as unknown as RawEpochRow) : null;
  },

  async createEpoch(epoch) {
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_experiment_epochs" as never)
      .insert({
        go_live_at: epoch.goLiveAtIso,
        wallet_cohort: epoch.walletCohort,
        git_sha: epoch.gitSha,
        config_hash: epoch.configHash,
        classifier_version: epoch.versions.classifierVersion,
        episode_version: epoch.versions.episodeVersion,
        resolver_version: epoch.versions.resolverVersion,
        router_version: epoch.versions.routerVersion,
        pmus_fee_model_version: epoch.versions.pmusFeeModelVersion,
        kalshi_fee_model_version: epoch.versions.kalshiFeeModelVersion,
        execution_simulator_version: epoch.versions.executionSimulatorVersion,
        settlement_version: epoch.versions.settlementVersion,
        stage: epoch.stage,
        frozen_at: epoch.frozenAtIso,
        is_current: false,
      } as never)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return fromRow(data as unknown as RawEpochRow);
  },

  async startNewEpoch(epoch) {
    // Two-step, not a single upsert: the OLD current epoch (if any) must be flipped to
    // false BEFORE the new one is inserted as current, or the partial unique index
    // (is_current WHERE is_current) rejects the insert -- see the schema migration's
    // own doc comment. A failure between these two steps leaves the OLD epoch current
    // and NO new epoch created (fails closed to "nothing changed", never to "two
    // current epochs" or "zero current epochs").
    const { error: flipError } = await supabaseAdmin
      .from("sports_shadow_experiment_epochs" as never)
      .update({ is_current: false } as never)
      .eq("is_current", true);
    if (flipError) throw new Error(flipError.message);

    const { data, error } = await supabaseAdmin
      .from("sports_shadow_experiment_epochs" as never)
      .insert({
        go_live_at: epoch.goLiveAtIso,
        wallet_cohort: epoch.walletCohort,
        git_sha: epoch.gitSha,
        config_hash: epoch.configHash,
        classifier_version: epoch.versions.classifierVersion,
        episode_version: epoch.versions.episodeVersion,
        resolver_version: epoch.versions.resolverVersion,
        router_version: epoch.versions.routerVersion,
        pmus_fee_model_version: epoch.versions.pmusFeeModelVersion,
        kalshi_fee_model_version: epoch.versions.kalshiFeeModelVersion,
        execution_simulator_version: epoch.versions.executionSimulatorVersion,
        settlement_version: epoch.versions.settlementVersion,
        stage: "PRE_SOAK",
        is_current: true,
      } as never)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return fromRow(data as unknown as RawEpochRow);
  },

  async transitionStage(epochId, stage) {
    const patch: Record<string, unknown> = { stage, stage_entered_at: new Date().toISOString() };
    if (stage === "OPERATIONAL_SOAK") patch["soak_started_at"] = new Date().toISOString();
    if (stage === "CALIBRATION") patch["calibration_started_at"] = new Date().toISOString();
    if (stage === "OUT_OF_SAMPLE") patch["oos_started_at"] = new Date().toISOString();
    const { error } = await supabaseAdmin.from("sports_shadow_experiment_epochs" as never).update(patch as never).eq("id", epochId);
    if (error) throw new Error(error.message);
  },

  async freezeEpoch(epochId, frozenConfig) {
    const { error } = await supabaseAdmin
      .from("sports_shadow_experiment_epochs" as never)
      .update({ frozen_at: new Date().toISOString(), frozen_config: frozenConfig } as never)
      .eq("id", epochId);
    if (error) throw new Error(error.message);
  },
};

/**
 * Ensures a current epoch exists and matches the CURRENT code's versions, creating a
 * new one if none exists yet or if `requiresNewEpoch` detects drift (a version bump
 * shipped since the last-known current epoch). Called once per source-lane cycle
 * (worker.server.ts) -- cheap (one SELECT in the common case, no write at all when the
 * existing epoch already matches).
 */
export async function ensureCurrentEpoch(
  wallets: readonly string[],
  goLiveAtMs: number,
  gitSha: string,
  repo: EpochRepository = supabaseEpochRepository,
): Promise<ExperimentEpoch> {
  const versions: ExperimentEpochVersions = currentEpochVersions(PMUS_FEE_MODEL_VERSION, KALSHI_FEE_MODEL_VERSION);
  const existing = await repo.getCurrentEpoch();
  const configHash = await computeConfigHash(wallets, versions);

  if (existing && !requiresNewEpoch(existing.versions, versions) && existing.configHash === configHash) {
    return existing;
  }

  // No current epoch, OR the current one's config/versions have drifted from what the
  // running code now implements -- start a fresh one rather than silently blending
  // pre-change and post-change results into the same epoch (Part 17's core rule).
  return repo.startNewEpoch({
    goLiveAtIso: new Date(goLiveAtMs).toISOString(),
    walletCohort: wallets,
    gitSha,
    configHash,
    versions,
  });
}
