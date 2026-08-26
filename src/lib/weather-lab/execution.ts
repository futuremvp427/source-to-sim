/**
 * Paper fill simulator.
 *
 * The research phase's decisive negative result came from assuming displayed
 * best quotes were executable. Historical one-minute BBO showed a positive
 * exhaustive-NO basket in 120 of 125 events while repeated live depth scans
 * found zero fillable ones. So this module never assumes signal price equals
 * fill price: it walks real depth, and refuses to record a trade it could not
 * have filled.
 *
 * A signal that cannot fill is NO_FILL. NO_FILL is not a trade and must never
 * be counted in win rate, P/L or sample size.
 */

import { quoteFee, type FeeSchedule } from "./fees";

/** One price level. `price` in dollars, `size` in contracts. */
export type LadderLevel = { price: number; size: number };

export type AdverseScenario = "BASE" | "PLUS_1C" | "PLUS_2C" | "PLUS_3C";

export const ADVERSE_SCENARIOS: readonly AdverseScenario[] = Object.freeze([
  "BASE",
  "PLUS_1C",
  "PLUS_2C",
  "PLUS_3C",
]);

export const SCENARIO_SHIFT_USD: Readonly<Record<AdverseScenario, number>> = Object.freeze({
  BASE: 0,
  PLUS_1C: 0.01,
  PLUS_2C: 0.02,
  PLUS_3C: 0.03,
});

export type FillStatus = "FILLED" | "PARTIAL" | "NO_FILL";

export type NoFillReason =
  | "EMPTY_BOOK"
  | "INSUFFICIENT_DEPTH"
  | "PRICE_LIMIT_EXCEEDED"
  | "QUOTE_STALE"
  | "MARKET_CLOSED"
  | "RATE_LIMITED"
  | "CAPITAL_CAP";

export type FillResult = {
  status: FillStatus;
  scenario: AdverseScenario;
  requestedContracts: number;
  filledContracts: number;
  /** Volume-weighted average fill price in dollars, null when nothing filled. */
  averagePriceUsd: number | null;
  /** Premium paid, excluding fees. */
  notionalUsd: number;
  feeUsd: number;
  /** Premium + fees. */
  allInCostUsd: number;
  levelsConsumed: number;
  reason: NoFillReason | null;
};

export type FillRequest = {
  ladder: readonly LadderLevel[];
  contracts: number;
  scenario: AdverseScenario;
  schedule: FeeSchedule;
  /** Refuse to pay above this price after the adverse shift. */
  maxPriceUsd: number;
  /** Refuse to spend more premium than this in one market. */
  maxNotionalUsd?: number;
  /** Set when the venue said the market is not tradable. */
  marketClosed?: boolean;
  /** Set when the quote failed the provenance staleness policy. */
  quoteStale?: boolean;
  /** Set when the collector was throttled and the book may be behind. */
  rateLimited?: boolean;
  /** When false, a partial fill is discarded and reported as NO_FILL. */
  allowPartial?: boolean;
};

function noFill(scenario: AdverseScenario, contracts: number, reason: NoFillReason): FillResult {
  return {
    status: "NO_FILL",
    scenario,
    requestedContracts: contracts,
    filledContracts: 0,
    averagePriceUsd: null,
    notionalUsd: 0,
    feeUsd: 0,
    allInCostUsd: 0,
    levelsConsumed: 0,
    reason,
  };
}

/**
 * Simulate lifting `contracts` from an ask ladder under one adverse scenario.
 *
 * The adverse shift is applied per level, modelling the book having moved
 * against us between quote and arrival. Fees are charged per price level, since
 * each level is a distinct fill at the venue and the fee rounds per fill.
 */
export function simulateFill(request: FillRequest): FillResult {
  const {
    ladder,
    contracts,
    scenario,
    schedule,
    maxPriceUsd,
    maxNotionalUsd,
    marketClosed = false,
    quoteStale = false,
    rateLimited = false,
    allowPartial = false,
  } = request;

  if (!Number.isFinite(contracts) || contracts <= 0) {
    throw new RangeError(`contracts must be a positive number, got ${contracts}`);
  }

  if (marketClosed) return noFill(scenario, contracts, "MARKET_CLOSED");
  if (quoteStale) return noFill(scenario, contracts, "QUOTE_STALE");
  if (rateLimited) return noFill(scenario, contracts, "RATE_LIMITED");
  if (ladder.length === 0) return noFill(scenario, contracts, "EMPTY_BOOK");

  const shift = SCENARIO_SHIFT_USD[scenario];
  const levels = [...ladder].sort((a, b) => a.price - b.price);

  let remaining = contracts;
  let notional = 0;
  let fees = 0;
  let consumed = 0;
  let hitPriceLimit = false;

  for (const level of levels) {
    if (remaining <= 0) break;
    const price = Math.min(1, level.price + shift);
    if (price > maxPriceUsd) {
      hitPriceLimit = true;
      break;
    }
    const take = Math.min(remaining, level.size);
    if (take <= 0) continue;

    const addedNotional = take * price;
    if (maxNotionalUsd !== undefined && notional + addedNotional > maxNotionalUsd) {
      const affordable = Math.floor((maxNotionalUsd - notional) / price);
      if (affordable <= 0) break;
      const partial = Math.min(take, affordable);
      notional += partial * price;
      fees += quoteFee({ price, contracts: partial, schedule }).feeUsd;
      remaining -= partial;
      consumed += 1;
      break;
    }

    notional += addedNotional;
    fees += quoteFee({ price, contracts: take, schedule }).feeUsd;
    remaining -= take;
    consumed += 1;
  }

  const filled = contracts - remaining;

  if (filled <= 0) {
    return noFill(scenario, contracts, hitPriceLimit ? "PRICE_LIMIT_EXCEEDED" : "INSUFFICIENT_DEPTH");
  }
  if (remaining > 0 && !allowPartial) {
    return noFill(scenario, contracts, hitPriceLimit ? "PRICE_LIMIT_EXCEEDED" : "INSUFFICIENT_DEPTH");
  }

  const feeUsd = Number(fees.toFixed(4));
  return {
    status: remaining > 0 ? "PARTIAL" : "FILLED",
    scenario,
    requestedContracts: contracts,
    filledContracts: filled,
    averagePriceUsd: notional / filled,
    notionalUsd: Number(notional.toFixed(6)),
    feeUsd,
    allInCostUsd: Number((notional + feeUsd).toFixed(6)),
    levelsConsumed: consumed,
    reason: null,
  };
}

/** Run every adverse scenario for one signal. Stress is mandatory, not optional. */
export function simulateAllScenarios(request: Omit<FillRequest, "scenario">): Record<AdverseScenario, FillResult> {
  const out = {} as Record<AdverseScenario, FillResult>;
  for (const scenario of ADVERSE_SCENARIOS) out[scenario] = simulateFill({ ...request, scenario });
  return out;
}

/**
 * Convert a Kalshi `orderbook_fp` YES-bid ladder into the NO ask ladder.
 *
 * Buying NO means lifting the NO ask, which is the mirror of a resting YES bid:
 * a YES bid at p is a NO ask at 1 - p for the same size.
 */
export function noAskLadderFromYesBids(yesBids: ReadonlyArray<[string | number, string | number]>): LadderLevel[] {
  return yesBids
    .map(([p, s]) => ({ price: 1 - Number(p), size: Number(s) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0)
    .sort((a, b) => a.price - b.price);
}

/** Convert a Kalshi `orderbook_fp` NO-bid ladder into the YES ask ladder. */
export function yesAskLadderFromNoBids(noBids: ReadonlyArray<[string | number, string | number]>): LadderLevel[] {
  return noBids
    .map(([p, s]) => ({ price: 1 - Number(p), size: Number(s) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0)
    .sort((a, b) => a.price - b.price);
}
