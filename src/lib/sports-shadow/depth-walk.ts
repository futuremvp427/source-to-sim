/**
 * Deterministic executable-depth walk for Sports Forward Shadow — PURE math only.
 *
 * Answers: "if our follower attempted to buy $X of the already-resolved (Task 7) target
 * outcome using the exact executable ask depth Task 8 actually captured, what execution
 * could that captured evidence support?" No network, no Supabase, no venue branching —
 * consumes `DepthLevel[]` (types.ts), the same representation Task 5/6/8 already
 * produce and persist. Venue-neutral by construction: PM-US and Kalshi asks for the
 * already-resolved side are handed to this module identically.
 *
 * Precision: operates directly on the plain `number` prices/sizes Task 5/6 already
 * produce (Kalshi's fixed-point-unit arithmetic happens upstream in kalshi.ts and is not
 * redone here — see that module's PRICE_SCALE/QTY_SCALE doc comment). All arithmetic
 * here is ordinary double subtraction/division/multiplication with an explicit epsilon
 * only for FULL-vs-PARTIAL boundary classification, never for rounding a reported value.
 */

import type { DepthLevel } from "./types";

/** Canonical Phase-1 research tiers. No other default tiers exist in this module. */
export const SPORTS_SHADOW_NOTIONALS_USD = [5, 10, 25, 50, 100] as const;
export type SportsShadowNotionalUsd = (typeof SPORTS_SHADOW_NOTIONALS_USD)[number];

export type ExecutionStatus = "FULL" | "PARTIAL" | "NONE" | "INVALID";

export type DepthWalkResult = {
  status: ExecutionStatus;
  requestedNotionalUsd: number;
  filledNotionalUsd: number;
  unfilledNotionalUsd: number;
  /** filledNotionalUsd / requestedNotionalUsd. 0 for NONE/INVALID. */
  fillRatio: number;
  contractsFilled: number;
  /** VWAP over the amount actually filled: filledNotionalUsd / contractsFilled. null for NONE/INVALID. */
  averageExecutionPrice: number | null;
  /** The lowest valid ask price in the depth, before walking. null only when depth is empty or evidence is INVALID. */
  bestAvailablePrice: number | null;
  /** The highest-price level actually consumed. null for NONE/INVALID. */
  worstExecutionPrice: number | null;
  /** Count of distinct (post price-aggregation) price levels actually touched by the walk. */
  levelsConsumed: number;
  /** Raw PRE-FEE execution impact: averageExecutionPrice - bestAvailablePrice. Never fee-adjusted. null for NONE/INVALID. */
  priceImpact: number | null;
  /** priceImpact * 100 — sub-cent precision preserved, never rounded. null for NONE/INVALID. */
  priceImpactCents: number | null;
  /** Populated only for status INVALID, describing exactly which input violated an invariant. */
  invalidReason: string | null;
};

/**
 * Tight enough to never treat a materially incomplete fill as FULL, wide enough to
 * absorb ordinary IEEE-754 double round-off from summing up to ~5 aggregated levels at
 * dollar-scale magnitudes (worst case well under 1e-10) — matches the epsilon already
 * used for float-equality checks elsewhere in sports-shadow (resolver.ts, pmus.ts).
 */
const EPSILON = 1e-9;

function isValidPrice(price: number): boolean {
  return Number.isFinite(price) && price > 0 && price <= 1;
}

function isValidSize(size: number): boolean {
  return Number.isFinite(size) && size > 0;
}

function invalidResult(requestedNotionalUsd: number, reason: string): DepthWalkResult {
  return {
    status: "INVALID",
    requestedNotionalUsd,
    filledNotionalUsd: 0,
    unfilledNotionalUsd: 0,
    fillRatio: 0,
    contractsFilled: 0,
    averageExecutionPrice: null,
    bestAvailablePrice: null,
    worstExecutionPrice: null,
    levelsConsumed: 0,
    priceImpact: null,
    priceImpactCents: null,
    invalidReason: reason,
  };
}

/**
 * Aggregates levels sharing the exact same price by summing their size — deterministic
 * diagnostics (levelsConsumed counts distinct price points, not raw input rows) and
 * mathematically identical VWAP either way. Exact `===` grouping is safe here: Task 6's
 * fixed-point-unit-then-single-division conversion is deterministic, so two levels
 * genuinely meant to be "the same price" always produce bit-identical doubles.
 */
function aggregateByPrice(levels: readonly DepthLevel[]): DepthLevel[] {
  const byPrice = new Map<number, number>();
  for (const level of levels) {
    byPrice.set(level.price, (byPrice.get(level.price) ?? 0) + level.size);
  }
  return [...byPrice.entries()].map(([price, size]) => ({ price, size }));
}

/**
 * Walks BUY-side executable ask depth for one requested USD notional against ONE
 * already-resolved target outcome's captured book. `levels` must be the ask levels for
 * the side Task 7 already resolved (e.g. Kalshi's `book.yes.askLevels` or
 * `book.no.askLevels`, or PM-US's `book.askLevels`) — this function never remaps
 * YES/NO, never inspects a source fill's side, and never does team/venue matching; all
 * of that is already resolved by the time depth reaches here.
 *
 * Fails closed to INVALID (not a silent exclusion) on ANY malformed level or requested
 * notional — per the mission, if Task 8 was supposed to persist normalized-valid depth,
 * unexpected malformed evidence at this layer is a signal something upstream is wrong,
 * not something to quietly discard and keep computing around.
 *
 * Never mutates `levels`. Sorts a copy ascending by price (never trusts stored order).
 */
export function walkBuyDepth(levels: readonly DepthLevel[], requestedNotionalUsd: number): DepthWalkResult {
  if (!Number.isFinite(requestedNotionalUsd) || requestedNotionalUsd <= 0) {
    return invalidResult(requestedNotionalUsd, `requested notional must be a finite positive number, got ${requestedNotionalUsd}`);
  }

  for (let i = 0; i < levels.length; i += 1) {
    const level = levels[i]!;
    if (!isValidPrice(level.price)) return invalidResult(requestedNotionalUsd, `level ${i}: invalid price ${level.price} (must be finite, >0, <=1)`);
    if (!isValidSize(level.size)) return invalidResult(requestedNotionalUsd, `level ${i}: invalid size ${level.size} (must be finite and >0)`);
  }

  const sorted = aggregateByPrice(levels).sort((a, b) => a.price - b.price);
  const bestAvailablePrice = sorted.length > 0 ? sorted[0]!.price : null;

  if (sorted.length === 0) {
    return {
      status: "NONE",
      requestedNotionalUsd,
      filledNotionalUsd: 0,
      unfilledNotionalUsd: requestedNotionalUsd,
      fillRatio: 0,
      contractsFilled: 0,
      averageExecutionPrice: null,
      bestAvailablePrice: null,
      worstExecutionPrice: null,
      levelsConsumed: 0,
      priceImpact: null,
      priceImpactCents: null,
      invalidReason: null,
    };
  }

  let remainingNotional = requestedNotionalUsd;
  let totalContracts = 0;
  let totalSpend = 0;
  let levelsConsumed = 0;
  let worstExecutionPrice: number | null = null;

  for (const level of sorted) {
    if (remainingNotional <= EPSILON) break;
    const levelCapacityUsd = level.price * level.size;
    const spendAtLevel = Math.min(remainingNotional, levelCapacityUsd);
    const contractsAtLevel = spendAtLevel / level.price;
    totalContracts += contractsAtLevel;
    totalSpend += spendAtLevel;
    remainingNotional -= spendAtLevel;
    levelsConsumed += 1;
    worstExecutionPrice = level.price;
  }

  if (totalContracts <= 0) {
    return {
      status: "NONE",
      requestedNotionalUsd,
      filledNotionalUsd: 0,
      unfilledNotionalUsd: requestedNotionalUsd,
      fillRatio: 0,
      contractsFilled: 0,
      averageExecutionPrice: null,
      bestAvailablePrice,
      worstExecutionPrice: null,
      levelsConsumed: 0,
      priceImpact: null,
      priceImpactCents: null,
      invalidReason: null,
    };
  }

  const rawUnfilled = requestedNotionalUsd - totalSpend;
  const isFull = rawUnfilled <= EPSILON;
  // A mathematically full fill is reported as exactly the requested notional / zero
  // unfilled — never leaking IEEE-754 summation dust (e.g. 4.999999999999999) into the
  // reported result. PARTIAL/NONE report the raw computed values as-is.
  const filledNotionalUsd = isFull ? requestedNotionalUsd : totalSpend;
  const unfilledNotionalUsd = isFull ? 0 : Math.max(0, rawUnfilled);
  const averageExecutionPrice = filledNotionalUsd / totalContracts;
  const priceImpact = averageExecutionPrice - bestAvailablePrice!;

  if (priceImpact < -EPSILON) {
    return invalidResult(requestedNotionalUsd, `invariant violated: negative price impact (${priceImpact}) walking a sorted-ascending ask book`);
  }

  return {
    status: isFull ? "FULL" : "PARTIAL",
    requestedNotionalUsd,
    filledNotionalUsd,
    unfilledNotionalUsd,
    fillRatio: filledNotionalUsd / requestedNotionalUsd,
    contractsFilled: totalContracts,
    averageExecutionPrice,
    bestAvailablePrice,
    worstExecutionPrice,
    levelsConsumed,
    priceImpact: Math.max(0, priceImpact),
    priceImpactCents: Math.max(0, priceImpact) * 100,
    invalidReason: null,
  };
}

export type NotionalTierResults = Record<SportsShadowNotionalUsd, DepthWalkResult>;

/**
 * Evaluates all five canonical Phase-1 tiers against the SAME original captured depth.
 * Each tier is an independent hypothetical scenario, not a sequential order against
 * depleting depth — walkBuyDepth never mutates `levels` and carries no state between
 * calls, so calling it once per tier against the identical `levels` reference already
 * guarantees this; nothing here needs to defensively re-clone between calls.
 */
export function evaluateNotionalTiers(levels: readonly DepthLevel[]): NotionalTierResults {
  const results = {} as NotionalTierResults;
  for (const notional of SPORTS_SHADOW_NOTIONALS_USD) {
    results[notional] = walkBuyDepth(levels, notional);
  }
  return results;
}
