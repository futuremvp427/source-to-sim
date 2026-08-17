/**
 * SHADOW V4 COMPOUND PILOT: HighTempTation — single-wallet forward pilot of
 * compound-v2-pilot sizing, run in parallel with (never replacing) the
 * existing V2 dynamic-v1 follower. PAPER ONLY.
 *
 * Kept as one small, explicit module — mirroring v2-cohort.ts's pattern — so
 * the pilot's identity is defined exactly once and every other file (seed
 * migration, sizing dispatch caller, comparison read model, UI) imports it
 * rather than re-typing the name/wallet/activation baseline.
 */

export const V4_PILOT_NAME = "SHADOW V4 COMPOUND PILOT: HighTempTation";
export const V4_PILOT_WALLET = "0x6011655c4afb76f36dd1b08a137a1ba73466b31e";
export const V4_PILOT_SIZING_RULE = "compound-v2-pilot";
export const V4_PILOT_FOLLOW_FROM_TS = 1786996047;
/** Rolled-in V2 book capital at activation — the pilot's starting principal and the shared A/B baseline. */
export const V4_PILOT_ACTIVATION_BASELINE = 433.36108;

export function isV4PilotName(name: string): boolean {
  return name === V4_PILOT_NAME;
}
