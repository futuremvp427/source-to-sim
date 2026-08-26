/**
 * Sport-agnostic adapter registry for the Sports Shadow pipeline.
 *
 * The orchestration (source fill -> league identification -> full-contest classification ->
 * participant normalization -> target discovery -> compatibility proof -> observation ->
 * paper copy) is generic. Everything that genuinely differs per sport (canonical slug
 * shapes, audited team-code tables, venue catalog endpoints/series) lives in ONE adapter
 * per league here, so a new sport is added by registering an adapter rather than by editing
 * the pipeline.
 *
 * Fail-closed invariants:
 * - A league with no registered adapter is still classifiable (structured provider metadata
 *   remains authoritative), but it gets NO slug-derived participant fallback and NO venue
 *   discovery — it can never reach a paper copy by guessing.
 * - `canonicalSlugParticipants` is only allowed to return an identity it can prove from an
 *   audited per-sport code table. Unknown codes return null, which callers turn into
 *   UNVERIFIED_UNKNOWN_TEAM.
 * - Venue support flags are set only for venues whose candidate parser has been verified
 *   for that sport. A known-but-unverified series (e.g. Kalshi's KXNBAGAME) is recorded as
 *   documentation only and is NOT queried.
 */

import { normalizeMlbTeamName, normalizeWnbaTeamName } from "./team-normalization";
import type { BetType } from "./types";

export type CanonicalSlugParticipants = { away: string; home: string; betType: BetType; line: number | null };

export type SportAdapter = {
  /** Canonical lowercase league token as produced by structured metadata or slug inference. */
  league: string;
  /** Label persisted on signals/positions. */
  displayLeague: string;
  /** Human sport family, used for reporting only. */
  sport: string;
  /**
   * PM-US catalog path segment for `/v2/leagues/<segment>/events`, or null when PM-US has no
   * proven per-league catalog for this sport.
   */
  pmusLeaguePath: string | null;
  /** Kalshi series tickers this project's Kalshi candidate parser is VERIFIED against. */
  kalshiSeries: readonly string[];
  /** Kalshi series known to exist upstream but not yet verified by our parser (never queried). */
  kalshiSeriesUnverified: readonly string[];
  /**
   * Audited canonical source-slug participant parser for FULL-CONTEST markets only.
   * Null when this sport has no audited slug grammar; callers then require structured
   * provider participants.
   */
  canonicalSlugParticipants: ((slug: string) => CanonicalSlugParticipants | null) | null;
  /**
   * Matches slugs that LOOK like this sport's canonical full-contest grammar. Used to tell
   * "this is a canonical slug whose team codes we could not resolve" (fail closed as
   * UNVERIFIED_UNKNOWN_TEAM) apart from "this slug is simply not canonical".
   */
  canonicalSlugShape: RegExp | null;
};

function parseLineToken(token: string | undefined | null): number | null {
  if (!token) return null;
  const m = token.match(/^(\d+)pt(\d+)$/i);
  if (!m) return null;
  return Number(`${m[1]}.${m[2]}`);
}

/**
 * Shared canonical Polymarket sports slug grammar:
 *   <league>-<away>-<home>-YYYY-MM-DD
 *   <league>-<away>-<home>-YYYY-MM-DD-spread-(home|away)-<line>
 *   <league>-<away>-<home>-YYYY-MM-DD-total-<line>
 *
 * Intentionally rejects every derivative tail (player props, F5/innings, quarters/halves,
 * sets, maps, team totals, futures, parlays). The per-sport adapter supplies the team-code
 * resolver, so this grammar can never invent an identity for a sport without an audited
 * table.
 */
function canonicalFullContestSlugParser(
  league: string,
  resolveCode: (raw: string) => string | null,
): (slug: string) => CanonicalSlugParticipants | null {
  const pattern = new RegExp(
    `^${league}-([a-z0-9]+)-([a-z0-9]+)-(\\d{4}-\\d{2}-\\d{2})(?:-(spread)-(?:home|away)-(\\d+pt\\d+)|-(total)-(\\d+pt\\d+))?$`,
    "i",
  );
  return (slug: string) => {
    const m = slug.match(pattern);
    if (!m || !m[1] || !m[2]) return null;
    const away = resolveCode(m[1]);
    const home = resolveCode(m[2]);
    if (!away || !home) return null;
    if (m[4] === "spread") return { away, home, betType: "SPREAD", line: parseLineToken(m[5]) };
    if (m[6] === "total") return { away, home, betType: "TOTAL", line: parseLineToken(m[7]) };
    return { away, home, betType: "MONEYLINE", line: null };
  };
}

function canonicalSlugShape(league: string): RegExp {
  return new RegExp(`^${league}-[a-z0-9]+-[a-z0-9]+-\\d{4}-\\d{2}-\\d{2}(?:$|-spread-|-total-)`, "i");
}

function adapter(partial: Omit<SportAdapter, "kalshiSeries" | "kalshiSeriesUnverified" | "canonicalSlugParticipants" | "canonicalSlugShape"> & Partial<SportAdapter>): SportAdapter {
  return {
    kalshiSeries: [],
    kalshiSeriesUnverified: [],
    canonicalSlugParticipants: null,
    canonicalSlugShape: null,
    ...partial,
  };
}

const ADAPTERS: SportAdapter[] = [
  adapter({
    league: "mlb",
    displayLeague: "MLB",
    sport: "baseball",
    pmusLeaguePath: "mlb",
    kalshiSeries: ["KXMLBGAME", "KXMLBSPREAD", "KXMLBTOTAL"],
    canonicalSlugParticipants: canonicalFullContestSlugParser("mlb", normalizeMlbTeamName),
    canonicalSlugShape: canonicalSlugShape("mlb"),
  }),
  // Basketball. Full-contest moneyline/spread/total only; quarters/halves/player props are
  // excluded by the generic classifier's period/prop rejections.
  adapter({ league: "nba", displayLeague: "NBA", sport: "basketball", pmusLeaguePath: "nba", kalshiSeriesUnverified: ["KXNBAGAME"] }),
  adapter({
    league: "wnba",
    displayLeague: "WNBA",
    sport: "basketball",
    pmusLeaguePath: "wnba",
    canonicalSlugParticipants: canonicalFullContestSlugParser("wnba", normalizeWnbaTeamName),
    canonicalSlugShape: canonicalSlugShape("wnba"),
  }),
  // Football.
  adapter({ league: "nfl", displayLeague: "NFL", sport: "football", pmusLeaguePath: "nfl", kalshiSeriesUnverified: ["KXNFLGAME"] }),
  // Hockey. Overtime/settlement treatment is proven per-signal by the resolver, not assumed.
  adapter({ league: "nhl", displayLeague: "NHL", sport: "hockey", pmusLeaguePath: "nhl" }),
  // Soccer. Three-way/draw and extra-time treatment must be proven by the resolver; the
  // generic classifier only admits full-match markets.
  adapter({ league: "epl", displayLeague: "EPL", sport: "soccer", pmusLeaguePath: "epl", kalshiSeriesUnverified: ["KXEPLGAME"] }),
  adapter({ league: "mls", displayLeague: "MLS", sport: "soccer", pmusLeaguePath: "mls" }),
  // Tennis. Full-match only; set/game-level markets are rejected upstream by the SET/period
  // exclusions, never reinterpreted as match winner.
  adapter({ league: "atp", displayLeague: "ATP", sport: "tennis", pmusLeaguePath: "atp", kalshiSeriesUnverified: ["KXATPMATCH"] }),
  adapter({ league: "wta", displayLeague: "WTA", sport: "tennis", pmusLeaguePath: "wta" }),
  // Esports. Series/match level only; map/game derivatives are rejected upstream.
  adapter({ league: "lol", displayLeague: "LOL", sport: "esports", pmusLeaguePath: "lol" }),
];

const BY_LEAGUE = new Map(ADAPTERS.map((a) => [a.league, a]));

export function getSportAdapter(league: string | null | undefined): SportAdapter | null {
  if (!league) return null;
  return BY_LEAGUE.get(league.trim().toLowerCase()) ?? null;
}

export function listSportAdapters(): readonly SportAdapter[] {
  return ADAPTERS;
}

/** PM-US catalog league segments to paginate, in a stable order. */
export function pmusDiscoveryLeagues(): readonly string[] {
  return ADAPTERS.map((a) => a.pmusLeaguePath).filter((p): p is string => p !== null);
}

/** Kalshi series tickers whose candidate parsing is verified — the ONLY series ever queried. */
export function kalshiDiscoverySeries(): readonly string[] {
  return ADAPTERS.flatMap((a) => a.kalshiSeries);
}

/**
 * Canonical persisted league label. Returns null for an unrecognized league so callers fail
 * closed instead of defaulting to a hard-coded sport.
 */
export function canonicalLeagueLabel(league: string | null | undefined): string | null {
  const found = getSportAdapter(league);
  if (found) return found.displayLeague;
  const raw = (league ?? "").trim();
  return raw.length > 0 ? raw.toUpperCase() : null;
}
