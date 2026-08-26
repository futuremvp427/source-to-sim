/**
 * FINAL BUILD Part 8/4: durable venue capability state — SERVER (DB/network) layer.
 *
 * A periodic, bounded, unauthenticated probe of each venue's discovery + orderbook
 * endpoints, persisted so the rest of the system (resolveVenuePending, the router,
 * the dashboard) can consult a durable capability row instead of inferring capability
 * from the shape of a live failure. Never places an order, never sends credentials.
 * If a venue's orderbook capability degrades (e.g. starts requiring auth), the system
 * must degrade safely -- continue the OTHER venue's research, mark this one
 * unavailable, never crash, never fabricate book data.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { getHostCooldown, parseRetryAfterMs, recordHostRateLimitReporting, reserveRequestSlot } from "../http-rate-limit.server";
import { KALSHI_BASE_URL } from "./kalshi.server";
import { runtimeFetch } from "./runtime-fetch.server";
import { wrapRecordHostRateLimitWithTelemetry } from "./telemetry.server";
import type { Venue } from "./types";
import { PMUS_PUBLIC_BASE } from "../pmus/us-markets.server";

export type VenueCapabilityRow = {
  venue: Venue;
  discoveryAvailable: boolean;
  orderbookAvailable: boolean;
  checkedAtIso: string;
  detail: string | null;
};

export type CapabilityRepository = {
  upsert(row: Omit<VenueCapabilityRow, "checkedAtIso">): Promise<void>;
  get(venue: Venue): Promise<VenueCapabilityRow | null>;
};

export const supabaseCapabilityRepository: CapabilityRepository = {
  async upsert(row) {
    const { error } = await supabaseAdmin
      .from("sports_shadow_venue_capability" as never)
      .upsert(
        {
          venue: row.venue,
          discovery_available: row.discoveryAvailable,
          orderbook_available: row.orderbookAvailable,
          checked_at: new Date().toISOString(),
          detail: row.detail,
        } as never,
        { onConflict: "venue" },
      );
    if (error) throw new Error(error.message);
  },
  async get(venue) {
    const { data, error } = await supabaseAdmin.from("sports_shadow_venue_capability" as never).select("*").eq("venue", venue).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as unknown as { venue: Venue; discovery_available: boolean; orderbook_available: boolean; checked_at: string; detail: string | null };
    return { venue: row.venue, discoveryAvailable: row.discovery_available, orderbookAvailable: row.orderbook_available, checkedAtIso: row.checked_at, detail: row.detail };
  },
};

const PROBE_TIMEOUT_MS = 8_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded, read-only, unauthenticated GET. Never throws -- a network failure IS the
 * capability signal, not an exception the caller must handle separately. Parses the
 * body once here (never re-fetched by the caller just to inspect its shape).
 *
 * Uses the same host-level cooldown/reservation discipline as the venue discovery and
 * orderbook capture paths. Capability checks run outside the source lease and can happen
 * even with zero pending signals, so they must not become an unpaced side channel that
 * rediscovers or amplifies a Kalshi/PM-US 429.
 */
async function probeGet(url: string, deps: CapabilityProbeDeps): Promise<{ ok: boolean; status: number | null; detail: string | null; json: unknown | null }> {
  const host = new URL(url).host;
  const deadlineAtMs = Date.now() + PROBE_TIMEOUT_MS;
  try {
    const cooldown = await deps.getHostCooldown(host);
    if (cooldown.blocked) {
      return { ok: false, status: null, detail: `cooldown active: ${cooldown.reason ?? "unknown reason"}`, json: null };
    }
    if (Date.now() >= deadlineAtMs) {
      return { ok: false, status: null, detail: "capability probe deadline reached after cooldown check", json: null };
    }
    const waitMs = await deps.reserveRequestSlot(host, deadlineAtMs);
    if (waitMs > 0) await sleep(waitMs);
    if (Date.now() >= deadlineAtMs) {
      return { ok: false, status: null, detail: "capability probe deadline reached after request pacing", json: null };
    }
  } catch (err) {
    return { ok: false, status: null, detail: err instanceof Error ? err.message : "host pacing unavailable", json: null };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadlineAtMs - Date.now()));
  try {
    const response = await deps.fetchImpl(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (response.status === 429) {
      let recordError: string | null = null;
      try {
        await deps.recordHostRateLimit(host, parseRetryAfterMs(response.headers.get("retry-after")));
      } catch (err) {
        recordError = err instanceof Error ? err.message : "unknown cooldown persistence failure";
      }
      return {
        ok: false,
        status: response.status,
        detail: recordError ? `HTTP 429; cooldown persistence failed: ${recordError}` : "HTTP 429",
        json: null,
      };
    }
    if (!response.ok) return { ok: false, status: response.status, detail: `HTTP ${response.status}`, json: null };
    try {
      return { ok: true, status: response.status, detail: null, json: await response.json() };
    } catch (err) {
      return { ok: false, status: response.status, detail: `malformed JSON: ${err instanceof Error ? err.message : "unknown"}`, json: null };
    }
  } catch (err) {
    return { ok: false, status: null, detail: err instanceof Error ? err.message : "unknown probe failure", json: null };
  } finally {
    clearTimeout(timer);
  }
}

export type CapabilityProbeDeps = {
  fetchImpl: typeof fetch;
  repo: CapabilityRepository;
  reserveRequestSlot: (host: string, deadlineAtMs?: number) => Promise<number>;
  getHostCooldown: (host: string) => Promise<{ blocked: boolean; reason: string | null }>;
  recordHostRateLimit: (host: string, retryAfterMs: number | null) => Promise<void>;
};
const defaultDeps: CapabilityProbeDeps = {
  fetchImpl: runtimeFetch,
  repo: supabaseCapabilityRepository,
  reserveRequestSlot,
  getHostCooldown,
  recordHostRateLimit: wrapRecordHostRateLimitWithTelemetry(recordHostRateLimitReporting),
};

/**
 * Probes PM-US: /v1/events (discovery) and one real market's /book (orderbook) --
 * reuses whatever the discovery probe just found rather than hardcoding a market slug,
 * so this never depends on a specific market staying listed.
 */
export async function probePmusCapability(deps: Partial<CapabilityProbeDeps> = {}): Promise<VenueCapabilityRow> {
  const d = { ...defaultDeps, ...deps };
  const discovery = await probeGet(`${PMUS_PUBLIC_BASE}/v1/events?limit=1&active=true&closed=false&category=sports`, d);
  let orderbookAvailable = false;
  let orderbookDetail: string | null = "no discovered market to probe";
  if (discovery.ok) {
    // Extracts a slug from the ALREADY-FETCHED discovery response to probe /book
    // against a real, currently-listed market -- never invents/guesses a slug, never
    // re-issues the discovery request just to inspect its shape.
    const json = discovery.json as { events?: { markets?: { slug?: string }[] }[] } | null;
    const slug = json?.events?.[0]?.markets?.[0]?.slug;
    if (slug) {
      const book = await probeGet(`${PMUS_PUBLIC_BASE}/v1/markets/${encodeURIComponent(slug)}/book`, d);
      orderbookAvailable = book.ok;
      orderbookDetail = book.detail;
    }
  }
  const row: VenueCapabilityRow = {
    venue: "PMUS",
    discoveryAvailable: discovery.ok,
    orderbookAvailable,
    checkedAtIso: new Date().toISOString(),
    detail: discovery.ok ? orderbookDetail : discovery.detail,
  };
  await d.repo.upsert(row);
  return row;
}

/** Probes Kalshi: /markets (discovery) and one real market's /orderbook -- same reused-slug approach as PM-US. */
export async function probeKalshiCapability(deps: Partial<CapabilityProbeDeps> = {}): Promise<VenueCapabilityRow> {
  const d = { ...defaultDeps, ...deps };
  const discovery = await probeGet(`${KALSHI_BASE_URL}/markets?series_ticker=KXMLBGAME&status=open&limit=1`, d);
  let orderbookAvailable = false;
  let orderbookDetail: string | null = "no discovered market to probe";
  if (discovery.ok) {
    const json = discovery.json as { markets?: { ticker?: string }[] } | null;
    const ticker = json?.markets?.[0]?.ticker;
    if (ticker) {
      const book = await probeGet(`${KALSHI_BASE_URL}/markets/${encodeURIComponent(ticker)}/orderbook`, d);
      orderbookAvailable = book.ok;
      orderbookDetail = book.detail;
    }
  }
  const row: VenueCapabilityRow = {
    venue: "KALSHI",
    discoveryAvailable: discovery.ok,
    orderbookAvailable,
    checkedAtIso: new Date().toISOString(),
    detail: discovery.ok ? orderbookDetail : discovery.detail,
  };
  await d.repo.upsert(row);
  return row;
}

/**
 * ============ SOAK INCIDENT (2026-08-22): CAPABILITY WAS NEVER PROBED ============
 * PROVEN root cause of the empty sports_shadow_venue_capability table: probePmusCapability
 * and probeKalshiCapability had NO call site anywhere in the codebase -- capability was
 * never probed at all, so this was NOT a downstream effect of the starvation bug and the
 * dashboard's "not yet checked" state was literally accurate. This refresher gives them a
 * real, bounded, cached cadence during the operational soak, independent of whether any
 * signal exists yet.
 * ================================================================================
 */
export const CAPABILITY_PROBE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Probes at most the two venues, sequentially (never concurrent fan-out -- Cloudflare
 * connection discipline), and only when that venue's durable row is missing or older than
 * CAPABILITY_PROBE_MAX_AGE_MS. Never throws: a probe failure is itself a capability signal
 * for that venue only and must never break the cycle.
 */
export async function refreshVenueCapabilityIfStale(now: number = Date.now(), deps: Partial<CapabilityProbeDeps> = {}): Promise<VenueCapabilityRow[]> {
  const d = { ...defaultDeps, ...deps };
  const refreshed: VenueCapabilityRow[] = [];
  const probes: [Venue, () => Promise<VenueCapabilityRow>][] = [
    ["PMUS", () => probePmusCapability(d)],
    ["KALSHI", () => probeKalshiCapability(d)],
  ];
  for (const [venue, probe] of probes) {
    try {
      const existing = await d.repo.get(venue);
      const ageMs = existing === null ? Number.POSITIVE_INFINITY : now - Date.parse(existing.checkedAtIso);
      if (Number.isFinite(ageMs) && ageMs < CAPABILITY_PROBE_MAX_AGE_MS) continue;
      refreshed.push(await probe());
    } catch {
      // Per-venue best-effort: the other venue is still attempted, and the cycle proceeds.
    }
  }
  return refreshed;
}
