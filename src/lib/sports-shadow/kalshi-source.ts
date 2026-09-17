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

export type KalshiTraderSourceEvent = {
  traderId: unknown;
  sourceTradeId: unknown;
  marketTicker: unknown;
  contractSide: unknown;
  action: unknown;
  quantity: unknown;
  priceCents: unknown;
  sourceTsSeconds: unknown;
};

export type NormalizedKalshiSourceTrade = {
  route: "SAME_VENUE_KALSHI";
  traderId: string;
  sourceTradeId: string;
  marketTicker: string;
  contractSide: KalshiContractSide;
  action: FillSide;
  quantity: number;
  price: number;
  priceCents: number;
  sourceTs: number;
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

const TICKER_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9.]+)*$/;

export function isVerifiedKalshiTicker(value: unknown): value is string {
  const ticker = trimmedString(value);
  return ticker !== null && ticker.length <= 128 && TICKER_PATTERN.test(ticker);
}

export function deriveKalshiSourceEventKey(traderId: string, sourceTradeId: string): string {
  return `KALSHI_SRC:${traderId}:${sourceTradeId}`;
}

export type KalshiTraderQualification = {
  traderId: string;
  approvedForPaperCopy: boolean;
  evidence?: Readonly<Record<string, unknown>>;
};

export type KalshiTraderWatchlist = {
  get(traderId: string): KalshiTraderQualification | null;
};

export function isTraderQualified(watchlist: KalshiTraderWatchlist | null, traderId: string): boolean {
  if (watchlist === null) return false;
  const record = watchlist.get(traderId);
  return record !== null && record !== undefined && record.approvedForPaperCopy === true;
}

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

export function targetLegForTrade(trade: NormalizedKalshiSourceTrade): { venue: "KALSHI"; ticker: string; side: KalshiContractSide } {
  return { venue: "KALSHI", ticker: trade.marketTicker, side: trade.contractSide };
}

export function requiresCrossVenueResolution(trade: Pick<NormalizedKalshiSourceTrade, "route">): boolean {
  return trade.route !== "SAME_VENUE_KALSHI";
}

export interface KalshiTraderActivitySource {
  readonly sourceName: string;
  fetchNewActivity(input: { traderId: string; sinceTsSeconds: number; signal?: AbortSignal }): Promise<KalshiTraderSourceEvent[]>;
}
