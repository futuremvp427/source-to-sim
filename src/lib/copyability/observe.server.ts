/**
 * SERVER-ONLY copyability observation collector.
 *
 * Samples the PUBLIC Polymarket CLOB order book for every post-go-live source
 * fill at detection and again at +30s, +60s, +5m and +15m. Nothing here signs,
 * authenticates or places an order. Missing samples are persisted as null.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { fetchAllRowsAfterId } from "../db-pagination";
import { computeBuySize } from "../shadow-core";
import {
  SAMPLE_DELAYS,
  computeObservation,
  copyabilityScore,
  median,
  nextCursorFor,
  type CopyabilityScore,
  type CursorPosition,
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
  id: string;
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
 * Durable scheduling cursor stored on paper_experiments. A latest-N-window
 * scan can permanently strand older unscheduled trades once backlog exceeds
 * the window; the cursor instead walks paper_trades forward exactly once per
 * row in stable (created_at, id) order, so any backlog size is eventually
 * fully covered.
 */
async function loadScheduleCursor(experimentId: string): Promise<CursorPosition | null> {
  const { data } = await supabaseAdmin
    .from("paper_experiments")
    .select("copyability_cursor_created_at, copyability_cursor_id")
    .eq("id", experimentId)
    .maybeSingle();
  const row = data as { copyability_cursor_created_at?: string | null; copyability_cursor_id?: string | null } | null;
  if (!row?.copyability_cursor_created_at || !row.copyability_cursor_id) return null;
  return { createdAt: row.copyability_cursor_created_at, id: row.copyability_cursor_id };
}

/**
 * One pending row per (experiment, event, delay). The unique constraint makes
 * repeated cycles idempotent, and rows are never shared between experiments.
 */
export async function scheduleObservations(experiment: {
  id: string;
  starting_cash: number;
  cash: number;
  /** General Shadow samples immediate/+30s/+60s only (storage-bounded cohort). */
  delays?: readonly SampleDelay[];
}): Promise<number> {
  const wantedDelays = experiment.delays
    ? SAMPLE_DELAYS.filter((d) => experiment.delays!.includes(d.delay))
    : SAMPLE_DELAYS;

  const cursor = await loadScheduleCursor(experiment.id);
  let query = supabaseAdmin
    .from("paper_trades")
    .select("id, event_key, source_event_id, asset, market_title, side, price, shares, source_ts, created_at")
    .eq("experiment_id", experiment.id)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(SCHEDULE_BATCH);
  if (cursor) {
    // Tuple cursor (created_at, id) > (cursor.createdAt, cursor.id), expressed as
    // PostgREST's or(...)/and(...) combinator since a composite comparison has
    // no direct .gt() equivalent on two columns.
    query = query.or(`created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`);
  }
  const { data: trades, error } = await query;
  if (error) throw new Error(error.message);
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
    for (const { delay, seconds } of wantedDelays) {
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

  let insertedCount = 0;
  if (inserts.length > 0) {
    const { data, error: upsertError } = await supabaseAdmin
      .from("copyability_observations")
      .upsert(inserts as never, { onConflict: "experiment_id,event_key,sample_delay", ignoreDuplicates: true })
      .select("id");
    if (upsertError) throw new Error(upsertError.message);
    insertedCount = data?.length ?? 0;
  }

  // Advance the cursor ONLY after this page's scheduling persistence succeeds
  // (including the "nothing new to insert" case, which is still a fully
  // scanned page — advancing here is what prevents rescanning it forever).
  const nextCursor = nextCursorFor(rows.map((r) => ({ createdAt: r.created_at, id: r.id })));
  if (nextCursor) {
    const { error: cursorError } = await supabaseAdmin
      .from("paper_experiments")
      .update({
        copyability_cursor_created_at: nextCursor.createdAt,
        copyability_cursor_id: nextCursor.id,
      } as never)
      .eq("id", experiment.id);
    if (cursorError) throw new Error(`Failed to persist copyability scheduling cursor: ${cursorError.message}`);
  }

  return insertedCount;
}

/** Take every due sample for this experiment. Failures persist as unavailable. */
export async function takeDueSamples(experimentId: string): Promise<{ sampled: number; unavailable: number }> {
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
      if (await claimObservationTransition(row.id, { status: "unavailable", observed_at: new Date().toISOString() })) {
        unavailable += 1;
      }
      continue;
    }
    const book = books.get(row.asset as string) ?? null;
    if (book === null) {
      if (await claimObservationTransition(row.id, { status: "unavailable", observed_at: new Date().toISOString() })) {
        unavailable += 1;
      }
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
    const claimed = await claimObservationTransition(row.id, {
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
    });
    if (claimed) sampled += 1;
  }
  return { sampled, unavailable };
}

/**
 * Compare-and-set: only a row still status='pending' may transition. Two
 * overlapping observation workers can both select the same due row; the
 * WHERE-status guard plus checking the returned row makes exactly one
 * worker's write win. The loser's returned row set is empty, so it must not
 * count the sample or overwrite the winner's observed_at/slippage/status.
 * Exported so the race itself is directly testable without a database.
 */
export async function claimObservationTransition(
  id: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("copyability_observations")
    .update(patch as never)
    .eq("id", id)
    .eq("status", "pending")
    .select("id");
  if (error) throw new Error(error.message);
  return (data?.length ?? 0) > 0;
}

export async function runCopyabilityPass(experiment: {
  id: string;
  starting_cash: number;
  cash: number;
  delays?: readonly SampleDelay[];
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
  // silently understate the observation set for busy experiments. Keyset (not
  // OFFSET) paging: this history reaches tens of thousands of rows per
  // experiment, where deep OFFSET pages exceed the role statement_timeout.
  const { rows } = await fetchAllRowsAfterId(async (afterId, limit) => {
    let query = supabaseAdmin
      .from("copyability_observations")
      .select("id, event_key, sample_delay, slippage_pct, slippage_cents, spread, fillable, status")
      .eq("experiment_id", experimentId);
    if (afterId !== null) query = query.gt("id", afterId);
    const { data, error } = await query.order("id", { ascending: true }).limit(limit);
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