/**
 * SAME-VENUE (Kalshi -> Kalshi) source adapter — PURE module.
 *
 * Purpose: a Kalshi public trader's own activity already names a VERIFIED Kalshi market
 * ticker and side, so it must NEVER be pushed through the Polymarket->Kalshi
 * economic-equivalence resolver (`resolver.ts`). This module normalizes such an event,
 * validates it fail-closed, derives a stable dedupe key, applies the trader
 * qualification/watchlist gate, and emits an `EligibleFill` for the EXISTING lifecycle
 * reducer (`episode.ts` -> observation -> paper.server.ts). It performs no I/O: no
 * network, no Supabase, no clock, no env.
 *
 * Safety: this module cannot place orders. It only produces PAPER-path inputs.
 * LIVE_EXECUTION_IMPLEMENTED stays false; nothing here touches a live order path.
 *
 * Transport status: as of this commit there is NO verified Kalshi interface that returns a
 * SPECIFIC public trader's trades (see docs/KALSHI_SAME_VENUE_SOURCE.md). Therefore this
 * file intentionally ships the `KalshiTraderActivitySource` INTERFACE ONLY, with no
 * production implementation and no simulated/fake transport.
 */

import type { EligibleFill, FillSide } from "./episode";

export type KalshiContractSide = "YES" | "NO";

/** Raw, untrusted event as a future verified trader feed would hand it to us. */
export type KalshiTraderSourceEvent = {
  /** Stable identifier of the observed public trader/profile (never a display name alone). */
  traderId: unknown;
  /** Source-side identifier of THIS trade, unique within the trader feed. Drives dedupe. */
  sourceTradeId: unknown;
  /** Exact Kalshi market ticker as reported by the venue. Used verbatim, never re-derived. */
  marketTicker: unknown;
  /** YES or NO contract. Orientation is preserved verbatim — never flipped. */
  contractSide: unknown;
  /** BUY or SELL of that contract. */
  action: unknown;
  /** Contract count, > 0. */
  quantity: unknown;
  /** Execution price in Kalshi cents, integer 1..99 inclusive. */
  priceCents: unknown;
  /** Unix SECONDS at which the trade executed on Kalshi. */
  sourceTsSeconds: unknown;
};

export type NormalizedKalshiSourceTrade = {
  /** Always SAME_VENUE: the routing contract that forbids cross-venue resolution. */
  route: "SAME_VENUE_KALSHI";
  traderId: string;
  sourceTradeId: string;
  /** Byte-identical to the feed's ticker. */
  marketTicker: string;
  contractSide: KalshiContractSide;
  action: FillSide;
  quantity: number;
  /** Probability form (0,1] used by the existing paper/episode math. */
  price: number;
  priceCents: number;
  sourceTs: number;
  /** Stable dedupe identity, also used as `EligibleFill.eventKey`. */
  eventKey: string;
};

export type KalshiSourceRejection = { ok: false; reasonCode: KalshiSourceRejectCode; reason: string };
export type KalshiSourceAcceptance = { ok: true; trade: NormalizedKalshiSourceTrade };
export type KalshiSourceNormalizationResult = KalshiSourceAcceptance | KalshiSourceRejection;

export type KalshiSourceRejectCode =
  | "REJECT_MISSING_TRADER_ID"
  | "REJECT_MISSING_TRADE_ID"
  | "REJECT_MISSING_TICKER"
  | "REJECT_INVALID_SIDE"
  | "REJECT_INVALID_ACTION"
  | "REJECT_INVALID_QUANTITY"
  | "REJECT_INVALID_PRICE"
  | "REJECT_INVALID_TIMESTAMP"
  | "REJECT_TRADER_NOT_QUALIFIED"
  | "REJECT_DUPLICATE_EVENT";

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Kalshi tickers are uppercase alphanumeric with `-` segments (e.g. KXMLBGAME-26AUG25CHCCIN-CHC).
 * Anything else fails closed rather than being "cleaned up" — we never guess a ticker.
 */
const TICKER_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9.]+)*$/;

export function isVerifiedKalshiTicker(value: unknown): value is string {
  const ticker = trimmedString(value);
  return ticker !== null && ticker.length <= 128 && TICKER_PATTERN.test(ticker);
}

/** Stable dedupe key. Same trader + same source trade id can never execute twice. */
export function deriveKalshiSourceEventKey(traderId: string, sourceTradeId: string): string {
  return `KALSHI_SRC:${traderId}:${sourceTradeId}`;
}

/**
 * Trader qualification gate. Deliberately NOT a set of invented numeric thresholds — the
 * project has no agreed same-venue thresholds yet. A trader is copyable only when an
 * explicit, externally-decided qualification record says so, so "top of the profit
 * leaderboard" alone can never auto-qualify.
 */
export type KalshiTraderQualification = {
  traderId: string;
  /** Set only by a deliberate qualification decision recorded elsewhere. */
  approvedForPaperCopy: boolean;
  /** Free-form evidence bundle (performance windows, trade count, concentration, latency, fees, drawdown, ...). Retained for later threshold work; never interpreted here. */
  evidence?: Readonly<Record<string, unknown>>;
};

export type KalshiTraderWatchlist = {
  get(traderId: string): KalshiTraderQualification | null;
};

export function isTraderQualified(watchlist: KalshiTraderWatchlist | null, traderId: string): boolean {
  if (watchlist === null) return false; // fail closed: no watchlist means nothing is copyable
  const record = watchlist.get(traderId);
  return record !== null && record !== undefined && record.approvedForPaperCopy === true;
}

/** Pure validation + normalization. No qualification, no dedupe — see `admitKalshiSourceEvent`. */
export function normalizeKalshiTraderEvent(raw: KalshiTraderSourceEvent): KalshiSourceNormalizationResult {
  const traderId = trimmedString(raw.traderId);
  if (traderId === null) return { ok: false, reasonCode: "REJECT_MISSING_TRADER_ID", reason: "trader identifier missing" };

  const sourceTradeId = trimmedString(raw.sourceTradeId);
  if (sourceTradeId === null) return { ok: false, reasonCode: "REJECT_MISSING_TRADE_ID", reason: "source trade identifier missing" };

  if (!isVerifiedKalshiTicker(raw.marketTicker)) {
    return { ok: false, reasonCode: "REJECT_MISSING_TICKER", reason: "kalshi market ticker missing or not a verified ticker shape" };
  }
  const marketTicker = (raw.marketTicker as string).trim();

  if (raw.contractSide !== "YES" && raw.contractSide !== "NO") {
    return { ok: false, reasonCode: "REJECT_INVALID_SIDE", reason: "contract side must be exactly YES or NO" };
  }
  const contractSide: KalshiContractSide = raw.contractSide;

  if (raw.action !== "BUY" && raw.action !== "SELL") {
    return { ok: false, reasonCode: "REJECT_INVALID_ACTION", reason: "action must be exactly BUY or SELL" };
  }
  const action: FillSide = raw.action;

  const quantity = raw.quantity;
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, reasonCode: "REJECT_INVALID_QUANTITY", reason: "quantity must be a finite number > 0" };
  }

  const priceCents = raw.priceCents;
  if (typeof priceCents !== "number" || !Number.isInteger(priceCents) || priceCents < 1 || priceCents > 99) {
    return { ok: false, reasonCode: "REJECT_INVALID_PRICE", reason: "priceCents must be an integer in [1,99]" };
  }

  const sourceTs = raw.sourceTsSeconds;
  if (typeof sourceTs !== "number" || !Number.isFinite(sourceTs) || sourceTs <= 0) {
    return { ok: false, reasonCode: "REJECT_INVALID_TIMESTAMP", reason: "sourceTsSeconds must be a positive unix-seconds value" };
  }

  return {
    ok: true,
    trade: {
      route: "SAME_VENUE_KALSHI",
      traderId,
      sourceTradeId,
      marketTicker,
      contractSide,
      action,
      quantity,
      price: priceCents / 100,
      priceCents,
      sourceTs,
      eventKey: deriveKalshiSourceEventKey(traderId, sourceTradeId),
    },
  };
}

/**
 * Full admission: normalization -> qualification gate -> dedupe. `seenEventKeys` is the
 * caller's already-processed set (DB-backed in production); the pure check here is an
 * additional safety net, never a replacement for the persistence-level unique constraint.
 */
export function admitKalshiSourceEvent(
  raw: KalshiTraderSourceEvent,
  watchlist: KalshiTraderWatchlist | null,
  seenEventKeys: ReadonlySet<string> = new Set(),
): KalshiSourceNormalizationResult {
  const normalized = normalizeKalshiTraderEvent(raw);
  if (!normalized.ok) return normalized;

  if (!isTraderQualified(watchlist, normalized.trade.traderId)) {
    return { ok: false, reasonCode: "REJECT_TRADER_NOT_QUALIFIED", reason: "trader is not approved for paper copy" };
  }
  if (seenEventKeys.has(normalized.trade.eventKey)) {
    return { ok: false, reasonCode: "REJECT_DUPLICATE_EVENT", reason: "source event already processed" };
  }
  return normalized;
}

/**
 * Bridge into the EXISTING lifecycle reducer (`decideFill` in episode.ts), which drives
 * BUY / ADD-DCA / partial SELL / full SELL exactly as it does for Polymarket sources.
 *
 * `conditionId` and `asset` carry the same-venue identity: the ticker is the contest/market
 * identity and `TICKER:SIDE` is the specific tradable leg, so YES and NO of one ticker are
 * distinct positions and are never merged.
 */
export function toEligibleFill(trade: NormalizedKalshiSourceTrade, detectedAtMs: number): EligibleFill {
  return {
    eventKey: trade.eventKey,
    wallet: trade.traderId,
    conditionId: trade.marketTicker,
    asset: `${trade.marketTicker}:${trade.contractSide}`,
    side: trade.action,
    shares: trade.quantity,
    price: trade.price,
    sourceTs: trade.sourceTs,
    detectedAt: detectedAtMs,
  };
}

/** The target leg to observe/paper-trade: byte-identical ticker, identical side. */
export function targetLegForTrade(trade: NormalizedKalshiSourceTrade): { venue: "KALSHI"; ticker: string; side: KalshiContractSide } {
  return { venue: "KALSHI", ticker: trade.marketTicker, side: trade.contractSide };
}

/**
 * Routing contract: a same-venue trade must NEVER be handed to the cross-venue resolver.
 * Callers assert this before matching.
 */
export function requiresCrossVenueResolution(trade: Pick<NormalizedKalshiSourceTrade, "route">): boolean {
  return trade.route !== "SAME_VENUE_KALSHI";
}

/**
 * THE ONE INTERFACE a later VERIFIED trader feed plugs into. No production implementation
 * exists yet and none must be faked — see docs/KALSHI_SAME_VENUE_SOURCE.md for the exact
 * evidence still required from Kalshi.
 */
export interface KalshiTraderActivitySource {
  /** Stable name of the transport, for telemetry/provenance. */
  readonly sourceName: string;
  /**
   * Returns raw trader activity newer than `sinceTsSeconds` for one trader. Implementations
   * must be read-only and must never synthesize trades.
   */
  fetchNewActivity(input: { traderId: string; sinceTsSeconds: number; signal?: AbortSignal }): Promise<KalshiTraderSourceEvent[]>;
}
