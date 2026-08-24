import { normalizeMlbTeamName } from "./team-normalization";

/**
 * Derives a conservative league/sport token from the canonical Polymarket sports slug
 * family (`wnba-...`, `wta-...`, `atp-...`, `nfl-...`, `val-...`, etc.). This is a
 * fallback only: callers should prefer structured league metadata whenever it exists.
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
  return cleaned.length > 0 ? `GENERIC:${cleaned}` : null;
}

/**
 * Canonical participant identity used by sport-agnostic source/PMUS classification.
 * MLB keeps the original audited alias table. Every other sport uses a deterministic
 * full-name key, avoiding a permanent hard-coded league/category allow-list.
 */
export function normalizeParticipantName(raw: string | null | undefined, league: string | null | undefined): string | null {
  if (!raw) return null;
  if ((league ?? "").toLowerCase() === "mlb") return normalizeMlbTeamName(raw);
  return normalizeGeneric(raw);
}

/** Parse the two competitors from a conventional "A vs B" title/question. */
export function parseVersusParticipants(text: string | null | undefined): { away: string; home: string } | null {
  if (!text) return null;
  const parts = text.split(/\s+vs\.?\s+/i);
  if (parts.length !== 2) return null;
  let away = (parts[0] ?? "").trim();
  let home = (parts[1] ?? "").trim();

  // Individual-sport titles often prefix the first participant with tournament context.
  const colon = away.lastIndexOf(":");
  if (colon >= 0) away = away.slice(colon + 1).trim();

  // Strip common partial-market suffixes from the second participant text.
  home = home.replace(/\s+-\s+(?:match|game|map|set)\b.*$/i, "").trim();
  if (!away || !home) return null;
  return { away, home };
}
