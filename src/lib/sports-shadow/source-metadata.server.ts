import { DeadlineExceededError, getHostCooldown, parseRetryAfterMs, recordHostRateLimit, reserveRequestSlot } from "../http-rate-limit.server";
import { classifyGammaMarket, type GammaMarket } from "./eligibility";
import { runtimeFetch } from "./runtime-fetch.server";
import type { SourceMarketMetadata } from "./types";

const GAMMA_API_BASE = "https://gamma-api.polymarket.com";
/**
 * CODEX P2-2: Gamma metadata calls previously used a raw `fetchImpl` with only a local
 * timeout -- entirely bypassing this project's shared host-aware rate limiter
 * (reserveRequestSlot/getHostCooldown/recordHostRateLimit), unlike every other upstream
 * host (data-api.polymarket.com, gateway.polymarket.us, Kalshi's API -- see
 * source-poll.server.ts/pmus.server.ts/kalshi.server.ts's identical pattern). A 429 from
 * Gamma was silently swallowed into a per-fill UNVERIFIED_FETCH_FAILED result with no
 * cooldown recorded anywhere, so the very next pending fill's lookup could immediately
 * re-hammer the same host. Gamma now gets its own shared host budget/cooldown entry,
 * exactly like every other upstream host.
 */
export const GAMMA_HOST = "gamma-api.polymarket.com";
const REQUEST_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type GammaNetworkDeps = {
  fetchImpl: typeof fetch;
  /** Task 13I / P1-T pattern: `deadlineAtMs` optional, forwarded from pacedGetGamma -- see http-rate-limit.server.ts's own doc comment for exactly what it changes. */
  reserveRequestSlot: (host: string, deadlineAtMs?: number) => Promise<number>;
  getHostCooldown: (host: string) => Promise<{ blocked: boolean; reason: string | null }>;
  recordHostRateLimit: (host: string, retryAfterMs: number | null) => Promise<void>;
  now: () => number;
};

const defaultDeps: GammaNetworkDeps = {
  // Task 13E: never the bare `fetch` reference -- see runtime-fetch.server.ts's doc
  // comment for why that breaks in Cloudflare Workers (confirmed live in production).
  fetchImpl: runtimeFetch,
  reserveRequestSlot,
  getHostCooldown,
  recordHostRateLimit,
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
  /** CODEX P1-6: confirmed present on the real gamma-api.polymarket.com response (live-verified, e.g. an MLB moneyline market's description includes "If the game is postponed, this market will remain open until the game has been completed..."). The SAME structural role as PmusCandidate/KalshiCandidate's own rulesDescription. */
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

/**
 * CODEX P2-2: mirrors pmus.server.ts's pacedGetJson / source-poll.server.ts's
 * pacedFetchTradesPage exactly -- same cooldown-check -> reserve-slot -> paced-wait ->
 * fetch -> 429-cooldown-record shape, against Gamma's own shared host budget. Throws
 * (DeadlineExceededError for a scheduler-budget exhaustion, a plain Error for a genuine
 * cooldown/429/HTTP failure) rather than returning a value -- the caller
 * (fetchSourceMarketMetadata) is the one place that decides how a THROWN failure here
 * differs from a structurally-valid-but-unverifiable response body (which still resolves
 * to an UNVERIFIED result, unchanged from before this fix).
 */
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
      if (deadlineAtMs === undefined || deps.now() < deadlineAtMs) {
        await deps.recordHostRateLimit(GAMMA_HOST, parseRetryAfterMs(response.headers.get("retry-after")));
      }
      throw new Error(`${GAMMA_HOST} rate limited (429) on /markets?condition_ids=${conditionId}`);
    }
    if (!response.ok) {
      throw new Error(`${GAMMA_HOST} request failed (HTTP ${response.status})`);
    }
    try {
      return await response.json();
    } catch (err) {
      // Distinguished from a plain Error (network/HTTP/cooldown/429 failure) so the
      // caller preserves the pre-existing UNVERIFIED_MALFORMED_RESPONSE reason code --
      // the host DID answer, it just did not answer usefully, a materially different
      // outcome from "could not reach/was told to back off from the host at all."
      throw new GammaMalformedResponseError(`${GAMMA_HOST} response was not valid JSON: ${err instanceof Error ? err.message : "unknown"}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

class GammaMalformedResponseError extends Error {}

/**
 * Resolves one source fill's structured market metadata by its conditionId (present on every
 * data-api.polymarket.com /trades row already). Read-only, public, no credentials.
 *
 * CODEX P2-2: now routes through the shared host-aware rate limiter (see pacedGetGamma
 * above). A cooldown-blocked host, a reservation wait, or a genuine 429 all resolve to an
 * explicit UNVERIFIED_FETCH_FAILED result (unchanged reason code, now ALSO the outcome for
 * these new failure modes) rather than throwing -- classifyUnverifiedDisposition already
 * treats UNVERIFIED_FETCH_FAILED as RETRYABLE (never converted to a permanent
 * TERMINAL_UNVERIFIED), and this result is cached per-conditionId for the remainder of THIS
 * poll (source-poll.server.ts's metadataCache), so multiple pending fills sharing a
 * rate-limited conditionId within one poll do not each independently re-attempt the
 * network call and re-trip the same cooldown. The ONE exception is `DeadlineExceededError`
 * (this scheduler invocation's own time budget, not evidence about Gamma or the market at
 * all) -- that still propagates so the existing caller's try/catch leaves the fill
 * completely untouched (stays PENDING, no cache entry, no counter) rather than caching a
 * result that says nothing real about the market.
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
    sourceRulesDescription: market.description ?? null,
  };
}
