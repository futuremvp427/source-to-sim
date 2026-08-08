/**
 * Pure promotion rules. Promotion is RESEARCH ONLY: it produces a PAUSED,
 * fully isolated paper experiment and can never activate a follower or write
 * into the reference SHADOW experiment's accounting.
 */

export const PROMOTED_EXPERIMENT_PREFIX = "CANDIDATE:";
export const PROMOTED_STARTING_CASH = 380;
export const REFERENCE_EXPERIMENT_NAME = "SHADOW";
export const REFERENCE_WALLET = "0x8fbd7cf5f806f563080864694415829f7229a959";
export const PROMOTED_STATUS = "PAUSED / RESEARCH_READY" as const;

export function promotedExperimentName(handle: string): string {
  return `${PROMOTED_EXPERIMENT_PREFIX}${handle}`;
}

export type PromotionGuard =
  | { ok: true }
  | { ok: false; error: string };

export function guardPromotion(input: { wallet: string | null; handle: string }): PromotionGuard {
  if (!input.wallet) return { ok: false, error: "Wallet unresolved — cannot promote." };
  if (input.wallet.toLowerCase() === REFERENCE_WALLET) {
    return { ok: false, error: "That is the reference wallet; it already has the SHADOW experiment." };
  }
  if (promotedExperimentName(input.handle) === REFERENCE_EXPERIMENT_NAME) {
    return { ok: false, error: "Reserved experiment name." };
  }
  return { ok: true };
}

export type PromotedExperimentInsert = {
  name: string;
  wallet_address: string;
  starting_cash: number;
  cash: number;
  buy_amount: number;
  poll_interval_seconds: number;
  /** Always false: the autonomous cycle must never pick a candidate up. */
  enabled: false;
  weather_only: boolean;
  realized_pnl: number;
  simulated: true;
  follow_from_ts: number;
};

export function buildPromotedExperiment(input: {
  handle: string;
  wallet: string;
  nowSeconds: number;
}): PromotedExperimentInsert {
  return {
    name: promotedExperimentName(input.handle),
    wallet_address: input.wallet,
    starting_cash: PROMOTED_STARTING_CASH,
    cash: PROMOTED_STARTING_CASH,
    buy_amount: 10,
    poll_interval_seconds: 60,
    enabled: false,
    weather_only: true,
    realized_pnl: 0,
    simulated: true,
    follow_from_ts: input.nowSeconds,
  };
}
