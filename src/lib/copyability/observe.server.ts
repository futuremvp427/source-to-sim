/**
 * SERVER-ONLY copyability observation collector.
 *
 * Samples the PUBLIC Polymarket CLOB order book for every post-go-live source
 * fill at detection and again at +30s, +60s, +5m and +15m. Nothing here signs,
 * authenticates or places an order. Missing samples are persisted as null.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { fetchAllRows } from "../db-pagination";
import { computeBuySize } from "../shadow-core";
import {
  SAMPLE_DELAYS,
  computeObservation,
  copyabilityScore,
  median,
  type CopyabilityScore,
  type ObservationLite,
  type SampleDelay,
  type Side,
} from "./core";

/** A sample taken more than this late is not the requested delay — stored as unavailable. */
export const SAMPLE_TOLERANCE_SECONDS = 150;
const SCHEDULE_BATCH = 40;
/**
 * Sampling throughput, not the standard, was the limit on completeness: at 25
 * sequential single-book fetches per cycle the due queue grew faster than it
 * drained, so nearly every sample aged past SAMPLE_TOLERANCE_SECONDS and was
 * (correctly) recorded as unavailable. Books are now read in one batched public
 * request, so a whole due batch costs a single round trip.
 */
const SAMPLE_BATCH = 200;

type ScheduleSource = {
  event_key: string;
  source_event_id: string | null;
  asset: string;
  market_title: string | null;
  side: string | null;
  price: number | null;
  shares: number | null;
  source_ts: number | null;
  created_at: string;
};

/**
 * One pending row per (experiment, event, delay). The unique constraint makes
 * repeated cycles idempotent, and rows are never shared between experiments.
 */
async function scheduleObservations(experiment: {
  id: string;
  starting_cash: number;
  cash: number;
}): Promise<number> {
  const { data: trades } = await supabaseAdmin
    .from("paper_trades")
    .select("event_key, source_event_id, asset, market_title, side, price, shares, source_ts, created_at")
    .eq("experiment_id", experiment.id)
    .order("created_at", { ascending: false })
    .limit(SCHEDULE_BATCH);
  const rows = (trades ?? []) as unknown as ScheduleSource[];
  if (rows.length === 0) return 0;

  const { data: existing } = await supabaseAdmin
    .from("copyability_observations")
    .select("event_key")
    .eq("experiment_id", experiment.id)
    .in(
      "event_key",
      rows.map((r) => r.event_key),
    );
  const already = new Set((existing ?? []).map((r) => r.event_key));
  const size = computeBuySize({ startingCash: Number(experiment.starting_cash), cash: Number(experiment.cash) });
  const notional = size.ok ? size.amount : 1;

  const inserts: Record<string, unknown>[] = [];
  for (const r of rows) {
    if (already.has(r.event_key)) continue;
    const side: Side = r.side === "SELL" ? "SELL" : "BUY";
    const price = r.price === null ? null : Number(r.price);
    const shares = Number(r.shares ?? 0);
    const requiredShares = shares > 0 ? shares : price && price > 0 ? notional / price : null;
    const detectedMs = new Date(r.created_at).getTime();
    for (const { delay, seconds } of SAMPLE_DELAYS) {
      inserts.push({
        experiment_id: experiment.id,
        event_key: r.event_key,
        source_event_id: r.source_event_id,
        asset: r.asset,
        market_title: r.market_title,
        side,
        leader_price: price,
        source_ts: r.source_ts,
        detected_at: r.created_at,
        sample_delay: delay,
        delay_seconds: seconds,
        scheduled_at: new Date(detectedMs + seconds * 1000).toISOString(),
        required_shares: requiredShares,
        status: "pending",
      });
    }
  }
  if (inserts.length === 0) return 0;
  const { data } = await supabaseAdmin
    .from("copyability_observations")
    .upsert(inserts as never, { onConflict: "experiment_id,event_key,sample_delay", ignoreDuplicates: true })
    .select("id");
  return data?.length ?? 0;
}

/** Take every due sample for this experiment. Failures persist as unavailable. */
async function takeDueSamples(experimentId: string): Promise<{ sampled: number; unavailable: number }> {
  const nowMs = Date.now();
  const { data: due } = await supabaseAdmin
    .from("copyability_observations")
    .select("id, asset, side, leader_price, required_shares, scheduled_at")
    .eq("experiment_id", experimentId)
    .eq("status", "pending")
    .lte("scheduled_at", new Date(nowMs).toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(SAMPLE_BATCH);
  const rows = due ?? [];
  if (rows.length === 0) return { sampled: 0, unavailable: 0 };

  const inTolerance = rows.filter(
    (r) => (nowMs - new Date(r.scheduled_at as string).getTime()) / 1000 <= SAMPLE_TOLERANCE_SECONDS,
  );
  const { fetchBooksBatched } = await import("../clob-books.server");
  const books = inTolerance.length
    ? await fetchBooksBatched(inTolerance.map((r) => r.asset as string))
    : new Map();
  let sampled = 0;
  let unavailable = 0;

  for (const row of rows) {
    const lateBy = (nowMs - new Date(row.scheduled_at as string).getTime()) / 1000;
    if (lateBy > SAMPLE_TOLERANCE_SECONDS) {
      await supabaseAdmin
        .from("copyability_observations")
        .update({ status: "unavailable", observed_at: new Date().toISOString() })
        .eq("id", row.id);
      unavailable += 1;
      continue;
    }
    const book = books.get(row.asset as string) ?? null;
    if (book === null) {
      await supabaseAdmin
        .from("copyability_observations")
        .update({ status: "unavailable", observed_at: new Date().toISOString() })
        .eq("id", row.id);
      unavailable += 1;
      continue;
    }
    const side: Side = row.side === "SELL" ? "SELL" : "BUY";
    const math = computeObservation({
      side,
      leaderPrice: row.leader_price === null ? null : Number(row.leader_price),
      requiredShares: row.required_shares === null ? null : Number(row.required_shares),
      sample: {
        bestBid: book.bid,
        bestAsk: book.ask,
        midpoint: null,
        visibleDepth: side === "BUY" ? book.askDepth : book.bidDepth,
      },
    });
    await supabaseAdmin
      .from("copyability_observations")
      .update({
        status: "observed",
        observed_at: new Date().toISOString(),
        best_bid: book.bid,
        best_ask: book.ask,
        midpoint: math.midpoint,
        spread: math.spread,
        follower_price: math.followerPrice,
        visible_depth: side === "BUY" ? book.askDepth : book.bidDepth,
        slippage_cents: math.slippageCents,
        slippage_pct: math.slippagePct,
        price_direction: math.priceDirection,
        improved: math.improved,
        fillable: math.fillable,
      })
      .eq("id", row.id);
    sampled += 1;
  }
  return { sampled, unavailable };
}

export async function runCopyabilityPass(experiment: {
  id: string;
  starting_cash: number;
  cash: number;
}): Promise<{ scheduled: number; sampled: number; unavailable: number }> {
  const scheduled = await scheduleObservations(experiment);
  const taken = await takeDueSamples(experiment.id);
  return { scheduled, ...taken };
}

export type CopyabilitySummary = CopyabilityScore & {
  medianSlippageCentsByDelay: Partial<Record<SampleDelay, number | null>>;
};

/** Read model: the copyability score for one isolated experiment. */
export async function summarizeCopyability(experimentId: string): Promise<CopyabilitySummary> {
  // Paged: a single PostgREST request returns at most 1000 rows, which would
  // silently understate the observation set for busy experiments.
  const { rows } = await fetchAllRows(async (from, to) => {
    const { data, error } = await supabaseAdmin
      .from("copyability_observations")
      .select("event_key, sample_delay, slippage_pct, slippage_cents, spread, fillable, status")
      .eq("experiment_id", experimentId)
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw new Error(error.message);
    return data ?? [];
  });
  const observations: ObservationLite[] = rows
    .filter((r) => r.status === "observed")
    .map((r) => ({
      eventKey: r.event_key,
      sampleDelay: r.sample_delay as SampleDelay,
      slippagePct: r.slippage_pct === null ? null : Number(r.slippage_pct),
      spread: r.spread === null ? null : Number(r.spread),
      fillable: r.fillable === null ? null : Boolean(r.fillable),
    }));
  const scheduledEvents = new Set(rows.map((r) => r.event_key)).size;
  const score = copyabilityScore({ observations, scheduledEvents });

  const centsByDelay: Partial<Record<SampleDelay, number | null>> = {};
  for (const { delay } of SAMPLE_DELAYS) {
    centsByDelay[delay] = median(
      rows
        .filter((r) => r.status === "observed" && r.sample_delay === delay && r.slippage_cents !== null)
        .map((r) => Number(r.slippage_cents)),
    );
  }
  return { ...score, medianSlippageCentsByDelay: centsByDelay };
}