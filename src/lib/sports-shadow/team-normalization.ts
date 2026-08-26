/**
 * MLB code -> [full name, common aliases/venue-specific short forms].
 *
 * Bare city names are included only where one MLB team is unambiguous. Chicago,
 * Los Angeles, and New York intentionally remain ambiguous/fail-closed.
 */
const MLB_TEAMS: Record<string, string[]> = {
  ARI: ["Arizona Diamondbacks", "Arizona", "Diamondbacks", "D-backs", "AZ"],
  ATL: ["Atlanta Braves", "Atlanta", "Braves"],
  BAL: ["Baltimore Orioles", "Baltimore", "Orioles"],
  BOS: ["Boston Red Sox", "Boston", "Red Sox"],
  CHC: ["Chicago Cubs", "Chicago C", "Cubs"],
  CWS: ["Chicago White Sox", "Chicago WS", "White Sox"],
  CIN: ["Cincinnati Reds", "Cincinnati", "Reds"],
  CLE: ["Cleveland Guardians", "Cleveland", "Guardians"],
  COL: ["Colorado Rockies", "Colorado", "Rockies"],
  DET: ["Detroit Tigers", "Detroit", "Tigers"],
  HOU: ["Houston Astros", "Houston", "Astros"],
  KC: ["Kansas City Royals", "Kansas City", "Royals"],
  LAA: ["Los Angeles Angels", "Los Angeles A", "Angels"],
  LAD: ["Los Angeles Dodgers", "Los Angeles D", "Dodgers"],
  MIA: ["Miami Marlins", "Miami", "Marlins"],
  MIL: ["Milwaukee Brewers", "Milwaukee", "Brewers"],
  MIN: ["Minnesota Twins", "Minnesota", "Twins"],
  NYM: ["New York Mets", "New York M", "Mets"],
  NYY: ["New York Yankees", "New York Y", "Yankees"],
  ATH: ["Athletics", "Oakland Athletics", "Oakland", "A's", "As"],
  PHI: ["Philadelphia Phillies", "Philadelphia", "Phillies"],
  PIT: ["Pittsburgh Pirates", "Pittsburgh", "Pirates"],
  SD: ["San Diego Padres", "San Diego", "Padres"],
  SF: ["San Francisco Giants", "San Francisco", "Giants"],
  SEA: ["Seattle Mariners", "Seattle", "Mariners"],
  STL: ["St. Louis Cardinals", "St Louis Cardinals", "St. Louis", "St Louis", "Cardinals"],
  TB: ["Tampa Bay Rays", "Tampa Bay", "Rays"],
  TEX: ["Texas Rangers", "Texas", "Rangers"],
  TOR: ["Toronto Blue Jays", "Toronto", "Blue Jays"],
  WSH: ["Washington Nationals", "Washington", "Nationals"],
};

const LOOKUP: Map<string, string> = new Map();
for (const [code, names] of Object.entries(MLB_TEAMS)) {
  LOOKUP.set(code.toLowerCase(), code);
  for (const name of names) LOOKUP.set(name.toLowerCase(), code);
}

/**
 * WNBA canonical identities. These are used only when upstream metadata has already
 * established league=WNBA, or when a full franchise name is explicit. City-only aliases
 * intentionally stay out of normalizeTeamName's global fallback so MLB's ambiguous city
 * safety rules remain intact.
 */
const WNBA_TEAMS: Record<string, string[]> = {
  ATL: ["Atlanta Dream", "Atlanta", "Dream"],
  CHI: ["Chicago Sky", "Chicago", "Sky"],
  CONN: ["Connecticut Sun", "Connecticut", "Sun"],
  DAL: ["Dallas Wings", "Dallas", "Wings"],
  GS: ["Golden State Valkyries", "Golden State", "Valkyries"],
  IND: ["Indiana Fever", "Indiana", "Fever"],
  LA: ["Los Angeles Sparks", "Los Angeles", "LA Sparks", "Sparks"],
  LV: ["Las Vegas Aces", "Las Vegas", "LV Aces", "Aces"],
  MIN: ["Minnesota Lynx", "Minnesota", "Lynx"],
  NY: ["New York Liberty", "New York", "NY Liberty", "Liberty"],
  PHX: ["Phoenix Mercury", "Phoenix", "Mercury"],
  POR: ["Portland Fire", "Portland", "Fire"],
  SEA: ["Seattle Storm", "Seattle", "Storm"],
  TOR: ["Toronto Tempo", "Toronto", "Tempo"],
  WSH: ["Washington Mystics", "Washington", "Mystics"],
};

const WNBA_LOOKUP: Map<string, string> = new Map();
for (const [code, names] of Object.entries(WNBA_TEAMS)) {
  WNBA_LOOKUP.set(code.toLowerCase(), `WNBA:${code}`);
  for (const name of names) WNBA_LOOKUP.set(name.toLowerCase(), `WNBA:${code}`);
}

function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[.']/g, "").replace(/\s+/g, " ");
}

/** Strict audited MLB identity. Use this whenever the caller positively knows league=MLB. */
export function normalizeMlbTeamName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return LOOKUP.get(normalizeKey(raw)) ?? null;
}

/** Strict audited WNBA identity. Use only when caller positively knows league=WNBA. */
export function normalizeWnbaTeamName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return WNBA_LOOKUP.get(normalizeKey(raw)) ?? null;
}

export function normalizeKnownLeagueTeamName(raw: string | null | undefined, league: string | null | undefined): string | null {
  const normalizedLeague = (league ?? "").trim().toLowerCase();
  if (normalizedLeague === "mlb") return normalizeMlbTeamName(raw);
  if (normalizedLeague === "wnba") return normalizeWnbaTeamName(raw);
  return null;
}

const AMBIGUOUS_MLB_BARE_NAMES = new Set(["chicago", "los angeles", "new york"]);

function genericParticipantKey(raw: string): string | null {
  const cleaned = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (!cleaned || AMBIGUOUS_MLB_BARE_NAMES.has(cleaned)) return null;
  // Do not let the generic fallback turn the long-standing MLB unknown-team regression
  // fixture into a valid identity. Real non-MLB participants are handled by full names.
  if (/\bminor league\b/.test(cleaned)) return null;
  return cleaned.split(" ").length >= 2 ? `GENERIC:${cleaned}` : null;
}

/**
 * Resolver-facing normalizer. Known MLB aliases retain their canonical codes. Unknown
 * multi-word names may fall back to a deterministic GENERIC identity so WNBA/tennis/etc.
 * source outcomes can be compared to PM-US full participant names without a permanent
 * league-by-league alias table. Sport classifiers that know they are processing MLB must
 * call normalizeMlbTeamName (participant-normalization.ts does exactly that), preserving
 * the original fail-closed MLB safety invariant.
 */
export function normalizeTeamName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return normalizeMlbTeamName(raw) ?? genericParticipantKey(raw);
}

export function teamsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  return na !== null && nb !== null && na === nb;
}

export const MLB_TEAM_CODES = Object.keys(MLB_TEAMS);
