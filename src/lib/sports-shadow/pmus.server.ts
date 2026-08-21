/**
 * Polymarket US sports market discovery + book capture — NETWORK layer only.
 *
 * Public, unauthenticated endpoints exclusively (https://gateway.polymarket.us). Never
 * imports credentials.server, signer.server, or capabilities.server — this module has no
 * path to an authenticated request, let alone an order. Every real upstream request goes
 * through the project's existing shared host-aware rate limiter
 * (reserveRequestSlot/getHostCooldown/recordHostRateLimit), exactly like
 * general-shadow.server.ts's getActivityPage. See ./pmus.ts for the pure
 * normalization/classification this module delegates to.
 */

import { getHostCooldown, parseRetryAfterMs, recordHostRateLimit, reserveRequestSlot } from "../http-rate-limit.server";
import { PMUS_PUBLIC_BASE } from "../pmus/us-markets.server";
import { eventToCandidates, normalizePmusBook, type PmusCandidate, type PmusRawEvent } from "./pmus";
import { NO_OP_LEASE_CHECKPOINT, type LeaseCheckpoint } from "./sports-lease.server";
import type { BookSnapshot } from "./types";

export const PMUS_HOST = "gateway.polymarket.us";

const REQUEST_TIMEOUT_MS = 12_000;
const DISCOVERY_PAGE_SIZE = 200;
/** Bounded: at most 2,000 sports events per baseline discovery refresh. */
const DISCOVERY_MAX_PAGES = 10;
const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type PmusNetworkDeps = {
  fetchImpl: typeof fetch;
  reserveRequestSlot: (host: string) => Promise<number>;
  getHostCooldown: (host: string) => Promise<{ blocked: boolean; reason: string | null }>;
  recordHostRateLimit: (host: string, retryAfterMs: number | null) => Promise<void>;
  now: () => number;
  /** Task 12F / P1-G: checked between discovery pages so a slow multi-page discovery pass can never silently outlive the caller's source lease. Defaults to always-true for any caller not exercising lease-loss behavior. */
  checkpointLease: LeaseCheckpoint;
};

const defaultDeps: PmusNetworkDeps = {
  fetchImpl: fetch,
  reserveRequestSlot,
  getHostCooldown,
  recordHostRateLimit,
  now: () => Date.now(),
  checkpointLease: NO_OP_LEASE_CHECKPOINT,
};

/**
 * Fails CLOSED and EXPLICITLY (throws) on any host cooldown, reservation failure, timeout,
 * non-2xx, or malformed-JSON response — never returns a silently-empty/degraded result that
 * could be confused with a genuine "nothing found." Callers of discovery let this propagate;
 * fetchPmusBook (below) is the one place that deliberately catches this and turns it into an
 * explicit per-observation BookSnapshot failure instead, since book capture is a
 * per-observation operation, not a bulk one.
 */
async function pacedGetJson<T>(path: string, deps: PmusNetworkDeps): Promise<T> {
  const cooldown = await deps.getHostCooldown(PMUS_HOST);
  if (cooldown.blocked) throw new Error(`${PMUS_HOST} is in cooldown: ${cooldown.reason ?? "unknown reason"}`);

  const waitMs = await deps.reserveRequestSlot(PMUS_HOST);
  if (waitMs > 0) await sleep(waitMs);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await deps.fetchImpl(`${PMUS_PUBLIC_BASE}${path}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status === 429) {
      await deps.recordHostRateLimit(PMUS_HOST, parseRetryAfterMs(response.headers.get("retry-after")));
      throw new Error(`${PMUS_HOST} rate limited (429) on ${path}`);
    }
    if (!response.ok) {
      throw new Error(`${PMUS_HOST} request failed (HTTP ${response.status}) on ${path}`);
    }
    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new Error(`${PMUS_HOST} returned malformed JSON on ${path}: ${err instanceof Error ? err.message : "unknown"}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

type CacheEntry = { value: PmusCandidate[]; expiresAt: number };
let discoveryCache: CacheEntry | null = null;

/**
 * Bounded, briefly-cached baseline discovery of currently-listed MLB sports markets.
 * Paginates GET /v1/events?...&category=sports (stopping at a short/empty page or
 * DISCOVERY_MAX_PAGES, whichever comes first), classifies every event's markets via the
 * pure `eventToCandidates`, and deduplicates by marketSlug (a retried/overlapping page can
 * never produce two candidates for the same market). This is catalog data ONLY — never used
 * for live book/quote data, which fetchPmusBook always fetches fresh (see its own doc
 * comment for why the two caches are kept semantically separate).
 */
export async function discoverPmusMlbMarkets(deps: Partial<PmusNetworkDeps> = {}): Promise<PmusCandidate[]> {
  const d: PmusNetworkDeps = { ...defaultDeps, ...deps };
  const now = d.now();
  if (discoveryCache && discoveryCache.expiresAt > now) return discoveryCache.value;

  const byMarketSlug = new Map<string, PmusCandidate>();
  for (let page = 0; page < DISCOVERY_MAX_PAGES; page += 1) {
    // Task 12F / P1-G: a full discovery pass can take up to DISCOVERY_MAX_PAGES * 12s --
    // checked BEFORE each page fetch so a lease lost mid-pagination stops issuing further
    // requests immediately rather than completing an unbounded discovery pass under a
    // stale fence.
    if (!(await d.checkpointLease())) {
      throw new Error("PM-US discovery aborted: source lease lost mid-pagination");
    }
    const offset = page * DISCOVERY_PAGE_SIZE;
    const json = await pacedGetJson<{ events?: unknown }>(
      `/v1/events?limit=${DISCOVERY_PAGE_SIZE}&offset=${offset}&active=true&closed=false&category=sports`,
      d,
    );
    // Task 12F / P1-I: a missing/non-array `events` field is a MALFORMED response, not a
    // legitimate empty page -- collapsing the two let a schema/proxy hiccup silently
    // become "zero candidates found," which the caller could then resolve a pending
    // signal against and persist a false semantic NONE. A genuinely empty `events: []`
    // remains a valid, successful empty page. Nothing malformed is ever added to the
    // cache: this throws before byMarketSlug/discoveryCache are touched for this call.
    if (json === null || typeof json !== "object" || !Array.isArray(json.events)) {
      throw new Error("PM-US discovery returned a malformed response: `events` is missing or not an array");
    }
    const events = json.events as PmusRawEvent[];
    for (const event of events) {
      for (const candidate of eventToCandidates(event)) {
        if (candidate.marketSlug) byMarketSlug.set(candidate.marketSlug, candidate);
      }
    }
    if (events.length < DISCOVERY_PAGE_SIZE) break;
  }

  const value = [...byMarketSlug.values()];
  discoveryCache = { value, expiresAt: d.now() + DISCOVERY_CACHE_TTL_MS };
  return value;
}

/** Test/diagnostics helper. */
export function clearPmusDiscoveryCache(): void {
  discoveryCache = null;
}

/**
 * Live, uncached order-book fetch for one market slug. ALWAYS issues a real request — never
 * served from the discovery catalog cache, and never itself cached, so a +0/+5/+10/+30/+60
 * observation burst always reflects the book at the moment each observation actually fires.
 * Unlike discovery, this never throws: any failure (cooldown, reservation, timeout, HTTP
 * error, malformed JSON) is captured as an explicit BookSnapshot with a non-null
 * staleReason and null bestBid/bestAsk — a terminal, recordable observation rather than an
 * exception a per-observation caller would need to wrap individually.
 */
export async function fetchPmusBook(marketSlug: string, deps: Partial<PmusNetworkDeps> = {}): Promise<BookSnapshot> {
  const d: PmusNetworkDeps = { ...defaultDeps, ...deps };
  // Task 12E / P1-E: observedAt must reflect when THIS book became observable to the
  // collector, not when the request started. pacedGetJson may wait out a rate-limit
  // reservation and then spend up to REQUEST_TIMEOUT_MS on the network round trip, so
  // capturing d.now() before it and reusing that value understates detection latency by
  // however long the fetch actually took -- silently corrupting the +0/+5/+10/+30/+60
  // timing measurements this whole subsystem exists to produce. d.now() is therefore
  // called again on EVERY exit path (success and failure), after the awaited work.
  try {
    const json = await pacedGetJson<unknown>(`/v1/markets/${encodeURIComponent(marketSlug)}/book`, d);
    return normalizePmusBook(json, marketSlug, d.now());
  } catch (err) {
    return {
      venue: "PMUS",
      marketId: marketSlug,
      bestBid: null,
      bestAsk: null,
      bidLevels: [],
      askLevels: [],
      marketStatus: null,
      observedAt: d.now(),
      staleReason: err instanceof Error ? err.message : "unknown fetch failure",
    };
  }
}
