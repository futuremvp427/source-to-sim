import { inferSportsLeagueFromSlug, normalizeParticipantName, parseVersusParticipants } from "./participant-normalization";
import { normalizeTeamName } from "./team-normalization";
import type { BetType, ClassificationStatus } from "./types";

export type GammaMarketTeam = { name?: string | null; ordering?: string | null };
export type GammaMarketEvent = { sport?: { sport?: string | null } | null; teams?: GammaMarketTeam[] | null };
export type GammaMarket = {
  slug: string | null;
  question: string | null;
  groupItemTitle: string | null;
  /** Structured bet-type field as returned by gamma-api. */
  sportsMarketType: string | null;
  line: number | null;
  events: GammaMarketEvent[] | null;
};

export type EligibleReasonCode = "ELIGIBLE_FULL_GAME_MONEYLINE" | "ELIGIBLE_FULL_GAME_SPREAD" | "ELIGIBLE_FULL_GAME_TOTAL";

/**
 * REJECT_NON_MLB / REJECT_ESPORTS are retained in the persisted vocabulary for backward
 * compatibility with historical epochs. The sport-agnostic classifier no longer emits
 * them merely because a league is non-MLB; it rejects market STRUCTURE instead.
 */
export type RejectReasonCode =
  | "REJECT_NON_MLB"
  | "REJECT_PROP"
  | "REJECT_F5"
  | "REJECT_INNING"
  | "REJECT_FUTURE"
  | "REJECT_PARLAY"
  | "REJECT_ESPORTS"
  | "REJECT_EXOTIC"
  | "REJECT_TEAM_TOTAL"
  | "REJECT_PARTIAL_CONTEST"
  | "REJECT_UNSUPPORTED_MARKET_TYPE";

export type UnverifiedReasonCode =
  | "UNVERIFIED_METADATA_MISSING"
  | "UNVERIFIED_AMBIGUOUS_PERIOD"
  | "UNVERIFIED_PARSE_FAILURE"
  | "UNVERIFIED_CONFLICTING_METADATA"
  | "UNVERIFIED_UNKNOWN_TEAM"
  | "UNVERIFIED_MISSING_LINE"
  | "UNVERIFIED_FETCH_FAILED"
  | "UNVERIFIED_EMPTY_RESPONSE"
  | "UNVERIFIED_MALFORMED_RESPONSE";

export type ReasonCode = EligibleReasonCode | RejectReasonCode | UnverifiedReasonCode;
export type UnverifiedDisposition = "RETRYABLE" | "TERMINAL";

export function classifyUnverifiedDisposition(reasonCode: UnverifiedReasonCode): UnverifiedDisposition {
  switch (reasonCode) {
    case "UNVERIFIED_FETCH_FAILED":
    case "UNVERIFIED_EMPTY_RESPONSE":
    case "UNVERIFIED_MALFORMED_RESPONSE":
      return "RETRYABLE";
    case "UNVERIFIED_METADATA_MISSING":
    case "UNVERIFIED_AMBIGUOUS_PERIOD":
    case "UNVERIFIED_PARSE_FAILURE":
    case "UNVERIFIED_CONFLICTING_METADATA":
    case "UNVERIFIED_UNKNOWN_TEAM":
    case "UNVERIFIED_MISSING_LINE":
      return "TERMINAL";
  }
}

export type ClassificationResult = {
  status: ClassificationStatus;
  /** Structured/fallback league token used for participant normalization and durable signal attribution. */
  league: string | null;
  betType: BetType | null;
  line: number | null;
  awayTeam: string | null;
  homeTeam: string | null;
  reasonCode: ReasonCode;
  reason: string;
};

const ESPORTS_LEAGUES = new Set(["esports", "lol", "leagueoflegends", "valorant", "val", "cs", "csgo", "cs2", "dota", "dota2"]);
const TENNIS_LEAGUES = new Set(["tennis", "atp", "wta"]);

// Positive exclusions are intentionally sport-structure based. A new league can be
// accepted without a deployment, but a map/set/period/prop/future cannot silently become
// a full-contest signal simply because its parent event is a sport.
const F5_PATTERN = /first\s*5\b|first\s*five|\bf5\b|1st\s*5\b|5\s*innings/i;
const ORDINAL_INNING_PATTERN = /\b(1st|first|2nd|second|3rd|third)\s+inning\b/i;
const PARTIAL_INNING_COUNT_PATTERN = /\bfirst\s*(3|7)\b/i;
const AMBIGUOUS_PERIOD_PATTERN = /\bthrough\s*\d+\s*innings?\b|\b\d+\s*innings?\b/i;
const MAP_PATTERN = /\bmap\s*\d+\b|(?:^|[-_])map\d+(?:$|[-_])/i;
const SET_PATTERN = /\bset\s*\d+\b|(?:^|[-_])set\d+(?:$|[-_])/i;
const PERIOD_PATTERN = /\b(first|second|1st|2nd)\s+half\b|\b(1st|first|2nd|second|3rd|third|4th|fourth)\s+(quarter|period)\b|\bq[1-4]\b/i;
const ESPORTS_GAME_PATTERN = /\bgame\s*\d+\b|(?:^|[-_])game\d+(?:$|[-_])/i;
const PROP_PATTERN = /\bplayer\s*prop\b|\bhome\s*runs?\b|\bstrikeouts?\b|\brbis?\b|\btotal\s*bases\b/i;
const FUTURE_PATTERN = /\bfutures?\b|\bchampion(ship)?\b|\bseries\s*winner\b|\bseason\s+winner\b|\bto\s+win\s+the\s+(league|division|conference|pennant|world\s*series)\b/i;
const PARLAY_PATTERN = /\bparlay\b|\bcombo\b|\bcombination\s*bet\b/i;
const EXOTIC_PATTERN = /\bexact\s*score\b|\balternate\b|\bwinning\s+margin\b/i;
const TEAM_TOTAL_PATTERN = /\bteam\s*total\b/i;

const SPORTS_MARKET_TYPE_TO_BET_TYPE: Record<string, BetType> = {
  moneyline: "MONEYLINE",
  spread: "SPREAD",
  spreads: "SPREAD",
  total: "TOTAL",
  totals: "TOTAL",
};

function combinedText(market: GammaMarket): string {
  return `${market.question ?? ""} ${market.slug ?? ""} ${market.groupItemTitle ?? ""}`;
}

function eligible(league: string, betType: BetType, line: number | null, awayTeam: string, homeTeam: string): ClassificationResult {
  const reasonCode: EligibleReasonCode =
    betType === "MONEYLINE" ? "ELIGIBLE_FULL_GAME_MONEYLINE" : betType === "SPREAD" ? "ELIGIBLE_FULL_GAME_SPREAD" : "ELIGIBLE_FULL_GAME_TOTAL";
  return {
    status: "ELIGIBLE",
    league,
    betType,
    line: betType === "MONEYLINE" ? null : line,
    awayTeam,
    homeTeam,
    reasonCode,
    reason: `full-contest ${league} ${betType.toLowerCase()}`,
  };
}

function rejected(league: string | null, reasonCode: RejectReasonCode, reason: string): ClassificationResult {
  return { status: "INELIGIBLE", league, betType: null, line: null, awayTeam: null, homeTeam: null, reasonCode, reason };
}

function unverified(league: string | null, reasonCode: UnverifiedReasonCode, reason: string): ClassificationResult {
  return { status: "UNVERIFIED", league, betType: null, line: null, awayTeam: null, homeTeam: null, reasonCode, reason };
}

function parseLineToken(token: string | undefined | null): number | null {
  if (!token) return null;
  const m = token.match(/^(\d+)pt(\d+)$/i);
  if (!m) return null;
  return Number(`${m[1]}.${m[2]}`);
}

/** Conservative generic slug fallback, used only when sportsMarketType is absent. */
function parseBetTypeFromSlug(slug: string): { betType: BetType; line: number | null } | null {
  const spreadMatch = slug.match(/-spread-(?:home|away)-(\d+pt\d+)/i);
  if (spreadMatch) return { betType: "SPREAD", line: parseLineToken(spreadMatch[1]) };
  const totalMatch = slug.match(/-total-(\d+pt\d+)/i);
  if (totalMatch) return { betType: "TOTAL", line: parseLineToken(totalMatch[1]) };
  // Canonical event-level winner slugs observed across sports use a sport/league prefix
  // and terminate in YYYY-MM-DD. Any derivative suffix must fail this exact ending test.
  if (/^[a-z0-9]+-.+-\d{4}-\d{2}-\d{2}$/i.test(slug)) return { betType: "MONEYLINE", line: null };
  return null;
}

function parseLineFromSlugForConflictCheck(slug: string, betType: BetType): number | null {
  if (betType === "SPREAD") return parseLineToken(slug.match(/-spread-(?:home|away)-(\d+pt\d+)/i)?.[1]);
  if (betType === "TOTAL") return parseLineToken(slug.match(/-total-(\d+pt\d+)/i)?.[1]);
  return null;
}

/** MLB keeps the prior strict slug/team cross-check; generic slugs often use short aliases that are not safe to equate with full participant names. */
function parseMlbTeamTokensFromSlug(slug: string): { away: string; home: string } | null {
  const m = slug.match(/^mlb-([a-z0-9]+)-([a-z0-9]+)-\d{4}-\d{2}-\d{2}/i);
  if (!m || !m[1] || !m[2]) return null;
  return { away: m[1], home: m[2] };
}

function resolveParticipantPair(market: GammaMarket, league: string): { away: string; home: string } | null {
  const teams = market.events?.[0]?.teams ?? [];
  const orderedAway = teams.find((t) => t.ordering === "away")?.name ?? null;
  const orderedHome = teams.find((t) => t.ordering === "home")?.name ?? null;
  if (orderedAway && orderedHome) {
    const away = normalizeParticipantName(orderedAway, league);
    const home = normalizeParticipantName(orderedHome, league);
    return away && home ? { away, home } : null;
  }

  // Some individual-sport Gamma events do not attach ordered team objects. The market
  // question/title still names the two competitors. This parser is intentionally limited
  // to the explicit "A vs B" shape and never guesses from arbitrary prose.
  const parsed = parseVersusParticipants(market.question ?? market.groupItemTitle);
  if (parsed) {
    const away = normalizeParticipantName(parsed.away, league);
    const home = normalizeParticipantName(parsed.home, league);
    if (away && home) return { away, home };
  }

  // Last structured fallback: exactly two named participants, preserving provider order.
  if (teams.length === 2 && teams[0]?.name && teams[1]?.name) {
    const away = normalizeParticipantName(teams[0].name, league);
    const home = normalizeParticipantName(teams[1].name, league);
    return away && home ? { away, home } : null;
  }
  return null;
}

/**
 * Sport-agnostic source classifier. It accepts recognizable full-contest MONEYLINE /
 * SPREAD / TOTAL markets for any sport/league while continuing to fail closed on partial
 * periods, maps, sets, props, futures, parlays, exotics, missing lines, and ambiguous
 * participant identity. Structured metadata is preferred; a canonical sport-prefixed
 * slug is a fallback when Gamma omits the structured sport field.
 */
export function classifyGammaMarket(market: GammaMarket): ClassificationResult {
  const text = combinedText(market);
  const structuredLeague = market.events?.[0]?.sport?.sport?.trim().toLowerCase() ?? null;
  const league = structuredLeague || inferSportsLeagueFromSlug(market.slug);
  if (!league) return unverified(null, "UNVERIFIED_METADATA_MISSING", "no structured sport/league and no canonical sports slug prefix");

  if (F5_PATTERN.test(text)) return rejected(league, "REJECT_F5", "first-five-innings market excluded");
  if (ORDINAL_INNING_PATTERN.test(text) || PARTIAL_INNING_COUNT_PATTERN.test(text)) return rejected(league, "REJECT_INNING", "single-inning/partial-inning market excluded");
  if (MAP_PATTERN.test(text)) return rejected(league, "REJECT_PARTIAL_CONTEST", "map-level market excluded");
  if (TENNIS_LEAGUES.has(league) && SET_PATTERN.test(text)) return rejected(league, "REJECT_PARTIAL_CONTEST", "set-level market excluded");
  if (PERIOD_PATTERN.test(text)) return rejected(league, "REJECT_PARTIAL_CONTEST", "partial-period market excluded");
  if (ESPORTS_LEAGUES.has(league) && ESPORTS_GAME_PATTERN.test(text)) return rejected(league, "REJECT_PARTIAL_CONTEST", "single-game esports market excluded");
  if (market.sportsMarketType?.toLowerCase().includes("prop") || PROP_PATTERN.test(text)) return rejected(league, "REJECT_PROP", "player/prop market excluded");
  if (FUTURE_PATTERN.test(text) || market.sportsMarketType === "futures") return rejected(league, "REJECT_FUTURE", "futures/season/series market excluded");
  if (PARLAY_PATTERN.test(text) || market.sportsMarketType === "parlay") return rejected(league, "REJECT_PARLAY", "parlay/combo market excluded");
  if (EXOTIC_PATTERN.test(text)) return rejected(league, "REJECT_EXOTIC", "exotic/alternate derivative market excluded");
  if (TEAM_TOTAL_PATTERN.test(text) || market.sportsMarketType === "team_total") return rejected(league, "REJECT_TEAM_TOTAL", "team-total market excluded");
  if (AMBIGUOUS_PERIOD_PATTERN.test(text)) return unverified(league, "UNVERIFIED_AMBIGUOUS_PERIOD", "text references a partial period that cannot be conclusively classified");

  let betType: BetType | undefined = market.sportsMarketType ? SPORTS_MARKET_TYPE_TO_BET_TYPE[market.sportsMarketType.toLowerCase()] : undefined;
  let fallbackLine: number | null = null;
  if (!betType) {
    if (market.sportsMarketType) {
      return rejected(league, "REJECT_UNSUPPORTED_MARKET_TYPE", `sportsMarketType '${market.sportsMarketType}' is not an eligible full-contest bet type`);
    }
    if (!market.slug) return unverified(league, "UNVERIFIED_METADATA_MISSING", "no sportsMarketType and no slug to fall back on");
    const fallback = parseBetTypeFromSlug(market.slug);
    if (!fallback) return unverified(league, "UNVERIFIED_PARSE_FAILURE", `slug '${market.slug}' did not match a known full-contest market shape`);
    betType = fallback.betType;
    fallbackLine = fallback.line;
  }

  const line = market.line ?? fallbackLine;
  if (betType !== "MONEYLINE" && line == null) {
    return unverified(league, "UNVERIFIED_MISSING_LINE", `${betType} market has no numeric line available from any source`);
  }

  if (market.line != null && market.slug && betType !== "MONEYLINE") {
    const slugLine = parseLineFromSlugForConflictCheck(market.slug, betType);
    if (slugLine != null && Math.abs(Math.abs(market.line) - slugLine) > 0.01) {
      return unverified(league, "UNVERIFIED_CONFLICTING_METADATA", `structured line ${market.line} conflicts with slug-derived line ${slugLine}`);
    }
  }

  const pair = resolveParticipantPair(market, league);
  if (!pair) return unverified(league, "UNVERIFIED_UNKNOWN_TEAM", "the two contest participants could not be normalized without guessing");

  // Preserve the old audited MLB structured-vs-slug identity conflict check. Generic
  // sport slugs often contain provider abbreviations rather than full names, so applying
  // the same comparison outside MLB would create false conflicts rather than safety.
  if (league === "mlb" && market.slug) {
    const slugTeams = parseMlbTeamTokensFromSlug(market.slug);
    if (slugTeams) {
      const slugAwayCode = normalizeTeamName(slugTeams.away);
      const slugHomeCode = normalizeTeamName(slugTeams.home);
      if (slugAwayCode && slugHomeCode && (slugAwayCode !== pair.away || slugHomeCode !== pair.home)) {
        return unverified(
          league,
          "UNVERIFIED_CONFLICTING_METADATA",
          `structured teams ${pair.away}@${pair.home} conflict with slug-derived teams ${slugAwayCode}@${slugHomeCode}`,
        );
      }
    }
  }

  return eligible(league, betType, line, pair.away, pair.home);
}
