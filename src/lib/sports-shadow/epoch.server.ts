/**
 * FINAL BUILD Part 17: durable experiment-epoch persistence — SERVER (DB) layer.
 * epoch.ts's version constants/config-hash are pure; this module is the Supabase-backed
 * repository that makes them durable and gives every evaluated row an epoch to
 * reference.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { computeConfigHash, currentEpochVersions, type ExperimentEpoch, type ExperimentEpochVersions, type ExperimentStage } from "./epoch";
import { KALSHI_FEE_MODEL_VERSION, PMUS_FEE_MODEL_VERSION } from "./fees";

/** Fields a caller never supplies directly -- always server-defaulted at creation (stage_entered_at = now(), the per-stage started_at columns stay null until transitionStage actually sets them). */
type EpochServerDefaultedFields = "id" | "createdAtIso" | "stageEnteredAtIso" | "soakStartedAtIso" | "calibrationStartedAtIso" | "oosStartedAtIso";

export type EpochRepository = {
  getCurrentEpoch(): Promise<ExperimentEpoch | null>;
  createEpoch(epoch: Omit<ExperimentEpoch, EpochServerDefaultedFields>): Promise<ExperimentEpoch>;
  /** Resolves the current epoch in one serialized database transaction. Concurrent callers requesting the same identity must receive the same current epoch id. */
  resolveCurrentEpoch(epoch: Omit<ExperimentEpoch, EpochServerDefaultedFields | "stage" | "frozenAtIso">): Promise<ExperimentEpoch>;
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

  async resolveCurrentEpoch(epoch) {
    const { data, error } = await supabaseAdmin.rpc("ensure_sports_shadow_current_epoch" as never, {
      p_go_live_at: epoch.goLiveAtIso,
      p_wallet_cohort: epoch.walletCohort,
      p_git_sha: epoch.gitSha,
      p_config_hash: epoch.configHash,
      p_classifier_version: epoch.versions.classifierVersion,
      p_episode_version: epoch.versions.episodeVersion,
      p_resolver_version: epoch.versions.resolverVersion,
      p_router_version: epoch.versions.routerVersion,
      p_pmus_fee_model_version: epoch.versions.pmusFeeModelVersion,
      p_kalshi_fee_model_version: epoch.versions.kalshiFeeModelVersion,
      p_execution_simulator_version: epoch.versions.executionSimulatorVersion,
      p_settlement_version: epoch.versions.settlementVersion,
    } as never);
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error("ensure_sports_shadow_current_epoch returned no epoch row");
    return fromRow(row as unknown as RawEpochRow);
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
 * Ensures a current epoch exists and matches the CURRENT runtime identity, creating a
 * new one whenever semantic config/versions, deployed git SHA, or prospective go-live
 * boundary changes. The SHA/go-live checks are intentionally explicit rather than
 * folded into computeConfigHash: configHash remains the semantic strategy fingerprint,
 * while deployment/boundary identity remains visible in its dedicated durable columns.
 */
export async function ensureCurrentEpoch(
  wallets: readonly string[],
  goLiveAtMs: number,
  gitSha: string,
  repo: EpochRepository = supabaseEpochRepository,
): Promise<ExperimentEpoch> {
  const versions: ExperimentEpochVersions = currentEpochVersions(PMUS_FEE_MODEL_VERSION, KALSHI_FEE_MODEL_VERSION);
  const configHash = await computeConfigHash(wallets, versions);
  const goLiveAtIso = new Date(goLiveAtMs).toISOString();

  // No application-level read/decide/write split here: production can run multiple
  // Cloudflare/Lovable invocations concurrently, so current-epoch resolution must be
  // serialized in the database. The Supabase repository backs this with the
  // ensure_sports_shadow_current_epoch RPC; tests use an equivalent fake implementation.
  return repo.resolveCurrentEpoch({
    goLiveAtIso,
    walletCohort: wallets,
    gitSha,
    configHash,
    versions,
  });
}
