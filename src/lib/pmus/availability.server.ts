/**
 * Periodic PUBLIC Polymarket US weather-market availability scan.
 *
 * Bounded and cached: it reuses the cached open-market snapshot from
 * us-markets.server and filters it locally. No credentials, no signing.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { isRelevantWeatherMarket, shouldRunAvailabilityScan } from "./automation";
import { safeErrorMessage } from "./redact";
import { fetchOpenUsMarkets } from "./us-markets.server";

export type AvailabilityScan = {
  scannedAt: string;
  status: string;
  relevantCount: number;
  newCount: number;
  slugs: string[];
  detail: string | null;
};

export async function latestAvailabilityScan(): Promise<AvailabilityScan | null> {
  const { data } = await supabaseAdmin
    .from("us_market_scans")
    .select("*")
    .order("scanned_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    scannedAt: data.scanned_at,
    status: data.status,
    relevantCount: data.relevant_count,
    newCount: data.new_count,
    slugs: Array.isArray(data.slugs) ? (data.slugs as string[]) : [],
    detail: data.detail,
  };
}

/** Timestamp of the most recent scan that discovered new relevant markets. */
export async function lastNewMarketsAt(): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("us_market_scans")
    .select("scanned_at")
    .gt("new_count", 0)
    .order("scanned_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.scanned_at ?? null;
}

/**
 * Runs at most once per SCAN_INTERVAL_MS. Returns the newest scan either way,
 * so callers can always render current availability.
 */
export async function runAvailabilityScan(
  opts: { force?: boolean } = {},
): Promise<AvailabilityScan | null> {
  const previous = await latestAvailabilityScan();
  if (!opts.force && !shouldRunAvailabilityScan(previous?.scannedAt ?? null)) return previous;

  const scannedAt = new Date().toISOString();
  try {
    const markets = await fetchOpenUsMarkets();
    const slugs = markets
      .filter((m) => isRelevantWeatherMarket(m))
      .map((m) => m.slug)
      .filter((s): s is string => Boolean(s))
      .sort();
    const known = new Set(previous?.slugs ?? []);
    const newSlugs = slugs.filter((s) => !known.has(s));

    const scan: AvailabilityScan = {
      scannedAt,
      status: "ok",
      relevantCount: slugs.length,
      newCount: newSlugs.length,
      slugs,
      detail: `Scanned ${markets.length} open Polymarket US markets for weather/climate terms.`,
    };
    await persist(scan);
    return scan;
  } catch (err) {
    const scan: AvailabilityScan = {
      scannedAt,
      status: "failed",
      relevantCount: previous?.relevantCount ?? 0,
      newCount: 0,
      slugs: previous?.slugs ?? [],
      detail: safeErrorMessage(err),
    };
    await persist(scan);
    return scan;
  }
}

async function persist(scan: AvailabilityScan): Promise<void> {
  await supabaseAdmin.from("us_market_scans").insert({
    scanned_at: scan.scannedAt,
    status: scan.status,
    relevant_count: scan.relevantCount,
    new_count: scan.newCount,
    slugs: scan.slugs as never,
    detail: scan.detail,
  } as never);
}
