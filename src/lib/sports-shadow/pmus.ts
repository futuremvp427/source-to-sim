/**
 * Polymarket US sports-market discovery + book normalization — PURE logic only.
 *
 * Field shapes below were confirmed by live, read-only, unauthenticated requests to
 * https://gateway.polymarket.us during development (GET /v1/events, GET /v1/markets,
 * GET /v1/markets/{slug}/book) — not guessed. In particular: `sportsMarketType` uses a
 * granular, sport-prefixed vocabulary (e.g. "baseball_team_full_game_winner",
 * "baseball_team_first_five_spread", "baseball_player_home_runs") that DOES distinguish
 * full-game from F5/inning/prop/futures — unlike the coarser `sportsMarketTypeV2` field
 * ("SPORTS_MARKET_TYPE_MONEYLINE"/"SPORTS_MARKET_TYPE_SPREAD"/"SPORTS_MARKET_TYPE_TOTAL"),
 * which is used here only as a secondary cross-check. The /book endpoint's real levels are
 * `{px: {value: "0.4530"}, qty: "1.0000"}` under `bids`/`offers` (NOT `asks`) — confirmed by
 * a real open market's book payload, not assumed.
 */

import { normalizeTeamName } from "./team-normalization";
import type { BetType, BookSnapshot, DepthLevel, Venue } from "./types";

/* ------------------------------- Discovery ------------------------------- */

export type PmusRawTeam = {
  abbreviation?: string | null;
  name?: string | null;
  league?: string | null;
  /** "away" | "home" — present on marketSides[].team, confirmed live. */
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
  marketType?: string | null;
  /** Granular, sport-prefixed type. THE authoritative field for eligibility (see module doc). */
  sportsMarketType?: string | null;
  /** Coarse type, used only as a secondary cross-check — does not distinguish full-game/F5. */
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
  /** Stable numeric game identifier — confirmed present, critical for doubleheader disambiguation. */
  gameId?: number | string | null;
  active?: boolean | null;
  closed?: boolean | null;
  /** Event-level team pair, array order [away, home] per confirmed live data (cross-checked against title/marketSides ordering, never trusted alone). */
  teams?: PmusRawTeam[] | null;
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
  | "REJECT_UNSUPPORTED_MARKET_TYPE";

export type PmusUnverifiedReasonCode =
  | "UNVERIFIED_MISSING_LINE"
  | "UNVERIFIED_UNKNOWN_TEAM"
  | "UNVERIFIED_METADATA_MISSING"
  | "UNVERIFIED_CONFLICTING_METADATA";

export type PmusCandidateReasonCode = PmusEligibleReasonCode | PmusRejectReasonCode | PmusUnverifiedReasonCode;

export type PmusCandidateSide = {
  description: string | null;
  teamAbbreviation: string | null;
  long: boolean | null;
};

/**
 * One normalized PM-US market candidate. ONE candidate per MARKET (not per side) — Task 5
 * deliberately does not decide which side maps to the source-selected outcome; `sides`
 * preserves both raw sides for Task 7 to resolve. This is NOT an EXACT match determination
 * (that is Task 7's job) — only ELIGIBLE (structurally a full-game MLB ML/SPREAD/TOTAL),
 * UNSUPPORTED (positively something else — F5/prop/futures/etc.), or UNVERIFIED (evidence
 * insufficient or contradictory; never silently promoted to ELIGIBLE).
 */
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
  sides: PmusCandidateSide[];
};

/** Only these three confirmed-live, sport-prefixed types are Phase-1 eligible. Whitelist, not blacklist — anything else defaults to rejected/unsupported. */
const FULL_GAME_TYPE_MAP: Record<string, BetType> = {
  baseball_team_full_game_winner: "MONEYLINE",
  baseball_team_full_game_spread: "SPREAD",
  baseball_team_full_game_total: "TOTAL",
};

const EXPECTED_V2: Record<BetType, string> = {
  MONEYLINE: "SPORTS_MARKET_TYPE_MONEYLINE",
  SPREAD: "SPORTS_MARKET_TYPE_SPREAD",
  TOTAL: "SPORTS_MARKET_TYPE_TOTAL",
};

/** Confirmed-live non-full-game sportsMarketType values, for a more specific rejection reason than the generic fallback. Not exhaustive — anything unrecognized still rejects via REJECT_UNSUPPORTED_MARKET_TYPE. */
function classifyKnownExclusion(rawType: string): PmusRejectReasonCode {
  if (rawType.includes("first_five")) return "REJECT_F5";
  if (/inning\d/.test(rawType) || rawType.includes("first_inning")) return "REJECT_INNING";
  if (rawType.startsWith("baseball_player_")) return "REJECT_PROP";
  if (rawType === "futures" || rawType.includes("champ") || rawType.includes("division")) return "REJECT_FUTURE";
  if (rawType.includes("extra_innings")) return "REJECT_EXTRA_INNINGS";
  return "REJECT_UNSUPPORTED_MARKET_TYPE";
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
    sides: (market.marketSides ?? []).map((s) => ({
      description: s.description ?? null,
      teamAbbreviation: s.team?.abbreviation ?? null,
      long: s.long ?? null,
    })),
  };
}

/** Resolves the event's away/home team pair, preferring the moneyline market's explicit `team.ordering` (most reliable), falling back to the event-level `teams` array (order [away, home], only trusted when exactly two teams are present). Returns null when neither source can establish it. */
function resolveEventTeams(event: PmusRawEvent): { away: PmusRawTeam; home: PmusRawTeam } | null {
  const moneyline = (event.markets ?? []).find((m) => m.sportsMarketType === "baseball_team_full_game_winner");
  const sides = moneyline?.marketSides ?? [];
  const awaySide = sides.find((s) => s.team?.ordering === "away")?.team;
  const homeSide = sides.find((s) => s.team?.ordering === "home")?.team;
  if (awaySide && homeSide) return { away: awaySide, home: homeSide };

  const teams = event.teams ?? [];
  if (teams.length === 2 && teams[0] && teams[1]) return { away: teams[0], home: teams[1] };

  return null;
}

function unsupported(event: PmusRawEvent, market: PmusRawMarket, reasonCode: PmusRejectReasonCode, league: string | null): PmusCandidate {
  return { ...baseCandidate(event, market), status: "UNSUPPORTED", reasonCode, betType: null, league, awayTeam: null, homeTeam: null, line: null };
}

function unverified(event: PmusRawEvent, market: PmusRawMarket, reasonCode: PmusUnverifiedReasonCode, league: string | null): PmusCandidate {
  return { ...baseCandidate(event, market), status: "UNVERIFIED", reasonCode, betType: null, league, awayTeam: null, homeTeam: null, line: null };
}

/**
 * Normalizes one PM-US event's markets into candidates. MLB-only, full-game
 * MONEYLINE/SPREAD/TOTAL only classify as ELIGIBLE; every other market is UNSUPPORTED
 * (positively excluded) or UNVERIFIED (evidence insufficient/contradictory) — never
 * silently ELIGIBLE. Preserves gameId/eventId/eventSlug/marketId/marketSlug on every
 * candidate so two same-day games between the same teams (doubleheaders) remain distinct.
 */
export function eventToCandidates(event: PmusRawEvent): PmusCandidate[] {
  const markets = event.markets ?? [];
  if (markets.length === 0) return [];

  const teamPair = resolveEventTeams(event);
  const league = teamPair?.away.league?.toLowerCase() ?? teamPair?.home.league?.toLowerCase() ?? null;

  if (league !== null && league !== "mlb") {
    return markets.map((m) => unsupported(event, m, "REJECT_NON_MLB", league));
  }
  if (teamPair === null) {
    return markets.map((m) => unverified(event, m, "UNVERIFIED_METADATA_MISSING", null));
  }

  const awayCode = normalizeTeamName(teamPair.away.abbreviation ?? teamPair.away.name);
  const homeCode = normalizeTeamName(teamPair.home.abbreviation ?? teamPair.home.name);
  if (!awayCode || !homeCode) {
    return markets.map((m) => unverified(event, m, "UNVERIFIED_UNKNOWN_TEAM", league));
  }

  return markets.map((market) => {
    const rawType = market.sportsMarketType ?? null;
    const betType = rawType ? FULL_GAME_TYPE_MAP[rawType] : undefined;
    if (!betType) {
      const reasonCode = rawType ? classifyKnownExclusion(rawType) : "REJECT_UNSUPPORTED_MARKET_TYPE";
      return unsupported(event, market, reasonCode, league);
    }

    const v2 = market.sportsMarketTypeV2 ?? null;
    if (v2 !== null && v2 !== EXPECTED_V2[betType]) {
      return unverified(event, market, "UNVERIFIED_CONFLICTING_METADATA", league);
    }

    if (betType !== "MONEYLINE" && (market.line === null || market.line === undefined || !Number.isFinite(market.line))) {
      return unverified(event, market, "UNVERIFIED_MISSING_LINE", league);
    }

    // Cross-check this specific market's own team sides (when present, e.g. moneyline/spread)
    // against the event-level team pair — a mismatch is a genuine data anomaly, not a guess.
    if (betType !== "TOTAL") {
      const sideTeams = (market.marketSides ?? []).map((s) => s.team?.abbreviation ?? s.team?.name).filter((t): t is string => Boolean(t));
      const sideCodes = new Set(sideTeams.map((t) => normalizeTeamName(t)).filter((c): c is string => c !== null));
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
  /** Confirmed live field name — NOT "asks". */
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

/**
 * Pure normalizer for the real /v1/markets/{slug}/book payload shape (`marketData.bids`/
 * `marketData.offers`, each `{px:{value}, qty}`, string-encoded). Deliberately re-sorts
 * both sides (never trusts input order), derives bestBid/bestAsk from the sorted depth
 * (there is no separate top-level BBO field on this endpoint to reconcile against), retains
 * up to 5 levels per side without fabricating missing ones, and fails closed to an explicit
 * invalid snapshot (nulled bestBid/bestAsk, non-null staleReason) on a crossed book or any
 * malformed shape — never returns a fabricated tradable quote.
 */
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
