/**
 * V3 CAPACITY cohort definition.
 *
 * V3 follows exactly the same five wallets as V2 with the same dynamic-v1
 * sizing rule, but at a larger $1,000 simulated bankroll so capacity effects
 * (position sizing headroom, cash-reserve skips) can be compared side by side
 * against V2 under otherwise identical conditions.
 *
 * Read-side naming helpers only: the V3 experiment rows already exist, so this
 * file intentionally contains no seeding or insertion logic.
 */

import { V2_COHORT, type CohortMember } from "./v2-cohort";

export const V3_PREFIX = "SHADOW V3 CAPACITY: ";
export const V3_STARTING_CASH = 1000;

/** Same five followed wallets as V2 — reused, never duplicated. */
export const V3_COHORT: readonly CohortMember[] = V2_COHORT;

export function v3ExperimentName(handle: string): string {
  return `${V3_PREFIX}${handle}`;
}

export function isV3Name(name: string): boolean {
  return name.startsWith(V3_PREFIX);
}

/** Handle behind a V3 experiment name, or null when the name is not V3. */
export function v3HandleFromName(name: string): string | null {
  return isV3Name(name) ? name.slice(V3_PREFIX.length) : null;
}
