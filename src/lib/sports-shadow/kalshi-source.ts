/**
 * Same-venue Kalshi source routing — PURE logic only.
 *
 * This module is the first implementation step for a Kalshi->Kalshi copy-research path.
 * It deliberately does NOT fetch Kalshi Social/leaderboard data, place orders, touch
 * Supabase, or reuse the cross-venue resolver. Its only job is to validate one already-
 * observed Kalshi source trade and turn it into a deterministic direct route to the exact
 * same Kalshi market ticker and side.
 *
 * Why this exists separately from resolver.ts:
 * - resolver.ts proves economic equivalence across DIFFERENT venues/contracts;
 * - a public Kalshi trader trade copied to the SAME Kalshi market already carries the
 *   authoritative target market ticker, so inventing a second fuzzy/economic match would
 *   add failure modes without adding evidence;
 * - this direct route is intentionally labeled KALSHI_SAME_VENUE rather than EXACT so it
 *   cannot contaminate the historical EXACT/NEAR/NONE/UNVERIFIED cross-venue metrics.
 *
 * Live trading remains out of scope. A later server adapter may feed canonical public
 * activity into this function only after the public activity source contract is verified.
 */

export type KalshiSourceSide = "YES" | "NO";
export type KalshiSourceAction = "BUY" | "SELL";

/** Canonical activity shape expected AFTER a future source adapter has parsed evidence. */
export type KalshiSourceTrade = {
  sourceTradeId: string;
  traderHandle: string;
  marketTicker: string;
  side: KalshiSourceSide;
  action: KalshiSourceAction;
  contracts: number;
  /** Dollar probability price, e.g. 0.63. */
  price: number;
  /** Epoch milliseconds when the source trade occurred. */
  sourceTsMs: number;
};

export type SameVenueKalshiRoute = {
  routeKind: "KALSHI_SAME_VENUE";
  sourceTradeId: string;
  traderHandle: string;
  marketTicker: string;
  side: KalshiSourceSide;
  action: KalshiSourceAction;
  contracts: number;
  sourcePrice: number;
  sourceTsMs: number;
  /** Explicit proof that no cross-venue resolver was involved. */
  matchingBasis: "SOURCE_MARKET_TICKER";
};

export type SameVenueKalshiRejectCode =
  | "MISSING_SOURCE_TRADE_ID"
  | "MISSING_TRADER_HANDLE"
  | "INVALID_MARKET_TICKER"
  | "INVALID_SIDE"
  | "INVALID_ACTION"
  | "INVALID_CONTRACTS"
  | "INVALID_PRICE"
  | "INVALID_SOURCE_TIMESTAMP";

export type SameVenueKalshiRouteDecision =
  | { status: "ROUTABLE"; route: SameVenueKalshiRoute }
  | { status: "REJECTED"; reasonCode: SameVenueKalshiRejectCode; reason: string };

const KALSHI_TICKER_RE = /^[A-Z0-9][A-Z0-9._:-]{1,199}$/;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function reject(reasonCode: SameVenueKalshiRejectCode, reason: string): SameVenueKalshiRouteDecision {
  return { status: "REJECTED", reasonCode, reason };
}

/**
 * Build a deterministic direct route from one canonical Kalshi source trade.
 *
 * Fail-closed invariants:
 * - no guessed ticker;
 * - no guessed YES/NO side;
 * - no guessed BUY/SELL action;
 * - no zero/negative/NaN quantity or price;
 * - no synthesized timestamp.
 */
export function buildSameVenueKalshiRoute(trade: KalshiSourceTrade): SameVenueKalshiRouteDecision {
  if (!nonEmpty(trade.sourceTradeId)) return reject("MISSING_SOURCE_TRADE_ID", "source trade id is required");
  if (!nonEmpty(trade.traderHandle)) return reject("MISSING_TRADER_HANDLE", "trader handle is required");

  const marketTicker = nonEmpty(trade.marketTicker) ? trade.marketTicker.trim().toUpperCase() : "";
  if (!KALSHI_TICKER_RE.test(marketTicker)) {
    return reject("INVALID_MARKET_TICKER", "Kalshi market ticker is missing or malformed");
  }
  if (trade.side !== "YES" && trade.side !== "NO") {
    return reject("INVALID_SIDE", "source side must be YES or NO");
  }
  if (trade.action !== "BUY" && trade.action !== "SELL") {
    return reject("INVALID_ACTION", "source action must be BUY or SELL");
  }
  if (!Number.isFinite(trade.contracts) || trade.contracts <= 0) {
    return reject("INVALID_CONTRACTS", "source contracts must be a positive finite number");
  }
  if (!Number.isFinite(trade.price) || trade.price <= 0 || trade.price > 1) {
    return reject("INVALID_PRICE", "source price must be in the interval (0, 1]");
  }
  if (!Number.isFinite(trade.sourceTsMs) || trade.sourceTsMs <= 0) {
    return reject("INVALID_SOURCE_TIMESTAMP", "source timestamp must be a positive epoch-millisecond value");
  }

  return {
    status: "ROUTABLE",
    route: {
      routeKind: "KALSHI_SAME_VENUE",
      sourceTradeId: trade.sourceTradeId.trim(),
      traderHandle: trade.traderHandle.trim(),
      marketTicker,
      side: trade.side,
      action: trade.action,
      contracts: trade.contracts,
      sourcePrice: trade.price,
      sourceTsMs: trade.sourceTsMs,
      matchingBasis: "SOURCE_MARKET_TICKER",
    },
  };
}

/** Stable idempotency key for persistence once the server-side source adapter is wired. */
export function kalshiSourceDedupeKey(trade: Pick<KalshiSourceTrade, "traderHandle" | "sourceTradeId">): string | null {
  if (!nonEmpty(trade.traderHandle) || !nonEmpty(trade.sourceTradeId)) return null;
  return `kalshi:${trade.traderHandle.trim().toLowerCase()}:${trade.sourceTradeId.trim()}`;
}
