/**
 * Pure cash-runway estimation and cash alert rules.
 * This file only MEASURES; it never changes dynamic-v1 sizing or any bankroll.
 */

import { SIZING_MIN_USD, cashBreakdown, computeBuySize } from "./shadow-core";

export const LOW_SPENDABLE_FRACTION = 0.25;

export type CashRunway = {
  availableCash: number;
  reservedCash: number;
  spendableCash: number;
  /** Next BUY size dynamic-v1 would use right now, or null when no BUY is possible. */
  nextBuyUsd: number | null;
  /** Deterministic estimate of how many more BUYs the spendable cash supports. */
  estimatedRemainingBuys: number;
  reserveReached: boolean;
  lowSpendableCash: boolean;
};

/**
 * Estimate only: replays dynamic-v1 sizing against a shrinking cash balance
 * until the reserve blocks the next BUY. No SELL proceeds are assumed.
 */
export function estimateCashRunway(input: { startingCash: number; cash: number }): CashRunway {
  const { availableCash, reservedCash, spendableCash } = cashBreakdown(input);
  const first = computeBuySize(input);
  let cash = input.cash;
  let buys = 0;
  for (let i = 0; i < 10_000; i += 1) {
    const size = computeBuySize({ startingCash: input.startingCash, cash });
    if (!size.ok || size.amount < SIZING_MIN_USD) break;
    cash = Math.round((cash - size.amount) * 100) / 100;
    buys += 1;
  }
  const lowThreshold = Math.max(0, input.startingCash) * LOW_SPENDABLE_FRACTION;
  return {
    availableCash,
    reservedCash,
    spendableCash,
    nextBuyUsd: first.ok ? first.amount : null,
    estimatedRemainingBuys: buys,
    reserveReached: !first.ok,
    lowSpendableCash: spendableCash < lowThreshold,
  };
}

export type CashAlert = {
  level: "warn";
  kind: "LOW_SPENDABLE_CASH" | "CASH_RESERVE_REACHED";
  message: string;
  /** Stable key: the same condition for the same experiment is only alerted once. */
  dedupKey: string;
};

/** Deterministic cash alerts. Reserve-reached supersedes the low-cash warning. */
export function decideCashAlerts(input: {
  experimentId: string;
  experimentName: string;
  startingCash: number;
  cash: number;
}): CashAlert[] {
  const runway = estimateCashRunway(input);
  const out: CashAlert[] = [];
  if (runway.reserveReached) {
    out.push({
      level: "warn",
      kind: "CASH_RESERVE_REACHED",
      message: `${input.experimentName}: simulated spendable cash reached the ${runway.reservedCash} reserve boundary. New paper BUYs are skipped until proceeds return.`,
      dedupKey: `CASH_RESERVE_REACHED:${input.experimentId}`,
    });
    return out;
  }
  if (runway.lowSpendableCash) {
    out.push({
      level: "warn",
      kind: "LOW_SPENDABLE_CASH",
      message: `${input.experimentName}: simulated spendable cash ${runway.spendableCash} is below 25% of the ${input.startingCash} starting bankroll (~${runway.estimatedRemainingBuys} BUYs left).`,
      dedupKey: `LOW_SPENDABLE_CASH:${input.experimentId}`,
    });
  }
  return out;
}