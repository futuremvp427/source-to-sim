/**
 * Sports Forward Shadow source wallet poller — SERVER (network/DB) orchestration.
 *
 * One bounded, one-shot call per wallet: paginate data-api.polymarket.com/trades for
 * ONE approved wallet, normalize via shadow-core.ts's already-proven
 * `normalizeSourceEvents`, persist every genuinely-new fill as durable evidence, resolve
 * source-market eligibility (Task 3), and feed ELIGIBLE fills through Task 4's pure
 * `decideFill` reducer against durably-reconstructed episode state. Task 11 is expected
 * to invoke `pollSportsShadowWallet` repeatedly (once per wallet per cycle) — this
 * module has no internal loop, no timer, and no daemon of its own.
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
import { decideFill, type OpenEpisodeState } from "./episode";
import { fetchSourceMarketMetadata } from "./source-metadata.server";
import { isEligibleForEpisodeTrigger, toEligibleFill } from "./source-poll";
import type { BetType, SourceMarketMetadata } from "./types";

/**
 * Bounded to exactly the provider's own offset ceiling (see MAX_TRADES_OFFSET's doc
 * comment in shadow.server.ts): 40 pages * 250/page = 10,000, the last offset the public
 * Data API will serve for /trades before returning HTTP 400. A wallet whose entire
 * unread backlog exceeds this in one poll cannot be fully covered by a single call —
 * `backlogTruncated` reports that explicitly rather than silently dropping older history.
 */
export const MAX_PAGES_PER_WALLET = Math.floor(MAX_TRADES_OFFSET / PAGE_SIZE) + 1;

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
  firstFillId: string;
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
  insertNewEpisode(row: NewSignalRow): Promise<{ id: string }>;
  updateEpisode(id: string, state: OpenEpisodeState): Promise<void>;
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

  async insertNewEpisode(row) {
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_signals" as never)
      .insert({
        episode_key: row.episodeKey,
        source_wallet: row.wallet,
        source_handle: row.walletHandle,
        source_condition_id: row.conditionId,
        source_asset: row.asset,
        source_outcome: row.sourceOutcome,
        source_event_slug: row.sourceEventSlug,
        source_market_slug: row.sourceMarketSlug,
        first_fill_id: row.firstFillId,
        source_first_fill_at: row.firstFillAtIso,
        source_last_fill_at: row.lastFillAtIso,
        source_vwap: row.vwap,
        source_shares: row.shares,
        source_notional: row.notional,
        source_fill_count: row.fillCount,
        source_sell_seen: row.sellSeen,
        league: row.league,
        scheduled_start_at: row.scheduledStartAt,
        away_team: row.awayTeam,
        home_team: row.homeTeam,
        bet_type: row.betType,
        selected_side: row.selectedSide,
        line: row.line,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: (data as unknown as { id: string }).id };
  },

  async updateEpisode(id, state) {
    const { error } = await supabaseAdmin
      .from("sports_shadow_signals" as never)
      .update({
        source_first_fill_at: new Date(state.firstBuyAt * 1000).toISOString(),
        source_last_fill_at: new Date(state.lastFillAt * 1000).toISOString(),
        source_vwap: state.vwap,
        source_shares: state.totalShares,
        source_notional: state.totalNotional,
        source_fill_count: state.buyFillCount,
        source_sell_seen: state.sellSeen,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id", id);
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
};

const defaultWalletPollDeps: WalletPollDeps = {
  network: defaultNetworkDeps,
  repo: supabasePollRepository,
  fetchSourceMarketMetadata,
  now: () => Date.now(),
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
  suppressedPreGoLive: number;
  newSignals: NewSignalSummary[];
  aggregatedCount: number;
  sellRecordedCount: number;
  lateReconciliationCount: number;
  /** True only when this was a RESUMPTION poll (wallet had prior history) and no durable overlap was found within MAX_PAGES_PER_WALLET — a genuine first-ever bootstrap hitting the page cap is NOT truncation (there is no "backlog" to complete). */
  backlogTruncated: boolean;
  /** First error encountered, if any. Partial progress made before the error is still reflected in the other fields above — one bad page/row does not discard already-persisted evidence. */
  error: string | null;
};

function rawStr(raw: unknown, key: string): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = (raw as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

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
    suppressedPreGoLive: 0,
    newSignals: [],
    aggregatedCount: 0,
    sellRecordedCount: 0,
    lateReconciliationCount: 0,
    backlogTruncated: false,
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

  if (hasHistory && !overlapFound && result.error === null) {
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

  const positionCache = new Map<string, EpisodeCacheEntry | null>();
  const metadataCache = new Map<string, SourceMarketMetadata>();

  for (const event of genuinelyNew) {
    let fillId: string;
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
      if (!insertResult.inserted) {
        result.duplicateRows += 1;
        continue;
      }
      fillId = insertResult.id;
      result.newRows += 1;
    } catch (err) {
      result.error = result.error ?? `insertRawFill failed: ${err instanceof Error ? err.message : "unknown error"}`;
      result.invalidRows += 1;
      continue;
    }

    if (!event.conditionId) {
      result.unverifiedRows += 1;
      continue;
    }

    let metadata = metadataCache.get(event.conditionId);
    if (!metadata) {
      try {
        metadata = await d.fetchSourceMarketMetadata(event.conditionId);
      } catch (err) {
        result.error = result.error ?? `fetchSourceMarketMetadata failed: ${err instanceof Error ? err.message : "unknown error"}`;
        result.metadataFetchFailures += 1;
        continue;
      }
      metadataCache.set(event.conditionId, metadata);
    }

    if (metadata.status === "INELIGIBLE") {
      result.ineligibleRows += 1;
      continue;
    }
    if (metadata.status === "UNVERIFIED" || !metadata.betType) {
      result.unverifiedRows += 1;
      continue;
    }

    const eligibleFill = toEligibleFill(event, detectedAtMs);
    if (!eligibleFill) {
      result.invalidRows += 1;
      continue;
    }

    if (!isEligibleForEpisodeTrigger(event.sourceTs, result.isBootstrap, goLiveAtMs)) {
      result.suppressedPreGoLive += 1;
      continue;
    }

    const positionKey = `${normalizedWallet}:${event.conditionId}:${event.asset}`;
    let cacheEntry: EpisodeCacheEntry | null;
    if (positionCache.has(positionKey)) {
      cacheEntry = positionCache.get(positionKey)!;
    } else {
      try {
        cacheEntry = await d.repo.findLatestEpisode(normalizedWallet, event.conditionId, event.asset);
      } catch (err) {
        result.error = result.error ?? `findLatestEpisode failed: ${err instanceof Error ? err.message : "unknown error"}`;
        continue;
      }
      positionCache.set(positionKey, cacheEntry);
    }

    const decision = decideFill(eligibleFill, cacheEntry ? cacheEntry.state : null);

    if (decision.kind === "INVALID_FILL") {
      result.invalidRows += 1;
      continue;
    }
    if (decision.kind === "DUPLICATE_FILL") {
      result.duplicateRows += 1;
      continue;
    }
    if (decision.kind === "SELL_RECORDED") {
      result.sellRecordedCount += 1;
      if (decision.nextState && cacheEntry) {
        try {
          await d.repo.updateEpisode(cacheEntry.id, decision.nextState);
          positionCache.set(positionKey, { id: cacheEntry.id, state: decision.nextState });
        } catch (err) {
          result.error = result.error ?? `updateEpisode (SELL_RECORDED) failed: ${err instanceof Error ? err.message : "unknown error"}`;
        }
      }
      continue;
    }
    if (decision.kind === "AGGREGATED_BUY" || decision.kind === "LATE_RECONCILIATION") {
      if (decision.kind === "AGGREGATED_BUY") result.aggregatedCount += 1;
      else result.lateReconciliationCount += 1;
      if (cacheEntry) {
        try {
          await d.repo.updateEpisode(cacheEntry.id, decision.nextState);
          positionCache.set(positionKey, { id: cacheEntry.id, state: decision.nextState });
        } catch (err) {
          result.error = result.error ?? `updateEpisode failed: ${err instanceof Error ? err.message : "unknown error"}`;
        }
      }
      continue;
    }

    // NEW_EPISODE | NEW_EPISODE_AFTER_30M
    const firstFillAtIso = new Date(event.sourceTs * 1000).toISOString();
    const newRow: NewSignalRow = {
      episodeKey: decision.episodeKey,
      wallet: normalizedWallet,
      walletHandle: rawStr(event.raw, "name"),
      conditionId: event.conditionId,
      asset: event.asset,
      firstFillId: fillId,
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
      selectedSide: event.outcome ?? "UNKNOWN",
      line: metadata.line,
      sourceEventSlug: metadata.eventSlug,
      sourceMarketSlug: metadata.marketSlug,
      sourceOutcome: event.outcome,
    };
    try {
      const inserted = await d.repo.insertNewEpisode(newRow);
      positionCache.set(positionKey, { id: inserted.id, state: decision.nextState });
      result.newSignals.push({
        id: inserted.id,
        episodeKey: decision.episodeKey,
        wallet: normalizedWallet,
        conditionId: event.conditionId,
        asset: event.asset,
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
      result.error = result.error ?? `insertNewEpisode failed: ${err instanceof Error ? err.message : "unknown error"}`;
    }
  }

  return result;
}
