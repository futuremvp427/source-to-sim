/**
 * Hard allowlist and risk limits for the Poligarch V2 live pilot.
 *
 * Exactly one wallet, exactly one experiment name, exact equality only.
 * This is the sole gate deciding whether any source event is even eligible
 * to be evaluated by the live-pilot preview pipeline — everything else in
 * live-pilot/ assumes this check already passed.
 */

export const POLIGARCH_V2_WALLET = "0xb40e89677d59665d5188541ad860450a6e2a7cc9";
export const POLIGARCH_V2_EXPERIMENT_NAME = "SHADOW V2: Poligarch";
export const POLIGARCH_LIVE_PILOT_ID = "poligarch_v2_live_pilot";

export const PILOT_RISK_LIMITS = {
  bankrollUsd: 25,
  maxOrderNotionalUsd: 2,
  maxTotalOpenExposureUsd: 10,
  maxDailyRealizedLossUsd: 5,
  maxConsecutiveFailedOrders: 3,
  maxSignalAgeSeconds: 90,
  maxAllowedSlippageCents: 3,
  maxOpenLivePositions: 5,
} as const;

export function isAllowedPilotSource(input: { experimentName: string; wallet: string }): boolean {
  return (
    input.experimentName === POLIGARCH_V2_EXPERIMENT_NAME && input.wallet === POLIGARCH_V2_WALLET
  );
}
