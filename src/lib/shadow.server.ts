/**
 * SERVER-ONLY engine for the autonomous SHADOW follower.
 * Read-only against public Polymarket endpoints; writes only to our own tables.
 * There is no signing, no credential use and no order-placement path in this file.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import {
  EMPTY_POSITION,
  MARK_MAX_AGE_MS,
  applyBuy,
  applySell,
  decideBuy,
  decideProportionalSell,
  normalizeSourceEvents,
  openPnl,
  reconcileSourceState,
  replaySourcePositions,
  resolveMark,
  roundShares,
  roundUsd,
  type NormalizedEvent,
  type PaperPositionState,
  type Side,
} from "./shadow-core";

export const TARGET_WALLET = "0x8fbd7cf5f806f563080864694415829f7229a959";
export const EXPERIMENT_NAME = "SHADOW";
export const WORKER_ID = "ingest";

const DATA_API = "https://data-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";
const PAGE_SIZE = 250;
const LIVE_PAGES = 2; // bounded incremental window per poll
const BOOTSTRAP_PAGES = 4;
const LEASE_SECONDS = 180;
const MAX_MARK_REFRESH = 20;
const PROCESS_BATCH = 300;

type Json = Record<string, unknown>;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/* ------------------------------------------------------------------ */
/* HTTP helpers (public, unauthenticated)                              */
/* ------------------------------------------------------------------ */

async function getJson(url: string, attempts = 3): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) throw new Error(`${url.split("?")[0]} responded ${res.status}`);
      return (await res.json()) as unknown;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("request failed");
}

async function getArray(url: string): Promise<Json[]> {
  const json = await getJson(url);
  if (Array.isArray(json)) return json as Json[];
  if (json && typeof json === "object" && Array.isArray((json as { data?: unknown[] }).data)) {
    return (json as { data: Json[] }).data;
  }
  throw new Error(`${url.split("?")[0]} returned an unexpected shape`);
}

/* ------------------------------------------------------------------ */
/* Alerts                                                              */
/* ------------------------------------------------------------------ */

export async function raiseAlert(
  level: "info" | "warn" | "error",
  kind: string,
  message: string,
  context?: Json,
): Promise<void> {
  await supabaseAdmin.from("alerts").insert({
    level,
    kind,
    message,
    context: (context ?? null) as never,
  });
}

/* ------------------------------------------------------------------ */
/* Lease / fencing so only one worker ingests at a time                */
/* ------------------------------------------------------------------ */

export type Lease = { fence: number; workerId: string };

export async function acquireLease(workerId: string): Promise<Lease | null> {
  const { data: current } = await supabaseAdmin
    .from("worker_status")
    .select("*")
    .eq("id", WORKER_ID)
    .maybeSingle();

  const now = Date.now();
  const leaseExpires = current?.lease_expires_at ? new Date(current.lease_expires_at).getTime() : 0;
  const heldByOther = current?.worker_id && current.worker_id !== workerId && leaseExpires > now;
  if (heldByOther) return null;

  const fence = (current?.fence ?? 0) + 1;
  const { error } = await supabaseAdmin
    .from("worker_status")
    .upsert({
      id: WORKER_ID,
      worker_id: workerId,
      fence,
      state: "running",
      heartbeat_at: new Date(now).toISOString(),
      lease_expires_at: new Date(now + LEASE_SECONDS * 1000).toISOString(),
      updated_at: new Date(now).toISOString(),
    })
    .select();
  if (error) throw new Error(error.message);
  return { fence, workerId };
}

async function releaseLease(
  lease: Lease,
  patch: Partial<{
    state: string;
    last_error: string | null;
    poll_failures: number;
    events_ingested: number;
    lag_seconds: number | null;
    last_success_at: string;
  }>,
): Promise<void> {
  await supabaseAdmin
    .from("worker_status")
    .update({
      ...patch,
      heartbeat_at: new Date().toISOString(),
      last_poll_at: new Date().toISOString(),
      // Release immediately so the next scheduled poll is never blocked by a stale lease.
      lease_expires_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", WORKER_ID)
    .eq("fence", lease.fence);
}

/* ------------------------------------------------------------------ */
/* Experiment / config                                                 */
/* ------------------------------------------------------------------ */

export type Experiment = {
  id: string;
  name: string;
  wallet_address: string;
  starting_cash: number;
  cash: number;
  buy_amount: number;
  poll_interval_seconds: number;
  enabled: boolean;
  weather_only: boolean;
  realized_pnl: number;
  /** Unix seconds. Fills older than this are stored as history only, never paper-copied. */
  follow_from_ts: number | null;
};

export async function getExperiment(): Promise<Experiment> {
  const { data, error } = await supabaseAdmin
    .from("paper_experiments")
    .select("*")
    .eq("name", EXPERIMENT_NAME)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("SHADOW experiment row is missing");
  return data as unknown as Experiment;
}

/* ------------------------------------------------------------------ */
/* Ingestion                                                          */
/* ------------------------------------------------------------------ */

async function fetchSourceWindow(pages: number): Promise<{ raw: Json[]; pagesFetched: number }> {
  const base = `${DATA_API}/trades?user=${TARGET_WALLET}`;
  const raw: Json[] = [];
  let pagesFetched = 0;
  for (let p = 0; p < pages; p += 1) {
    const page = await getArray(`${base}&limit=${PAGE_SIZE}&offset=${p * PAGE_SIZE}`);
    pagesFetched += 1;
    raw.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return { raw, pagesFetched };
}

/** Insert new events only. The unique event_key makes replays idempotent. */
async function persistEvents(events: NormalizedEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const rows = events.map((e) => ({
    event_key: e.eventKey,
    wallet: e.wallet,
    tx_hash: e.txHash,
    source_native_id: e.sourceNativeId,
    log_index: e.logIndex,
    condition_id: e.conditionId,
    asset: e.asset,
    market_title: e.marketTitle,
    outcome: e.outcome,
    slug: e.slug,
    side: e.side,
    shares: e.shares,
    price: e.price,
    source_ts: e.sourceTs,
    identity_basis: e.identityBasis,
    identity_degraded: e.identityDegraded,
    raw: e.raw as never,
  }));
  const { data, error } = await supabaseAdmin
    .from("source_events")
    .upsert(rows, { onConflict: "event_key", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}

/* ------------------------------------------------------------------ */
/* Follower pass over unprocessed events                               */
/* ------------------------------------------------------------------ */

type SourceEventRow = {
  id: string;
  event_key: string;
  asset: string;
  market_title: string;
  outcome: string | null;
  side: string;
  shares: number;
  price: number;
  source_ts: number;
};

type PaperPositionRow = {
  asset: string;
  shares: number;
  cost_basis: number;
  avg_price: number;
  realized_pnl: number;
};

export type ProcessResult = {
  processed: number;
  buys: number;
  sells: number;
  skips: number;
  /** Pre-go-live fills recorded for history/reconciliation only. */
  backfilled: number;
};

async function processPendingEvents(experiment: Experiment): Promise<ProcessResult> {
  const { data: pending, error } = await supabaseAdmin
    .from("source_events")
    .select("id, event_key, asset, market_title, outcome, side, shares, price, source_ts")
    .is("processed_at", null)
    .order("source_ts", { ascending: true })
    .order("event_key", { ascending: true })
    .limit(PROCESS_BATCH);
  if (error) throw new Error(error.message);
  const rows = (pending ?? []) as SourceEventRow[];
  if (rows.length === 0) return { processed: 0, buys: 0, sells: 0, skips: 0, backfilled: 0 };
  const followFrom = experiment.follow_from_ts ?? 0;

  const assets = [...new Set(rows.map((r) => r.asset))];

  const { data: sourceStateRows } = await supabaseAdmin
    .from("source_position_state")
    .select("asset, shares")
    .eq("wallet", TARGET_WALLET)
    .in("asset", assets);
  const sourceShares = new Map<string, number>();
  for (const r of sourceStateRows ?? []) sourceShares.set(r.asset, Number(r.shares));

  const { data: paperRows } = await supabaseAdmin
    .from("paper_positions")
    .select("asset, shares, cost_basis, avg_price, realized_pnl")
    .eq("experiment_id", experiment.id)
    .in("asset", assets);
  const paper = new Map<string, PaperPositionState>();
  for (const r of (paperRows ?? []) as PaperPositionRow[]) {
    paper.set(r.asset, {
      shares: Number(r.shares),
      costBasis: Number(r.cost_basis),
      avgPrice: Number(r.avg_price),
      realizedPnl: Number(r.realized_pnl),
    });
  }

  let cash = Number(experiment.cash);
  let realizedTotal = Number(experiment.realized_pnl);
  const result: ProcessResult = { processed: 0, buys: 0, sells: 0, skips: 0, backfilled: 0 };
  const backfilledIds: string[] = [];
  const meta = new Map<string, { title: string; outcome: string | null; ts: number }>();
  const tradeRows: Record<string, unknown>[] = [];
  const processedIds: string[] = [];

  for (const row of rows) {
    const side = (row.side === "SELL" ? "SELL" : "BUY") as Side;
    const price = Number(row.price);
    const srcShares = Number(row.shares);
    const before = sourceShares.has(row.asset) ? (sourceShares.get(row.asset) as number) : null;
    const position = paper.get(row.asset) ?? EMPTY_POSITION;
    meta.set(row.asset, { title: row.market_title, outcome: row.outcome, ts: Number(row.source_ts) });

    // Advance source state for pre-go-live history, but never spend simulated cash on it.
    const nextSourceForRow =
      side === "BUY" ? (before ?? 0) + srcShares : Math.max(0, (before ?? 0) - srcShares);

    if (Number(row.source_ts) < followFrom) {
      sourceShares.set(row.asset, roundShares(nextSourceForRow));
      processedIds.push(row.id);
      backfilledIds.push(row.id);
      result.backfilled += 1;
      result.processed += 1;
      continue;
    }

    const decision =
      side === "BUY"
        ? decideBuy({ price, buyAmount: Number(experiment.buy_amount), availableCash: cash })
        : decideProportionalSell({
            price,
            sourceSharesBefore: before,
            sourceSoldShares: srcShares,
            paperShares: position.shares,
          });

    let cashAfter = cash;
    let realized = 0;
    let nextPosition = position;

    if (decision.action === "BUY") {
      const applied = applyBuy(position, cash, decision.shares, decision.notional);
      nextPosition = applied.position;
      cashAfter = applied.cash;
      result.buys += 1;
    } else if (decision.action === "SELL") {
      const applied = applySell(position, cash, decision.shares, decision.price);
      nextPosition = applied.position;
      cashAfter = applied.cash;
      realized = applied.realized;
      realizedTotal = roundUsd(realizedTotal + realized);
      result.sells += 1;
    } else {
      result.skips += 1;
    }

    cash = cashAfter;
    paper.set(row.asset, nextPosition);

    // Source-side state always advances, even when the paper side skipped.
    sourceShares.set(row.asset, roundShares(nextSourceForRow));

    tradeRows.push({
      experiment_id: experiment.id,
      source_event_id: row.id,
      event_key: row.event_key,
      action: decision.action,
      side,
      asset: row.asset,
      market_title: row.market_title,
      outcome: row.outcome,
      price: decision.price,
      shares: decision.shares,
      notional: decision.notional,
      reason: decision.reason,
      cash_after: cashAfter,
      realized_pnl: realized,
      source_ts: row.source_ts,
    });
    processedIds.push(row.id);
    result.processed += 1;
  }

  // Batched writes: one round-trip per chunk instead of per event.
  const stampNow = new Date().toISOString();
  for (const chunk of chunked(tradeRows, 200)) {
    const { error: tradeErr } = await supabaseAdmin
      .from("paper_trades")
      .upsert(chunk as never, { onConflict: "experiment_id,event_key", ignoreDuplicates: true });
    if (tradeErr) throw new Error(tradeErr.message);
  }
  for (const chunk of chunked(processedIds, 200)) {
    await supabaseAdmin.from("source_events").update({ processed_at: stampNow }).in("id", chunk);
  }
  for (const chunk of chunked(backfilledIds, 200)) {
    await supabaseAdmin.from("source_events").update({ backfilled: true }).in("id", chunk);
  }

  // Persist the compact source state and the paper book (batched).
  const sourceRows = [...sourceShares].map(([asset, shares]) => ({
    wallet: TARGET_WALLET,
    asset,
    market_title: meta.get(asset)?.title ?? null,
    outcome: meta.get(asset)?.outcome ?? null,
    shares,
    last_event_ts: meta.get(asset)?.ts ?? null,
    updated_at: stampNow,
  }));
  for (const chunk of chunked(sourceRows, 200)) {
    const { error: e } = await supabaseAdmin
      .from("source_position_state")
      .upsert(chunk as never, { onConflict: "wallet,asset" });
    if (e) throw new Error(e.message);
  }

  const paperRowsOut = [...paper].map(([asset, p]) => ({
    experiment_id: experiment.id,
    asset,
    market_title: meta.get(asset)?.title ?? null,
    outcome: meta.get(asset)?.outcome ?? null,
    shares: p.shares,
    cost_basis: p.costBasis,
    avg_price: p.avgPrice,
    realized_pnl: p.realizedPnl,
    settlement_status: p.shares > 0 ? "open" : "closed",
    last_activity_ts: meta.get(asset)?.ts ?? null,
    updated_at: stampNow,
  }));
  for (const chunk of chunked(paperRowsOut, 200)) {
    const { error: e } = await supabaseAdmin
      .from("paper_positions")
      .upsert(chunk as never, { onConflict: "experiment_id,asset" });
    if (e) throw new Error(e.message);
  }

  await supabaseAdmin
    .from("paper_experiments")
    .update({ cash, realized_pnl: realizedTotal, updated_at: new Date().toISOString() })
    .eq("id", experiment.id);

  return result;
}

/* ------------------------------------------------------------------ */
/* Marks from the public CLOB                                          */
/* ------------------------------------------------------------------ */

type BookLevel = { price: string; size: string };

async function fetchBook(
  asset: string,
): Promise<{ bid: number | null; ask: number | null; ts: number | null }> {
  const json = (await getJson(`${CLOB_API}/book?token_id=${asset}`)) as {
    bids?: BookLevel[];
    asks?: BookLevel[];
    timestamp?: string;
  };
  const bids = (json.bids ?? []).map((l) => Number(l.price)).filter((n) => Number.isFinite(n) && n > 0);
  const asks = (json.asks ?? []).map((l) => Number(l.price)).filter((n) => Number.isFinite(n) && n > 0);
  const ts = Number(json.timestamp);
  return {
    bid: bids.length ? Math.max(...bids) : null,
    ask: asks.length ? Math.min(...asks) : null,
    ts: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
  };
}

export async function refreshMarks(experimentId: string): Promise<{ updated: number; failed: number }> {
  const { data: open } = await supabaseAdmin
    .from("paper_positions")
    .select("asset")
    .eq("experiment_id", experimentId)
    .gt("shares", 0)
    .order("updated_at", { ascending: true })
    .limit(MAX_MARK_REFRESH);

  let updated = 0;
  let failed = 0;
  for (const row of open ?? []) {
    try {
      const book = await fetchBook(row.asset);
      const resolved = resolveMark({
        bestBid: book.bid,
        bestAsk: book.ask,
        midpoint: null,
        markTs: book.ts,
        nowMs: Date.now(),
      });
      await supabaseAdmin
        .from("paper_positions")
        .update({
          best_bid: book.bid,
          best_ask: book.ask,
          midpoint: resolved.mark,
          mark: resolved.mark,
          mark_source: resolved.source,
          mark_ts: resolved.mark === null ? null : new Date(book.ts ?? Date.now()).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("experiment_id", experimentId)
        .eq("asset", row.asset);
      updated += 1;
    } catch {
      failed += 1;
      // Stale marks are cleared rather than reused, so open P&L reads Unavailable.
      await supabaseAdmin
        .from("paper_positions")
        .update({ mark: null, mark_source: null, mark_ts: null, updated_at: new Date().toISOString() })
        .eq("experiment_id", experimentId)
        .eq("asset", row.asset);
    }
  }
  return { updated, failed };
}

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

export async function reconcile(): Promise<{ ok: boolean; mismatches: number }> {
  const { data: events } = await supabaseAdmin
    .from("source_events")
    .select("asset, side, shares")
    .eq("wallet", TARGET_WALLET)
    .order("source_ts", { ascending: true })
    .limit(5000);
  const replayed = replaySourcePositions(
    (events ?? []).map((e) => ({
      asset: e.asset,
      side: (e.side === "SELL" ? "SELL" : "BUY") as Side,
      shares: Number(e.shares),
    })),
  );

  const { data: compactRows } = await supabaseAdmin
    .from("source_position_state")
    .select("asset, shares")
    .eq("wallet", TARGET_WALLET);
  const compact = new Map<string, number>();
  for (const r of compactRows ?? []) compact.set(r.asset, Number(r.shares));

  const result = reconcileSourceState(compact, replayed);
  const stamp = new Date().toISOString();
  const bad = new Set(result.mismatches.map((m) => m.asset));

  const rows = [...new Set([...compact.keys(), ...replayed.keys()])].map((asset) => ({
    wallet: TARGET_WALLET,
    asset,
    shares: replayed.get(asset) ?? 0,
    reconciled_at: stamp,
    reconciliation_status: bad.has(asset) ? "repaired_from_replay" : "ok",
    updated_at: stamp,
  }));
  for (const chunk of chunked(rows, 200)) {
    await supabaseAdmin
      .from("source_position_state")
      .upsert(chunk as never, { onConflict: "wallet,asset" });
  }

  if (!result.ok) {
    await raiseAlert(
      "warn",
      "reconciliation_mismatch",
      `Reconciliation repaired ${result.mismatches.length} source position(s) from the persisted event replay.`,
      { mismatches: result.mismatches.slice(0, 20) as never },
    );
  }
  return { ok: result.ok, mismatches: result.mismatches.length };
}

/* ------------------------------------------------------------------ */
/* One full poll cycle                                                 */
/* ------------------------------------------------------------------ */

export type CycleResult = {
  ranAt: string;
  skipped: string | null;
  newEvents: number;
  pagesFetched: number;
  process: ProcessResult;
  marks: { updated: number; failed: number };
  reconciliation: { ok: boolean; mismatches: number } | null;
  lagSeconds: number | null;
};

export async function runIngestCycle(workerId: string): Promise<CycleResult> {
  const ranAt = new Date().toISOString();
  const experiment = await getExperiment();
  if (!experiment.enabled) {
    return {
      ranAt,
      skipped: "Follower is paused (enabled = false).",
      newEvents: 0,
      pagesFetched: 0,
      process: { processed: 0, buys: 0, sells: 0, skips: 0, backfilled: 0 },
      marks: { updated: 0, failed: 0 },
      reconciliation: null,
      lagSeconds: null,
    };
  }

  const lease = await acquireLease(workerId);
  if (!lease) {
    return {
      ranAt,
      skipped: "Another worker holds the ingestion lease.",
      newEvents: 0,
      pagesFetched: 0,
      process: { processed: 0, buys: 0, sells: 0, skips: 0, backfilled: 0 },
      marks: { updated: 0, failed: 0 },
      reconciliation: null,
      lagSeconds: null,
    };
  }

  const { data: checkpoint } = await supabaseAdmin
    .from("worker_checkpoints")
    .select("*")
    .eq("id", WORKER_ID)
    .maybeSingle();
  const bootstrapped = checkpoint?.bootstrap_complete ?? false;

  // First ever run: shadow-copy only from go-live onwards.
  if (experiment.follow_from_ts === null) {
    const goLive = Math.floor(Date.now() / 1000);
    await supabaseAdmin
      .from("paper_experiments")
      .update({ follow_from_ts: goLive, updated_at: new Date().toISOString() })
      .eq("id", experiment.id);
    experiment.follow_from_ts = goLive;
    await raiseAlert(
      "info",
      "follower_started",
      "Follower go-live recorded. Earlier fills are stored as history only and are not paper-copied.",
      { follow_from_ts: goLive as never },
    );
  }

  try {
    const window = await fetchSourceWindow(bootstrapped ? LIVE_PAGES : BOOTSTRAP_PAGES);
    const events = normalizeSourceEvents(window.raw, TARGET_WALLET);
    const inserted = await persistEvents(events);
    const process = await processPendingEvents(experiment);
    const marks = await refreshMarks(experiment.id);
    const reconciliation = inserted > 0 || !bootstrapped ? await reconcile() : null;

    const newest = events.length ? Math.max(...events.map((e) => e.sourceTs)) : 0;
    const lagSeconds = newest > 0 ? Math.max(0, Math.round(Date.now() / 1000 - newest)) : null;

    await supabaseAdmin.from("worker_checkpoints").upsert({
      id: WORKER_ID,
      wallet: TARGET_WALLET,
      last_source_ts: Math.max(newest, checkpoint?.last_source_ts ?? 0),
      last_event_key: events.at(-1)?.eventKey ?? checkpoint?.last_event_key ?? null,
      events_seen: (checkpoint?.events_seen ?? 0) + inserted,
      bootstrap_complete: true,
      updated_at: new Date().toISOString(),
    });

    const { data: statusRow } = await supabaseAdmin
      .from("worker_status")
      .select("events_ingested")
      .eq("id", WORKER_ID)
      .maybeSingle();

    await releaseLease(lease, {
      state: "idle",
      last_error: null,
      poll_failures: 0,
      events_ingested: (statusRow?.events_ingested ?? 0) + inserted,
      lag_seconds: lagSeconds,
      last_success_at: new Date().toISOString(),
    });

    if (inserted > 0) {
      await raiseAlert("info", "new_source_trades", `Detected ${inserted} new source trade(s).`, {
        buys: process.buys as never,
        sells: process.sells as never,
        skips: process.skips as never,
      });
    }

    return {
      ranAt,
      skipped: null,
      newEvents: inserted,
      pagesFetched: window.pagesFetched,
      process,
      marks,
      reconciliation,
      lagSeconds,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    const { data: statusRow } = await supabaseAdmin
      .from("worker_status")
      .select("poll_failures")
      .eq("id", WORKER_ID)
      .maybeSingle();
    const failures = (statusRow?.poll_failures ?? 0) + 1;
    await releaseLease(lease, { state: "error", last_error: message, poll_failures: failures });
    if (failures === 1 || failures % 5 === 0) {
      await raiseAlert("error", "poll_failure", `Ingestion poll failed: ${message}`, {
        failures: failures as never,
      });
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Dashboard read model                                               */
/* ------------------------------------------------------------------ */

export type DashboardOpenPosition = {
  asset: string;
  marketTitle: string;
  outcome: string | null;
  shares: number;
  costBasis: number;
  avgPrice: number;
  mark: number | null;
  markSource: string | null;
  markAgeSeconds: number | null;
  openPnl: number | null;
  realizedPnl: number;
};

export async function loadDashboard() {
  const experiment = await getExperiment();
  const nowMs = Date.now();

  const [statusRes, checkpointRes, eventsRes, tradesRes, positionsRes, alertsRes, countsRes] =
    await Promise.all([
      supabaseAdmin.from("worker_status").select("*").eq("id", WORKER_ID).maybeSingle(),
      supabaseAdmin.from("worker_checkpoints").select("*").eq("id", WORKER_ID).maybeSingle(),
      supabaseAdmin
        .from("source_events")
        .select("*")
        .eq("wallet", TARGET_WALLET)
        .order("source_ts", { ascending: false })
        .limit(300),
      supabaseAdmin
        .from("paper_trades")
        .select("*")
        .eq("experiment_id", experiment.id)
        .order("source_ts", { ascending: false })
        .limit(300),
      supabaseAdmin.from("paper_positions").select("*").eq("experiment_id", experiment.id),
      supabaseAdmin.from("alerts").select("*").order("created_at", { ascending: false }).limit(20),
      supabaseAdmin
        .from("source_events")
        .select("*", { count: "exact", head: true })
        .eq("wallet", TARGET_WALLET),
    ]);

  const positions = positionsRes.data ?? [];
  const open: DashboardOpenPosition[] = positions
    .filter((p) => Number(p.shares) > 0)
    .map((p) => {
      const markTs = p.mark_ts ? new Date(p.mark_ts).getTime() : null;
      const age = markTs === null ? null : Math.round((nowMs - markTs) / 1000);
      const fresh = markTs !== null && nowMs - markTs < MARK_MAX_AGE_MS;
      const mark = fresh && p.mark !== null ? Number(p.mark) : null;
      return {
        asset: p.asset,
        marketTitle: p.market_title ?? "Unknown market",
        outcome: p.outcome,
        shares: Number(p.shares),
        costBasis: Number(p.cost_basis),
        avgPrice: Number(p.avg_price),
        mark,
        markSource: mark === null ? null : p.mark_source,
        markAgeSeconds: age,
        openPnl: openPnl(Number(p.shares), Number(p.cost_basis), mark),
        realizedPnl: Number(p.realized_pnl),
      };
    })
    .sort((a, b) => b.costBasis - a.costBasis);

  const closed = positions
    .filter((p) => Number(p.shares) <= 0)
    .map((p) => ({
      asset: p.asset,
      marketTitle: p.market_title ?? "Unknown market",
      outcome: p.outcome,
      realizedPnl: Number(p.realized_pnl),
      lastActivityTs: p.last_activity_ts ? Number(p.last_activity_ts) : null,
    }))
    .sort((a, b) => (b.lastActivityTs ?? 0) - (a.lastActivityTs ?? 0));

  const openCostBasis = roundUsd(open.reduce((s, p) => s + p.costBasis, 0));
  const markedValue = open.every((p) => p.mark !== null)
    ? roundUsd(open.reduce((s, p) => s + p.shares * (p.mark as number), 0))
    : null;

  const status = statusRes.data;
  const heartbeatAgeSeconds = status?.heartbeat_at
    ? Math.round((nowMs - new Date(status.heartbeat_at).getTime()) / 1000)
    : null;

  return {
    fetchedAt: new Date(nowMs).toISOString(),
    wallet: TARGET_WALLET,
    experiment: {
      id: experiment.id,
      name: experiment.name,
      startingCash: Number(experiment.starting_cash),
      cash: Number(experiment.cash),
      buyAmount: Number(experiment.buy_amount),
      pollIntervalSeconds: experiment.poll_interval_seconds,
      enabled: experiment.enabled,
      weatherOnly: experiment.weather_only,
      realizedPnl: Number(experiment.realized_pnl),
      followFromTs: experiment.follow_from_ts,
    },
    worker: {
      workerId: status?.worker_id ?? null,
      state: status?.state ?? "stopped",
      heartbeatAt: status?.heartbeat_at ?? null,
      heartbeatAgeSeconds,
      lastSuccessAt: status?.last_success_at ?? null,
      lastPollAt: status?.last_poll_at ?? null,
      lastError: status?.last_error ?? null,
      pollFailures: status?.poll_failures ?? 0,
      eventsIngested: status?.events_ingested ?? 0,
      lagSeconds: status?.lag_seconds ?? null,
      fence: status?.fence ?? 0,
      bootstrapComplete: checkpointRes.data?.bootstrap_complete ?? false,
      lastSourceTs: checkpointRes.data?.last_source_ts ?? 0,
    },
    totals: {
      persistedEvents: countsRes.count ?? 0,
      openPositions: open.length,
      openCostBasis,
      markedValue,
      equity: markedValue === null ? null : roundUsd(Number(experiment.cash) + markedValue),
    },
    events: (eventsRes.data ?? []).map((e) => ({
      id: e.id,
      eventKey: e.event_key,
      asset: e.asset,
      marketTitle: e.market_title,
      outcome: e.outcome,
      slug: e.slug,
      side: e.side as Side,
      shares: Number(e.shares),
      price: Number(e.price),
      sourceTs: Number(e.source_ts),
      firstSeenAt: e.first_seen_at,
      identityBasis: e.identity_basis,
      identityDegraded: e.identity_degraded,
      processed: e.processed_at !== null,
      backfilled: e.backfilled ?? false,
      txHash: e.tx_hash,
    })),
    paperTrades: (tradesRes.data ?? []).map((t) => ({
      id: t.id,
      eventKey: t.event_key,
      action: t.action,
      side: t.side,
      asset: t.asset,
      marketTitle: t.market_title ?? "Unknown market",
      outcome: t.outcome,
      price: t.price === null ? null : Number(t.price),
      shares: Number(t.shares),
      notional: Number(t.notional),
      reason: t.reason,
      cashAfter: t.cash_after === null ? null : Number(t.cash_after),
      realizedPnl: Number(t.realized_pnl),
      sourceTs: t.source_ts ? Number(t.source_ts) : null,
      createdAt: t.created_at,
    })),
    open,
    closed,
    alerts: (alertsRes.data ?? []).map((a) => ({
      id: a.id,
      level: a.level,
      kind: a.kind,
      message: a.message,
      createdAt: a.created_at,
      acknowledged: a.acknowledged,
    })),
    degradedIdentityCount: (eventsRes.data ?? []).filter((e) => e.identity_degraded).length,
  };
}

export type DashboardData = Awaited<ReturnType<typeof loadDashboard>>;
