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

import { KALSHI_BASE_URL } from "./kalshi.server";
import { runtimeFetch } from "./runtime-fetch.server";
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

/**
 * Bounded, read-only, unauthenticated GET. Never throws -- a network failure IS the
 * capability signal, not an exception the caller must handle separately. Parses the
 * body once here (never re-fetched by the caller just to inspect its shape).
 */
async function probeGet(url: string, fetchImpl: typeof fetch): Promise<{ ok: boolean; status: number | null; detail: string | null; json: unknown | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: controller.signal });
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

export type CapabilityProbeDeps = { fetchImpl: typeof fetch; repo: CapabilityRepository };
const defaultDeps: CapabilityProbeDeps = { fetchImpl: runtimeFetch, repo: supabaseCapabilityRepository };

/**
 * Probes PM-US: /v1/events (discovery) and one real market's /book (orderbook) --
 * reuses whatever the discovery probe just found rather than hardcoding a market slug,
 * so this never depends on a specific market staying listed.
 */
export async function probePmusCapability(deps: Partial<CapabilityProbeDeps> = {}): Promise<VenueCapabilityRow> {
  const d = { ...defaultDeps, ...deps };
  const discovery = await probeGet(`${PMUS_PUBLIC_BASE}/v1/events?limit=1&active=true&closed=false&category=sports`, d.fetchImpl);
  let orderbookAvailable = false;
  let orderbookDetail: string | null = "no discovered market to probe";
  if (discovery.ok) {
    // Extracts a slug from the ALREADY-FETCHED discovery response to probe /book
    // against a real, currently-listed market -- never invents/guesses a slug, never
    // re-issues the discovery request just to inspect its shape.
    const json = discovery.json as { events?: { markets?: { slug?: string }[] }[] } | null;
    const slug = json?.events?.[0]?.markets?.[0]?.slug;
    if (slug) {
      const book = await probeGet(`${PMUS_PUBLIC_BASE}/v1/markets/${encodeURIComponent(slug)}/book`, d.fetchImpl);
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
  const discovery = await probeGet(`${KALSHI_BASE_URL}/markets?series_ticker=KXMLBGAME&status=open&limit=1`, d.fetchImpl);
  let orderbookAvailable = false;
  let orderbookDetail: string | null = "no discovered market to probe";
  if (discovery.ok) {
    const json = discovery.json as { markets?: { ticker?: string }[] } | null;
    const ticker = json?.markets?.[0]?.ticker;
    if (ticker) {
      const book = await probeGet(`${KALSHI_BASE_URL}/markets/${encodeURIComponent(ticker)}/orderbook`, d.fetchImpl);
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
