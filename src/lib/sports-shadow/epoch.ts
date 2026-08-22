/**
 * FINAL BUILD Part 17: experiment epoch versioning.
 *
 * Every subsystem whose semantics materially affect what counts as an eligible
 * episode, an EXACT match, an executable fill, or a settled P&L figure carries an
 * explicit version string here. A material change to any of them (Part 17's list:
 * eligibility, contract matching, execution modeling, routing, size rules, fee rules)
 * MUST bump the relevant constant below -- that is what forces
 * computeConfigHash's output to change, which is what forces a NEW experiment epoch
 * rather than silently blending pre-change and post-change results into one sample.
 *
 * Ordinary bug fixes that only RESTORE already-declared semantics (per Part 17's own
 * carve-out) may keep the existing version string -- that judgment call is made by
 * whoever ships the fix, not automated here, and must be justified in the fix's own
 * commit message per the mission's engineering discipline.
 *
 * Uses Web Crypto (`crypto.subtle`), not `node:crypto` -- this codebase runs on
 * Cloudflare Workers (see pmus/signer.server.ts's identical choice), where
 * `node:crypto` is unavailable.
 */

import type { Venue } from "./types";

/** Bump on any material change to eligibility.ts's classification rules. */
export const CLASSIFIER_VERSION = "classifier_v1_mlb_phase1";
/** Bump on any material change to episode.ts's DCA aggregation window/rules or sell-tracking semantics. */
export const EPISODE_VERSION = "episode_v1_dca_buy_sell";
/** Bump on any material change to resolver.ts's EXACT/NEAR/NONE/UNVERIFIED matching rules or its rule-fingerprint dimensions. */
export const RESOLVER_VERSION = "resolver_v1_rule_fingerprint";
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

/**
 * Deterministic SHA-256 hash over the wallet cohort (order-independent -- sorted
 * before hashing, since the SAME cohort listed in a different order is the SAME
 * config) and every version string above. Deliberately does NOT include timing/tuning
 * constants (lease TTLs, budgets, batch sizes) -- those affect operational behavior,
 * never eligibility/matching/execution/settlement SEMANTICS, so changing them alone
 * must never force a new epoch (Part 17's own scoping: "Material change to:
 * eligibility / contract matching / execution modeling / routing / size rules / fee
 * rules -- must create a NEW epoch", nothing broader than that list).
 */
export async function computeConfigHash(wallets: readonly string[], versions: ExperimentEpochVersions): Promise<string> {
  const sortedWallets = [...wallets].map((w) => w.toLowerCase()).sort();
  const material = JSON.stringify({
    wallets: sortedWallets,
    ...versions,
  });
  const bytes = new TextEncoder().encode(material);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Part 18's persisted research state machine, plus terminal FAILED/PAUSED holds. Matches the CHECK constraint on sports_shadow_experiment_epochs.stage exactly. */
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

/**
 * Part 20's automatic rule freeze: once an epoch's config is frozen, its versions +
 * config hash become immutable evidence for OOS comparison -- this function only
 * validates the transition is legal (SOAK/CALIBRATION -> frozen), it does not persist
 * anything (see epoch.server.ts for the durable write, not yet built).
 */
export function canFreeze(epoch: Pick<ExperimentEpoch, "stage" | "frozenAtIso">): boolean {
  return epoch.frozenAtIso === null && (epoch.stage === "OPERATIONAL_SOAK" || epoch.stage === "CALIBRATION");
}

/** True when a completed venue-matching result (from resolver.ts) would require a NEW epoch under the CURRENT versions vs. the versions an existing epoch was built with -- lets a caller detect drift before silently mixing incompatible rows. */
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

/** Venue capability state persisted per Part 8 -- not epoch-versioned (a capability outage is an operational fact, not a rule change), but exported here since it shares this module's "what changed" vocabulary. */
export type VenueCapabilityState = { venue: Venue; discoveryAvailable: boolean; orderbookAvailable: boolean; checkedAtIso: string; detail: string | null };
