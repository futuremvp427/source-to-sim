/** code -> [full name, common aliases/venue-specific short forms]. */
const MLB_TEAMS: Record<string, string[]> = {
  ARI: ["Arizona Diamondbacks", "Diamondbacks", "D-backs"],
  ATL: ["Atlanta Braves", "Braves"],
  BAL: ["Baltimore Orioles", "Orioles"],
  BOS: ["Boston Red Sox", "Red Sox"],
  CHC: ["Chicago Cubs", "Cubs"],
  CWS: ["Chicago White Sox", "White Sox"],
  CIN: ["Cincinnati Reds", "Reds"],
  CLE: ["Cleveland Guardians", "Guardians"],
  COL: ["Colorado Rockies", "Rockies"],
  DET: ["Detroit Tigers", "Tigers"],
  HOU: ["Houston Astros", "Astros"],
  KC: ["Kansas City Royals", "Royals"],
  LAA: ["Los Angeles Angels", "Angels"],
  LAD: ["Los Angeles Dodgers", "Los Angeles D", "Dodgers"],
  MIA: ["Miami Marlins", "Marlins"],
  MIL: ["Milwaukee Brewers", "Brewers"],
  MIN: ["Minnesota Twins", "Twins"],
  NYM: ["New York Mets", "Mets"],
  NYY: ["New York Yankees", "Yankees"],
  ATH: ["Athletics", "Oakland Athletics", "A's", "As"],
  PHI: ["Philadelphia Phillies", "Phillies"],
  PIT: ["Pittsburgh Pirates", "Pirates"],
  SD: ["San Diego Padres", "Padres"],
  SF: ["San Francisco Giants", "Giants"],
  SEA: ["Seattle Mariners", "Mariners"],
  STL: ["St. Louis Cardinals", "St Louis Cardinals", "Cardinals"],
  TB: ["Tampa Bay Rays", "Rays"],
  TEX: ["Texas Rangers", "Rangers"],
  TOR: ["Toronto Blue Jays", "Blue Jays"],
  WSH: ["Washington Nationals", "Nationals"],
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
