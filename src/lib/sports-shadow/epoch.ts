/**
 * FINAL BUILD Part 17: experiment epoch versioning.
 *
 * Every subsystem whose semantics materially affect what counts as an eligible
 * episode, an EXACT match, an executable fill, or a settled P&L figure carries an
 * explicit version string here. A material change to any of them MUST bump the relevant
 * constant below, forcing a new config hash and therefore a new experiment epoch.
 */

import type { Venue } from "./types";

/** Bump on any material change to eligibility.ts's classification rules. */
export const CLASSIFIER_VERSION = "classifier_v3_wnba_canonical_participants";
/** Bump on any material change to episode.ts's DCA aggregation window/rules or sell-tracking semantics. */
export const EPISODE_VERSION = "episode_v1_dca_buy_sell";
/** Generic participant identity now participates in cross-venue matching. */
export const RESOLVER_VERSION = "resolver_v3_league_scoped_participants_source_event_rules";
/** Bump on any material change to router.ts's venue-selection rule. */
export const ROUTER_VERSION = "router_v1_fillratio_then_cost";
/** Bump on any material change to depth-walk.ts's execution-simulation math or the notional tier ladder. */
export const EXECUTION_SIMULATOR_VERSION = "depth_walk_v1_5_10_25_50_100";
/** Bump on any material change to the settlement engine's resolution/payoff rules. */
export const SETTLEMENT_VERSION = "settlement_v1";

export type ExperimentEpochVersions = {
  classifierVersion: string;
  episodeVersion: string;
  resolverVersion: string;
  routerVersion: string;
  pmusFeeModelVersion: string;
  kalshiFeeModelVersion: string;
  executionSimulatorVersion: string;
  settlementVersion: string;
};

export function currentEpochVersions(pmusFeeModelVersion: string, kalshiFeeModelVersion: string): ExperimentEpochVersions {
  return {
    classifierVersion: CLASSIFIER_VERSION,
    episodeVersion: EPISODE_VERSION,
    resolverVersion: RESOLVER_VERSION,
    routerVersion: ROUTER_VERSION,
    pmusFeeModelVersion,
    kalshiFeeModelVersion,
    executionSimulatorVersion: EXECUTION_SIMULATOR_VERSION,
    settlementVersion: SETTLEMENT_VERSION,
  };
}

export async function computeConfigHash(wallets: readonly string[], versions: ExperimentEpochVersions): Promise<string> {
  const sortedWallets = [...wallets].map((w) => w.toLowerCase()).sort();
  const material = JSON.stringify({ wallets: sortedWallets, ...versions });
  const bytes = new TextEncoder().encode(material);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type ExperimentStage = "PRE_SOAK" | "OPERATIONAL_SOAK" | "CALIBRATION" | "OUT_OF_SAMPLE" | "LIVE_PILOT_REVIEW_READY" | "FAILED" | "PAUSED";

export type ExperimentEpoch = {
  id: string;
  createdAtIso: string;
  goLiveAtIso: string;
  walletCohort: readonly string[];
  gitSha: string;
  configHash: string;
  versions: ExperimentEpochVersions;
  stage: ExperimentStage;
  stageEnteredAtIso: string;
  soakStartedAtIso: string | null;
  calibrationStartedAtIso: string | null;
  oosStartedAtIso: string | null;
  frozenAtIso: string | null;
};

export function canFreeze(epoch: Pick<ExperimentEpoch, "stage" | "frozenAtIso">): boolean {
  return epoch.frozenAtIso === null && (epoch.stage === "OPERATIONAL_SOAK" || epoch.stage === "CALIBRATION");
}

export function requiresNewEpoch(existing: ExperimentEpochVersions, current: ExperimentEpochVersions): boolean {
  return (
    existing.classifierVersion !== current.classifierVersion ||
    existing.episodeVersion !== current.episodeVersion ||
    existing.resolverVersion !== current.resolverVersion ||
    existing.routerVersion !== current.routerVersion ||
    existing.pmusFeeModelVersion !== current.pmusFeeModelVersion ||
    existing.kalshiFeeModelVersion !== current.kalshiFeeModelVersion ||
    existing.executionSimulatorVersion !== current.executionSimulatorVersion ||
    existing.settlementVersion !== current.settlementVersion
  );
}

export type VenueCapabilityState = { venue: Venue; discoveryAvailable: boolean; orderbookAvailable: boolean; checkedAtIso: string; detail: string | null };
