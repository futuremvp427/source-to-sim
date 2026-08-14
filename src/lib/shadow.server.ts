/**
 * SERVER-ONLY engine for the autonomous SHADOW follower.
 * Read-only against public Polymarket endpoints; writes only to our own tables.
 * There is no signing, no credential use and no order-placement path in this file.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { fetchAllRows } from "./db-pagination";
import {
  classifyWorker,
  findAbandonedWorkers,
  orderByStaleness,
  type WorkerRow,
} from "./worker-health";
import {
  EMPTY_POSITION,
  MARK_MAX_AGE_MS,
  applyBuy,
  applySell,
  buildEventCommit,
  decideDynamicBuy,
  decideProportionalSell,
  normalizeSourceEvents,
  openPnl,
  reconcileSourceState,
  replaySourcePositions,
  resolveMark,
  roundShares,
  roundUsd,
  type FollowerDecision,
  type NormalizedEvent,
  type PaperPositionState,
  type Side,
} from "./shadow-core";
import {
  SETTLED_POSITION_SKIP_REASON,
  isPhantomClosedPosition,
  isTerminalSettlementStatus,
  shouldPersistPaperPosition,
} from "./shadow-core";
import {
  V2_REFERENCE_NAME,
  isEligibleForV2Copy,
  isV2Name,
} from "./v2-cohort";
import { isGeneralShadowName } from "./general-shadow";

export const TARGET_WALLET = "0x8fbd7cf5f806f563080864694415829f7229a959";
export const EXPERIMENT_NAME = "SHADOW";
export const WORKER_ID = "ingest";

const DATA_API = "https://data-api.polymarket.com";
export const PAGE_SIZE = 250;
const BOOTSTRAP_PAGES = 4;
const LEASE_SECONDS = 180;
/** Exposed for the lease regression tests only. */
export const LEASE_SECONDS_FOR_TEST = LEASE_SECONDS;
/**
 * A refresh pass must be able to cover every open position inside
 * MARK_MAX_AGE_MS, otherwise equity can never satisfy the freshness rule.
 * Books are fetched in small concurrent batches to keep the pass well inside
 * one scheduler cycle without hammering the public CLOB.
 */
const MAX_MARK_REFRESH = 800;
/** Books arrive in one batched request; only the DB writes are fanned out. */
const MARK_WRITE_CONCURRENCY = 25;
const PROCESS_BATCH = 300;
/**
 * A scheduled invocation is a single HTTP request with a finite platform budget.
 * Without an explicit budget the request is killed mid-experiment, which leaves
 * that experiment's worker row stuck at state='running' with last_poll_at
 * frozen. We therefore stop starting new experiment cycles once the budget is
 * spent, and bound each individual cycle so a hung upstream call still releases
 * its lease through the normal error path.
 */
const CYCLE_BUDGET_MS = 50_000;
/**
 * Independent-lease experiments processed concurrently per batch. Kept small:
 * each experiment already fans out its own mark fetches, so too much total
 * concurrency makes the public CLOB rate-limit and marks fail.
 */
const EXPERIMENT_CONCURRENCY = 2;
const EXPERIMENT_DEADLINE_MS = 40_000;
const RESEARCH_DEADLINE_MS = 8_000;
/** Auxiliary (non-accounting) stage budgets, so one slow stage cannot eat a cycle. */
/**
 * Unlike every other auxiliary stage below, mark_refresh previously had no
 * budget of its own — only the outer EXPERIMENT_DEADLINE_MS bounded it. A
 * single unreachable/stalled public CLOB /books chunk can legitimately
 * consume up to ~37s across fetchBooksBatched's 3 retry attempts (each up to
 * a 12s AbortSignal.timeout, plus backoff), which is dangerously close to —
 * and for experiments needing more than one 100-asset chunk, can exceed —
 * the 40s cycle deadline on its own. When that happens the platform's own
 * hard request timeout can kill the invocation before our JS-level deadline
 * ever gets a chance to run the catch block and release the lease, leaving
 * the worker row stuck at state='running' indefinitely. Marks are
 * measurement only, so mark_refresh gets the same bounded-with-safe-fallback
 * treatment as reconciliation/settlement/previews/copyability.
 */
const MARK_REFRESH_DEADLINE_MS = 15_000;
const SETTLEMENT_DEADLINE_MS = 8_000;
const PREVIEW_DEADLINE_MS = 6_000;
const COPYABILITY_DEADLINE_MS = 6_000;
/** General Shadow non-trade activity evidence stage. Bounded and isolated. */
const GENERAL_ACTIVITY_DEADLINE_MS = 6_000;
const RECONCILE_DEADLINE_MS = 8_000;

class DeadlineError extends Error {}

async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineError(`${label} exceeded ${ms}ms deadline`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Bounded auxiliary stage. On timeout the cycle continues with the neutral
 * fallback so ingestion, paper accounting and marking always complete; the
 * stage's own writes remain idempotent and fenced.
 */
async function boundedStage<T>(work: Promise<T>, ms: number, label: string, fallback: T): Promise<T> {
  try {
    return await withDeadline(work, ms, label);
  } catch {
    return fallback;
  }
}

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
  /** When set, the same condition is only ever alerted (and notified) once. */
  dedupKey?: string,
): Promise<void> {
  const row = {
    level,
    kind,
    message,
    context: (context ?? null) as never,
    dedup_key: dedupKey ?? null,
  };
  const { data } = dedupKey
    ? await supabaseAdmin
        .from("alerts")
        .upsert(row, { onConflict: "dedup_key", ignoreDuplicates: true })
        .select("id")
    : await supabaseAdmin.from("alerts").insert(row).select("id");
  const id = data?.[0]?.id;
  if (!id) return;
  const { notifyAlert } = await import("./notify.server");
  await notifyAlert({ id, level, kind, message });
}

/* ------------------------------------------------------------------ */
/* Lease / fencing so only one worker ingests at a time                */
/* ------------------------------------------------------------------ */

export type Lease = { fence: number; workerId: string; lockId: string };

/**
 * Atomic lease acquisition. One SQL statement decides ownership and bumps the
 * fence; there is no read-then-decide window, so two overlapping cycles can
 * never both believe they hold the lease. Returns null when the lease is held
 * by a different, still-live worker.
 */
export async function acquireLease(workerId: string, lockId: string = WORKER_ID): Promise<Lease | null> {
  const { data, error } = await supabaseAdmin.rpc("acquire_worker_lease", {
    p_id: lockId,
    p_worker_id: workerId,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error(error.message);
  const fence = typeof data === "number" ? data : null;
  if (fence === null) return null;
  return { fence, workerId, lockId };
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
    /** Per-stage durations (ms) for the cycle that is releasing the lease. */
    stage_ms: Record<string, number>;
    /**
     * Diagnostic telemetry only: how many source_events this specific
     * COMPLETED poll attempt persisted, win or lose. Never affects paper
     * accounting, sizing, bankroll, settlement or lease ownership.
     */
    last_poll_events_inserted: number;
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
    } as never)
    .eq("id", lease.lockId)
    .eq("fence", lease.fence)
    // A stale owner must not be able to clobber the worker that took over.
    .eq("worker_id", lease.workerId);
}

/** Test-only alias so the lease fencing rules can be asserted directly. */
export const releaseLeaseForTest = releaseLease;
/** Test-only alias so the bounded-stage timeout/fallback mechanism can be asserted directly. */
export const boundedStageForTest = boundedStage;
export const MARK_REFRESH_DEADLINE_MS_FOR_TEST = MARK_REFRESH_DEADLINE_MS;

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

/**
 * The active reference experiment: the V2 fair-comparison row for the reference
 * wallet when it exists, otherwise the frozen V1 SHADOW row.
 */
export async function getExperiment(): Promise<Experiment> {
  const { data, error } = await supabaseAdmin
    .from("paper_experiments")
    .select("*")
    .in("name", [V2_REFERENCE_NAME, EXPERIMENT_NAME]);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as Experiment[];
  const row = rows.find((r) => r.name === V2_REFERENCE_NAME) ?? rows[0];
  if (!row) throw new Error("Reference experiment row is missing");
  return row;
}

/**
 * Every enabled experiment. The reference SHADOW experiment is always polled
 * first; candidate shadow experiments follow. Each row carries its own wallet,
 * bankroll and accounting, so one cycle can never cross-contaminate another.
 */
export async function listActiveExperiments(): Promise<Experiment[]> {
  const { data, error } = await supabaseAdmin
    .from("paper_experiments")
    .select("*")
    .eq("enabled", true)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as Experiment[];
  return rows.sort((a, b) =>
    a.name === EXPERIMENT_NAME ? -1 : b.name === EXPERIMENT_NAME ? 1 : a.name.localeCompare(b.name),
  );
}

/** Per-experiment worker/checkpoint row id. The V1 reference keeps its historical id. */
export function workerIdFor(experiment: { id: string; name: string }): string {
  return experiment.name === EXPERIMENT_NAME ? WORKER_ID : `ingest:${experiment.id}`;
}

/* ------------------------------------------------------------------ */
/* Ingestion                                                          */
/* ------------------------------------------------------------------ */

/**
 * takerOnly=false is explicit: the endpoint default omits a large share of this
 * wallet's activity (maker-side fills), so relying on the default would leave
 * the source history materially incomplete.
 */
export const TAKER_ONLY_PARAM = "takerOnly=false";

export function buildTradesUrl(limit: number, offset: number, wallet: string = TARGET_WALLET): string {
  return `${DATA_API}/trades?user=${wallet}&${TAKER_ONLY_PARAM}&limit=${limit}&offset=${offset}`;
}

/** Bounded page walk: used only for a fixed number of newest pages. */
async function fetchFixedPages(
  wallet: string,
  pages: number,
): Promise<{ raw: Json[]; pagesFetched: number }> {
  const raw: Json[] = [];
  let pagesFetched = 0;
  for (let p = 0; p < pages; p += 1) {
    const page = await getArray(buildTradesUrl(PAGE_SIZE, p * PAGE_SIZE, wallet));
    pagesFetched += 1;
    raw.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return { raw, pagesFetched };
}

/**
 * Checkpoint-driven catch-up: walk pages newest-to-oldest until the previous
 * checkpoint is fully covered, or the API's available history is exhausted.
 *
 * Coverage is proven by either:
 *  - a page containing an event strictly OLDER than checkpointTs (a page
 *    whose oldest event is exactly == checkpointTs does NOT prove coverage —
 *    more events sharing that same second may sit on the next page), or
 *  - the API returning fewer than pageSize rows (history exhausted).
 *
 * No artificial page cap is applied: a real backlog must be fully covered or
 * the caller's own deadline aborts the cycle (fail closed — see
 * runExperimentCycle, which only advances the checkpoint and processes
 * events once this promise resolves).
 *
 * Exported so the stopping semantics can be tested directly against an
 * injected page fetcher, without mocking the network.
 */
export async function fetchUntilCheckpointCovered(
  fetchPage: (offset: number) => Promise<Json[]>,
  checkpointTs: number,
  pageSize: number = PAGE_SIZE,
): Promise<{ raw: Json[]; pagesFetched: number }> {
  const raw: Json[] = [];
  let pagesFetched = 0;
  let offset = 0;
  for (;;) {
    const page = await fetchPage(offset);
    pagesFetched += 1;
    raw.push(...page);
    const exhausted = page.length < pageSize;
    // A malformed timestamp (null, "", non-numeric) must never falsely prove
    // coverage: Number(null) === 0 and Number("") === 0 would otherwise look
    // like a genuine event older than any positive checkpoint.
    const coversCheckpoint = page.some((r) => {
      const ts = Number(r["timestamp"]);
      return Number.isFinite(ts) && ts > 0 && ts < checkpointTs;
    });
    if (exhausted || coversCheckpoint) return { raw, pagesFetched };
    offset += pageSize;
  }
}

/** Raised when a bootstrapped worker has no valid boundary to catch up against. */
export class MissingCatchupBoundaryError extends Error {}

/**
 * A first-ever bootstrap stays a bounded fixed-page fetch (never an unlimited
 * history download). Once bootstrapped, catchupBoundary (the previous
 * checkpoint, or experiment.follow_from_ts when there is no real checkpoint
 * yet — e.g. a newly followed wallet whose first bootstrap saw zero trades)
 * drives how far back this poll must catch up, so a backlog larger than the
 * old fixed window can never leave older unseen events permanently out of
 * reach. If neither boundary exists, this fails closed rather than silently
 * falling back to a bounded window: the caller's existing error/lease-release
 * path handles it, exactly like a deadline timeout.
 */
async function fetchSourceWindow(
  wallet: string,
  bootstrapped: boolean,
  catchupBoundary: number | null,
): Promise<{ raw: Json[]; pagesFetched: number }> {
  if (!bootstrapped) return fetchFixedPages(wallet, BOOTSTRAP_PAGES);
  if (catchupBoundary === null) {
    throw new MissingCatchupBoundaryError(
      "Bootstrapped worker has neither a checkpoint nor a follow_from_ts to catch up against",
    );
  }
  return fetchUntilCheckpointCovered(
    (offset) => getArray(buildTradesUrl(PAGE_SIZE, offset, wallet)),
    catchupBoundary,
  );
}

/** Previous checkpoint, falling back to go-live when there is no real checkpoint yet. */
export function resolveCatchupBoundary(
  checkpointTs: number | null | undefined,
  followFromTs: number | null | undefined,
): number | null {
  if (Number(checkpointTs) > 0) return Number(checkpointTs);
  if (Number(followFromTs) > 0) return Number(followFromTs);
  return null;
}

/**
 * Insert new events only. The unique event_key makes replays idempotent.
 *
 * keepRaw=false stores no raw provider payload. Used for the high-frequency
 * General Shadow wallets: every field we measure or display is already
 * extracted into typed columns, and the raw blob is ~75% of the row, so
 * dropping it keeps this cohort from crowding out the Weather observation
 * window. Weather rows are untouched.
 */
async function persistEvents(events: NormalizedEvent[], keepRaw = true): Promise<number> {
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
    raw: (keepRaw ? e.raw : null) as never,
  }));
  const { data, error } = await supabaseAdmin
    .from("source_events")
    // Event identity is wallet-scoped: two wallets may legitimately report the
    // same event_key, and one wallet can never record the same event twice.
    .upsert(rows, { onConflict: "wallet,event_key", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}

/* ------------------------------------------------------------------ */
/* Follower pass over experiment-scoped pending events                 */
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
  first_seen_at: string;
};

type PaperPositionRow = {
  asset: string;
  shares: number;
  cost_basis: number;
  avg_price: number;
  realized_pnl: number;
  settlement_status: string;
};

type ExperimentSourcePositionRow = {
  asset: string;
  shares: number;
};

export type ProcessResult = {
  processed: number;
  buys: number;
  sells: number;
  skips: number;
  /** Pre-go-live fills recorded for history/reconciliation only. */
  backfilled: number;
};

/**
 * Real-event validation record: source timestamp vs. detection vs. decision.
 * Written once per (experiment, event) so latency can be audited after the fact.
 */
function buildAuditRow(input: {
  experimentId: string;
  wallet: string;
  eventKey: string;
  marketTitle: string | null;
  side: string;
  action: string;
  sourceTs: number;
  firstSeenAt: string;
}): Record<string, unknown> {
  const decisionAt = new Date();
  const detectedMs = new Date(input.firstSeenAt).getTime();
  const sourceMs = input.sourceTs * 1000;
  const secs = (ms: number) => Math.round((ms / 1000) * 100) / 100;
  return {
    experiment_id: input.experimentId,
    event_key: input.eventKey,
    wallet: input.wallet,
    market_title: input.marketTitle,
    side: input.side,
    action: input.action,
    source_ts: input.sourceTs,
    detected_at: input.firstSeenAt,
    event_persisted_at: input.firstSeenAt,
    decision_at: decisionAt.toISOString(),
    paper_trade_at: decisionAt.toISOString(),
    position_updated_at: decisionAt.toISOString(),
    detection_latency_seconds: sourceMs > 0 ? Math.max(0, secs(detectedMs - sourceMs)) : null,
    decision_latency_seconds: Math.max(0, secs(decisionAt.getTime() - detectedMs)),
    total_latency_seconds: sourceMs > 0 ? Math.max(0, secs(decisionAt.getTime() - sourceMs)) : null,
  };
}

/** Raised when the database refuses a commit because another worker took the lease. */
export class StaleFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleFenceError";
  }
}

export function isStaleFenceMessage(message: string): boolean {
  return message.toLowerCase().includes("stale_fence");
}

/**
 * Commits one source event as ONE PostgreSQL transaction that also re-verifies
 * the worker lease fence. A stale worker cannot commit, and a partial failure
 * cannot leave half of an event's accounting applied.
 */
async function commitEventAtomically(
  lease: Lease,
  experimentId: string,
  payload: Record<string, unknown>,
): Promise<{ applied: boolean }> {
  const { data, error } = await supabaseAdmin.rpc("process_source_event_atomic", {
    p_lock_id: lease.lockId,
    p_worker_id: lease.workerId,
    p_fence: lease.fence,
    p_experiment_id: experimentId,
    p_event: payload as never,
  } as never);
  if (error) {
    if (isStaleFenceMessage(error.message)) throw new StaleFenceError(error.message);
    throw new Error(error.message);
  }
  const applied = Boolean((data as { applied?: boolean } | null)?.applied);
  return { applied };
}

async function processPendingEvents(
  experiment: Experiment,
  lease: Lease,
): Promise<ProcessResult> {
  const wallet = experiment.wallet_address.toLowerCase();

  // Pending/consumed state belongs to (experiment, source_event). The source
  // event row itself is immutable shared input and is never filtered by the
  // legacy wallet-global processed_at bit here.
  const { data: pending, error } = await supabaseAdmin.rpc(
    "get_pending_experiment_source_events" as never,
    { p_experiment_id: experiment.id, p_limit: PROCESS_BATCH } as never,
  );
  if (error) throw new Error(error.message);
  const rows = (pending ?? []) as unknown as SourceEventRow[];
  if (rows.length === 0) return { processed: 0, buys: 0, sells: 0, skips: 0, backfilled: 0 };
  const followFrom = experiment.follow_from_ts ?? 0;

  const assets = [...new Set(rows.map((r) => r.asset))];

  // SourceSharesBefore must also be experiment-scoped. A wallet-global compact
  // row can be ahead of another experiment and would distort proportional sells.
  const { data: sourceStateRows, error: sourceStateError } = await supabaseAdmin.rpc(
    "get_experiment_source_positions" as never,
    { p_experiment_id: experiment.id, p_assets: assets } as never,
  );
  if (sourceStateError) throw new Error(sourceStateError.message);
  const sourceShares = new Map<string, number>();
  for (const r of (sourceStateRows ?? []) as unknown as ExperimentSourcePositionRow[]) {
    sourceShares.set(r.asset, Number(r.shares));
  }

  const { data: paperRows } = await supabaseAdmin
    .from("paper_positions")
    .select("asset, shares, cost_basis, avg_price, realized_pnl, settlement_status")
    .eq("experiment_id", experiment.id)
    .in("asset", assets);
  const paper = new Map<string, PaperPositionState>();
  const settlementStatusByAsset = new Map<string, string>();
  for (const r of (paperRows ?? []) as PaperPositionRow[]) {
    paper.set(r.asset, {
      shares: Number(r.shares),
      costBasis: Number(r.cost_basis),
      avgPrice: Number(r.avg_price),
      realizedPnl: Number(r.realized_pnl),
    });
    settlementStatusByAsset.set(r.asset, r.settlement_status);
  }

  let cash = Number(experiment.cash);
  let realizedTotal = Number(experiment.realized_pnl);
  const result: ProcessResult = { processed: 0, buys: 0, sells: 0, skips: 0, backfilled: 0 };
  const meta = new Map<string, { title: string; outcome: string | null; ts: number }>();
  /** Assets that already had a persisted paper_positions row before this batch. */
  const existingPaperAssets = new Set<string>(
    ((paperRows ?? []) as PaperPositionRow[]).map((r) => r.asset),
  );
  /** Assets genuinely traded (BUY/SELL) in this batch. SKIP-only assets are never written. */
  const tradedAssets = new Set<string>();

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

    if (!isEligibleForV2Copy(Number(row.source_ts), followFrom)) {
      const nextShares = roundShares(nextSourceForRow);
      await commitEventAtomically(
        lease,
        experiment.id,
        buildEventCommit({
          sourceEventId: row.id,
          backfilled: true,
          sourceState: {
            wallet,
            asset: row.asset,
            marketTitle: row.market_title,
            outcome: row.outcome,
            shares: nextShares,
            lastEventKey: row.event_key,
            lastEventTs: Number(row.source_ts),
          },
          trade: null,
          paperPosition: null,
          experiment: null,
          audit: null,
        }),
      );
      sourceShares.set(row.asset, nextShares);
      result.backfilled += 1;
      result.processed += 1;
      continue;
    }

    // A late source event must never reopen a paper position that already
    // reached final settlement: that row is a closed historical record.
    const isTerminal = isTerminalSettlementStatus(settlementStatusByAsset.get(row.asset));
    const decision: FollowerDecision = isTerminal
      ? { action: "SKIP", shares: 0, notional: 0, price, reason: SETTLED_POSITION_SKIP_REASON }
      : side === "BUY"
        ? decideDynamicBuy({
            price,
            startingCash: Number(experiment.starting_cash),
            cash,
          })
        : decideProportionalSell({
            price,
            sourceSharesBefore: before,
            sourceSoldShares: srcShares,
            paperShares: position.shares,
          });

    let cashAfter = cash;
    let realized = 0;
    let nextPosition = position;
    const prevCash = cash;
    const prevRealizedTotal = realizedTotal;

    if (decision.action === "BUY") {
      const applied = applyBuy(position, cash, decision.shares, decision.notional);
      nextPosition = applied.position;
      cashAfter = applied.cash;
      result.buys += 1;
      tradedAssets.add(row.asset);
    } else if (decision.action === "SELL") {
      const applied = applySell(position, cash, decision.shares, decision.price);
      nextPosition = applied.position;
      cashAfter = applied.cash;
      realized = applied.realized;
      realizedTotal = roundUsd(realizedTotal + realized);
      result.sells += 1;
      tradedAssets.add(row.asset);
    } else {
      result.skips += 1;
    }

    cash = cashAfter;

    const tradeRow = {
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
    };
    const auditRow = buildAuditRow({
      experimentId: experiment.id,
      wallet,
      eventKey: row.event_key,
      marketTitle: row.market_title,
      side,
      action: decision.action,
      sourceTs: Number(row.source_ts),
      firstSeenAt: row.first_seen_at,
    });

    const nextSourceShares = roundShares(nextSourceForRow);
    // Terminal positions are never written, even with unchanged values: the
    // existing paper_positions row (including settlement_status) must stay
    // byte-for-byte untouched by a late source event.
    const persistPosition =
      !isTerminal &&
      shouldPersistPaperPosition({
        hadExistingRow: existingPaperAssets.has(row.asset),
        tradedThisBatch: tradedAssets.has(row.asset),
      });

    const commit = await commitEventAtomically(
      lease,
      experiment.id,
      buildEventCommit({
        sourceEventId: row.id,
        backfilled: false,
        sourceState: {
          wallet,
          asset: row.asset,
          marketTitle: row.market_title,
          outcome: row.outcome,
          shares: nextSourceShares,
          lastEventKey: row.event_key,
          lastEventTs: Number(row.source_ts),
        },
        trade: tradeRow,
        paperPosition: persistPosition
          ? {
              asset: row.asset,
              marketTitle: row.market_title,
              outcome: row.outcome,
              shares: nextPosition.shares,
              costBasis: nextPosition.costBasis,
              avgPrice: nextPosition.avgPrice,
              realizedPnl: nextPosition.realizedPnl,
              lastActivityTs: Number(row.source_ts),
            }
          : null,
        experiment: { cash, realizedPnl: realizedTotal },
        audit: auditRow,
      }),
    );

    // This local source state is experiment-scoped and advances even for SKIP.
    sourceShares.set(row.asset, nextSourceShares);

    if (commit.applied) {
      paper.set(row.asset, nextPosition);
    } else {
      // This event's trade already existed: its accounting is already in the
      // persisted bankroll, so nothing may be applied a second time.
      cash = prevCash;
      realizedTotal = prevRealizedTotal;
      if (decision.action === "BUY") result.buys -= 1;
      if (decision.action === "SELL") result.sells -= 1;
    }
    result.processed += 1;
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Marks from the public CLOB                                          */
/* ------------------------------------------------------------------ */

/**
 * Marks come from ONE batched public POST /books call per 100 open positions.
 * Per-asset fetching could not cover a 200-position book inside a cycle, which
 * was the direct cause of both cycle-deadline failures and low mark coverage.
 */
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
  const rows = open ?? [];
  if (rows.length === 0) return { updated, failed };

  const { fetchBooksBatched } = await import("./clob-books.server");
  const books = await fetchBooksBatched(rows.map((r) => r.asset));

  const writeOne = async (asset: string) => {
    const book = books.get(asset) ?? null;
    if (book === null) {
      failed += 1;
      // No public book in this pass: clear rather than reuse a stale price, so
      // open P&L reads Unavailable instead of a fabricated mark.
      await supabaseAdmin
        .from("paper_positions")
        .update({ mark: null, mark_source: null, mark_ts: null, updated_at: new Date().toISOString() })
        .eq("experiment_id", experimentId)
        .eq("asset", asset);
      return;
    }
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
        mark_ts: resolved.mark === null ? null : new Date(book.ts).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("experiment_id", experimentId)
      .eq("asset", asset);
    if (resolved.mark === null) failed += 1;
    else updated += 1;
  };

  for (let i = 0; i < rows.length; i += MARK_WRITE_CONCURRENCY) {
    await Promise.all(rows.slice(i, i + MARK_WRITE_CONCURRENCY).map((r) => writeOne(r.asset)));
  }
  return { updated, failed };
}

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

export async function reconcile(
  wallet: string = TARGET_WALLET,
): Promise<{ ok: boolean; mismatches: number; replayComplete: boolean; replayedEvents: number }> {
  // The replay MUST cover every persisted fill. PostgREST caps a single request
  // at 1000 rows, so a plain .limit(5000) silently replayed only the oldest
  // page and reported every later asset as a phantom mismatch.
  const paged = await fetchAllRows<{ asset: string; side: string; shares: number }>(
    async (from, to) => {
      const { data, error } = await supabaseAdmin
        .from("source_events")
        .select("asset, side, shares")
        .eq("wallet", wallet)
        .order("source_ts", { ascending: true })
        .order("event_key", { ascending: true })
        .range(from, to);
      if (error) throw new Error(error.message);
      return (data ?? []) as { asset: string; side: string; shares: number }[];
    },
  );

  if (!paged.complete) {
    // Never repair from a truncated replay: that would corrupt correct state.
    await raiseAlert(
      "warn",
      "reconciliation_incomplete",
      `Reconciliation skipped for ${wallet}: the event replay was truncated after ${paged.rows.length} events.`,
      { wallet, events: paged.rows.length } as never,
    );
    return { ok: true, mismatches: 0, replayComplete: false, replayedEvents: paged.rows.length };
  }

  const replayed = replaySourcePositions(
    paged.rows.map((e) => ({
      asset: e.asset,
      side: (e.side === "SELL" ? "SELL" : "BUY") as Side,
      shares: Number(e.shares),
    })),
  );

  const compactPaged = await fetchAllRows<{ asset: string; shares: number }>(async (from, to) => {
    const { data, error } = await supabaseAdmin
      .from("source_position_state")
      .select("asset, shares")
      .eq("wallet", wallet)
      .order("asset", { ascending: true })
      .range(from, to);
    if (error) throw new Error(error.message);
    return (data ?? []) as { asset: string; shares: number }[];
  });
  const compact = new Map<string, number>();
  for (const r of compactPaged.rows) compact.set(r.asset, Number(r.shares));

  const result = reconcileSourceState(compact, replayed);
  const stamp = new Date().toISOString();
  const bad = new Set(result.mismatches.map((m) => m.asset));

  const rows = [...new Set([...compact.keys(), ...replayed.keys()])].map((asset) => ({
    wallet,
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
  return {
    ok: result.ok,
    mismatches: result.mismatches.length,
    replayComplete: true,
    replayedEvents: paged.rows.length,
  };
}

/* ------------------------------------------------------------------ */
/* One full poll cycle                                                 */
/* ------------------------------------------------------------------ */

export type CycleResult = {
  ranAt: string;
  experimentName: string;
  wallet: string;
  skipped: string | null;
  newEvents: number;
  pagesFetched: number;
  process: ProcessResult;
  marks: { updated: number; failed: number };
  reconciliation: { ok: boolean; mismatches: number } | null;
  lagSeconds: number | null;
  previews: { created: number; ineligible: number; failed: number; skippedReason: string | null };
  settlements: { settled: number; unresolved: number };
  copyability: { scheduled: number; sampled: number; unavailable: number };
  /** Stage-duration telemetry (ms) for this cycle. Empty on a skipped cycle. */
  stageMs?: Record<string, number>;
};

export type MultiCycleResult = {
  ranAt: string;
  experiments: number;
  cycles: CycleResult[];
  /** Reference SHADOW experiment result, kept for the existing dashboard read. */
  reference: CycleResult | null;
  /** Stuck worker rows whose state was reclaimed at the start of this cycle. */
  reclaimedWorkers: number;
  /** Experiments intentionally left for the next cycle to stay inside the budget. */
  deferredExperiments: number;
  candidateResearch: { ran: boolean; detail: string | null };
};

const NO_SETTLEMENTS = { settled: 0, unresolved: 0 };

const NO_PREVIEWS = {
  created: 0,
  ineligible: 0,
  failed: 0,
  skippedReason: null as string | null,
};

/**
 * Order-preview generation is best-effort: a Polymarket US outage must never
 * break autonomous public-wallet ingestion.
 */
async function generatePreviewsSafely(
  experimentId: string,
  wallet: string,
): Promise<typeof NO_PREVIEWS> {
  try {
    // Bounded, self-throttled public weather-availability scan. Its result is
    // what triggers automatic rechecks of previously unmatched source markets.
    const { runAvailabilityScan } = await import("./pmus/availability.server");
    await runAvailabilityScan();
    const { generatePendingPreviews } = await import("./pmus/previews.server");
    const result = await generatePendingPreviews(experimentId, {}, undefined, wallet);
    return {
      created: result.created,
      ineligible: result.ineligible,
      failed: result.failed,
      skippedReason: result.skippedReason,
    };
  } catch {
    return { ...NO_PREVIEWS, skippedReason: "Order-preview generation was skipped after an error." };
  }
}

/** Settlement automation is best-effort and must never break ingestion. */
async function settleSafely(experimentId: string): Promise<typeof NO_SETTLEMENTS> {
  try {
    const { runSettlementPass } = await import("./settlement.server");
    const result = await runSettlementPass(experimentId);
    return { settled: result.settled, unresolved: result.unresolved };
  } catch (err) {
    // Ingestion must stay isolated from settlement failure, but the failure
    // itself must never be silent. Bucketed hourly so a persistent outage does
    // not notify every minute.
    const message = err instanceof Error ? err.message : "unknown settlement error";
    const bucket = new Date().toISOString().slice(0, 13);
    try {
      await raiseAlert(
        "error",
        "settlement_pass_failed",
        `Settlement pass failed for experiment ${experimentId}: ${message} (at ${new Date().toISOString()})`,
        { experiment_id: experimentId as never, error: message as never },
        `settlement_pass_failed:${experimentId}:${bucket}`,
      );
    } catch {
      // alerting itself must not break ingestion
    }
    return NO_SETTLEMENTS;
  }
}

/**
 * Iterates every ENABLED experiment. Each experiment has its own lease,
 * checkpoint, bankroll, paper book, event-consumption state and source-position
 * state, so same-wallet experiments can evaluate the same immutable event stream
 * independently without competing for a shared processing bit.
 */
export async function runIngestCycle(workerId: string): Promise<MultiCycleResult> {
  const ranAt = new Date().toISOString();
  const startedMs = Date.now();
  const experiments = await listActiveExperiments();
  const reclaimed = await reclaimAbandonedWorkers();
  const ordered = await orderExperimentsForCycle(experiments);
  const cycles: CycleResult[] = [];
  let deferred = 0;
  // Experiments hold independent leases, checkpoints and books, so a small
  // concurrent batch cannot overlap execution for the same experiment. Batching
  // lets every enabled experiment finish inside one scheduler cycle, which is
  // what keeps marks inside the freshness window.
  for (const batch of chunked(ordered, EXPERIMENT_CONCURRENCY)) {
    if (Date.now() - startedMs > CYCLE_BUDGET_MS) {
      // Out of budget: leave the remaining experiments untouched. They are served
      // first on the next cycle because ordering is least-recently-completed-first.
      for (const experiment of batch) {
        deferred += 1;
        cycles.push({
          ...emptyCycle(ranAt, experiment),
          skipped: "Deferred to the next scheduled cycle (cycle time budget reached).",
        });
      }
      continue;
    }
    const settled = await Promise.allSettled(
      batch.map((experiment) => runExperimentCycle(experiment, workerId)),
    );
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        cycles.push(result.value);
        return;
      }
      cycles.push({
        ...emptyCycle(ranAt, batch[index]!),
        skipped: result.reason instanceof Error ? result.reason.message : "cycle failed",
      });
    });
  }
  return {
    ranAt,
    experiments: experiments.length,
    cycles,
    reference: cycles.find((c) => c.experimentName === EXPERIMENT_NAME) ?? null,
    reclaimedWorkers: reclaimed,
    deferredExperiments: deferred,
    candidateResearch:
      Date.now() - startedMs > CYCLE_BUDGET_MS
        ? { ran: false, detail: "deferred: cycle time budget reached" }
        : await refreshCandidateResearchSafely(),
  };
}

/**
 * A cycle killed by the platform leaves state='running' forever even though its
 * lease has long expired. The lease itself never blocked recovery (acquisition
 * is atomic and expiry-based), but the stuck state hid the failure from health
 * reporting. Reclaiming only rewrites worker STATE — never any paper accounting,
 * fence, or lease ownership — so fencing guarantees are untouched.
 */
async function reclaimAbandonedWorkers(): Promise<number> {
  const { data } = await supabaseAdmin
    .from("worker_status")
    .select("id, state, heartbeat_at, last_poll_at, last_success_at, lease_expires_at, poll_failures");
  const abandoned = findAbandonedWorkers((data ?? []) as unknown as WorkerRow[], Date.now());
  for (const row of abandoned) {
    await supabaseAdmin
      .from("worker_status")
      .update({
        state: "stale",
        last_error: "Previous cycle was abandoned before completion (lease expired while running).",
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id", row.id)
      .eq("state", "running");
  }
  return abandoned.length;
}

/** Least-recently-completed experiment first, so no experiment can be starved. */
async function orderExperimentsForCycle(experiments: Experiment[]): Promise<Experiment[]> {
  const { data } = await supabaseAdmin.from("worker_status").select("id, last_poll_at, last_success_at");
  const completedAt = new Map<string, number | null>();
  for (const row of (data ?? []) as { id: string; last_poll_at: string | null; last_success_at: string | null }[]) {
    const iso = row.last_success_at ?? row.last_poll_at;
    const ms = iso ? new Date(iso).getTime() : NaN;
    completedAt.set(row.id, Number.isFinite(ms) ? ms : null);
  }
  return orderByStaleness(experiments, (e) => completedAt.get(workerIdFor(e)) ?? null);
}

function emptyCycle(ranAt: string, experiment: Experiment): CycleResult {
  return {
    ranAt,
    experimentName: experiment.name,
    wallet: experiment.wallet_address,
    skipped: null,
    newEvents: 0,
    pagesFetched: 0,
    process: { processed: 0, buys: 0, sells: 0, skips: 0, backfilled: 0 },
    marks: { updated: 0, failed: 0 },
    reconciliation: null,
    lagSeconds: null,
    previews: NO_PREVIEWS,
    settlements: NO_SETTLEMENTS,
    copyability: { scheduled: 0, sampled: 0, unavailable: 0 },
  };
}

/**
 * Public-CLOB copyability sampling. Measurement only: a failure here must never
 * break ingestion or paper accounting.
 */
async function observeCopyabilitySafely(
  experiment: Experiment,
): Promise<{ scheduled: number; sampled: number; unavailable: number }> {
  try {
    const { runCopyabilityPass } = await import("./copyability/observe.server");
    return await runCopyabilityPass({
      id: experiment.id,
      starting_cash: Number(experiment.starting_cash),
      cash: Number(experiment.cash),
      ...(isGeneralShadowName(experiment.name)
        ? { delays: ["immediate", "30s", "60s"] as const }
        : {}),
    });
  } catch {
    return { scheduled: 0, sampled: 0, unavailable: 0 };
  }
}

/** Deterministic, de-duplicated cash-runway alerts. Never changes any bankroll. */
async function raiseCashAlerts(experiment: Experiment): Promise<void> {
  try {
    const { decideCashAlerts } = await import("./cash-runway");
    const { data: fresh } = await supabaseAdmin
      .from("paper_experiments")
      .select("cash, starting_cash")
      .eq("id", experiment.id)
      .maybeSingle();
    const alerts = decideCashAlerts({
      experimentId: experiment.id,
      experimentName: experiment.name,
      startingCash: Number(fresh?.starting_cash ?? experiment.starting_cash),
      cash: Number(fresh?.cash ?? experiment.cash),
    });
    for (const alert of alerts) {
      await raiseAlert(alert.level, alert.kind, alert.message, { experiment: experiment.name as never }, alert.dedupKey);
    }
  } catch {
    /* measurement only */
  }
}

/** Recurring candidate research refresh (throttled to once every 6 hours). */
async function refreshCandidateResearchSafely(): Promise<{ ran: boolean; detail: string | null }> {
  try {
    const { refreshCandidateResearchIfDue } = await import("./candidates/research.server");
    return await withDeadline(refreshCandidateResearchIfDue(), RESEARCH_DEADLINE_MS, "candidate research");
  } catch (err) {
    return { ran: false, detail: err instanceof Error ? err.message : "research refresh skipped" };
  }
}

export async function runExperimentCycle(
  experiment: Experiment,
  baseWorkerId: string,
): Promise<CycleResult> {
  const ranAt = new Date().toISOString();
  const lockId = workerIdFor(experiment);
  const wallet = experiment.wallet_address.toLowerCase();
  const workerId = `${baseWorkerId}:${experiment.name}`;
  const base = emptyCycle(ranAt, experiment);
  if (!experiment.enabled) {
    return {
      ...base,
      skipped: "Follower is paused (enabled = false).",
    };
  }

  const lease = await acquireLease(workerId, lockId);
  if (!lease) {
    return {
      ...base,
      skipped: "Another worker holds the ingestion lease.",
    };
  }

  /**
   * Per-stage durations, persisted with the worker row. This is how a slow
   * stage is identified in production instead of guessed at, and why the
   * mark stage could be proven to be the deadline consumer.
   */
  const stageMs: Record<string, number> = {};
  const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await work();
    } finally {
      stageMs[label] = Date.now() - startedAt;
    }
  };

  /**
   * How many source_events THIS poll attempt persisted, regardless of
   * whether the cycle goes on to succeed or fail in a later stage. Stays 0
   * if the cycle never reaches a successful persistEvents() result.
   */
  let cycleEventsInserted = 0;

  try {
    // Bounded so a hung upstream call fails through the normal error path (which
    // releases the lease) instead of being killed with the lease still claimed.
    const stages = await withDeadline(
      (async () => {
        // Bounded so a hung checkpoint load (or the one-time first-run bootstrap
        // write) can no longer strand the lease with no internal recovery: before
        // this was moved inside the deadline race, a hang here left heartbeat_at
        // advancing on lease acquisition but stage_ms/last_error/poll_failures
        // frozen forever, indistinguishable in worker_status from a permanent hang.
        const { data: checkpoint } = await timed("checkpoint_load", async () =>
          supabaseAdmin.from("worker_checkpoints").select("*").eq("id", lockId).maybeSingle(),
        );
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

        const window = await timed("source_ingest", () =>
          fetchSourceWindow(
            wallet,
            bootstrapped,
            resolveCatchupBoundary(checkpoint?.last_source_ts, experiment.follow_from_ts),
          ),
        );
        const events = normalizeSourceEvents(window.raw, wallet);
        const inserted = await timed("persist_events", () =>
          persistEvents(events, !isGeneralShadowName(experiment.name)),
        );
        cycleEventsInserted = inserted;
        const process = await timed("paper_processing", () => processPendingEvents(experiment, lease));
        const marks = await timed("mark_refresh", () =>
          boundedStage(refreshMarks(experiment.id), MARK_REFRESH_DEADLINE_MS, "mark_refresh", {
            updated: 0,
            failed: 0,
          }),
        );
        const reconciliation = await timed("reconciliation", () =>
          inserted > 0 || !bootstrapped
            ? boundedStage(reconcile(wallet), RECONCILE_DEADLINE_MS, "reconciliation", null)
            : Promise.resolve(null),
        );
        const settlements = await timed("settlement", () =>
          boundedStage(settleSafely(experiment.id), SETTLEMENT_DEADLINE_MS, "settlement", NO_SETTLEMENTS),
        );
        const previews = await timed("previews", () =>
          // General Shadow has no order path at all: the PMUS preview stage is
          // never reached for those experiments.
          isGeneralShadowName(experiment.name)
            ? Promise.resolve(NO_PREVIEWS)
            : boundedStage(
                generatePreviewsSafely(experiment.id, wallet),
                PREVIEW_DEADLINE_MS,
                "previews",
                NO_PREVIEWS,
              ),
        );
        if (isGeneralShadowName(experiment.name)) {
          await timed("general_activity", async () => {
            try {
              const { ingestGeneralActivity } = await import("./general-shadow.server");
              await withDeadline(
                ingestGeneralActivity(wallet),
                GENERAL_ACTIVITY_DEADLINE_MS,
                "general activity",
              );
            } catch {
              // Evidence-only stage: a failure never blocks paper accounting.
            }
          });
        }
        const copyability = await timed("copyability", () =>
          boundedStage(observeCopyabilitySafely(experiment), COPYABILITY_DEADLINE_MS, "copyability", {
            scheduled: 0,
            sampled: 0,
            unavailable: 0,
          }),
        );
        await timed("cash_alerts", () => raiseCashAlerts(experiment));
        return {
          checkpoint,
          window,
          events,
          inserted,
          process,
          marks,
          reconciliation,
          settlements,
          previews,
          copyability,
        };
      })(),
      EXPERIMENT_DEADLINE_MS,
      `${experiment.name} ingest cycle`,
    );
    const {
      checkpoint,
      window,
      events,
      inserted,
      process,
      marks,
      reconciliation,
      settlements,
      previews,
      copyability,
    } = stages;

    const newest = events.length ? Math.max(...events.map((e) => e.sourceTs)) : 0;
    const lagSeconds = newest > 0 ? Math.max(0, Math.round(Date.now() / 1000 - newest)) : null;

    await supabaseAdmin.from("worker_checkpoints").upsert({
      id: lockId,
      wallet,
      last_source_ts: Math.max(newest, checkpoint?.last_source_ts ?? 0),
      last_event_key: events.at(-1)?.eventKey ?? checkpoint?.last_event_key ?? null,
      events_seen: (checkpoint?.events_seen ?? 0) + inserted,
      bootstrap_complete: true,
      updated_at: new Date().toISOString(),
    });

    const { data: statusRow } = await supabaseAdmin
      .from("worker_status")
      .select("events_ingested")
      .eq("id", lockId)
      .maybeSingle();

    await releaseLease(lease, {
      state: "idle",
      last_error: null,
      poll_failures: 0,
      events_ingested: (statusRow?.events_ingested ?? 0) + inserted,
      lag_seconds: lagSeconds,
      last_success_at: new Date().toISOString(),
      stage_ms: stageMs as never,
      last_poll_events_inserted: cycleEventsInserted,
    });

    if (inserted > 0) {
      await raiseAlert("info", "new_source_trades", `${experiment.name}: detected ${inserted} new source trade(s).`, {
        experiment: experiment.name as never,
        buys: process.buys as never,
        sells: process.sells as never,
        skips: process.skips as never,
      });
    }
    if (process.skips > 0) {
      await raiseAlert("info", "paper_copy_skips", `${experiment.name}: skipped ${process.skips} source fill(s).`, {
        experiment: experiment.name as never,
      });
    }

    return {
      ...base,
      skipped: null,
      newEvents: inserted,
      pagesFetched: window.pagesFetched,
      process,
      marks,
      reconciliation,
      lagSeconds,
      previews,
      settlements,
      copyability,
      stageMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    const { data: statusRow } = await supabaseAdmin
      .from("worker_status")
      .select("poll_failures")
      .eq("id", lockId)
      .maybeSingle();
    const failures = (statusRow?.poll_failures ?? 0) + 1;
    await releaseLease(lease, {
      state: "error",
      last_error: message,
      poll_failures: failures,
      stage_ms: stageMs as never,
      last_poll_events_inserted: cycleEventsInserted,
    });
    if (failures === 1 || failures % 5 === 0) {
      await raiseAlert("error", "poll_failure", `${experiment.name}: ingestion poll failed: ${message}`, {
        experiment: experiment.name as never,
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
  const workerId = workerIdFor(experiment);
  const nowMs = Date.now();

  const [statusRes, checkpointRes, eventsRes, tradesRes, positionsRes, alertsRes, countsRes] =
    await Promise.all([
      supabaseAdmin.from("worker_status").select("*").eq("id", workerId).maybeSingle(),
      supabaseAdmin.from("worker_checkpoints").select("*").eq("id", workerId).maybeSingle(),
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

  const status = statusRes.data;

  // Lifetime count comes from source_events (the source of truth). The
  // hand-maintained worker_status.events_ingested counter is not presented
  // as authoritative for that figure.
  const totalEventsPersisted = countsRes.count ?? 0;
  // last_poll_events_inserted is diagnostic telemetry persisted directly by
  // the worker itself (see releaseLease in runExperimentCycle): the exact
  // count persistEvents() returned for the most recently COMPLETED poll
  // attempt, win or lose. Deriving this from first_seen_at >= last_poll_at
  // was structurally wrong — last_poll_at is stamped at cycle END, strictly
  // after that same cycle's own inserts, so the comparison always missed them.
  const lastPollEventsInserted: number | null = status
    ? Number((status as unknown as { last_poll_events_inserted?: number | null }).last_poll_events_inserted ?? 0)
    : null;

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
    // Phantom rows from the old write path: never funded, never closed for real.
    .filter(
      (p) =>
        !isPhantomClosedPosition({
          costBasis: Number(p.cost_basis),
          realizedPnl: Number(p.realized_pnl),
        }),
    )
    .map((p) => ({
      asset: p.asset,
      marketTitle: p.market_title ?? "Unknown market",
      outcome: p.outcome,
      realizedPnl: Number(p.realized_pnl),
      settlementStatus: p.settlement_status as string,
      lastActivityTs: p.last_activity_ts ? Number(p.last_activity_ts) : null,
    }))
    .sort((a, b) => (b.lastActivityTs ?? 0) - (a.lastActivityTs ?? 0));

  const openCostBasis = roundUsd(open.reduce((s, p) => s + p.costBasis, 0));
  const markedValue = open.every((p) => p.mark !== null)
    ? roundUsd(open.reduce((s, p) => s + p.shares * (p.mark as number), 0))
    : null;

  const heartbeatAgeSeconds = status?.heartbeat_at
    ? Math.round((nowMs - new Date(status.heartbeat_at).getTime()) / 1000)
    : null;

  return {
    fetchedAt: new Date(nowMs).toISOString(),
    wallet: TARGET_WALLET,
    experiment: {
      id: experiment.id,
      name: experiment.name,
      cohort: isV2Name(experiment.name) ? ("V2" as const) : ("V1" as const),
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
      lagSeconds: status?.lag_seconds ?? null,
      fence: status?.fence ?? 0,
      bootstrapComplete: checkpointRes.data?.bootstrap_complete ?? false,
      lastSourceTs: checkpointRes.data?.last_source_ts ?? 0,
    },
    totals: {
      totalEventsPersisted,
      lastPollEventsInserted,
      persistedEvents: totalEventsPersisted,
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
      // Legacy wallet-global processing flags remain visible only as provenance.
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
    sourceCompleteness: {
      status: "COMPLETE AS AVAILABLE FROM PUBLIC API" as const,
      detail: `Public trade history requested with ${TAKER_ONLY_PARAM}, which returns maker and taker fills.`,
    },
  };
}

export type DashboardData = Awaited<ReturnType<typeof loadDashboard>>;
