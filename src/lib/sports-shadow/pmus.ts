/**
 * Polymarket US sports-market discovery + book normalization — PURE logic only.
 *
 * The public PM-US Events API is already queried with category=sports by the server
 * layer. This module therefore classifies market STRUCTURE rather than hard-coding one
 * league: recognizable full-contest MONEYLINE/SPREAD/TOTAL markets may become candidates;
 * partial periods/maps/sets, props and futures continue to fail closed.
 */

import { inferSportsLeagueFromSlug, normalizeParticipantName } from "./participant-normalization";
import type { BetType, BookSnapshot, DepthLevel, Venue } from "./types";

/* ------------------------------- Discovery ------------------------------- */

export type PmusRawTeam = {
  abbreviation?: string | null;
  name?: string | null;
  league?: string | null;
  ordering?: string | null;
};

export type PmusRawMarketSide = {
  description?: string | null;
  price?: string | null;
  long?: boolean | null;
  team?: PmusRawTeam | null;
};

export type PmusRawMarket = {
  id?: string | number | null;
  slug?: string | null;
  question?: string | null;
  description?: string | null;
  marketType?: string | null;
  sportsMarketType?: string | null;
  sportsMarketTypeV2?: string | null;
  line?: number | null;
  status?: string | null;
  active?: boolean | null;
  closed?: boolean | null;
  gameStartTime?: string | null;
  marketSides?: PmusRawMarketSide[] | null;
};

export type PmusRawEvent = {
  id?: string | number | null;
  slug?: string | null;
  title?: string | null;
  startTime?: string | null;
  gameId?: number | string | null;
  active?: boolean | null;
  closed?: boolean | null;
  teams?: PmusRawTeam[] | null;
  participants?: PmusRawTeam[] | null;
  markets?: PmusRawMarket[] | null;
};

export type PmusCandidateStatus = "ELIGIBLE" | "UNSUPPORTED" | "UNVERIFIED";
export type PmusEligibleReasonCode = "ELIGIBLE_FULL_GAME_MONEYLINE" | "ELIGIBLE_FULL_GAME_SPREAD" | "ELIGIBLE_FULL_GAME_TOTAL";

export type PmusRejectReasonCode =
  | "REJECT_NON_MLB"
  | "REJECT_F5"
  | "REJECT_INNING"
  | "REJECT_PROP"
  | "REJECT_FUTURE"
  | "REJECT_EXTRA_INNINGS"
  | "REJECT_PARTIAL_CONTEST"
  | "REJECT_UNSUPPORTED_MARKET_TYPE";

export type PmusUnverifiedReasonCode =
  | "UNVERIFIED_MISSING_LINE"
  | "UNVERIFIED_UNKNOWN_TEAM"
  | "UNVERIFIED_METADATA_MISSING"
  | "UNVERIFIED_CONFLICTING_METADATA";

export type PmusCandidateReasonCode = PmusEligibleReasonCode | PmusRejectReasonCode | PmusUnverifiedReasonCode;

export type PmusCandidateSide = {
  description: string | null;
  /**
   * Historical field name retained for resolver compatibility. It now prefers the full
   * participant name when available, because generic sports cannot safely map a provider
   * abbreviation without a league-specific alias table. MLB full names still normalize
   * to the same audited codes through normalizeTeamName in resolver.ts.
   */
  teamAbbreviation: string | null;
  /** Runtime normalization populates this when provider metadata supplies a full name.
   * Optional for compatibility with older resolver fixtures/callers that predate the field.
   */
  teamName?: string | null;
  long: boolean | null;
};

export type PmusCandidate = {
  status: PmusCandidateStatus;
  reasonCode: PmusCandidateReasonCode;
  betType: BetType | null;
  eventId: string | null;
  eventSlug: string | null;
  gameId: string | null;
  marketId: string | null;
  marketSlug: string | null;
  scheduledStartAt: string | null;
  league: string | null;
  awayTeam: string | null;
  homeTeam: string | null;
  line: number | null;
  active: boolean | null;
  closed: boolean | null;
  marketStatus: string | null;
  question: string | null;
  rulesDescription: string | null;
  sides: PmusCandidateSide[];
};

const FULL_GAME_TYPE_MAP: Record<string, BetType> = {
  baseball_team_full_game_winner: "MONEYLINE",
  baseball_team_full_game_spread: "SPREAD",
  baseball_team_full_game_total: "TOTAL",
};

const V2_TO_BET_TYPE: Record<string, BetType> = {
  SPORTS_MARKET_TYPE_MONEYLINE: "MONEYLINE",
  SPORTS_MARKET_TYPE_SPREAD: "SPREAD",
  SPORTS_MARKET_TYPE_TOTAL: "TOTAL",
};

const EXPECTED_V2: Record<BetType, string> = {
  MONEYLINE: "SPORTS_MARKET_TYPE_MONEYLINE",
  SPREAD: "SPORTS_MARKET_TYPE_SPREAD",
  TOTAL: "SPORTS_MARKET_TYPE_TOTAL",
};

const PARTIAL_TEXT = /\bmap\s*\d+\b|\bset\s*\d+\b|\b(first|second|1st|2nd)\s+half\b|\b(1st|first|2nd|second|3rd|third|4th|fourth)\s+(quarter|period)\b|\bq[1-4]\b/i;
const PARTIAL_TYPE = /first[_-]?five|inning|quarter|period|(?:^|[_-])half(?:$|[_-])|(?:^|[_-])map\d*|(?:^|[_-])set\d*|first[_-]?set|first[_-]?map/i;

function classifyKnownExclusion(rawType: string, market: PmusRawMarket): PmusRejectReasonCode | null {
  const lower = rawType.toLowerCase();
  const text = `${market.question ?? ""} ${market.slug ?? ""} ${lower}`;
  if (lower.includes("first_five")) return "REJECT_F5";
  if (/inning\d|first_inning/.test(lower)) return "REJECT_INNING";
  if (lower.includes("player_") || lower.includes("prop") || market.sportsMarketTypeV2 === "SPORTS_MARKET_TYPE_PROP") return "REJECT_PROP";
  if (lower === "futures" || /champ|season|division|conference|series_winner/.test(lower)) return "REJECT_FUTURE";
  if (lower.includes("extra_innings")) return "REJECT_EXTRA_INNINGS";
  if (PARTIAL_TYPE.test(lower) || PARTIAL_TEXT.test(text)) return "REJECT_PARTIAL_CONTEST";
  return null;
}

function baseCandidate(event: PmusRawEvent, market: PmusRawMarket): Omit<PmusCandidate, "status" | "reasonCode" | "betType" | "league" | "awayTeam" | "homeTeam" | "line"> {
  return {
    eventId: event.id !== null && event.id !== undefined ? String(event.id) : null,
    eventSlug: event.slug ?? null,
    gameId: event.gameId !== null && event.gameId !== undefined ? String(event.gameId) : null,
    marketId: market.id !== null && market.id !== undefined ? String(market.id) : null,
    marketSlug: market.slug ?? null,
    scheduledStartAt: market.gameStartTime ?? event.startTime ?? null,
    active: market.active ?? null,
    closed: market.closed ?? null,
    marketStatus: market.status ?? null,
    question: market.question ?? null,
    rulesDescription: market.description ?? null,
    sides: (market.marketSides ?? []).map((s) => ({
      description: s.description ?? null,
      teamAbbreviation: s.team?.name ?? s.team?.abbreviation ?? null,
      teamName: s.team?.name ?? null,
      long: s.long ?? null,
    })),
  };
}

function resolveEventTeams(event: PmusRawEvent): { away: PmusRawTeam; home: PmusRawTeam } | null {
  const moneyline = (event.markets ?? []).find((m) => m.sportsMarketTypeV2 === "SPORTS_MARKET_TYPE_MONEYLINE");
  const sides = moneyline?.marketSides ?? [];
  const awaySide = sides.find((s) => s.team?.ordering === "away")?.team;
  const homeSide = sides.find((s) => s.team?.ordering === "home")?.team;
  if (awaySide && homeSide) return { away: awaySide, home: homeSide };

  const participants = event.teams ?? event.participants ?? [];
  const orderedAway = participants.find((t) => t.ordering === "away");
  const orderedHome = participants.find((t) => t.ordering === "home");
  if (orderedAway && orderedHome) return { away: orderedAway, home: orderedHome };
  if (participants.length === 2 && participants[0] && participants[1]) return { away: participants[0], home: participants[1] };
  return null;
}

function unsupported(event: PmusRawEvent, market: PmusRawMarket, reasonCode: PmusRejectReasonCode, league: string | null): PmusCandidate {
  return { ...baseCandidate(event, market), status: "UNSUPPORTED", reasonCode, betType: null, league, awayTeam: null, homeTeam: null, line: null };
}

function unverified(event: PmusRawEvent, market: PmusRawMarket, reasonCode: PmusUnverifiedReasonCode, league: string | null): PmusCandidate {
  return { ...baseCandidate(event, market), status: "UNVERIFIED", reasonCode, betType: null, league, awayTeam: null, homeTeam: null, line: null };
}

function marketBetType(market: PmusRawMarket): { betType: BetType | null; rejection: PmusRejectReasonCode | null } {
  const rawType = market.sportsMarketType?.toLowerCase() ?? null;
  if (rawType) {
    const exclusion = classifyKnownExclusion(rawType, market);
    if (exclusion) return { betType: null, rejection: exclusion };
    const exact = FULL_GAME_TYPE_MAP[rawType];
    if (exact) return { betType: exact, rejection: null };
  }
  const v2 = market.sportsMarketTypeV2 ?? null;
  const fromV2 = v2 ? V2_TO_BET_TYPE[v2] : undefined;
  if (fromV2) return { betType: fromV2, rejection: null };
  return { betType: null, rejection: "REJECT_UNSUPPORTED_MARKET_TYPE" };
}

export function eventToCandidates(event: PmusRawEvent): PmusCandidate[] {
  const markets = event.markets ?? [];
  if (markets.length === 0) return [];

  const teamPair = resolveEventTeams(event);
  const league =
    teamPair?.away.league?.toLowerCase() ??
    teamPair?.home.league?.toLowerCase() ??
    inferSportsLeagueFromSlug(event.slug) ??
    inferSportsLeagueFromSlug(markets[0]?.slug) ??
    null;

  if (!league) return markets.map((m) => unverified(event, m, "UNVERIFIED_METADATA_MISSING", null));
  if (teamPair === null) return markets.map((m) => unverified(event, m, "UNVERIFIED_METADATA_MISSING", league));
  const awayCode = normalizeParticipantName(teamPair.away.name ?? teamPair.away.abbreviation, league);
  const homeCode = normalizeParticipantName(teamPair.home.name ?? teamPair.home.abbreviation, league);
  if (!awayCode || !homeCode) return markets.map((m) => unverified(event, m, "UNVERIFIED_UNKNOWN_TEAM", league));

  return markets.map((market) => {
    const rawType = market.sportsMarketType?.toLowerCase() ?? "";
    if (league !== "mlb" && rawType.startsWith("baseball_")) return unsupported(event, market, "REJECT_NON_MLB", league);

    const { betType, rejection } = marketBetType(market);
    if (!betType) return unsupported(event, market, rejection ?? "REJECT_UNSUPPORTED_MARKET_TYPE", league);

    const v2 = market.sportsMarketTypeV2 ?? null;
    if (v2 !== null && v2 !== EXPECTED_V2[betType]) return unverified(event, market, "UNVERIFIED_CONFLICTING_METADATA", league);

    if (betType !== "MONEYLINE" && (market.line === null || market.line === undefined || !Number.isFinite(market.line))) {
      return unverified(event, market, "UNVERIFIED_MISSING_LINE", league);
    }

    if (betType !== "TOTAL") {
      const sideCodes = new Set(
        (market.marketSides ?? [])
          .map((s) => normalizeParticipantName(s.team?.name ?? s.team?.abbreviation, league))
          .filter((c): c is string => c !== null),
      );
      if (sideCodes.size > 0 && (!sideCodes.has(awayCode) || !sideCodes.has(homeCode))) {
        return unverified(event, market, "UNVERIFIED_CONFLICTING_METADATA", league);
      }
    }

    const reasonCode: PmusEligibleReasonCode =
      betType === "MONEYLINE" ? "ELIGIBLE_FULL_GAME_MONEYLINE" : betType === "SPREAD" ? "ELIGIBLE_FULL_GAME_SPREAD" : "ELIGIBLE_FULL_GAME_TOTAL";

    return {
      ...baseCandidate(event, market),
      status: "ELIGIBLE",
      reasonCode,
      betType,
      league,
      awayTeam: awayCode,
      homeTeam: homeCode,
      line: betType === "MONEYLINE" ? null : (market.line ?? null),
    };
  });
}

/* ---------------------------- Book normalization ---------------------------- */

export type PmusRawBookLevel = { px?: { value?: string | null } | null; qty?: string | null };
export type PmusRawBookData = {
  marketSlug?: string | null;
  bids?: PmusRawBookLevel[] | null;
  offers?: PmusRawBookLevel[] | null;
  state?: string | null;
  transactTime?: string | null;
};
export type PmusRawBookResponse = { marketData?: PmusRawBookData | null };

const PMUS_VENUE: Venue = "PMUS";
const TOP_LEVELS = 5;
const PRICE_MIN_EXCLUSIVE = 0;
const PRICE_MAX_INCLUSIVE = 1;

function parseLevel(raw: PmusRawBookLevel): DepthLevel | null {
  const priceStr = raw.px?.value;
  const qtyStr = raw.qty;
  if (priceStr === undefined || priceStr === null || qtyStr === undefined || qtyStr === null) return null;
  const price = Number(priceStr);
  const size = Number(qtyStr);
  if (!Number.isFinite(price) || price <= PRICE_MIN_EXCLUSIVE || price > PRICE_MAX_INCLUSIVE) return null;
  if (!Number.isFinite(size) || size <= 0) return null;
  return { price, size };
}

function emptySnapshot(marketSlug: string, observedAt: number, marketStatus: string | null, staleReason: string): BookSnapshot {
  return { venue: PMUS_VENUE, marketId: marketSlug, bestBid: null, bestAsk: null, bidLevels: [], askLevels: [], marketStatus, observedAt, staleReason };
}

export function normalizePmusBook(raw: unknown, marketSlug: string, observedAt: number): BookSnapshot {
  if (typeof raw !== "object" || raw === null) return emptySnapshot(marketSlug, observedAt, null, "malformed book payload: not an object");
  const marketData = (raw as PmusRawBookResponse).marketData;
  if (!marketData || typeof marketData !== "object") return emptySnapshot(marketSlug, observedAt, null, "malformed book payload: missing marketData");
  if (!Array.isArray(marketData.bids) || !Array.isArray(marketData.offers)) {
    return emptySnapshot(marketSlug, observedAt, marketData.state ?? null, "malformed book payload: bids/offers not arrays");
  }

  const bidLevels = marketData.bids
    .map(parseLevel)
    .filter((l): l is DepthLevel => l !== null)
    .sort((a, b) => b.price - a.price)
    .slice(0, TOP_LEVELS);
  const askLevels = marketData.offers
    .map(parseLevel)
    .filter((l): l is DepthLevel => l !== null)
    .sort((a, b) => a.price - b.price)
    .slice(0, TOP_LEVELS);

  let bestBid = bidLevels[0]?.price ?? null;
  let bestAsk = askLevels[0]?.price ?? null;
  let staleReason: string | null = null;
  if (bestBid !== null && bestAsk !== null && bestBid >= bestAsk) {
    staleReason = `crossed book: best bid ${bestBid} >= best ask ${bestAsk}`;
    bestBid = null;
    bestAsk = null;
  }

  return {
    venue: PMUS_VENUE,
    marketId: marketSlug,
    bestBid,
    bestAsk,
    bidLevels,
    askLevels,
    marketStatus: marketData.state ?? null,
    observedAt,
    staleReason,
  };
}
