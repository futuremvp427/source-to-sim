/**
 * Sports Forward Shadow source wallet poller — SERVER (network/DB) orchestration.
 *
 * One bounded, one-shot call per wallet: paginate data-api.polymarket.com/trades for
 * ONE approved wallet, normalize via shadow-core.ts's already-proven
 * `normalizeSourceEvents`, persist every genuinely-new fill as durable evidence, then
 * retry EVERY currently-pending fill for this wallet (freshly inserted this poll, or
 * orphaned by an earlier failure/crash — see the Task 12D / P1-A design below) through
 * Task 3 eligibility and Task 4's pure `decideFill` reducer against durably-reconstructed
 * episode state. Task 11 is expected to invoke `pollSportsShadowWallet` repeatedly (once
 * per wallet per cycle) — this module has no internal loop, no timer, and no daemon of
 * its own.
 *
 * ============================== TASK 12D / P1-A: DURABLE DOWNSTREAM RETRY ==============================
 * ROOT CAUSE (Codex P1 finding): a fill's raw row could be inserted successfully, then
 * fail LATER — metadata lookup, UNVERIFIED metadata, findLatestEpisode, the episode
 * mutation itself — and the ONLY thing a later poll checked was insertRawFill's
 * `inserted: false` (i.e. "the raw row already exists"). That collapsed two genuinely
 * different states into one: "raw evidence persisted" and "downstream processing safely
 * applied" are NOT the same thing, and treating them as one meant a transient failure
 * permanently lost that fill from ever contributing to an episode/signal.
 *
 * FIX: `sports_shadow_source_fills.downstream_status` (see
 * supabase/migrations/20260821040000_sports_shadow_fill_retry_and_fairness.sql) makes
 * the two states independently durable. Every poll now has two phases: (1) insert every
 * genuinely-new fill as before (default downstream_status = PENDING, dedup semantics on
 * the raw insert itself are UNCHANGED); (2) query EVERY currently-PENDING fill for this
 * wallet — bounded, oldest source_ts first — and run it through classification +
 * decideFill, exactly like the pre-Task-12D inline loop did, except the DB write that
 * "commits" a fill's outcome now happens ONLY through insertEpisodeAtomic /
 * updateEpisodeAtomic (see below), which the migration proves atomically pairs the
 * episode mutation with marking that exact fill COMPLETE in one transaction.
 *
 * HARD DESIGN GATE — why a fill can never be applied twice, even across a crash:
 *   a. raw fill exists (downstream_status = PENDING)
 *   b. episode aggregation is COMPUTED (decideFill runs, produces nextState)
 *   c. the atomic RPC call that would commit nextState + mark this fill COMPLETE either
 *      fully commits or the process crashes before/during it
 *   d. if it crashed: NEITHER the episode mutation NOR the completion marker landed —
 *      Postgres rolled back the whole (single-function-call) transaction
 *   e. the next worker's retry re-reads episode state fresh via findLatestEpisode, sees
 *      the SAME prior state as before (because nothing from the crashed attempt
 *      persisted), recomputes the IDENTICAL decideFill result, and this time either
 *      commits cleanly (episode mutated + fill COMPLETE together) or crashes again with
 *      the same all-or-nothing guarantee
 * There is no reachable intermediate state where the episode was mutated but the fill is
 * still PENDING — by construction, not by convention. This relies on wallet polling
 * being serialized by Task 11's SOURCE_LOCK_ID lease (only one worker ever calls
 * pollSportsShadowWallet for a given wallet at a time); true concurrent double-processing
 * of the same wallet was already out of scope for the rest of Task 10/11.
 *
 * Terminal classification (a fill's OWN immutable data will never produce a different
 * outcome on retry, so it is safe to stop retrying it):
 *   - missing conditionId, or metadata.status === "INELIGIBLE"  -> TERMINAL_INELIGIBLE
 *   - decideFill returns INVALID_FILL (shares/price/side already violate its own
 *     invariants; those values never change once persisted)                -> TERMINAL_INVALID
 *   - metadata.status === "UNVERIFIED" (or a metadata fetch throws)  -> STAYS PENDING.
 *     Per the mission's explicit instruction, temporary uncertainty is never silently
 *     treated as permanently processed — Task 3's UNVERIFIED reason-code vocabulary
 *     mixes genuinely transient causes (fetch failure, malformed/empty response) with
 *     causes that happen to also be permanent in practice (ambiguous period, unknown
 *     team) without a cheap, already-proven way to tell them apart here; retrying a
 *     permanently-ambiguous market is bounded wasted work, not a correctness bug,
 *     whereas terminally dropping a transient one would be.
 *   - pre-go-live suppression (isEligibleForEpisodeTrigger === false)  -> COMPLETE. This
 *     is the historically-correct, final answer for that exact fill: goLiveAtMs is fixed
 *     and durable (Task 10), and (as of Task 12E / P1-F below) the decision depends ONLY
 *     on the fill's own immutable sourceTs vs. that fixed boundary — never on
 *     wallet-history state — so re-evaluating it on a later retry always reproduces the
 *     identical answer. Marking it COMPLETE here is a bounded-work optimization (stop
 *     retrying a fill whose answer can never change), not a correctness requirement.
 *
 * ============================== TASK 12E / P1-F: IMMUTABLE GO-LIVE DECISION ==============================
 * ROOT CAUSE (Codex P1 finding): isEligibleForEpisodeTrigger used to take an `isBootstrap`
 * flag and return `true` unconditionally once it was false. `isBootstrap` is recomputed
 * fresh every poll from `hasAnyFillsForWallet` — NOT an immutable property of any one
 * fill. A pre-go-live fill left PENDING (e.g. past MAX_PENDING_FILLS_PER_POLL, or a
 * transient markFillComplete failure) could therefore be retried on a later poll, once
 * the wallet had accrued unrelated history, and wrongly become eligible — the SAME fill
 * producing a DIFFERENT answer depending purely on when it happened to be retried.
 *
 * FIX: isEligibleForEpisodeTrigger(sourceTs, goLiveAtMs) now compares two immutable,
 * durable values only — no wallet-history flag. Truth table (verified by
 * source-poll.test.ts and this file's own P1-F integration tests):
 *   sourceTs  < goLiveAt                          -> NEVER eligible, on any retry/restart
 *   sourceTs == goLiveAt                           -> ELIGIBLE (inclusive boundary)
 *   sourceTs  > goLiveAt                           -> ELIGIBLE, on any retry/restart
 *   first bootstrap poll                           -> same pure rule, no special case
 *   later retry of a durably-PENDING fill          -> identical answer (sourceTs/goLiveAtMs unchanged)
 *   process restart                                -> identical answer (goLiveAtMs re-parsed from the same static config)
 *   pre-go-live fill beyond the pending cap         -> stays ineligible forever
 *   post-go-live fill recovered after worker downtime -> eligible regardless of how late it's discovered
 * ================================================================================
 *   - DUPLICATE_FILL, or SELL_RECORDED with no matching open episode  -> COMPLETE
 *     (single fill-only write, safe alone: either the aggregation is already reflected
 *     elsewhere, or there is genuinely nothing durable left to do for a SELL against no
 *     tracked position).
 *   - a network/DB failure at any step (metadata fetch, findLatestEpisode, the atomic
 *     RPC itself)  -> STAYS PENDING, retried next poll.
 *
 * Never imports pmus.ts/kalshi.ts/resolver.ts/observation.ts/depth-walk.ts — target-venue
 * matching and quote capture are explicitly out of scope here; Task 11 wires this
 * module's `newSignals` output into Task 8's `persistVenueMatch`.
 *
 * All network, DB, and clock access is dependency-injected (see WalletPollDeps) so tests
 * never touch a real database, network, or wall clock.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import {
  DATA_API_HOST,
  getHostCooldown,
  parseRetryAfterMs,
  recordHostRateLimit,
  reserveRequestSlot,
} from "../http-rate-limit.server";
import { buildTradesUrl, MAX_TRADES_OFFSET, PAGE_SIZE } from "../shadow.server";
import { normalizeSourceEvents, type NormalizedEvent, type RawTrade } from "../shadow-core";
import { classifyUnverifiedDisposition, type UnverifiedReasonCode } from "./eligibility";
import { decideFill, type EligibleFill, type OpenEpisodeState } from "./episode";
import { fetchSourceMarketMetadata } from "./source-metadata.server";
import { isEligibleForEpisodeTrigger } from "./source-poll";
import { NO_OP_LEASE_CHECKPOINT, type LeaseCheckpoint } from "./sports-lease.server";
import type { BetType, SourceMarketMetadata } from "./types";

/**
 * Bounded to exactly the provider's own offset ceiling (see MAX_TRADES_OFFSET's doc
 * comment in shadow.server.ts): 40 pages * 250/page = 10,000, the last offset the public
 * Data API will serve for /trades before returning HTTP 400. A wallet whose entire
 * unread backlog exceeds this in one poll cannot be fully covered by a single call —
 * `backlogTruncated` reports that explicitly rather than silently dropping older history.
 */
export const MAX_PAGES_PER_WALLET = Math.floor(MAX_TRADES_OFFSET / PAGE_SIZE) + 1;

/** Bounded per-poll cap on how many currently-PENDING fills are retried in phase 2 — generous relative to expected per-wallet volume, but never unbounded. Excess pending work simply stays durable for a later poll, exactly like Task 11B's pending-signal batch. */
export const MAX_PENDING_FILLS_PER_POLL = 500;

const REQUEST_TIMEOUT_MS = 12_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* Paced network fetch                                                 */
/* ------------------------------------------------------------------ */

export type SourcePollNetworkDeps = {
  fetchImpl: typeof fetch;
  reserveRequestSlot: (host: string) => Promise<number>;
  getHostCooldown: (host: string) => Promise<{ blocked: boolean; reason: string | null }>;
  recordHostRateLimit: (host: string, retryAfterMs: number | null) => Promise<void>;
};

const defaultNetworkDeps: SourcePollNetworkDeps = {
  fetchImpl: fetch,
  reserveRequestSlot,
  getHostCooldown,
  recordHostRateLimit,
};

/**
 * Fails CLOSED and EXPLICITLY (throws) on cooldown, reservation failure, timeout,
 * non-2xx, or a non-array body — mirrors pmus.server.ts/kalshi.server.ts's `pacedGetJson`
 * exactly. shadow.server.ts's own `getJson` is private/not exported and tightly coupled
 * to its checkpoint model, so this is a small, deliberately independent fetcher against
 * the SAME shared host budget (`DATA_API_HOST`), reusing only `buildTradesUrl` — the URL
 * shape that is already the proven production contract for this endpoint.
 */
async function pacedFetchTradesPage(wallet: string, offset: number, deps: SourcePollNetworkDeps): Promise<RawTrade[]> {
  const cooldown = await deps.getHostCooldown(DATA_API_HOST);
  if (cooldown.blocked) throw new Error(`${DATA_API_HOST} is in cooldown: ${cooldown.reason ?? "unknown reason"}`);

  const waitMs = await deps.reserveRequestSlot(DATA_API_HOST);
  if (waitMs > 0) await sleep(waitMs);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = buildTradesUrl(PAGE_SIZE, offset, wallet);
    const response = await deps.fetchImpl(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (response.status === 429) {
      await deps.recordHostRateLimit(DATA_API_HOST, parseRetryAfterMs(response.headers.get("retry-after")));
      throw new Error(`${DATA_API_HOST} rate limited (429) on /trades offset=${offset}`);
    }
    if (!response.ok) {
      throw new Error(`${DATA_API_HOST} request failed (HTTP ${response.status}) on /trades offset=${offset}`);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw new Error(`${DATA_API_HOST} /trades response was not valid JSON: ${err instanceof Error ? err.message : "unknown"}`);
    }
    if (!Array.isArray(json)) throw new Error(`${DATA_API_HOST} /trades returned a non-array response`);
    return json as RawTrade[];
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Repository (DI) — the ONLY thing that talks to Postgres              */
/* ------------------------------------------------------------------ */

export type RawFillRow = {
  eventKey: string;
  wallet: string;
  walletHandle: string | null;
  conditionId: string | null;
  asset: string;
  marketTitle: string;
  outcome: string | null;
  eventSlug: string | null;
  marketSlug: string | null;
  side: "BUY" | "SELL";
  shares: number;
  price: number;
  sourceTs: number;
  identityBasis: string;
  identityDegraded: boolean;
  raw: unknown;
};

export type InsertFillResult = { id: string; inserted: boolean };

export type EpisodeCacheEntry = { id: string; state: OpenEpisodeState };

export type NewSignalRow = {
  episodeKey: string;
  wallet: string;
  walletHandle: string | null;
  conditionId: string;
  asset: string;
  firstFillAtIso: string;
  lastFillAtIso: string;
  vwap: number;
  shares: number;
  notional: number;
  fillCount: number;
  sellSeen: boolean;
  league: string;
  scheduledStartAt: string | null;
  awayTeam: string | null;
  homeTeam: string | null;
  betType: BetType;
  selectedSide: string;
  line: number | null;
  sourceEventSlug: string | null;
  sourceMarketSlug: string | null;
  sourceOutcome: string | null;
};

/** A durably-persisted fill whose downstream (classification + episode) processing has not yet safely completed. Reconstructed entirely from already-stored columns — never re-fetched from the source API. */
export type PendingDownstreamFillRow = {
  id: string;
  eventKey: string;
  walletHandle: string | null;
  conditionId: string | null;
  asset: string;
  outcome: string | null;
  eventSlug: string | null;
  marketSlug: string | null;
  side: "BUY" | "SELL";
  shares: number;
  price: number;
  sourceTs: number;
};

export type PollRepository = {
  hasAnyFillsForWallet(wallet: string): Promise<boolean>;
  findExistingEventKeys(wallet: string, eventKeys: string[]): Promise<Set<string>>;
  insertRawFill(row: RawFillRow): Promise<InsertFillResult>;
  /**
   * For tx_hash_ordinal (degraded) identity reconciliation ONLY — see the
   * STABLE EVENT-KEY WINDOW-SHIFT AUDIT doc comment above
   * `reconcileDegradedEvents`. Counts, per raw economic tuple (the "ord:...#"
   * prefix, ordinal digits excluded), how many rows already durably exist for
   * this wallet — queried fresh against the database every call, never
   * cached, never derived from any single poll's own batch.
   */
  countDurableOrdinalFills(wallet: string, tuplePrefixes: string[]): Promise<Map<string, number>>;
  /** Most recent episode (by source_last_fill_at) for this exact position, if any. */
  findLatestEpisode(wallet: string, conditionId: string, asset: string): Promise<EpisodeCacheEntry | null>;
  /** Bounded, oldest-source_ts-first: every fill for this wallet whose downstream processing has not yet safely completed. Includes fills inserted THIS poll and any orphaned by an earlier failure/crash — see this module's Task 12D/P1-A doc comment. */
  findPendingDownstreamFills(wallet: string, limit: number): Promise<PendingDownstreamFillRow[]>;
  /** Atomically inserts the new episode row AND marks fillId's downstream_status COMPLETE in one transaction. */
  insertEpisodeAtomic(fillId: string, row: NewSignalRow): Promise<{ id: string }>;
  /** Atomically updates the existing episode's aggregate fields AND marks fillId's downstream_status COMPLETE in one transaction. */
  updateEpisodeAtomic(fillId: string, signalId: string, state: OpenEpisodeState): Promise<void>;
  /** Marks a fill COMPLETE with no paired episode mutation — safe as a lone single-table write (see this module's terminal-classification doc comment). */
  markFillComplete(fillId: string): Promise<void>;
  /** Marks a fill permanently terminal — its own immutable data will never produce a different outcome on retry. */
  markFillTerminal(fillId: string, status: "TERMINAL_INELIGIBLE" | "TERMINAL_INVALID"): Promise<void>;
  /** Task 12F / P1-H: marks a fill TERMINAL_UNVERIFIED, durably retaining the exact classifier reason code for later audit/accounting -- distinct from TERMINAL_INELIGIBLE (a positive ineligibility determination) since "could not verify" and "determined ineligible" remain different outcomes. */
  markFillTerminalUnverified(fillId: string, reasonCode: UnverifiedReasonCode): Promise<void>;
};

type RawPendingFillRow = {
  id: string;
  event_key: string;
  wallet_handle: string | null;
  condition_id: string | null;
  asset: string;
  outcome: string | null;
  event_slug: string | null;
  market_slug: string | null;
  side: "BUY" | "SELL";
  shares: number;
  price: number;
  source_ts: number;
};

/**
 * Real Supabase-backed repository. Table names cast `as never` — same established
 * pattern as http-rate-limit.server.ts / observation.server.ts — since generated
 * Supabase types lag this unapplied migration.
 *
 * SCHEMA GATE limitation (documented, non-blocking): `sports_shadow_signals` has only
 * `source_sell_seen boolean`, no `first_sell_at`/`last_sell_at`/`sell_count` columns.
 * OpenEpisodeState's three sell-detail fields are therefore never durably round-tripped
 * — reconstructed as null/0 on load, and never written back. This does not affect
 * `decideFill`'s branching (those fields are pure evidence, never read for a decision),
 * only their own future value, which the DB cannot represent yet.
 */
export const supabasePollRepository: PollRepository = {
  async hasAnyFillsForWallet(wallet) {
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_source_fills" as never)
      .select("id")
      .eq("wallet", wallet)
      .limit(1);
    if (error) throw new Error(error.message);
    return ((data as unknown[] | null)?.length ?? 0) > 0;
  },

  async findExistingEventKeys(wallet, eventKeys) {
    if (eventKeys.length === 0) return new Set();
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_source_fills" as never)
      .select("event_key")
      .eq("wallet", wallet)
      .in("event_key", eventKeys);
    if (error) throw new Error(error.message);
    return new Set(((data as unknown as { event_key: string }[] | null) ?? []).map((r) => r.event_key));
  },

  async insertRawFill(row) {
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_source_fills" as never)
      .upsert(
        {
          event_key: row.eventKey,
          wallet: row.wallet,
          wallet_handle: row.walletHandle,
          condition_id: row.conditionId,
          asset: row.asset,
          market_title: row.marketTitle,
          outcome: row.outcome,
          event_slug: row.eventSlug,
          market_slug: row.marketSlug,
          side: row.side,
          shares: row.shares,
          price: row.price,
          source_ts: row.sourceTs,
          identity_basis: row.identityBasis,
          identity_degraded: row.identityDegraded,
          raw: row.raw,
        } as never,
        { onConflict: "event_key", ignoreDuplicates: true },
      )
      .select("id");
    if (error) throw new Error(error.message);
    const inserted = (data as unknown as { id: string }[] | null) ?? [];
    if (inserted.length > 0) return { id: inserted[0]!.id, inserted: true };
    // Conflict path: the row already existed (a concurrent poller or a pre-filter miss).
    const { data: existing, error: selectError } = await supabaseAdmin
      .from("sports_shadow_source_fills" as never)
      .select("id")
      .eq("event_key", row.eventKey)
      .single();
    if (selectError) throw new Error(selectError.message);
    return { id: (existing as unknown as { id: string }).id, inserted: false };
  },

  async countDurableOrdinalFills(wallet, tuplePrefixes) {
    const out = new Map<string, number>();
    for (const prefix of tuplePrefixes) {
      const { count, error } = await supabaseAdmin
        .from("sports_shadow_source_fills" as never)
        .select("id", { count: "exact", head: true })
        .eq("wallet", wallet)
        .like("event_key", `${prefix}%`);
      if (error) throw new Error(error.message);
      out.set(prefix, count ?? 0);
    }
    return out;
  },

  async findLatestEpisode(wallet, conditionId, asset) {
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_signals" as never)
      .select(
        "id, episode_key, source_first_fill_at, source_last_fill_at, source_vwap, source_shares, source_notional, source_fill_count, source_sell_seen, sports_shadow_source_fills!first_fill_id(event_key)",
      )
      .eq("source_wallet", wallet)
      .eq("source_condition_id", conditionId)
      .eq("source_asset", asset)
      .order("source_last_fill_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    type Row = {
      id: string;
      episode_key: string;
      source_first_fill_at: string;
      source_last_fill_at: string;
      source_vwap: number;
      source_shares: number;
      source_notional: number;
      source_fill_count: number;
      source_sell_seen: boolean;
      sports_shadow_source_fills: { event_key: string } | null;
    };
    const row = data as unknown as Row;
    const anchorEventKey = row.sports_shadow_source_fills?.event_key ?? "";
    return {
      id: row.id,
      state: {
        episodeKey: row.episode_key,
        anchorEventKey,
        wallet,
        conditionId,
        asset,
        firstBuyAt: Math.floor(new Date(row.source_first_fill_at).getTime() / 1000),
        lastFillAt: Math.floor(new Date(row.source_last_fill_at).getTime() / 1000),
        vwap: row.source_vwap,
        totalShares: row.source_shares,
        totalNotional: row.source_notional,
        buyFillCount: row.source_fill_count,
        sellSeen: row.source_sell_seen,
        firstSellAt: null,
        lastSellAt: null,
        sellCount: 0,
        triggered: true,
        processedEventKeys: new Set(anchorEventKey ? [anchorEventKey] : []),
      },
    };
  },

  async findPendingDownstreamFills(wallet, limit) {
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_source_fills" as never)
      .select("id, event_key, wallet_handle, condition_id, asset, outcome, event_slug, market_slug, side, shares, price, source_ts")
      .eq("wallet", wallet)
      .eq("downstream_status", "PENDING")
      .order("source_ts", { ascending: true })
      .limit(limit);
    if (error) throw new Error(error.message);
    return ((data ?? []) as unknown as RawPendingFillRow[]).map((r) => ({
      id: r.id,
      eventKey: r.event_key,
      walletHandle: r.wallet_handle,
      conditionId: r.condition_id,
      asset: r.asset,
      outcome: r.outcome,
      eventSlug: r.event_slug,
      marketSlug: r.market_slug,
      side: r.side,
      shares: r.shares,
      price: r.price,
      sourceTs: r.source_ts,
    }));
  },

  async insertEpisodeAtomic(fillId, row) {
    const { data, error } = await supabaseAdmin.rpc("insert_sports_shadow_episode" as never, {
      p_fill_id: fillId,
      p_episode_key: row.episodeKey,
      p_source_wallet: row.wallet,
      p_source_handle: row.walletHandle,
      p_source_condition_id: row.conditionId,
      p_source_asset: row.asset,
      p_source_outcome: row.sourceOutcome,
      p_source_event_slug: row.sourceEventSlug,
      p_source_market_slug: row.sourceMarketSlug,
      p_source_first_fill_at: row.firstFillAtIso,
      p_source_last_fill_at: row.lastFillAtIso,
      p_source_vwap: row.vwap,
      p_source_shares: row.shares,
      p_source_notional: row.notional,
      p_source_fill_count: row.fillCount,
      p_source_sell_seen: row.sellSeen,
      p_league: row.league,
      p_scheduled_start_at: row.scheduledStartAt,
      p_away_team: row.awayTeam,
      p_home_team: row.homeTeam,
      p_bet_type: row.betType,
      p_selected_side: row.selectedSide,
      p_line: row.line,
    } as never);
    if (error) throw new Error(error.message);
    return { id: data as unknown as string };
  },

  async updateEpisodeAtomic(fillId, signalId, state) {
    const { error } = await supabaseAdmin.rpc("update_sports_shadow_episode" as never, {
      p_fill_id: fillId,
      p_signal_id: signalId,
      p_source_first_fill_at: new Date(state.firstBuyAt * 1000).toISOString(),
      p_source_last_fill_at: new Date(state.lastFillAt * 1000).toISOString(),
      p_source_vwap: state.vwap,
      p_source_shares: state.totalShares,
      p_source_notional: state.totalNotional,
      p_source_fill_count: state.buyFillCount,
      p_source_sell_seen: state.sellSeen,
    } as never);
    if (error) throw new Error(error.message);
  },

  async markFillComplete(fillId) {
    const { error } = await supabaseAdmin
      .from("sports_shadow_source_fills" as never)
      .update({ downstream_status: "COMPLETE" } as never)
      .eq("id", fillId);
    if (error) throw new Error(error.message);
  },

  async markFillTerminal(fillId, status) {
    const { error } = await supabaseAdmin
      .from("sports_shadow_source_fills" as never)
      .update({ downstream_status: status } as never)
      .eq("id", fillId);
    if (error) throw new Error(error.message);
  },

  async markFillTerminalUnverified(fillId, reasonCode) {
    const { error } = await supabaseAdmin
      .from("sports_shadow_source_fills" as never)
      .update({ downstream_status: "TERMINAL_UNVERIFIED", downstream_unverified_reason: reasonCode } as never)
      .eq("id", fillId);
    if (error) throw new Error(error.message);
  },
};

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

export type WalletPollDeps = {
  network: SourcePollNetworkDeps;
  repo: PollRepository;
  fetchSourceMarketMetadata: typeof fetchSourceMarketMetadata;
  now: () => number;
  /** Task 12F / P1-G: checked between trade pages and before each pending fill's downstream write so this poll can never continue non-idempotent episode mutations after its caller's source lease has been lost. Defaults to always-true for any caller not exercising lease-loss behavior. */
  checkpointLease: LeaseCheckpoint;
};

const defaultWalletPollDeps: WalletPollDeps = {
  network: defaultNetworkDeps,
  repo: supabasePollRepository,
  fetchSourceMarketMetadata,
  now: () => Date.now(),
  checkpointLease: NO_OP_LEASE_CHECKPOINT,
};

export type NewSignalSummary = {
  id: string;
  episodeKey: string;
  wallet: string;
  conditionId: string;
  asset: string;
  betType: BetType;
  selectedSide: string;
  line: number | null;
  awayTeam: string | null;
  homeTeam: string | null;
  scheduledStartAt: string | null;
  sourceEventSlug: string | null;
  sourceMarketSlug: string | null;
  vwap: number;
  shares: number;
  notional: number;
  firstFillAtIso: string;
};

export type WalletPollResult = {
  wallet: string;
  isBootstrap: boolean;
  pagesFetched: number;
  rowsFetched: number;
  newRows: number;
  duplicateRows: number;
  invalidRows: number;
  metadataFetchFailures: number;
  ineligibleRows: number;
  unverifiedRows: number;
  /** Task 12F / P1-H: the subset of unverifiedRows classified TERMINAL (see eligibility.ts's classifyUnverifiedDisposition) and marked TERMINAL_UNVERIFIED rather than left PENDING. */
  terminalUnverifiedRows: number;
  suppressedPreGoLive: number;
  newSignals: NewSignalSummary[];
  aggregatedCount: number;
  sellRecordedCount: number;
  lateReconciliationCount: number;
  /** True only when this was a RESUMPTION poll (wallet had prior history) and no durable overlap was found within MAX_PAGES_PER_WALLET — a genuine first-ever bootstrap hitting the page cap is NOT truncation (there is no "backlog" to complete). */
  backlogTruncated: boolean;
  /** How many fills processed this poll (phase 2) were NOT part of this poll's freshly-inserted batch — i.e. genuinely recovered from an earlier failed/crashed poll. Direct evidence of the Task 12D/P1-A durable-retry mechanism actually doing something, not just existing. */
  orphanedFillsRecovered: number;
  /** Task 12F / P1-G: true when checkpointLease() reported the source lease lost at any point this poll -- pagination and/or phase-2 downstream processing stopped immediately rather than continuing under a stale fence. */
  leaseLost: boolean;
  /** First error encountered, if any. Partial progress made before the error is still reflected in the other fields above — one bad page/row does not discard already-persisted evidence. */
  error: string | null;
};

function emptyResult(wallet: string): WalletPollResult {
  return {
    wallet,
    isBootstrap: false,
    pagesFetched: 0,
    rowsFetched: 0,
    newRows: 0,
    duplicateRows: 0,
    invalidRows: 0,
    metadataFetchFailures: 0,
    ineligibleRows: 0,
    unverifiedRows: 0,
    terminalUnverifiedRows: 0,
    suppressedPreGoLive: 0,
    newSignals: [],
    aggregatedCount: 0,
    sellRecordedCount: 0,
    lateReconciliationCount: 0,
    backlogTruncated: false,
    orphanedFillsRecovered: 0,
    leaseLost: false,
    error: null,
  };
}

/**
 * ============================ STABLE EVENT-KEY WINDOW-SHIFT AUDIT ============================
 * `normalizeSourceEvents`'s tx_hash_ordinal fallback (the tier every currently-observed
 * /trades row uses — see source-poll.ts's module doc) assigns "#N" per raw economic tuple
 * (txHash:asset:side:sourceTs:shares:price) FRESH within each call, counting occurrences in
 * whatever order that call's own input array happens to hold them. Two DIFFERENT physical
 * fills sharing an identical 6-way tuple (same tx, asset, side, integer-second timestamp,
 * shares, AND price — e.g. one taker order matching two makers at the same price/size in the
 * same block) get "#0"/"#1" ordinals that are ONLY meaningful within that one call. If a later
 * poll's own batch reorders or only partially re-observes such a colliding tuple, naively
 * trusting the recomputed "#N" string against a flat existing-key set can either (a) silently
 * skip a genuinely new physical fill as a false duplicate, or (b) attempt a duplicate insert —
 * see the Task 10 checkpoint report for the traced examples.
 *
 * FIX (Task-10-local, does not touch shadow-core.ts's shared identity scheme): reliable-basis
 * events (source_id / tx_hash_log_index) are unaffected — those keys are stable by
 * construction and use the plain existing-key-set path unchanged. Degraded (tx_hash_ordinal)
 * events are instead reconciled by COUNT per raw tuple against `countDurableOrdinalFills`,
 * which queries the database directly (never a prior poll's own in-memory computation):
 * if this poll's batch holds <= as many occurrences of a tuple as are already durable, ALL of
 * them are treated as already-represented and skipped; otherwise exactly the numeric excess
 * is inserted, using the highest-ordinal labels in the batch. This makes the OUTCOME
 * (row count, and therefore every VWAP/shares aggregate downstream) independent of which
 * specific physical occurrence happens to be labeled "#0" vs "#1" in any given poll — the six
 * tuple fields are, by definition of colliding, byte-identical across occurrences, so a
 * mislabeled instance still carries the correct data.
 *
 * Paired with the pagination change above (a page can only be trusted as "already-seen
 * territory" via a RELIABLE key match, never a degraded one), this eliminates the concrete
 * reordering/false-early-stop scenarios: whenever a poll finds a reliable anchor and stops
 * "normally" (not MAX_PAGES-truncated), its fetched pages are a complete, gapless,
 * newest-to-oldest slice back to that anchor, so any colliding tuple's occurrences within that
 * slice are counted together, in one call, correctly.
 *
 * RESIDUAL RISK (explicitly not claimed to be eliminated): this reasoning is inductive on
 * every EARLIER poll that established the durable state also having had complete coverage
 * back to ITS OWN reliable anchor. A poll whose own pagination hit MAX_PAGES_PER_WALLET
 * without ever finding a reliable anchor (`backlogTruncated: true`) does not itself corrupt
 * anything — `countDurableOrdinalFills` always reflects the database's true current count,
 * not that poll's own view — but if some earlier, already-forgotten poll was ALSO truncated
 * in a way that left one instance of a colliding tuple permanently outside every subsequent
 * poll's fetch window, that instance could still be undercounted. This requires the compound,
 * extremely narrow combination of (1) a genuine 6-way tuple collision between two distinct
 * physical fills, AND (2) that collision's instances being split across polls whose pagination
 * windows never both include them together. Eliminating this residual entirely would require
 * either a native identifier from the source API (not available today) or unconditionally
 * re-walking full wallet history every poll (defeats incremental resumption) — both out of
 * Task 10's local scope. Reported as OUTCOME C, not OUTCOME A, in the Task 10 checkpoint.
 * ================================================================================
 */

function ordinalSuffix(eventKey: string): number {
  const idx = eventKey.lastIndexOf("#");
  const n = idx >= 0 ? Number(eventKey.slice(idx + 1)) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
}

function ordinalPrefix(eventKey: string): string {
  const idx = eventKey.lastIndexOf("#");
  return idx >= 0 ? eventKey.slice(0, idx + 1) : eventKey;
}

/**
 * Splits `events` into (reliable, degraded), reconciles the degraded half by durable count
 * per raw tuple (see the window-shift audit above), and returns the combined genuinely-new
 * set — reliable events filtered by simple existing-key-set membership (unchanged behavior),
 * degraded events filtered by the count-based rule. `existingReliableKeys` must already be
 * the result of checking every reliable event's own eventKey against the repository.
 */
async function reconcileDegradedEvents(
  degradedEvents: NormalizedEvent[],
  wallet: string,
  repo: Pick<PollRepository, "countDurableOrdinalFills">,
): Promise<{ newDegraded: NormalizedEvent[]; duplicateCount: number; error: string | null }> {
  if (degradedEvents.length === 0) return { newDegraded: [], duplicateCount: 0, error: null };

  const groups = new Map<string, NormalizedEvent[]>();
  for (const e of degradedEvents) {
    const prefix = ordinalPrefix(e.eventKey);
    const list = groups.get(prefix);
    if (list) list.push(e);
    else groups.set(prefix, [e]);
  }

  let durableCounts: Map<string, number>;
  let error: string | null = null;
  try {
    durableCounts = await repo.countDurableOrdinalFills(wallet, [...groups.keys()]);
  } catch (err) {
    // Fail closed: on a genuine reconciliation-query failure, treat every degraded tuple this
    // poll observed as already fully durable (skip, never insert) rather than risk a
    // miscount under unverifiable state. Deferred fills are simply re-evaluated next poll.
    error = `countDurableOrdinalFills failed: ${err instanceof Error ? err.message : "unknown error"}`;
    durableCounts = new Map([...groups.keys()].map((k) => [k, Number.POSITIVE_INFINITY]));
  }

  const newDegraded: NormalizedEvent[] = [];
  let duplicateCount = 0;
  for (const [prefix, group] of groups) {
    const durableCount = durableCounts.get(prefix) ?? 0;
    const batchCount = group.length;
    if (batchCount <= durableCount) {
      duplicateCount += batchCount;
      continue;
    }
    const sorted = [...group].sort((a, b) => ordinalSuffix(a.eventKey) - ordinalSuffix(b.eventKey));
    duplicateCount += durableCount;
    newDegraded.push(...sorted.slice(durableCount));
  }

  return { newDegraded, duplicateCount, error };
}

/**
 * One bounded poll of ONE approved source wallet. `goLiveAtMs` is REQUIRED input
 * (caller-supplied, e.g. Task 11/config) — see `isEligibleForEpisodeTrigger` in
 * source-poll.ts for exactly how it gates a wallet's first-ever (bootstrap) poll.
 * Never throws: every failure mode is reported via `result.error` plus whatever partial
 * progress was made, so Task 11 can log/retry without special-casing exceptions.
 */
export async function pollSportsShadowWallet(
  wallet: string,
  goLiveAtMs: number | null,
  deps: Partial<WalletPollDeps> = {},
): Promise<WalletPollResult> {
  const d: WalletPollDeps = {
    ...defaultWalletPollDeps,
    ...deps,
    network: { ...defaultNetworkDeps, ...deps.network },
  };
  const normalizedWallet = wallet.toLowerCase();
  const detectedAtMs = d.now();
  const result = emptyResult(normalizedWallet);

  let hasHistory: boolean;
  try {
    hasHistory = await d.repo.hasAnyFillsForWallet(normalizedWallet);
  } catch (err) {
    result.error = `hasAnyFillsForWallet failed: ${err instanceof Error ? err.message : "unknown error"}`;
    return result;
  }
  result.isBootstrap = !hasHistory;

  const rawPages: RawTrade[][] = [];
  let overlapFound = false;
  try {
    for (let page = 0; page < MAX_PAGES_PER_WALLET; page += 1) {
      const offset = page * PAGE_SIZE;
      if (offset > MAX_TRADES_OFFSET) break;
      // Task 12F / P1-G: a full pagination pass can take up to MAX_PAGES_PER_WALLET * 12s
      // -- checked before each page so a lease lost mid-pagination stops issuing further
      // requests immediately. Pages already fetched are still processed below (Phase 1's
      // raw-fill insert is idempotent/dedup-safe regardless of lease state); it is ONLY
      // Phase 2's episode mutations that must never run under a stale fence.
      if (!(await d.checkpointLease())) {
        result.leaseLost = true;
        break;
      }
      const rows = await pacedFetchTradesPage(normalizedWallet, offset, d.network);
      result.pagesFetched += 1;
      if (rows.length === 0) break;
      rawPages.push(rows);
      result.rowsFetched += rows.length;

      // Overlap-to-stop must be proven with a RELIABLE key only (source_id or
      // tx_hash_log_index). A tx_hash_ordinal (degraded) key is re-derived fresh
      // per call from THIS page's own row order and carries no cross-poll identity
      // guarantee on its own — trusting it here could stop pagination one page too
      // early, leaving an older, not-yet-covered sibling of a colliding tuple
      // outside this poll's fetched range. See the window-shift audit above
      // reconcileDegradedEvents for the full reasoning.
      const pageReliableKeys = normalizeSourceEvents(rows, normalizedWallet)
        .filter((e) => !e.identityDegraded)
        .map((e) => e.eventKey);
      if (pageReliableKeys.length > 0) {
        const pageExisting = await d.repo.findExistingEventKeys(normalizedWallet, pageReliableKeys);
        if (pageExisting.size > 0) {
          overlapFound = true;
          break;
        }
      }
      if (rows.length < PAGE_SIZE) break;
    }
  } catch (err) {
    result.error = `trade page fetch failed: ${err instanceof Error ? err.message : "unknown error"}`;
  }

  // Task 12F / P1-G: a pagination pass stopped early by lease loss is NOT genuine backlog
  // exhaustion -- there may well be more history the wallet's own overlap key would have
  // found had the lease survived. Only a real MAX_PAGES_PER_WALLET exhaustion (or a
  // genuine short/empty page) without lease loss counts as backlogTruncated.
  if (hasHistory && !overlapFound && !result.leaseLost && result.error === null) {
    result.backlogTruncated = true;
  }

  const normalizedEvents: NormalizedEvent[] = normalizeSourceEvents(rawPages.flat(), normalizedWallet);
  const reliableEvents = normalizedEvents.filter((e) => !e.identityDegraded);
  const degradedEvents = normalizedEvents.filter((e) => e.identityDegraded);

  let existingReliableKeys: Set<string>;
  try {
    existingReliableKeys = await d.repo.findExistingEventKeys(normalizedWallet, reliableEvents.map((e) => e.eventKey));
  } catch (err) {
    result.error = result.error ?? `findExistingEventKeys failed: ${err instanceof Error ? err.message : "unknown error"}`;
    existingReliableKeys = new Set();
  }
  const newReliable = reliableEvents.filter((e) => !existingReliableKeys.has(e.eventKey));
  result.duplicateRows += reliableEvents.length - newReliable.length;

  const { newDegraded, duplicateCount: degradedDuplicates, error: reconcileError } = await reconcileDegradedEvents(degradedEvents, normalizedWallet, d.repo);
  result.error = result.error ?? reconcileError;
  result.duplicateRows += degradedDuplicates;

  const genuinelyNew = [...newReliable, ...newDegraded].sort((a, b) => a.sourceTs - b.sourceTs || a.eventKey.localeCompare(b.eventKey));

  /* -------------------- Phase 1: persist every genuinely-new fill as durable evidence -------------------- */
  const insertedThisPoll = new Set<string>();
  for (const event of genuinelyNew) {
    try {
      const insertResult = await d.repo.insertRawFill({
        eventKey: event.eventKey,
        wallet: normalizedWallet,
        walletHandle: rawStr(event.raw, "name"),
        conditionId: event.conditionId,
        asset: event.asset,
        marketTitle: event.marketTitle,
        outcome: event.outcome,
        eventSlug: rawStr(event.raw, "eventSlug"),
        marketSlug: event.slug,
        side: event.side,
        shares: event.shares,
        price: event.price,
        sourceTs: event.sourceTs,
        identityBasis: event.identityBasis,
        identityDegraded: event.identityDegraded,
        raw: event.raw,
      });
      if (insertResult.inserted) {
        result.newRows += 1;
        insertedThisPoll.add(insertResult.id);
      } else {
        result.duplicateRows += 1;
      }
    } catch (err) {
      result.error = result.error ?? `insertRawFill failed: ${err instanceof Error ? err.message : "unknown error"}`;
      result.invalidRows += 1;
    }
  }

  /*
   * -------------------- Phase 2: retry EVERY currently-pending fill for this wallet --------------------
   * Bounded, oldest source_ts first. Naturally includes fills just inserted above AND any
   * orphaned by an earlier failed/crashed poll — see this module's Task 12D/P1-A doc
   * comment for why re-running this against the same fill is always safe.
   *
   * Task 12F / P1-G: if the lease was already lost during pagination (or the checkpoint
   * below fails immediately), Phase 2 does not even start -- no metadata fetch, no
   * findLatestEpisode, no episode mutation is attempted under a lease this worker can no
   * longer prove it still holds. Every fill that would have been processed simply stays
   * PENDING, safely retryable by whichever worker holds the lease next.
   */
  if (!result.leaseLost && !(await d.checkpointLease())) {
    result.leaseLost = true;
  }
  if (result.leaseLost) {
    return result;
  }

  let pendingFills: PendingDownstreamFillRow[];
  try {
    pendingFills = await d.repo.findPendingDownstreamFills(normalizedWallet, MAX_PENDING_FILLS_PER_POLL);
  } catch (err) {
    result.error = result.error ?? `findPendingDownstreamFills failed: ${err instanceof Error ? err.message : "unknown error"}`;
    pendingFills = [];
  }
  result.orphanedFillsRecovered = pendingFills.filter((f) => !insertedThisPoll.has(f.id)).length;

  const positionCache = new Map<string, EpisodeCacheEntry | null>();
  const metadataCache = new Map<string, SourceMarketMetadata>();

  for (const fill of pendingFills) {
    // Task 12F / P1-G: checked at the top of every iteration, BEFORE this fill's own
    // (up to 10s) metadata fetch -- once lost, the entire remaining batch is abandoned
    // (safely PENDING) rather than continuing to spend metadata-fetch budget on fills
    // that could not be safely written anyway.
    if (!(await d.checkpointLease())) {
      result.leaseLost = true;
      break;
    }
    if (!fill.conditionId) {
      result.unverifiedRows += 1;
      try {
        await d.repo.markFillTerminal(fill.id, "TERMINAL_INELIGIBLE");
      } catch {
        // Best-effort: a failed terminal-marker write just leaves this fill PENDING,
        // re-evaluated (and re-attempted) identically next poll.
      }
      continue;
    }

    let metadata = metadataCache.get(fill.conditionId);
    if (!metadata) {
      try {
        metadata = await d.fetchSourceMarketMetadata(fill.conditionId);
      } catch (err) {
        result.error = result.error ?? `fetchSourceMarketMetadata failed: ${err instanceof Error ? err.message : "unknown error"}`;
        result.metadataFetchFailures += 1;
        continue; // stays PENDING
      }
      metadataCache.set(fill.conditionId, metadata);
    }

    if (metadata.status === "INELIGIBLE") {
      result.ineligibleRows += 1;
      try {
        await d.repo.markFillTerminal(fill.id, "TERMINAL_INELIGIBLE");
      } catch {
        // Best-effort; stays PENDING and is re-evaluated identically next poll.
      }
      continue;
    }
    if (metadata.status === "UNVERIFIED") {
      result.unverifiedRows += 1;
      // Task 12F / P1-H: retryable (transport/response-availability) reasons stay
      // PENDING exactly as before -- temporary uncertainty is never silently treated as
      // permanent. Terminal (classifier-level, deterministic-given-this-conditionId)
      // reasons are marked TERMINAL_UNVERIFIED so they stop permanently occupying this
      // bounded batch's retry capacity, while durably retaining the reason code as
      // evidence (see eligibility.ts's classifyUnverifiedDisposition for the exact split
      // and rationale).
      if (classifyUnverifiedDisposition(metadata.reasonCode as UnverifiedReasonCode) === "TERMINAL") {
        result.terminalUnverifiedRows += 1;
        try {
          await d.repo.markFillTerminalUnverified(fill.id, metadata.reasonCode as UnverifiedReasonCode);
        } catch {
          // Best-effort; stays PENDING and is re-evaluated identically next poll.
        }
      }
      continue;
    }
    if (!metadata.betType) {
      // Defensive: status claims something other than UNVERIFIED/INELIGIBLE but betType
      // is still null (should never happen for a genuine ELIGIBLE result). Fail closed to
      // PENDING rather than guessing a disposition from a reasonCode that may not even be
      // a real UnverifiedReasonCode in this anomalous state.
      result.unverifiedRows += 1;
      continue;
    }

    const eligibleFill: EligibleFill = {
      eventKey: fill.eventKey,
      wallet: normalizedWallet,
      conditionId: fill.conditionId,
      asset: fill.asset,
      side: fill.side,
      shares: fill.shares,
      price: fill.price,
      sourceTs: fill.sourceTs,
      detectedAt: detectedAtMs,
    };

    if (!isEligibleForEpisodeTrigger(fill.sourceTs, goLiveAtMs)) {
      result.suppressedPreGoLive += 1;
      try {
        await d.repo.markFillComplete(fill.id);
      } catch {
        // Best-effort; stays PENDING and is re-evaluated identically next poll. Task 12E/P1-F:
        // this stays safe under retry because the decision depends ONLY on this fill's own
        // immutable sourceTs and the fixed, durable goLiveAtMs -- never on wallet-history
        // state -- so it is guaranteed to still be false next time.
      }
      continue;
    }

    const positionKey = `${normalizedWallet}:${fill.conditionId}:${fill.asset}`;
    let cacheEntry: EpisodeCacheEntry | null;
    if (positionCache.has(positionKey)) {
      cacheEntry = positionCache.get(positionKey)!;
    } else {
      try {
        cacheEntry = await d.repo.findLatestEpisode(normalizedWallet, fill.conditionId, fill.asset);
      } catch (err) {
        result.error = result.error ?? `findLatestEpisode failed: ${err instanceof Error ? err.message : "unknown error"}`;
        continue; // stays PENDING
      }
      positionCache.set(positionKey, cacheEntry);
    }

    const decision = decideFill(eligibleFill, cacheEntry ? cacheEntry.state : null);

    if (decision.kind === "INVALID_FILL") {
      result.invalidRows += 1;
      try {
        await d.repo.markFillTerminal(fill.id, "TERMINAL_INVALID");
      } catch {
        // Best-effort; stays PENDING and is re-evaluated identically next poll.
      }
      continue;
    }
    if (decision.kind === "DUPLICATE_FILL") {
      result.duplicateRows += 1;
      try {
        await d.repo.markFillComplete(fill.id);
      } catch {
        // Best-effort; stays PENDING and is re-evaluated identically next poll.
      }
      continue;
    }
    if (decision.kind === "SELL_RECORDED") {
      result.sellRecordedCount += 1;
      if (decision.nextState && cacheEntry) {
        // Task 12F / P1-G, requirement E: re-verify ownership immediately before the
        // state-changing write, after whatever await (metadata fetch, findLatestEpisode)
        // preceded it this iteration -- a lease that was valid at the top of this
        // iteration may have been lost during that await.
        if (!(await d.checkpointLease())) {
          result.leaseLost = true;
          break;
        }
        try {
          await d.repo.updateEpisodeAtomic(fill.id, cacheEntry.id, decision.nextState);
          positionCache.set(positionKey, { id: cacheEntry.id, state: decision.nextState });
        } catch (err) {
          result.error = result.error ?? `updateEpisodeAtomic (SELL_RECORDED) failed: ${err instanceof Error ? err.message : "unknown error"}`;
          // stays PENDING
        }
      } else {
        try {
          await d.repo.markFillComplete(fill.id);
        } catch {
          // Best-effort; stays PENDING and is re-evaluated identically next poll.
        }
      }
      continue;
    }
    if (decision.kind === "AGGREGATED_BUY" || decision.kind === "LATE_RECONCILIATION") {
      if (decision.kind === "AGGREGATED_BUY") result.aggregatedCount += 1;
      else result.lateReconciliationCount += 1;
      if (cacheEntry) {
        if (!(await d.checkpointLease())) {
          result.leaseLost = true;
          break;
        }
        try {
          await d.repo.updateEpisodeAtomic(fill.id, cacheEntry.id, decision.nextState);
          positionCache.set(positionKey, { id: cacheEntry.id, state: decision.nextState });
        } catch (err) {
          result.error = result.error ?? `updateEpisodeAtomic failed: ${err instanceof Error ? err.message : "unknown error"}`;
          // stays PENDING
        }
      }
      continue;
    }

    // NEW_EPISODE | NEW_EPISODE_AFTER_30M
    const firstFillAtIso = new Date(fill.sourceTs * 1000).toISOString();
    const newRow: NewSignalRow = {
      episodeKey: decision.episodeKey,
      wallet: normalizedWallet,
      walletHandle: fill.walletHandle,
      conditionId: fill.conditionId,
      asset: fill.asset,
      firstFillAtIso,
      lastFillAtIso: firstFillAtIso,
      vwap: decision.nextState.vwap,
      shares: decision.nextState.totalShares,
      notional: decision.nextState.totalNotional,
      fillCount: decision.nextState.buyFillCount,
      sellSeen: decision.nextState.sellSeen,
      league: metadata.league ?? "MLB",
      scheduledStartAt: metadata.gameStartTime,
      awayTeam: metadata.awayTeam,
      homeTeam: metadata.homeTeam,
      betType: metadata.betType,
      selectedSide: fill.outcome ?? "UNKNOWN",
      line: metadata.line,
      sourceEventSlug: metadata.eventSlug,
      sourceMarketSlug: metadata.marketSlug,
      sourceOutcome: fill.outcome,
    };
    if (!(await d.checkpointLease())) {
      result.leaseLost = true;
      break;
    }
    try {
      const inserted = await d.repo.insertEpisodeAtomic(fill.id, newRow);
      positionCache.set(positionKey, { id: inserted.id, state: decision.nextState });
      result.newSignals.push({
        id: inserted.id,
        episodeKey: decision.episodeKey,
        wallet: normalizedWallet,
        conditionId: fill.conditionId,
        asset: fill.asset,
        betType: metadata.betType,
        selectedSide: newRow.selectedSide,
        line: metadata.line,
        awayTeam: metadata.awayTeam,
        homeTeam: metadata.homeTeam,
        scheduledStartAt: metadata.gameStartTime,
        sourceEventSlug: metadata.eventSlug,
        sourceMarketSlug: metadata.marketSlug,
        vwap: decision.nextState.vwap,
        shares: decision.nextState.totalShares,
        notional: decision.nextState.totalNotional,
        firstFillAtIso,
      });
    } catch (err) {
      result.error = result.error ?? `insertEpisodeAtomic failed: ${err instanceof Error ? err.message : "unknown error"}`;
      // stays PENDING
    }
  }

  return result;
}

function rawStr(raw: unknown, key: string): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = (raw as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}
