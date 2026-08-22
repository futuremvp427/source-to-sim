/**
 * Deterministic source-position episode aggregation state machine.
 *
 * Answers: "when raw BUY/SELL fills arrive for an already-ELIGIBLE (Task 3) source market,
 * which fills belong to one position-building episode, and does this fill require triggering a
 * target-venue quote burst?" Pure, synchronous, no I/O — no network, no Supabase, no timers, no
 * environment variables. Callers (Task 11) are responsible for looking up the current
 * `OpenEpisodeState` for a position from `sports_shadow_signals` before calling `decideFill`, and
 * for persisting `decision.nextState` afterward. This module never talks to a database itself.
 */

export type FillSide = "BUY" | "SELL";

export type EligibleFill = {
  /** Stable per-fill identity (matches sports_shadow_source_fills.event_key). */
  eventKey: string;
  wallet: string;
  conditionId: string;
  asset: string;
  side: FillSide;
  shares: number;
  price: number;
  /**
   * Unix seconds — when the fill actually happened at the source venue (matches
   * NormalizedEvent.sourceTs in shadow-core.ts). May carry sub-second precision when the caller
   * has it; this module never rounds it.
   */
  sourceTs: number;
  /**
   * Epoch milliseconds — when THIS process observed/ingested the fill. Distinct from sourceTs and
   * NEVER fabricated from it (and vice versa): a fill discovered late still carries its true
   * historical sourceTs alongside a detectedAt that reflects when we actually saw it. Later tasks
   * compute real follower latency from detectedAt, never from sourceTs.
   */
  detectedAt: number;
};

export type OpenEpisodeState = {
  episodeKey: string;
  anchorEventKey: string;
  wallet: string;
  conditionId: string;
  asset: string;

  /** BUY-only aggregate metrics. SELL fills never touch any of these five fields. */
  firstBuyAt: number;
  /** High-water mark: sourceTs of the chronologically latest BUY folded into this episode so far. Never moved backward by a late/out-of-order fill. */
  lastFillAt: number;
  vwap: number;
  totalShares: number;
  totalNotional: number;
  buyFillCount: number;

  /** SELL evidence. Attached to the episode; never alters the BUY metrics above. */
  sellSeen: boolean;
  firstSellAt: number | null;
  lastSellAt: number | null;
  sellCount: number;
  /** FINAL BUILD Part 5/14: real sell quantity/notional aggregates -- source_sell_seen alone was insufficient for genuine copy-follower exit simulation. Remaining forward position at any point is totalShares - sellShares (derived at read time, never stored separately -- see the schema migration's own doc comment for why). */
  sellShares: number;
  sellNotional: number;

  /** True once this episode has emitted its one NEW_EPISODE/NEW_EPISODE_AFTER_30M trigger. */
  triggered: boolean;
  /** Every eventKey (BUY or SELL) already folded into this episode — the pure-module duplicate-safety net, independent of (and in addition to) the DB's event_key UNIQUE constraint. */
  processedEventKeys: ReadonlySet<string>;
};

export type EpisodeDecision =
  | { kind: "NEW_EPISODE"; episodeKey: string; anchorEventKey: string; fill: EligibleFill; shouldTriggerBurst: true; nextState: OpenEpisodeState }
  | { kind: "NEW_EPISODE_AFTER_30M"; episodeKey: string; anchorEventKey: string; fill: EligibleFill; shouldTriggerBurst: true; nextState: OpenEpisodeState }
  | { kind: "AGGREGATED_BUY"; episodeKey: string; fill: EligibleFill; shouldTriggerBurst: false; nextState: OpenEpisodeState }
  | { kind: "SELL_RECORDED"; episodeKey: string | null; fill: EligibleFill; shouldTriggerBurst: false; nextState: OpenEpisodeState | null; isPreEpoch: boolean }
  | { kind: "DUPLICATE_FILL"; episodeKey: string | null; fill: EligibleFill; shouldTriggerBurst: false }
  | { kind: "LATE_RECONCILIATION"; episodeKey: string; fill: EligibleFill; shouldTriggerBurst: false; nextState: OpenEpisodeState }
  | { kind: "INVALID_FILL"; fill: EligibleFill; reason: string; shouldTriggerBurst: false };

/** Mission-specified aggregation window: fills <=30 minutes apart (by source event time) merge. */
export const AGGREGATION_WINDOW_SECONDS = 30 * 60;

/** Prediction-market price bounds, matching the existing validPrice() convention in shadow-core.ts. */
const PRICE_MIN_EXCLUSIVE = 0;
const PRICE_MAX_INCLUSIVE = 1;

export function deriveEpisodeKey(wallet: string, conditionId: string, asset: string, anchorEventKey: string): string {
  return `${wallet}:${conditionId}:${asset}:${anchorEventKey}`;
}

function validateFill(fill: EligibleFill): string | null {
  if (fill.side !== "BUY" && fill.side !== "SELL") return `unsupported side '${String(fill.side)}'`;
  if (!fill.eventKey) return "eventKey is required";
  if (!fill.wallet || !fill.conditionId || !fill.asset) return "wallet, conditionId, and asset are required";
  if (!Number.isFinite(fill.shares) || fill.shares <= 0) return `shares must be a positive finite number, got ${fill.shares}`;
  if (!Number.isFinite(fill.price) || fill.price <= PRICE_MIN_EXCLUSIVE || fill.price > PRICE_MAX_INCLUSIVE) {
    return `price must be a finite number in (0, 1], got ${fill.price}`;
  }
  if (!Number.isFinite(fill.sourceTs) || fill.sourceTs <= 0) return `sourceTs must be a positive finite unix timestamp, got ${fill.sourceTs}`;
  if (!Number.isFinite(fill.detectedAt) || fill.detectedAt <= 0) return `detectedAt must be a positive finite timestamp, got ${fill.detectedAt}`;
  return null;
}

function samePosition(a: { wallet: string; conditionId: string; asset: string }, b: { wallet: string; conditionId: string; asset: string }): boolean {
  return a.wallet === b.wallet && a.conditionId === b.conditionId && a.asset === b.asset;
}

function newEpisodeState(fill: EligibleFill, episodeKey: string): OpenEpisodeState {
  return {
    episodeKey,
    anchorEventKey: fill.eventKey,
    wallet: fill.wallet,
    conditionId: fill.conditionId,
    asset: fill.asset,
    firstBuyAt: fill.sourceTs,
    lastFillAt: fill.sourceTs,
    vwap: fill.price,
    totalShares: fill.shares,
    totalNotional: fill.price * fill.shares,
    buyFillCount: 1,
    sellSeen: false,
    firstSellAt: null,
    lastSellAt: null,
    sellCount: 0,
    sellShares: 0,
    sellNotional: 0,
    triggered: true,
    processedEventKeys: new Set([fill.eventKey]),
  };
}

/**
 * Pure, single-fill decision function. `existingOpenEpisode` must be the caller's best current
 * knowledge of the open episode (if any) for this exact wallet+conditionId+asset position. Given
 * the same fill and the same existingOpenEpisode snapshot, this always returns an equal decision:
 * safe to call again after a worker crash/retry (retry-safety comes from `nextState` being a pure
 * function of the inputs, plus explicit DUPLICATE_FILL detection via processedEventKeys).
 *
 * Out-of-order policy (documented, not silently applied): grouping is defined by source event
 * time, but this function only ever sees ONE fill plus the CURRENT aggregate state — it does not
 * reconstruct full fill history. So a fill whose sourceTs is behind the episode's current
 * high-water mark (`lastFillAt`) is always treated as LATE_RECONCILIATION: its BUY metrics (VWAP,
 * shares, notional, fill count) are folded into the episode as legitimate evidence, and
 * `firstBuyAt` may move earlier, but `lastFillAt` (the high-water mark used for the forward
 * 30-minute window) is never moved backward, and `shouldTriggerBurst` is always false — an
 * already-triggered episode never triggers again because of a late-arriving fill. This is a
 * deliberately conservative policy: Task 4 does not attempt to re-derive "true" episode boundaries
 * under strict event-time ordering (e.g. splitting a late fill into an earlier episode of its own)
 * — that would require a full database reconciliation engine, explicitly out of scope here.
 */
export function decideFill(fill: EligibleFill, existingOpenEpisode: OpenEpisodeState | null): EpisodeDecision {
  const invalidReason = validateFill(fill);
  if (invalidReason) return { kind: "INVALID_FILL", fill, reason: invalidReason, shouldTriggerBurst: false };

  const matchesPosition = existingOpenEpisode !== null && samePosition(existingOpenEpisode, fill);

  if (matchesPosition && existingOpenEpisode!.processedEventKeys.has(fill.eventKey)) {
    return { kind: "DUPLICATE_FILL", episodeKey: existingOpenEpisode!.episodeKey, fill, shouldTriggerBurst: false };
  }

  if (fill.side === "SELL") {
    if (!matchesPosition) {
      // No known forward (post-go-live) open position to reduce -- Part 5's explicit
      // "pre-epoch/untracked sell" case. Never fabricates a position; the caller
      // persists this with is_pre_epoch=true rather than silently dropping it.
      return { kind: "SELL_RECORDED", episodeKey: null, fill, shouldTriggerBurst: false, nextState: null, isPreEpoch: true };
    }
    const open = existingOpenEpisode!;
    const nextState: OpenEpisodeState = {
      ...open,
      sellSeen: true,
      firstSellAt: open.firstSellAt === null ? fill.sourceTs : Math.min(open.firstSellAt, fill.sourceTs),
      lastSellAt: open.lastSellAt === null ? fill.sourceTs : Math.max(open.lastSellAt, fill.sourceTs),
      sellCount: open.sellCount + 1,
      sellShares: open.sellShares + fill.shares,
      sellNotional: open.sellNotional + fill.price * fill.shares,
      processedEventKeys: new Set(open.processedEventKeys).add(fill.eventKey),
    };
    return { kind: "SELL_RECORDED", episodeKey: open.episodeKey, fill, shouldTriggerBurst: false, nextState, isPreEpoch: false };
  }

  // BUY.
  if (!matchesPosition) {
    const episodeKey = deriveEpisodeKey(fill.wallet, fill.conditionId, fill.asset, fill.eventKey);
    return { kind: "NEW_EPISODE", episodeKey, anchorEventKey: fill.eventKey, fill, shouldTriggerBurst: true, nextState: newEpisodeState(fill, episodeKey) };
  }

  const open = existingOpenEpisode!;

  if (fill.sourceTs < open.lastFillAt) {
    const totalShares = open.totalShares + fill.shares;
    const totalNotional = open.totalNotional + fill.price * fill.shares;
    const nextState: OpenEpisodeState = {
      ...open,
      firstBuyAt: Math.min(open.firstBuyAt, fill.sourceTs),
      totalShares,
      totalNotional,
      vwap: totalNotional / totalShares,
      buyFillCount: open.buyFillCount + 1,
      processedEventKeys: new Set(open.processedEventKeys).add(fill.eventKey),
    };
    return { kind: "LATE_RECONCILIATION", episodeKey: open.episodeKey, fill, shouldTriggerBurst: false, nextState };
  }

  const gap = fill.sourceTs - open.lastFillAt;
  if (gap <= AGGREGATION_WINDOW_SECONDS) {
    const totalShares = open.totalShares + fill.shares;
    const totalNotional = open.totalNotional + fill.price * fill.shares;
    const nextState: OpenEpisodeState = {
      ...open,
      lastFillAt: fill.sourceTs,
      totalShares,
      totalNotional,
      vwap: totalNotional / totalShares,
      buyFillCount: open.buyFillCount + 1,
      processedEventKeys: new Set(open.processedEventKeys).add(fill.eventKey),
    };
    return { kind: "AGGREGATED_BUY", episodeKey: open.episodeKey, fill, shouldTriggerBurst: false, nextState };
  }

  const episodeKey = deriveEpisodeKey(fill.wallet, fill.conditionId, fill.asset, fill.eventKey);
  return { kind: "NEW_EPISODE_AFTER_30M", episodeKey, anchorEventKey: fill.eventKey, fill, shouldTriggerBurst: true, nextState: newEpisodeState(fill, episodeKey) };
}

/**
 * Batch convenience wrapper for tests and for Task 11's in-process ordering of one poll cycle's
 * fills. Sorts by sourceTs then eventKey (same tie-break as normalizeSourceEvents in
 * shadow-core.ts) and threads state through decideFill's own `nextState`. Production code must NOT
 * reuse this in-memory map across separate scheduler invocations — Task 11 must re-hydrate each
 * position's OpenEpisodeState from sports_shadow_signals every cycle, since only the DB is
 * durable; this wrapper exists for tests (and single-cycle in-memory ordering) only.
 */
export function processFillsForTest(fills: EligibleFill[], initialStates: ReadonlyMap<string, OpenEpisodeState> = new Map()): EpisodeDecision[] {
  const states = new Map(initialStates);
  const sorted = [...fills].sort((a, b) => a.sourceTs - b.sourceTs || a.eventKey.localeCompare(b.eventKey));
  return sorted.map((fill) => {
    const positionKey = `${fill.wallet}:${fill.conditionId}:${fill.asset}`;
    const decision = decideFill(fill, states.get(positionKey) ?? null);
    if ("nextState" in decision && decision.nextState) {
      states.set(positionKey, decision.nextState);
    }
    return decision;
  });
}
