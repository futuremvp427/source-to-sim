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

/**
 * CODEX P1-5: one price level's own contribution to a walked fill -- price and contracts
 * consumed AT THAT price specifically, never blended. Both venues' documented fee
 * formulas (fees.ts) are NONLINEAR in price (Θ × C × p × (1-p)), so summing fees computed
 * per-level is NOT the same number as computing one fee against the blended VWAP -- see
 * fees.ts's computeTakerFeeForFills, the only fee entry point that should ever consume
 * this array for a multi-level fill.
 */
export type ConsumedLevel = { price: number; contracts: number };

export type DepthWalkResult = {
  status: ExecutionStatus;
  requestedNotionalUsd: number;
  filledNotionalUsd: number;
  unfilledNotionalUsd: number;
  /** filledNotionalUsd / requestedNotionalUsd. 0 for NONE/INVALID. */
  fillRatio: number;
  contractsFilled: number;
  /** VWAP over the amount actually filled: filledNotionalUsd / contractsFilled. null for NONE/INVALID. Diagnostic/display only -- NEVER fed into fee computation (see `fills` + CODEX P1-5). */
  averageExecutionPrice: number | null;
  /** The lowest valid ask price in the depth, before walking. null only when depth is empty or evidence is INVALID. */
  bestAvailablePrice: number | null;
  /** The highest-price level actually consumed. null for NONE/INVALID. */
  worstExecutionPrice: number | null;
  /** Count of distinct (post price-aggregation) price levels actually touched by the walk. */
  levelsConsumed: number;
  /** CODEX P1-5: every price level actually consumed, in the order walked (best price first), each with its own contracts -- the execution-granularity record fees.ts's computeTakerFeeForFills requires. Empty for NONE/INVALID. */
  fills: readonly ConsumedLevel[];
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
    fills: [],
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
      fills: [],
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
  // CODEX P1-5: preserved so fees.ts can compute the fee AT EACH level's own price
  // (both venues' fee formulas are nonlinear in price -- see fees.ts's own doc comment)
  // instead of collapsing to one blended VWAP before the fee is ever computed.
  const fills: ConsumedLevel[] = [];

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
    fills.push({ price: level.price, contracts: contractsAtLevel });
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
      fills: [],
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
    fills,
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

/**
 * CODEX P1-3: EXIT-side result -- a follower EXIT/partial-EXIT sells a specific number
 * of CONTRACTS it already holds (proportional to the source's own sell fraction), never
 * "as much as $X buys." Denominated in contracts, not USD -- a deliberately DISTINCT
 * type from DepthWalkResult (not a reused/reinterpreted field) so a reader can never
 * mistake `requestedContracts` for a dollar amount. `fills`/`averageExecutionPrice`/
 * `bestAvailablePrice`/`worstExecutionPrice`/`priceImpact*`/`invalidReason` carry the
 * SAME meaning as walkBuyDepth's (price received, not paid), and `fills` is directly
 * consumable by fees.ts's computeTakerFeeForFills exactly like an ENTRY/ADD walk's own.
 */
export type ExitDepthWalkResult = {
  status: ExecutionStatus;
  requestedContracts: number;
  filledContracts: number;
  unfilledContracts: number;
  /** filledContracts / requestedContracts. 0 for NONE/INVALID. */
  fillRatio: number;
  /** Total USD received for filledContracts, BEFORE fees. */
  proceedsUsd: number;
  averageExecutionPrice: number | null;
  /** The highest valid bid price in the depth, before walking. null only when depth is empty or evidence is INVALID. */
  bestAvailablePrice: number | null;
  /** The lowest-price level actually consumed. null for NONE/INVALID. */
  worstExecutionPrice: number | null;
  levelsConsumed: number;
  fills: readonly ConsumedLevel[];
  /** Raw PRE-FEE execution impact: bestAvailablePrice - averageExecutionPrice (a seller receives LESS as they walk down the book, the mirror of a buyer paying MORE). Never fee-adjusted. null for NONE/INVALID. */
  priceImpact: number | null;
  priceImpactCents: number | null;
  invalidReason: string | null;
};

function invalidExitResult(requestedContracts: number, reason: string): ExitDepthWalkResult {
  return {
    status: "INVALID",
    requestedContracts,
    filledContracts: 0,
    unfilledContracts: 0,
    fillRatio: 0,
    proceedsUsd: 0,
    averageExecutionPrice: null,
    bestAvailablePrice: null,
    worstExecutionPrice: null,
    levelsConsumed: 0,
    fills: [],
    priceImpact: null,
    priceImpactCents: null,
    invalidReason: reason,
  };
}

/**
 * CODEX P1-3: walks SELL-side executable BID depth for a requested CONTRACT COUNT.
 * `levels` must be the BID levels for the already-resolved target side (the price a
 * taker RECEIVES when selling into the book) -- the mirror image of walkBuyDepth's
 * ask-side walk. Sorted DESCENDING by price (best bid -- the HIGHEST price -- first,
 * consuming progressively worse/lower bids), the opposite order from walkBuyDepth's
 * ascending ask sort, since the best price for a SELLER is the highest bid, not the
 * lowest ask.
 *
 * Never mutates `levels`. Fails closed to INVALID on any malformed level or requested
 * contract count, exactly like walkBuyDepth.
 */
export function walkSellDepth(levels: readonly DepthLevel[], requestedContracts: number): ExitDepthWalkResult {
  if (!Number.isFinite(requestedContracts) || requestedContracts <= 0) {
    return invalidExitResult(requestedContracts, `requested contracts must be a finite positive number, got ${requestedContracts}`);
  }

  for (let i = 0; i < levels.length; i += 1) {
    const level = levels[i]!;
    if (!isValidPrice(level.price)) return invalidExitResult(requestedContracts, `level ${i}: invalid price ${level.price} (must be finite, >0, <=1)`);
    if (!isValidSize(level.size)) return invalidExitResult(requestedContracts, `level ${i}: invalid size ${level.size} (must be finite and >0)`);
  }

  const sorted = aggregateByPrice(levels).sort((a, b) => b.price - a.price);
  const bestAvailablePrice = sorted.length > 0 ? sorted[0]!.price : null;

  if (sorted.length === 0) {
    return {
      status: "NONE",
      requestedContracts,
      filledContracts: 0,
      unfilledContracts: requestedContracts,
      fillRatio: 0,
      proceedsUsd: 0,
      averageExecutionPrice: null,
      bestAvailablePrice: null,
      worstExecutionPrice: null,
      levelsConsumed: 0,
      fills: [],
      priceImpact: null,
      priceImpactCents: null,
      invalidReason: null,
    };
  }

  let remainingContracts = requestedContracts;
  let totalContracts = 0;
  let totalProceeds = 0;
  let levelsConsumed = 0;
  let worstExecutionPrice: number | null = null;
  const fills: ConsumedLevel[] = [];

  for (const level of sorted) {
    if (remainingContracts <= EPSILON) break;
    const contractsAtLevel = Math.min(remainingContracts, level.size);
    totalContracts += contractsAtLevel;
    totalProceeds += contractsAtLevel * level.price;
    remainingContracts -= contractsAtLevel;
    levelsConsumed += 1;
    worstExecutionPrice = level.price;
    fills.push({ price: level.price, contracts: contractsAtLevel });
  }

  if (totalContracts <= 0) {
    return {
      status: "NONE",
      requestedContracts,
      filledContracts: 0,
      unfilledContracts: requestedContracts,
      fillRatio: 0,
      proceedsUsd: 0,
      averageExecutionPrice: null,
      bestAvailablePrice,
      worstExecutionPrice: null,
      levelsConsumed: 0,
      fills: [],
      priceImpact: null,
      priceImpactCents: null,
      invalidReason: null,
    };
  }

  const rawUnfilled = requestedContracts - totalContracts;
  const isFull = rawUnfilled <= EPSILON;
  const filledContracts = isFull ? requestedContracts : totalContracts;
  const unfilledContracts = isFull ? 0 : Math.max(0, rawUnfilled);
  const averageExecutionPrice = totalProceeds / totalContracts;
  const priceImpact = bestAvailablePrice! - averageExecutionPrice; // a seller receives LESS as depth worsens -- mirror sign of walkBuyDepth's

  if (priceImpact < -EPSILON) {
    return invalidExitResult(requestedContracts, `invariant violated: negative price impact (${priceImpact}) walking a sorted-descending bid book`);
  }

  return {
    status: isFull ? "FULL" : "PARTIAL",
    requestedContracts,
    filledContracts,
    unfilledContracts,
    fillRatio: filledContracts / requestedContracts,
    proceedsUsd: totalProceeds,
    averageExecutionPrice,
    bestAvailablePrice,
    worstExecutionPrice,
    levelsConsumed,
    fills,
    priceImpact: Math.max(0, priceImpact),
    priceImpactCents: Math.max(0, priceImpact) * 100,
    invalidReason: null,
  };
}
