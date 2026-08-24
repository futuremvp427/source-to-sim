import { DeadlineExceededError, getHostCooldown, parseRetryAfterMs, recordHostRateLimitReporting, reserveRequestSlot } from "../http-rate-limit.server";
import { classifyGammaMarket, type GammaMarket } from "./eligibility";
import { wrapRecordHostRateLimitWithTelemetry } from "./telemetry.server";
import { runtimeFetch } from "./runtime-fetch.server";
import type { SourceMarketMetadata } from "./types";

const GAMMA_API_BASE = "https://gamma-api.polymarket.com";
export const GAMMA_HOST = "gamma-api.polymarket.com";
const REQUEST_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type GammaNetworkDeps = {
  fetchImpl: typeof fetch;
  reserveRequestSlot: (host: string, deadlineAtMs?: number) => Promise<number>;
  getHostCooldown: (host: string) => Promise<{ blocked: boolean; reason: string | null }>;
  recordHostRateLimit: (host: string, retryAfterMs: number | null) => Promise<void>;
  now: () => number;
};

const defaultDeps: GammaNetworkDeps = {
  fetchImpl: runtimeFetch,
  reserveRequestSlot,
  getHostCooldown,
  recordHostRateLimit: wrapRecordHostRateLimitWithTelemetry(recordHostRateLimitReporting),
  now: () => Date.now(),
};

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
  description?: string | null;
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
    sourceRulesDescription: null,
  };
}

async function pacedGetGamma(conditionId: string, deps: GammaNetworkDeps, deadlineAtMs?: number): Promise<unknown> {
  if (deadlineAtMs !== undefined && deps.now() >= deadlineAtMs) {
    throw new DeadlineExceededError(`${GAMMA_HOST} request skipped: caller deadline already reached`);
  }
  const cooldown = await deps.getHostCooldown(GAMMA_HOST);
  if (cooldown.blocked) throw new Error(`${GAMMA_HOST} is in cooldown: ${cooldown.reason ?? "unknown reason"}`);
  if (deadlineAtMs !== undefined && deps.now() >= deadlineAtMs) {
    throw new DeadlineExceededError(`${GAMMA_HOST} request skipped: caller deadline reached after cooldown check`);
  }

  const waitMs = await deps.reserveRequestSlot(GAMMA_HOST, deadlineAtMs);
  if (waitMs > 0) await sleep(waitMs);
  if (deadlineAtMs !== undefined && deps.now() >= deadlineAtMs) {
    throw new DeadlineExceededError(`${GAMMA_HOST} request skipped: caller deadline reached after pacing wait`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await deps.fetchImpl(`${GAMMA_API_BASE}/markets?condition_ids=${encodeURIComponent(conditionId)}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status === 429) {
      await deps.recordHostRateLimit(GAMMA_HOST, parseRetryAfterMs(response.headers.get("retry-after")));
      throw new Error(`${GAMMA_HOST} rate limited (429) on /markets?condition_ids=${conditionId}`);
    }
    if (!response.ok) throw new Error(`${GAMMA_HOST} request failed (HTTP ${response.status})`);
    try {
      return await response.json();
    } catch (err) {
      throw new GammaMalformedResponseError(`${GAMMA_HOST} response was not valid JSON: ${err instanceof Error ? err.message : "unknown"}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

class GammaMalformedResponseError extends Error {}

/**
 * Resolves one source fill's public Gamma metadata. The classifier can now infer a league
 * from the canonical sports slug when Gamma omits event.sport; that inferred league is
 * persisted below so a new sport does not fall back to the historical hard-coded "MLB"
 * label in source-poll.server.ts.
 */
export async function fetchSourceMarketMetadata(conditionId: string, deps: Partial<GammaNetworkDeps> = {}, deadlineAtMs?: number): Promise<SourceMarketMetadata> {
  const d: GammaNetworkDeps = { ...defaultDeps, ...deps };
  let raw: unknown;
  try {
    raw = await pacedGetGamma(conditionId, d, deadlineAtMs);
  } catch (err) {
    if (err instanceof DeadlineExceededError) throw err;
    if (err instanceof GammaMalformedResponseError) return unverifiedResult(conditionId, "UNVERIFIED_MALFORMED_RESPONSE", err.message);
    return unverifiedResult(conditionId, "UNVERIFIED_FETCH_FAILED", err instanceof Error ? err.message : "gamma-api request failed");
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
    league: classification.league,
    sportsMarketType: market.sportsMarketType ?? null,
    betType: classification.betType,
    status: classification.status,
    reasonCode: classification.reasonCode,
    ineligibleReason: classification.status === "ELIGIBLE" ? null : classification.reason,
    line: classification.status === "ELIGIBLE" ? classification.line : (market.line ?? null),
    awayTeam: classification.awayTeam,
    homeTeam: classification.homeTeam,
    gameStartTime: market.gameStartTime ?? null,
    sourceGameId: event?.gameId !== undefined ? String(event.gameId) : null,
    eventSlug: event?.slug ?? null,
    marketSlug: market.slug ?? null,
    sourceRulesDescription: market.description ?? null,
  };
}
