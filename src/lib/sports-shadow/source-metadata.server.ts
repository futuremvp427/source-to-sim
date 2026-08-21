import { classifyGammaMarket, type GammaMarket } from "./eligibility";
import type { SourceMarketMetadata } from "./types";

const GAMMA_API_BASE = "https://gamma-api.polymarket.com";
const REQUEST_TIMEOUT_MS = 10_000;

type RawGammaEventTeam = { name?: string; ordering?: string };
type RawGammaEvent = {
  gameId?: number | string;
  slug?: string;
  sport?: { sport?: string } | null;
  teams?: RawGammaEventTeam[];
};
type RawGammaMarket = {
  conditionId?: string;
  slug?: string;
  question?: string;
  groupItemTitle?: string | null;
  sportsMarketType?: string;
  line?: number;
  gameStartTime?: string;
  events?: RawGammaEvent[];
};

function unverifiedResult(conditionId: string, reasonCode: "UNVERIFIED_FETCH_FAILED" | "UNVERIFIED_EMPTY_RESPONSE" | "UNVERIFIED_MALFORMED_RESPONSE", reason: string): SourceMarketMetadata {
  return {
    conditionId,
    league: null,
    sportsMarketType: null,
    betType: null,
    status: "UNVERIFIED",
    reasonCode,
    ineligibleReason: reason,
    line: null,
    awayTeam: null,
    homeTeam: null,
    gameStartTime: null,
    sourceGameId: null,
    eventSlug: null,
    marketSlug: null,
  };
}

/**
 * Resolves one source fill's structured market metadata by its conditionId (present on every
 * data-api.polymarket.com /trades row already). Read-only, public, no credentials. Fails closed
 * to an UNVERIFIED result on any network, HTTP, timeout, or shape error — never throws, so one bad
 * lookup cannot abort a batch of fills for a wallet poll, and network uncertainty is never
 * silently converted into eligibility.
 */
export async function fetchSourceMarketMetadata(conditionId: string, fetchImpl: typeof fetch = fetch): Promise<SourceMarketMetadata> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let raw: unknown;
  try {
    const response = await fetchImpl(`${GAMMA_API_BASE}/markets?condition_ids=${encodeURIComponent(conditionId)}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return unverifiedResult(conditionId, "UNVERIFIED_FETCH_FAILED", `gamma-api HTTP ${response.status}`);
    try {
      raw = await response.json();
    } catch (err) {
      return unverifiedResult(conditionId, "UNVERIFIED_MALFORMED_RESPONSE", `gamma-api response was not valid JSON: ${err instanceof Error ? err.message : "unknown"}`);
    }
  } catch (err) {
    return unverifiedResult(conditionId, "UNVERIFIED_FETCH_FAILED", `gamma-api request failed: ${err instanceof Error ? err.message : "unknown"}`);
  } finally {
    clearTimeout(timer);
  }

  if (!Array.isArray(raw)) return unverifiedResult(conditionId, "UNVERIFIED_MALFORMED_RESPONSE", "gamma-api response was not an array");
  const marketList = raw as RawGammaMarket[];
  const market = marketList[0];
  if (!market) return unverifiedResult(conditionId, "UNVERIFIED_EMPTY_RESPONSE", "gamma-api returned no market for this conditionId");

  const event = market.events?.[0];

  const gammaMarket: GammaMarket = {
    slug: market.slug ?? null,
    question: market.question ?? null,
    groupItemTitle: market.groupItemTitle ?? null,
    sportsMarketType: market.sportsMarketType ?? null,
    line: market.line ?? null,
    events: event ? [{ sport: event.sport ?? null, teams: event.teams ?? [] }] : null,
  };
  const classification = classifyGammaMarket(gammaMarket);

  return {
    conditionId,
    league: event?.sport?.sport ?? null,
    sportsMarketType: market.sportsMarketType ?? null,
    betType: classification.betType,
    status: classification.status,
    reasonCode: classification.reasonCode,
    ineligibleReason: classification.status === "ELIGIBLE" ? null : classification.reason,
    line: classification.status === "ELIGIBLE" ? classification.line : (market.line ?? null),
    // Task 12E / P1-D: classification.awayTeam/homeTeam are already the classifier's
    // normalized canonical MLB codes (null unless ELIGIBLE) -- persisting the raw Gamma
    // display name here instead caused a real-name-vs-canonical-code mismatch against
    // resolver.ts's strict-equality team matching, silently producing NONE_NO_CANDIDATE
    // for otherwise-valid signals. Never recompute or discard the classifier's identity.
    awayTeam: classification.awayTeam,
    homeTeam: classification.homeTeam,
    gameStartTime: market.gameStartTime ?? null,
    sourceGameId: event?.gameId !== undefined ? String(event.gameId) : null,
    eventSlug: event?.slug ?? null,
    marketSlug: market.slug ?? null,
  };
}
