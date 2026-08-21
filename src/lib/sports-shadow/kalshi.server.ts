/**
 * Kalshi MLB market discovery + order-book capture — NETWORK layer only.
 *
 * ============================== AUTH PROBE RESULT ==============================
 * Kalshi's documentation is internally inconsistent about whether GET
 * /markets/{ticker}/orderbook requires authentication (the API-reference page shows
 * KALSHI-ACCESS-* headers as required; the separate Orderbook Responses guide states "No
 * authentication is required for this endpoint"). Per the mission, ONE bounded unauthenticated
 * read-only probe was made before writing any network code:
 *
 *   GET https://external-api.kalshi.com/trade-api/v2/markets/KXMLBGAME-26AUG222040MINSD-SD/orderbook
 *   (no credentials, no signing headers)
 *   -> HTTP 200, real orderbook_fp payload returned.
 *
 * The probe succeeded. This module proceeds credential-free, exactly as instructed. It
 * contains NO KALSHI_API_KEY_ID, NO KALSHI_PRIVATE_KEY, NO request signing, and NO
 * KALSHI-ACCESS-* headers anywhere — see the auth/safety tests in kalshi.server.test.ts.
 * =================================================================================
 */

import { getHostCooldown, parseRetryAfterMs, recordHostRateLimit, reserveRequestSlot } from "../http-rate-limit.server";
import { classifyKalshiMarket, normalizeKalshiBook, PHASE1_KALSHI_SERIES, type KalshiBookSnapshot, type KalshiCandidate, type KalshiRawEvent, type KalshiRawMarket } from "./kalshi";
import { NO_OP_LEASE_CHECKPOINT, type LeaseCheckpoint } from "./sports-lease.server";

export const KALSHI_HOST = "external-api.kalshi.com";
export const KALSHI_BASE_URL = "https://external-api.kalshi.com/trade-api/v2";

const REQUEST_TIMEOUT_MS = 12_000;
const PAGE_LIMIT = 200;
/** Bounded: at most 10 pages per series per endpoint (markets and events each), well under Kalshi's documented max limit of 1000/page. */
export const MAX_PAGES_PER_SERIES = 10;
const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type KalshiNetworkDeps = {
  fetchImpl: typeof fetch;
  reserveRequestSlot: (host: string) => Promise<number>;
  getHostCooldown: (host: string) => Promise<{ blocked: boolean; reason: string | null }>;
  recordHostRateLimit: (host: string, retryAfterMs: number | null) => Promise<void>;
  now: () => number;
  /** Task 12F / P1-G: checked between discovery pages so a slow multi-page discovery pass can never silently outlive the caller's source lease. Defaults to always-true for any caller not exercising lease-loss behavior. */
  checkpointLease: LeaseCheckpoint;
};

const defaultDeps: KalshiNetworkDeps = {
  fetchImpl: fetch,
  reserveRequestSlot,
  getHostCooldown,
  recordHostRateLimit,
  now: () => Date.now(),
  checkpointLease: NO_OP_LEASE_CHECKPOINT,
};

/**
 * Fails CLOSED and EXPLICITLY (throws) on cooldown, reservation failure, timeout, non-2xx, or
 * malformed JSON — mirrors pmus.server.ts's pacedGetJson exactly, including the same
 * discovery-throws / book-catches split rationale (see fetchKalshiBook below).
 */
async function pacedGetJson<T>(path: string, deps: KalshiNetworkDeps): Promise<T> {
  const cooldown = await deps.getHostCooldown(KALSHI_HOST);
  if (cooldown.blocked) throw new Error(`${KALSHI_HOST} is in cooldown: ${cooldown.reason ?? "unknown reason"}`);

  const waitMs = await deps.reserveRequestSlot(KALSHI_HOST);
  if (waitMs > 0) await sleep(waitMs);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await deps.fetchImpl(`${KALSHI_BASE_URL}${path}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status === 429) {
      await deps.recordHostRateLimit(KALSHI_HOST, parseRetryAfterMs(response.headers.get("retry-after")));
      throw new Error(`${KALSHI_HOST} rate limited (429) on ${path}`);
    }
    if (!response.ok) {
      throw new Error(`${KALSHI_HOST} request failed (HTTP ${response.status}) on ${path}`);
    }
    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new Error(`${KALSHI_HOST} returned malformed JSON on ${path}: ${err instanceof Error ? err.message : "unknown"}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

type PaginatedKalshiResponse = { cursor?: string; markets?: unknown; events?: unknown };

/**
 * Task 12F / P1-I: strict envelope validation. Previously, a missing/non-array
 * `markets`/`events` field was silently treated as `[]` and pagination simply broke as
 * if the venue had run dry -- collapsing "this page's collection is malformed/untrustworthy"
 * into "the venue genuinely has zero more candidates." The caller (discoverKalshiMlbMarkets,
 * and above that resolveVenuePending) could then resolve a pending signal against an
 * incomplete catalog and persist a false semantic NONE. A malformed LATER page now throws
 * immediately, discarding whatever this call had already accumulated in `out` -- a partial
 * catalog is not complete enough to justify a semantic NONE either. A genuinely well-formed
 * empty array remains a valid, successful (possibly final) page.
 *
 * Task 12I / P2-P1: hitting MAX_PAGES_PER_SERIES while the final page STILL carried a
 * non-empty continuation cursor means upstream evidence says more data exists that this
 * call never fetched -- a resolver NONE must mean "complete trustworthy discovery found
 * no exact target," never "we only inspected the first N pages." That is discovery
 * FAILURE, not a successful (if large) result, so it must never be returned OR cached.
 * `pageBudgetExhausted` starts true and is set false the instant the loop breaks for a
 * genuinely proven-complete reason (an empty final cursor, or a legitimately empty final
 * page) -- it stays true ONLY when every single one of the MAX_PAGES_PER_SERIES
 * iterations ran without ever proving completeness, i.e. the loop ended purely because
 * the page budget ran out, not because pagination naturally finished.
 */
async function paginate<T>(pathBuilder: (cursor: string | null) => string, itemsKey: "markets" | "events", deps: KalshiNetworkDeps): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  let pageBudgetExhausted = true;
  for (let page = 0; page < MAX_PAGES_PER_SERIES; page += 1) {
    // Task 12F / P1-G: see pmus.server.ts's discoverPmusMlbMarkets for the identical
    // checkpoint rationale -- Kalshi discovery has a WORSE worst case (3 series x 2
    // endpoints x up to 10 pages x up to 12s each).
    if (!(await deps.checkpointLease())) {
      throw new Error("Kalshi discovery aborted: source lease lost mid-pagination");
    }
    const json: unknown = await pacedGetJson<unknown>(pathBuilder(cursor), deps);
    if (json === null || typeof json !== "object") {
      throw new Error("Kalshi discovery returned a malformed response: not an object");
    }
    const record = json as PaginatedKalshiResponse;
    const items = record[itemsKey];
    if (!Array.isArray(items)) {
      throw new Error(`Kalshi discovery returned a malformed response: \`${itemsKey}\` is missing or not an array`);
    }
    if (record.cursor !== undefined && record.cursor !== null && typeof record.cursor !== "string") {
      throw new Error("Kalshi discovery returned a malformed response: `cursor` is present but not a string");
    }
    out.push(...(items as T[]));
    cursor = record.cursor && record.cursor.length > 0 ? record.cursor : null;
    if (!cursor || items.length === 0) {
      pageBudgetExhausted = false;
      break;
    }
  }
  if (pageBudgetExhausted) {
    throw new Error(
      `Kalshi discovery truncated: MAX_PAGES_PER_SERIES (${MAX_PAGES_PER_SERIES}) exhausted while the final page still carried a non-empty continuation cursor -- catalog is incomplete, refusing to return/cache a partial result`,
    );
  }
  return out;
}

type CacheEntry = { value: KalshiCandidate[]; expiresAt: number };
let discoveryCache: CacheEntry | null = null;

/**
 * Bounded, briefly-cached baseline discovery across the three Phase-1 series
 * (KXMLBGAME/KXMLBSPREAD/KXMLBTOTAL only — F5/prop/other series are never queried at all,
 * excluded by construction, not by post-hoc filtering). For each series, paginates both
 * GET /markets?series_ticker=...&status=open and GET /events?series_ticker=...&status=open
 * (cursor-bounded, MAX_PAGES_PER_SERIES each), joins markets to their event by event_ticker,
 * classifies via the pure classifyKalshiMarket, and deduplicates by market ticker. Catalog
 * data ONLY — fetchKalshiBook never reads from or writes to this cache.
 */
export async function discoverKalshiMlbMarkets(deps: Partial<KalshiNetworkDeps> = {}): Promise<KalshiCandidate[]> {
  const d: KalshiNetworkDeps = { ...defaultDeps, ...deps };
  const now = d.now();
  if (discoveryCache && discoveryCache.expiresAt > now) return discoveryCache.value;

  const byTicker = new Map<string, KalshiCandidate>();
  for (const series of PHASE1_KALSHI_SERIES) {
    const markets = await paginate<KalshiRawMarket>(
      (cursor) => `/markets?series_ticker=${series}&status=open&limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      "markets",
      d,
    );
    const events = await paginate<KalshiRawEvent>(
      (cursor) => `/events?series_ticker=${series}&status=open&limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      "events",
      d,
    );
    const eventsByTicker = new Map<string, KalshiRawEvent>();
    for (const event of events) if (event.event_ticker) eventsByTicker.set(event.event_ticker, event);

    for (const market of markets) {
      const event = market.event_ticker ? (eventsByTicker.get(market.event_ticker) ?? null) : null;
      const candidate = classifyKalshiMarket(market, event);
      if (candidate.marketTicker) byTicker.set(candidate.marketTicker, candidate);
    }
  }

  const value = [...byTicker.values()];
  discoveryCache = { value, expiresAt: d.now() + DISCOVERY_CACHE_TTL_MS };
  return value;
}

/** Test/diagnostics helper. */
export function clearKalshiDiscoveryCache(): void {
  discoveryCache = null;
}

/**
 * Live, uncached order-book fetch for one market ticker. Always issues a real request — never
 * cached, never served from the discovery catalog cache — so a +0/+5/+10/+30/+60 observation
 * burst always reflects the book at the moment each observation fires. Never throws: any
 * failure is captured as an explicit KalshiBookSnapshot with a non-null staleReason and null
 * best prices on both sides, mirroring fetchPmusBook's per-observation failure contract.
 */
export async function fetchKalshiBook(ticker: string, deps: Partial<KalshiNetworkDeps> = {}): Promise<KalshiBookSnapshot> {
  const d: KalshiNetworkDeps = { ...defaultDeps, ...deps };
  // Task 12E / P1-E: same fix, same rationale as fetchPmusBook above -- observedAt must
  // be captured AFTER the awaited network work completes or fails, never before.
  try {
    const json = await pacedGetJson<unknown>(`/markets/${encodeURIComponent(ticker)}/orderbook`, d);
    return normalizeKalshiBook(json, ticker, d.now());
  } catch (err) {
    const emptySide = { bestBid: null, bestAsk: null, bestBidUnits: null, bestAskUnits: null, bidLevels: [], askLevels: [] };
    return {
      venue: "KALSHI",
      marketId: ticker,
      observedAt: d.now(),
      yes: { ...emptySide },
      no: { ...emptySide },
      rawYesBids: [],
      rawNoBids: [],
      staleReason: err instanceof Error ? err.message : "unknown fetch failure",
    };
  }
}
