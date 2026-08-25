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

import { DeadlineExceededError, getHostCooldown, parseRetryAfterMs, recordHostRateLimitReporting, reserveRequestSlot } from "../http-rate-limit.server";
import { PMUS_PUBLIC_BASE } from "../pmus/us-markets.server";
import { wrapRecordHostRateLimitWithTelemetry } from "./telemetry.server";
import { eventToCandidates, normalizePmusBook, type PmusCandidate, type PmusRawEvent } from "./pmus";
import { runtimeFetch } from "./runtime-fetch.server";
import { NO_OP_LEASE_CHECKPOINT, type LeaseCheckpoint } from "./sports-lease.server";
import type { BookSnapshot } from "./types";

export const PMUS_HOST = "gateway.polymarket.us";

const REQUEST_TIMEOUT_MS = 12_000;
export const DISCOVERY_PAGE_SIZE = 200;
/** Bounded: at most 2,000 MLB events per baseline discovery refresh. */
export const DISCOVERY_MAX_PAGES = 10;
const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;
const pmusLeagueEventsEndpoint = (league: string) => `/v2/leagues/${league}/events`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type PmusNetworkDeps = {
  fetchImpl: typeof fetch;
  /** Task 13I / P1-T: `deadlineAtMs` optional, forwarded from pacedGetJson -- see http-rate-limit.server.ts's own doc comment for exactly what it changes. */
  reserveRequestSlot: (host: string, deadlineAtMs?: number) => Promise<number>;
  getHostCooldown: (host: string) => Promise<{ blocked: boolean; reason: string | null }>;
  recordHostRateLimit: (host: string, retryAfterMs: number | null) => Promise<void>;
  now: () => number;
  /** Task 12F / P1-G: checked between discovery pages so a slow multi-page discovery pass can never silently outlive the caller's source lease. Defaults to always-true for any caller not exercising lease-loss behavior. */
  checkpointLease: LeaseCheckpoint;
};

const defaultDeps: PmusNetworkDeps = {
  // Task 13E: never the bare `fetch` reference -- see runtime-fetch.server.ts's doc
  // comment for why that breaks in Cloudflare Workers (confirmed live in production).
  fetchImpl: runtimeFetch,
  reserveRequestSlot,
  getHostCooldown,
  recordHostRateLimit: wrapRecordHostRateLimitWithTelemetry(recordHostRateLimitReporting),
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
/**
 * Task 13I / P1-S, P1-T: `deadlineAtMs` (optional epoch ms; omitted preserves prior
 * behavior exactly) threads a caller's absolute wall-clock budget through every stage
 * that can consume material time BEFORE the bounded upstream fetch even starts --
 * cooldown check, reservation RPC, and the pacing wait a granted reservation may require.
 * Prior to this task, none of these three stages had any relationship to a caller's own
 * deadline: reserveRequestSlot alone could take up to its own 5s RPC deadline or grant a
 * wait of up to 8s (MAX_RESERVATION_LOOKAHEAD_MS), meaning "one paced request" could
 * already consume ~13s before the ~12s upstream fetch timeout even began -- the ~12s
 * figure this route's wall-clock contract assumed was never the true bound. Every check
 * here throws DeadlineExceededError (never a plain Error) so callers (fetchPmusBook,
 * discoverPmusMlbMarkets) can distinguish "my own scheduler budget ran out" from a genuine
 * upstream/venue failure and must never persist the former as evidence about the market.
 */
async function pacedGetJson<T>(path: string, deps: PmusNetworkDeps, deadlineAtMs?: number): Promise<T> {
  if (deadlineAtMs !== undefined && deps.now() >= deadlineAtMs) {
    throw new DeadlineExceededError(`${PMUS_HOST} request skipped: caller deadline already reached`);
  }
  const cooldown = await deps.getHostCooldown(PMUS_HOST);
  if (cooldown.blocked) throw new Error(`${PMUS_HOST} is in cooldown: ${cooldown.reason ?? "unknown reason"}`);
  if (deadlineAtMs !== undefined && deps.now() >= deadlineAtMs) {
    throw new DeadlineExceededError(`${PMUS_HOST} request skipped: caller deadline reached after cooldown check`);
  }

  // reserveRequestSlot itself throws DeadlineExceededError if the RPC would run past
  // deadlineAtMs, or if a genuinely granted wait would land at/after it -- see its own doc
  // comment in http-rate-limit.server.ts.
  const waitMs = await deps.reserveRequestSlot(PMUS_HOST, deadlineAtMs);
  if (waitMs > 0) await sleep(waitMs);
  if (deadlineAtMs !== undefined && deps.now() >= deadlineAtMs) {
    throw new DeadlineExceededError(`${PMUS_HOST} request skipped: caller deadline reached after pacing wait`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await deps.fetchImpl(`${PMUS_PUBLIC_BASE}${path}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status === 429) {
      // CODEX P2-2: the fetch that just returned 429 was already in flight (an accepted
      // overrun -- see this module's own worst-case contract). recordHostRateLimit IS a
      // new operation starting after it, but it is already hard-bounded to
      // COOLDOWN_WRITE_DEADLINE_MS (5s, via a real AbortController in
      // http-rate-limit.server.ts) regardless of THIS caller's own deadline -- there was
      // never an unbounded-wait reason to skip it. Previously skipped entirely once
      // deadlineAtMs had passed, which silently discarded an ALREADY-OBSERVED 429 fact
      // (no cooldown written, no telemetry recorded) -- the very next cycle could
      // immediately re-hit a host known to be rate-limiting this application. Always
      // recorded now; a genuine persistence failure surfaces as its own NETWORK telemetry
      // event (see wrapRecordHostRateLimitWithTelemetry) rather than disappearing.
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
 * Paginates GET /v2/leagues/mlb/events?... (stopping at a short/empty page or
 * DISCOVERY_MAX_PAGES, whichever comes first), classifies every event's markets via the
 * pure `eventToCandidates`, and deduplicates by marketSlug (a retried/overlapping page can
 * never produce two candidates for the same market). This is catalog data ONLY — never used
 * for live book/quote data, which fetchPmusBook always fetches fresh (see its own doc
 * comment for why the two caches are kept semantically separate).
 *
 * CANARY-6 / PM-US discovery truncation: the previous implementation scanned
 * `/v1/events?category=sports`, an all-sports catalog where the live API ignores attempted
 * `league`, `sport`, `seriesSlug`, and `tag` filters. Production proved that catalog can
 * remain full through the 10-page safety cap, leaving PM-US pending signals untouched. A
 * live read-only probe on 2026-08-25 confirmed the MLB league endpoint now carries the same
 * `marketSides` orientation data this resolver requires, so discovery narrows at the server
 * while preserving the existing fail-closed page cap.
 */
export async function discoverPmusSportsMarkets(deps: Partial<PmusNetworkDeps> = {}, deadlineAtMs?: number): Promise<PmusCandidate[]> {
  const d: PmusNetworkDeps = { ...defaultDeps, ...deps };
  const now = d.now();
  // Task 13I / P1-S: a cache hit is allowed only if the caller is still within its own
  // deadline -- if not, fall through into the discovery loop below rather than returning
  // early, so the SAME deadline check at the top of that loop uniformly reports
  // DeadlineExceededError instead of silently serving a "successful" cached result to a
  // caller that could not actually prove it had time to ask.
  if (discoveryCache && discoveryCache.expiresAt > now && (deadlineAtMs === undefined || now < deadlineAtMs)) {
    return discoveryCache.value;
  }

  const byMarketSlug = new Map<string, PmusCandidate>();
  // Sport-agnostic: one bounded league pass per registered adapter with a PM-US catalog
  // path (see ./sport-registry). Completeness is proven PER LEAGUE with the same
  // fail-closed page-cap rule as before, so one sport's truncation can never be laundered
  // into a "complete" multi-sport catalog.
  for (const leagueSegment of pmusDiscoveryLeagues()) {
  // Task 12I / P2-P2: PM-US uses fixed offset/page-size pagination (no continuation
  // cursor), so a FULL final page (events.length === DISCOVERY_PAGE_SIZE) at the page cap
  // proves nothing -- there could be an unread page 11 sitting right behind it. Only a
  // SHORT final page (< DISCOVERY_PAGE_SIZE) proves the catalog is exhausted. Same
  // completeness-flag pattern as kalshi.server.ts's paginate: stays true only when every
  // one of the DISCOVERY_MAX_PAGES iterations ran full, i.e. the loop ended purely
  // because the page budget ran out, never because pagination naturally proved complete.
  let pageBudgetExhausted = true;
  for (let page = 0; page < DISCOVERY_MAX_PAGES; page += 1) {
    // Task 13I / P1-S: checked before EVERY page, including the first -- a deadline
    // exhaustion here is NEITHER a malformed response NOR genuine backlog truncation
    // (pageBudgetExhausted below); it must never be conflated with either, so it is a
    // distinct thrown type the caller (resolveVenuePending) can recognize and treat as
    // "defer, not evidence" rather than "this venue's discovery failed."
    if (deadlineAtMs !== undefined && d.now() >= deadlineAtMs) {
      throw new DeadlineExceededError(`PM-US discovery aborted: caller deadline reached before page ${page}`);
    }
    // Task 12F / P1-G: a full discovery pass can take up to DISCOVERY_MAX_PAGES * 12s --
    // checked BEFORE each page fetch so a lease lost mid-pagination stops issuing further
    // requests immediately rather than completing an unbounded discovery pass under a
    // stale fence.
    if (!(await d.checkpointLease())) {
      throw new Error("PM-US discovery aborted: source lease lost mid-pagination");
    }
    // Task 13I / P1-S: re-checked immediately after the lease checkpoint -- that call can
    // itself perform a real renewal RPC, mirroring the identical renewal-latency fix
    // already established throughout source-poll.server.ts and worker.server.ts.
    if (deadlineAtMs !== undefined && d.now() >= deadlineAtMs) {
      throw new DeadlineExceededError(`PM-US discovery aborted: caller deadline reached after lease checkpoint`);
    }
    const offset = page * DISCOVERY_PAGE_SIZE;
    const json = await pacedGetJson<{ events?: unknown }>(
      `${pmusLeagueEventsEndpoint(leagueSegment)}?limit=${DISCOVERY_PAGE_SIZE}&offset=${offset}&active=true&closed=false`,
      d,
      deadlineAtMs,
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
    if (events.length < DISCOVERY_PAGE_SIZE) {
      pageBudgetExhausted = false;
      break;
    }
  }
  if (pageBudgetExhausted) {
    throw new Error(
      `PM-US MLB discovery truncated: DISCOVERY_MAX_PAGES (${DISCOVERY_MAX_PAGES}) exhausted while the final page was still full (${DISCOVERY_PAGE_SIZE} events) -- completeness unproven, refusing to return/cache a partial catalog`,
    );
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
export async function fetchPmusBook(
  marketSlug: string,
  deps: Partial<PmusNetworkDeps> = {},
  deadlineAtMs?: number,
): Promise<BookSnapshot> {
  const d: PmusNetworkDeps = { ...defaultDeps, ...deps };
  // Task 12E / P1-E: observedAt must reflect when THIS book became observable to the
  // collector, not when the request started. pacedGetJson may wait out a rate-limit
  // reservation and then spend up to REQUEST_TIMEOUT_MS on the network round trip, so
  // capturing d.now() before it and reusing that value understates detection latency by
  // however long the fetch actually took -- silently corrupting the +0/+5/+10/+30/+60
  // timing measurements this whole subsystem exists to produce. d.now() is therefore
  // called again on EVERY exit path (success and failure), after the awaited work.
  try {
    const json = await pacedGetJson<unknown>(`/v1/markets/${encodeURIComponent(marketSlug)}/book`, d, deadlineAtMs);
    return normalizePmusBook(json, marketSlug, d.now());
  } catch (err) {
    // Task 13I / P1-T, Section 7: a caller-deadline exhaustion is NOT evidence about the
    // market -- it must never be captured as a stale/failed BookSnapshot. Re-throw so the
    // caller (takeDueSportsShadowObservations) can leave the due observation row untouched.
    if (err instanceof DeadlineExceededError) throw err;
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
