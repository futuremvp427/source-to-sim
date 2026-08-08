/**
 * V2 fair-comparison cohort definition.
 *
 * The V1 experiments ran under unequal conditions (some exhausted their
 * simulated bankroll before dynamic-v1 sizing existed), so they are frozen as
 * historical records and a fresh V2 experiment is created per followed wallet.
 * Everything here is pure so the invariants can be asserted in tests.
 */

export const V2_PREFIX = "SHADOW V2: ";
export const V2_STARTING_CASH = 380;
export const V2_RESERVE_FRACTION = 0.1;
export const V2_RESERVE_USD = V2_STARTING_CASH * V2_RESERVE_FRACTION;
export const V2_SIZING_RULE = "dynamic-v1";
export const V2_DEFAULT_BUY_USD = 5;

export type CohortMember = {
  handle: string;
  wallet: string;
  /** Name of the frozen V1 experiment for the same wallet. */
  v1Name: string;
};

/** The five followed wallets. Reference wallet first. */
export const V2_COHORT: readonly CohortMember[] = Object.freeze([
  {
    handle: "badatmath.",
    wallet: "0x8fbd7cf5f806f563080864694415829f7229a959",
    v1Name: "SHADOW",
  },
  {
    handle: "Poligarch",
    wallet: "0xb40e89677d59665d5188541ad860450a6e2a7cc9",
    v1Name: "SHADOW:Poligarch",
  },
  {
    handle: "gghff",
    wallet: "0x044f334595a7fd42c143e11c8ec47f23c8d1d1f1",
    v1Name: "SHADOW:gghff",
  },
  {
    handle: "Weather-Guru",
    wallet: "0xb6fbce093cdd139858c44148a6598d8ec028c038",
    v1Name: "SHADOW:Weather-Guru",
  },
  {
    handle: "HighTempTation",
    wallet: "0x6011655c4afb76f36dd1b08a137a1ba73466b31e",
    v1Name: "SHADOW:HighTempTation",
  },
]);

export const V2_REFERENCE_HANDLE = V2_COHORT[0]!.handle;

export function v2ExperimentName(handle: string): string {
  return `${V2_PREFIX}${handle}`;
}

export const V2_REFERENCE_NAME = v2ExperimentName(V2_REFERENCE_HANDLE);

export function isV2Name(name: string): boolean {
  return name.startsWith(V2_PREFIX);
}

export type Cohort = "V2" | "V1";

export function experimentCohort(name: string): Cohort {
  return isV2Name(name) ? "V2" : "V1";
}

/** Human label for a row in the comparison table. */
export function experimentLabel(name: string): string {
  if (isV2Name(name)) return name.slice(V2_PREFIX.length);
  if (name === "SHADOW") return "badatmath.";
  return name.replace(/^SHADOW:/, "");
}

export type V2SeedRow = {
  name: string;
  wallet_address: string;
  starting_cash: number;
  cash: number;
  realized_pnl: number;
  buy_amount: number;
  sizing_rule: string;
  enabled: boolean;
  simulated: boolean;
  follow_from_ts: number;
};

/**
 * Seed configuration for the whole V2 cohort. Every row starts at exactly
 * $380 cash / $380 equity, zero positions, zero P&L, dynamic-v1 sizing, and a
 * follow_from_ts equal to the shared go-live second — so no historical fill can
 * ever be replayed into a V2 book.
 */
export function v2SeedRows(goLiveTs: number): V2SeedRow[] {
  return V2_COHORT.map((member) => ({
    name: v2ExperimentName(member.handle),
    wallet_address: member.wallet,
    starting_cash: V2_STARTING_CASH,
    cash: V2_STARTING_CASH,
    realized_pnl: 0,
    buy_amount: V2_DEFAULT_BUY_USD,
    sizing_rule: V2_SIZING_RULE,
    enabled: true,
    simulated: true,
    follow_from_ts: goLiveTs,
  }));
}

/**
 * A source fill is eligible for V2 paper copying only when it happened at or
 * after the V2 go-live second. Pre-go-live fills stay as research history.
 */
export function isEligibleForV2Copy(sourceTs: number, followFromTs: number): boolean {
  if (!Number.isFinite(sourceTs) || !Number.isFinite(followFromTs)) return false;
  return sourceTs >= followFromTs;
}
