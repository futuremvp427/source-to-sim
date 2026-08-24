import { normalizeTeamName } from "./team-normalization";

/**
 * Derives a conservative league/sport token from the canonical Polymarket sports slug
 * family (`wnba-...`, `wta-...`, `atp-...`, `nfl-...`, `val-...`, etc.). This is a
 * fallback only: callers should prefer structured league metadata whenever it exists.
 *
 * The helper deliberately does not maintain an allow-list. A new sport can enter the
 * research pipeline without a code deployment, while downstream classification still
 * fails closed on unsupported/partial market structure.
 */
export function inferSportsLeagueFromSlug(slug: string | null | undefined): string | null {
  if (!slug) return null;
  const token = slug.trim().toLowerCase().match(/^([a-z0-9]+)-/)?.[1] ?? null;
  return token && token.length >= 2 ? token : null;
}

function normalizeGeneric(raw: string): string | null {
  const cleaned = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Canonical participant identity used by the sport-agnostic source/PMUS resolver.
 *
 * MLB keeps the existing audited alias table and intentionally ambiguous-city failures.
 * Every other sport uses a conservative normalized FULL NAME. Callers should pass a full
 * participant/team name when one is available (rather than an abbreviation), so the same
 * real participant on Gamma and PM-US converges without requiring a permanent league-by-
 * league alias table.
 */
export function normalizeParticipantName(raw: string | null | undefined, league: string | null | undefined): string | null {
  if (!raw) return null;
  if ((league ?? "").toLowerCase() === "mlb") return normalizeTeamName(raw);
  return normalizeGeneric(raw);
}

/** Parse the two competitors from a conventional "A vs B" title/question. */
export function parseVersusParticipants(text: string | null | undefined): { away: string; home: string } | null {
  if (!text) return null;
  const parts = text.split(/\s+vs\.?\s+/i);
  if (parts.length !== 2) return null;
  let away = (parts[0] ?? "").trim();
  let home = (parts[1] ?? "").trim();

  // Tennis/event titles often prefix the first player with tournament context, e.g.
  // "Monterrey Open, Qualification: Anna Bondar vs En-Shuo Liang". Keep only the text
  // after the final colon on the left side; the right side is already the participant.
  const colon = away.lastIndexOf(":");
  if (colon >= 0) away = away.slice(colon + 1).trim();

  // Strip common market-scope suffixes that can follow the second participant.
  home = home.replace(/\s+-\s+(?:match|game|map|set)\b.*$/i, "").trim();
  if (!away || !home) return null;
  return { away, home };
}
