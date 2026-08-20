/**
 * code -> [full name, common aliases/venue-specific short forms].
 *
 * Bare city names (e.g. "Minnesota", "San Diego") are included only for cities with exactly
 * one MLB team, confirmed live from Kalshi's event.title field (e.g. "Minnesota vs San
 * Diego"), which uses bare city names rather than full franchise names. Chicago (CHC/CWS),
 * Los Angeles (LAA/LAD), and New York (NYM/NYY) each host two teams -- their bare city names
 * are deliberately NOT added anywhere, so a bare "Chicago"/"Los Angeles"/"New York" input
 * fails closed to null instead of silently guessing which of the two teams is meant.
 */
const MLB_TEAMS: Record<string, string[]> = {
  ARI: ["Arizona Diamondbacks", "Arizona", "Diamondbacks", "D-backs"],
  ATL: ["Atlanta Braves", "Atlanta", "Braves"],
  BAL: ["Baltimore Orioles", "Baltimore", "Orioles"],
  BOS: ["Boston Red Sox", "Boston", "Red Sox"],
  CHC: ["Chicago Cubs", "Cubs"],
  CWS: ["Chicago White Sox", "White Sox"],
  CIN: ["Cincinnati Reds", "Cincinnati", "Reds"],
  CLE: ["Cleveland Guardians", "Cleveland", "Guardians"],
  COL: ["Colorado Rockies", "Colorado", "Rockies"],
  DET: ["Detroit Tigers", "Detroit", "Tigers"],
  HOU: ["Houston Astros", "Houston", "Astros"],
  KC: ["Kansas City Royals", "Kansas City", "Royals"],
  LAA: ["Los Angeles Angels", "Angels"],
  LAD: ["Los Angeles Dodgers", "Los Angeles D", "Dodgers"],
  MIA: ["Miami Marlins", "Miami", "Marlins"],
  MIL: ["Milwaukee Brewers", "Milwaukee", "Brewers"],
  MIN: ["Minnesota Twins", "Minnesota", "Twins"],
  NYM: ["New York Mets", "Mets"],
  NYY: ["New York Yankees", "Yankees"],
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

function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[.']/g, "").replace(/\s+/g, " ");
}

/** Returns the canonical 2-4 letter MLB code, or null when unrecognized (fail closed). */
export function normalizeTeamName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return LOOKUP.get(normalizeKey(raw)) ?? null;
}

export function teamsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  return na !== null && nb !== null && na === nb;
}

/** Test/diagnostics helper: the full canonical table, for other tasks' fixtures. */
export const MLB_TEAM_CODES = Object.keys(MLB_TEAMS);
