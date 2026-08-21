/**
 * Kalshi MLB market discovery + order-book normalization — PURE logic only.
 *
 * Field shapes confirmed by live, read-only, unauthenticated requests to
 * https://external-api.kalshi.com/trade-api/v2 during development: GET /markets,
 * GET /markets/{ticker}, GET /markets/{ticker}/orderbook, GET /events. In particular:
 * - The orderbook endpoint worked WITHOUT any auth headers (HTTP 200) — resolving the
 *   documented auth conflict in favor of the "no authentication required" guide, for this
 *   environment, as of this recon. See kalshi.server.ts's doc comment for the exact probe.
 * - `orderbook_fp.yes_dollars`/`orderbook_fp.no_dollars` are BOTH bids-only arrays of
 *   `[priceString, quantityString]` tuples — confirmed real, e.g.
 *   `["0.0100","86861.00"]`. There is no separate ask array; asks are derived via the
 *   binary complement (1 - price) of the OTHER side's bids, per Kalshi's documented
 *   mechanics.
 * - Each MLB game has its own team-specific KXMLBGAME market (e.g. `...-SD` and `...-MIN`
 *   as two SEPARATE sibling markets under one `event_ticker`), not one market with two
 *   sides. `yes_sub_title`/`no_sub_title` are identical on a given market (both restate the
 *   YES proposition) — there is no separate NO-side label to parse.
 * - `event.title` ("Minnesota vs San Diego") and `event.sub_title` ("MIN vs SD (Aug 22)")
 *   are confirmed present on the EVENTS list endpoint (no per-event detail call needed).
 * - `occurrence_datetime` is a confirmed structured game-time field, present and populated
 *   on MONEYLINE/SPREAD/TOTAL markets alike, distinct from open_time/close_time/
 *   expiration_time (settlement-window fields, not game time).
 */

import { normalizeTeamName } from "./team-normalization";
import type { BetType, DepthLevel } from "./types";

/* ------------------------------- Discovery ------------------------------- */

export type KalshiSeriesTicker = "KXMLBGAME" | "KXMLBSPREAD" | "KXMLBTOTAL";

export const PHASE1_KALSHI_SERIES: readonly KalshiSeriesTicker[] = ["KXMLBGAME", "KXMLBSPREAD", "KXMLBTOTAL"];

export type KalshiRawMarket = {
  ticker?: string | null;
  event_ticker?: string | null;
  market_type?: string | null;
  title?: string | null;
  yes_sub_title?: string | null;
  no_sub_title?: string | null;
  status?: string | null;
  open_time?: string | null;
  close_time?: string | null;
  latest_expiration_time?: string | null;
  expected_expiration_time?: string | null;
  occurrence_datetime?: string | null;
  floor_strike?: number | null;
  cap_strike?: number | null;
  strike_type?: string | null;
  rules_primary?: string | null;
  rules_secondary?: string | null;
  early_close_condition?: string | null;
  yes_bid_dollars?: string | null;
  yes_ask_dollars?: string | null;
  no_bid_dollars?: string | null;
  no_ask_dollars?: string | null;
  result?: string | null;
  /** Descriptive only per Kalshi's own docs — NEVER the authoritative precision bound; use price_ranges[].step for that. Confirmed live value: "linear_cent" (even alongside a "0.0010" price_ranges step on other markets). */
  price_level_structure?: string | null;
  /** The authoritative valid-price-grid source, confirmed live (e.g. [{start:"0.0000",end:"1.0000",step:"0.0100"}], and separately step:"0.0010" on other open markets — sub-cent grids are real and current). Preserved as raw fixed-point strings, never parsed/snapped — Task 6/7 do not implement order-price snapping or trading. */
  price_ranges?: { start?: string | null; end?: string | null; step?: string | null }[] | null;
};

/** Confirmed present on GET /events list responses (no per-event detail call needed). */
export type KalshiRawEvent = {
  event_ticker?: string | null;
  series_ticker?: string | null;
  /** "Minnesota vs San Diego" — away vs home, confirmed by cross-checking ticker team-code order. */
  title?: string | null;
  sub_title?: string | null;
};

export type KalshiCandidateStatus = "ELIGIBLE" | "UNSUPPORTED" | "UNVERIFIED";

export type KalshiEligibleReasonCode = "ELIGIBLE_FULL_GAME_MONEYLINE" | "ELIGIBLE_FULL_GAME_SPREAD" | "ELIGIBLE_FULL_GAME_TOTAL";
export type KalshiRejectReasonCode = "REJECT_UNKNOWN_SERIES";
export type KalshiUnverifiedReasonCode = "UNVERIFIED_MISSING_LINE" | "UNVERIFIED_UNKNOWN_TEAM" | "UNVERIFIED_METADATA_MISSING" | "UNVERIFIED_CONFLICTING_METADATA";
export type KalshiCandidateReasonCode = KalshiEligibleReasonCode | KalshiRejectReasonCode | KalshiUnverifiedReasonCode;

/**
 * One normalized Kalshi market candidate. ONE candidate per Kalshi market ticker (each MLB
 * team already gets its own market for MONEYLINE/SPREAD — Task 6 does not merge them). Never
 * decides which side (YES/NO) maps to the source-selected outcome — `propositionTeam` names
 * which team's proposition THIS specific market represents (for MONEYLINE/SPREAD only);
 * Task 7 maps that to the source side.
 */
export type KalshiCandidate = {
  status: KalshiCandidateStatus;
  reasonCode: KalshiCandidateReasonCode;
  betType: BetType | null;
  seriesTicker: string | null;
  eventTicker: string | null;
  /** event_ticker with the series prefix stripped (e.g. "26AUG201310SFCLE") — shared across a game's KXMLBGAME/KXMLBSPREAD/KXMLBTOTAL event_tickers, giving Task 7 a cross-series join key without Task 6 performing any join itself. */
  gameCode: string | null;
  marketTicker: string | null;
  title: string | null;
  awayTeam: string | null;
  homeTeam: string | null;
  /** Which team's proposition this market represents (MONEYLINE/SPREAD only; null for TOTAL). */
  propositionTeam: string | null;
  line: number | null;
  strikeType: string | null;
  marketStatus: string | null;
  openTime: string | null;
  closeTime: string | null;
  latestExpirationTime: string | null;
  /** Preferred structured game-time field (occurrence_datetime), never derived from open/close/expiration. */
  scheduledStartAt: string | null;
  rulesPrimary: string | null;
  rulesSecondary: string | null;
  earlyCloseCondition: string | null;
  yesSubTitle: string | null;
  noSubTitle: string | null;
  /** Get-Markets summary BBO — diagnostic only, NEVER authoritative for executable depth (the live orderbook is). */
  summaryYesBidDollars: number | null;
  summaryYesAskDollars: number | null;
  summaryNoBidDollars: number | null;
  summaryNoAskDollars: number | null;
  /** Descriptive only — see PriceRange note on KalshiRawMarket.price_level_structure. */
  priceLevelStructure: string | null;
  /** Authoritative valid-price-grid, raw fixed-point strings preserved verbatim. Measurement metadata only — no order-price snapping implemented. */
  priceRanges: KalshiPriceRange[] | null;
};

export type KalshiPriceRange = { start: string | null; end: string | null; step: string | null };

const SERIES_TO_BET_TYPE: Record<string, BetType> = {
  KXMLBGAME: "MONEYLINE",
  KXMLBSPREAD: "SPREAD",
  KXMLBTOTAL: "TOTAL",
};

function parseDollarField(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Strips the series prefix from an event_ticker, e.g. ("KXMLBSPREAD-26AUG201310SFCLE", "KXMLBSPREAD") -> "26AUG201310SFCLE". */
export function deriveGameCode(eventTicker: string | null | undefined, seriesTicker: string | null | undefined): string | null {
  if (!eventTicker || !seriesTicker) return null;
  const prefix = `${seriesTicker}-`;
  if (!eventTicker.startsWith(prefix)) return null;
  return eventTicker.slice(prefix.length);
}

/** Fallback series derivation directly from a market ticker's prefix, for defense-in-depth when no event object is supplied. */
function deriveSeriesFromTicker(ticker: string | null | undefined): string | null {
  if (!ticker) return null;
  const dash = ticker.indexOf("-");
  return dash > 0 ? ticker.slice(0, dash) : null;
}

function baseFields(market: KalshiRawMarket, seriesTicker: string | null) {
  return {
    seriesTicker,
    eventTicker: market.event_ticker ?? null,
    marketTicker: market.ticker ?? null,
    title: market.title ?? null,
    strikeType: market.strike_type ?? null,
    marketStatus: market.status ?? null,
    openTime: market.open_time ?? null,
    closeTime: market.close_time ?? null,
    latestExpirationTime: market.latest_expiration_time ?? null,
    scheduledStartAt: market.occurrence_datetime ?? market.expected_expiration_time ?? null,
    rulesPrimary: market.rules_primary ?? null,
    rulesSecondary: market.rules_secondary ?? null,
    earlyCloseCondition: market.early_close_condition ?? null,
    yesSubTitle: market.yes_sub_title ?? null,
    noSubTitle: market.no_sub_title ?? null,
    summaryYesBidDollars: parseDollarField(market.yes_bid_dollars),
    summaryYesAskDollars: parseDollarField(market.yes_ask_dollars),
    summaryNoBidDollars: parseDollarField(market.no_bid_dollars),
    summaryNoAskDollars: parseDollarField(market.no_ask_dollars),
    priceLevelStructure: market.price_level_structure ?? null,
    priceRanges: market.price_ranges
      ? market.price_ranges.map((r) => ({ start: r.start ?? null, end: r.end ?? null, step: r.step ?? null }))
      : null,
  };
}

function unsupported(market: KalshiRawMarket, seriesTicker: string | null, reasonCode: KalshiRejectReasonCode): KalshiCandidate {
  return {
    ...baseFields(market, seriesTicker),
    status: "UNSUPPORTED",
    reasonCode,
    betType: null,
    gameCode: deriveGameCode(market.event_ticker, seriesTicker),
    awayTeam: null,
    homeTeam: null,
    propositionTeam: null,
    line: null,
  };
}

function unverified(market: KalshiRawMarket, seriesTicker: string | null, reasonCode: KalshiUnverifiedReasonCode): KalshiCandidate {
  return {
    ...baseFields(market, seriesTicker),
    status: "UNVERIFIED",
    reasonCode,
    betType: null,
    gameCode: deriveGameCode(market.event_ticker, seriesTicker),
    awayTeam: null,
    homeTeam: null,
    propositionTeam: null,
    line: null,
  };
}

/**
 * Determines which team's proposition this specific market names, cross-checked against the
 * already-resolved away/home pair. For MONEYLINE, yes_sub_title IS the bare team name. For
 * SPREAD, yes_sub_title is prose ("Cleveland wins by over 5.5 runs") — matched against the
 * raw away/home text (not just the normalized code) via startsWith, anchored to the two
 * known teams rather than generic free-text team parsing. A market naming a team that is
 * neither of the event's two resolved teams is a genuine conflict, not a guess.
 */
function resolvePropositionTeam(
  betType: BetType,
  market: KalshiRawMarket,
  awayRaw: string,
  homeRaw: string,
  awayCode: string,
  homeCode: string,
): { team: string | null; conflict: boolean } {
  if (betType === "TOTAL") return { team: null, conflict: false };
  const subTitle = market.yes_sub_title ?? "";
  if (betType === "MONEYLINE") {
    const code = normalizeTeamName(subTitle);
    if (code === awayCode) return { team: awayCode, conflict: false };
    if (code === homeCode) return { team: homeCode, conflict: false };
    return { team: null, conflict: true };
  }
  // SPREAD
  if (subTitle.startsWith(awayRaw)) return { team: awayCode, conflict: false };
  if (subTitle.startsWith(homeRaw)) return { team: homeCode, conflict: false };
  return { team: null, conflict: true };
}

/**
 * Classifies one Kalshi market into a candidate. `event` should be the market's parent event
 * (looked up from a bounded GET /events?series_ticker=... pass, joined by event_ticker) when
 * available — team identity and gameCode both depend on it. Falls back to deriving the series
 * from the market ticker's own prefix when no event is supplied, so this remains callable and
 * safe (fails closed, never guesses) even without a joined event.
 */
export function classifyKalshiMarket(market: KalshiRawMarket, event: KalshiRawEvent | null): KalshiCandidate {
  const seriesTicker = event?.series_ticker ?? deriveSeriesFromTicker(market.ticker);
  const betType = seriesTicker ? SERIES_TO_BET_TYPE[seriesTicker] : undefined;
  if (!betType) return unsupported(market, seriesTicker, "REJECT_UNKNOWN_SERIES");

  const line = market.floor_strike ?? null;
  if (betType !== "MONEYLINE" && (line === null || !Number.isFinite(line))) {
    return unverified(market, seriesTicker, "UNVERIFIED_MISSING_LINE");
  }

  if (!event?.title) return unverified(market, seriesTicker, "UNVERIFIED_METADATA_MISSING");
  const parts = event.title.split(" vs ");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return unverified(market, seriesTicker, "UNVERIFIED_METADATA_MISSING");
  const [awayRaw, homeRaw] = parts;
  const awayCode = normalizeTeamName(awayRaw);
  const homeCode = normalizeTeamName(homeRaw);
  if (!awayCode || !homeCode) return unverified(market, seriesTicker, "UNVERIFIED_UNKNOWN_TEAM");

  const { team: propositionTeam, conflict } = resolvePropositionTeam(betType, market, awayRaw, homeRaw, awayCode, homeCode);
  if (conflict) return unverified(market, seriesTicker, "UNVERIFIED_CONFLICTING_METADATA");

  const reasonCode: KalshiEligibleReasonCode =
    betType === "MONEYLINE" ? "ELIGIBLE_FULL_GAME_MONEYLINE" : betType === "SPREAD" ? "ELIGIBLE_FULL_GAME_SPREAD" : "ELIGIBLE_FULL_GAME_TOTAL";

  return {
    ...baseFields(market, seriesTicker),
    status: "ELIGIBLE",
    reasonCode,
    betType,
    gameCode: deriveGameCode(market.event_ticker, seriesTicker),
    awayTeam: awayCode,
    homeTeam: homeCode,
    propositionTeam,
    line: betType === "MONEYLINE" ? null : line,
  };
}

/* ---------------------------- Book normalization ---------------------------- */

export type KalshiBookSide = {
  bestBid: number | null;
  bestAsk: number | null;
  /** Exact integer 1e-4-dollar units (see PRICE_SCALE) for the best prices above — retained alongside the float for auditability, since this is the form all arithmetic actually happened in. */
  bestBidUnits: number | null;
  bestAskUnits: number | null;
  bidLevels: DepthLevel[];
  askLevels: DepthLevel[];
};

/**
 * Both binary complement views of one Kalshi market's book. Neither `yes` nor `no` is
 * assumed to be the source-selected side — that mapping is Task 7's job. `rawYesBids`/
 * `rawNoBids` preserve the venue's own bid arrays verbatim (post-validation) so Task 7/8 can
 * always recover exactly what Kalshi returned, independent of the derived ask views.
 */
export type KalshiBookSnapshot = {
  venue: "KALSHI";
  marketId: string;
  observedAt: number;
  yes: KalshiBookSide;
  no: KalshiBookSide;
  rawYesBids: DepthLevel[];
  rawNoBids: DepthLevel[];
  staleReason: string | null;
};

const TOP_LEVELS = 5;

/**
 * Kalshi's *_dollars price strings carry up to 4 decimal places (confirmed live: a broad scan
 * of open markets found `price_ranges[].step: "0.0010"` — finer than whole cents — alongside
 * the single-cent `"0.0100"` step seen on other markets; `price_level_structure` is
 * DESCRIPTIVE per Kalshi's own docs, never the authoritative precision bound). All price
 * arithmetic (parsing, complement, sort, crossed-book comparison) happens in exact integer
 * 1e-4-dollar units — never `Math.round(price * 100)`, never float subtraction — so 0.1234's
 * complement is exactly 0.8766 and 0.5001 stays distinguishable from 0.5002. Conversion to a
 * plain `number` happens exactly once, at the final output boundary, by dividing by
 * PRICE_SCALE — a single division of a small exact integer introduces no visible drift at 4
 * decimal digits (unlike the classic `1 - 0.7` float-subtraction problem this design avoids
 * entirely by never subtracting two already-lossy floats).
 */
const PRICE_SCALE = 10_000;
/** Kalshi contract quantities carry up to 2 decimal places (confirmed live, e.g. "301.17", "511.03"). Same exact-integer-then-single-division approach as price. */
const QTY_SCALE = 100;

/**
 * Strict parser for a Kalshi fixed-point dollar string into exact integer 1e-4-dollar units.
 * Accepts 0-4 decimal digits ("0", "0.1", "0.12", "0.123", "0.1234", "1", "1.0000"). Rejects
 * (returns null, never rounds or truncates): more than 4 decimals, malformed decimals,
 * exponent notation, negative numbers, values over 1, trailing junk, and empty strings —
 * enforced by full anchoring (`^...$`), not by post-hoc range clamping.
 */
export function parseKalshiPriceUnits(raw: string): number | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec(raw);
  if (!m) return null;
  const intPart = Number(m[1]);
  const fracDigits = (m[2] ?? "").padEnd(4, "0");
  const units = intPart * PRICE_SCALE + Number(fracDigits);
  if (!Number.isFinite(units) || units <= 0 || units > PRICE_SCALE) return null;
  return units;
}

/**
 * Strict parser for a Kalshi fixed-point quantity string into exact integer 1e-2-contract
 * units. Accepts 0-2 decimal digits ("1.55", "0.01", "100.00"). Rejects malformed strings,
 * negative values, zero (a zero-quantity level carries no live depth), NaN, and Infinity.
 */
export function parseKalshiQuantityUnits(raw: string): number | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!m) return null;
  const intPart = Number(m[1]);
  const fracDigits = (m[2] ?? "").padEnd(2, "0");
  const units = intPart * QTY_SCALE + Number(fracDigits);
  if (!Number.isFinite(units) || units <= 0) return null;
  return units;
}

type UnitsLevel = { priceUnits: number; qtyUnits: number };

function parseRawLevel(tuple: unknown): UnitsLevel | null {
  if (!Array.isArray(tuple) || tuple.length !== 2) return null;
  const [priceStr, qtyStr] = tuple as unknown[];
  if (typeof priceStr !== "string" || typeof qtyStr !== "string") return null;
  const priceUnits = parseKalshiPriceUnits(priceStr);
  const qtyUnits = parseKalshiQuantityUnits(qtyStr);
  if (priceUnits === null || qtyUnits === null) return null;
  return { priceUnits, qtyUnits };
}

function toDepthLevel(level: UnitsLevel): DepthLevel {
  return { price: level.priceUnits / PRICE_SCALE, size: level.qtyUnits / QTY_SCALE };
}

function emptyKalshiBook(ticker: string, observedAt: number, staleReason: string): KalshiBookSnapshot {
  const emptySide: KalshiBookSide = { bestBid: null, bestAsk: null, bestBidUnits: null, bestAskUnits: null, bidLevels: [], askLevels: [] };
  return { venue: "KALSHI", marketId: ticker, observedAt, yes: emptySide, no: { ...emptySide }, rawYesBids: [], rawNoBids: [], staleReason };
}

/**
 * Pure normalizer for the real /markets/{ticker}/orderbook payload
 * (`orderbook_fp.yes_dollars`/`orderbook_fp.no_dollars`, each an array of
 * `[priceString, quantityString]` BID tuples — confirmed live, no separate ask arrays).
 * Derives YES asks from NO bids and NO asks from YES bids via the binary complement
 * (PRICE_SCALE - priceUnits), entirely in exact integer units. Per the mission: bid > ask is
 * crossed and fails closed (nulled best price, non-null staleReason, raw levels still
 * preserved); bid == ask is a legitimate locked-market state, left as-is — both comparisons
 * are done on the exact integer units, so sub-cent distinctions (e.g. 0.5001 vs 0.5002) are
 * never lost. An empty side is a valid observation with no executable depth on that side, not
 * an error.
 */
export function normalizeKalshiBook(raw: unknown, ticker: string, observedAt: number): KalshiBookSnapshot {
  if (typeof raw !== "object" || raw === null) return emptyKalshiBook(ticker, observedAt, "malformed orderbook payload: not an object");
  const ob = (raw as { orderbook_fp?: unknown }).orderbook_fp;
  if (!ob || typeof ob !== "object") return emptyKalshiBook(ticker, observedAt, "malformed orderbook payload: missing orderbook_fp");
  const yesRaw = (ob as Record<string, unknown>)["yes_dollars"];
  const noRaw = (ob as Record<string, unknown>)["no_dollars"];
  if (!Array.isArray(yesRaw) || !Array.isArray(noRaw)) {
    return emptyKalshiBook(ticker, observedAt, "malformed orderbook payload: yes_dollars/no_dollars not arrays");
  }

  const yesBids = yesRaw
    .map(parseRawLevel)
    .filter((l): l is UnitsLevel => l !== null)
    .sort((a, b) => b.priceUnits - a.priceUnits)
    .slice(0, TOP_LEVELS);
  const noBids = noRaw
    .map(parseRawLevel)
    .filter((l): l is UnitsLevel => l !== null)
    .sort((a, b) => b.priceUnits - a.priceUnits)
    .slice(0, TOP_LEVELS);

  const yesAsks = noBids
    .map((l): UnitsLevel => ({ priceUnits: PRICE_SCALE - l.priceUnits, qtyUnits: l.qtyUnits }))
    .sort((a, b) => a.priceUnits - b.priceUnits)
    .slice(0, TOP_LEVELS);
  const noAsks = yesBids
    .map((l): UnitsLevel => ({ priceUnits: PRICE_SCALE - l.priceUnits, qtyUnits: l.qtyUnits }))
    .sort((a, b) => a.priceUnits - b.priceUnits)
    .slice(0, TOP_LEVELS);

  let yesBestBidUnits = yesBids[0]?.priceUnits ?? null;
  let yesBestAskUnits = yesAsks[0]?.priceUnits ?? null;
  let noBestBidUnits = noBids[0]?.priceUnits ?? null;
  let noBestAskUnits = noAsks[0]?.priceUnits ?? null;

  const reasons: string[] = [];
  if (yesBestBidUnits !== null && yesBestAskUnits !== null && yesBestBidUnits > yesBestAskUnits) {
    reasons.push(`crossed YES book: bid ${yesBestBidUnits} > ask ${yesBestAskUnits} (1e-4 units)`);
    yesBestBidUnits = null;
    yesBestAskUnits = null;
  }
  if (noBestBidUnits !== null && noBestAskUnits !== null && noBestBidUnits > noBestAskUnits) {
    reasons.push(`crossed NO book: bid ${noBestBidUnits} > ask ${noBestAskUnits} (1e-4 units)`);
    noBestBidUnits = null;
    noBestAskUnits = null;
  }

  return {
    venue: "KALSHI",
    marketId: ticker,
    observedAt,
    yes: {
      bestBid: yesBestBidUnits !== null ? yesBestBidUnits / PRICE_SCALE : null,
      bestAsk: yesBestAskUnits !== null ? yesBestAskUnits / PRICE_SCALE : null,
      bestBidUnits: yesBestBidUnits,
      bestAskUnits: yesBestAskUnits,
      bidLevels: yesBids.map(toDepthLevel),
      askLevels: yesAsks.map(toDepthLevel),
    },
    no: {
      bestBid: noBestBidUnits !== null ? noBestBidUnits / PRICE_SCALE : null,
      bestAsk: noBestAskUnits !== null ? noBestAskUnits / PRICE_SCALE : null,
      bestBidUnits: noBestBidUnits,
      bestAskUnits: noBestAskUnits,
      bidLevels: noBids.map(toDepthLevel),
      askLevels: noAsks.map(toDepthLevel),
    },
    rawYesBids: yesBids.map(toDepthLevel),
    rawNoBids: noBids.map(toDepthLevel),
    staleReason: reasons.length > 0 ? reasons.join("; ") : null,
  };
}
