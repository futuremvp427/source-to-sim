/**
 * Sports Forward Shadow observation scheduling + persistence — SERVER (DB/network) layer.
 *
 * Orchestrates the pure builders in observation.ts against Supabase
 * (sports_market_matches / sports_quote_observations) and the Task 5/6 live book
 * fetchers. All dependencies (repository, book fetchers, clock) are injectable so tests
 * never touch a real database, network, or wall clock — see ObservationDeps.
 *
 * Match-persistence ratchet: once a (signal, venue) match is EXACT, it is never
 * silently downgraded by a later, worse-informed call (e.g. a transient discovery gap
 * that would otherwise re-resolve to NONE/UNVERIFIED). Any other transition (including
 * NEAR/NONE/UNVERIFIED -> EXACT, or re-writing an identical result) proceeds normally.
 * This is a simple one-way ratchet, not a versioning system.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { fetchKalshiBook } from "./kalshi.server";
import { fetchPmusBook } from "./pmus.server";
import {
  buildKalshiObservationPatch,
  buildMatchRow,
  buildObservationRows,
  buildPmusObservationPatch,
  buildTerminalFailurePatch,
  isSchedulable,
  type MatchRow,
  type ObservationCapturePatch,
  type ObservationScheduleRow,
} from "./observation";
import type { MatchStatus, VenueMatchResult } from "./resolver";
import type { Venue } from "./types";

/** Bounded due-observation batch per collector call — each due row issues one real book fetch, sequentially (never Promise.all), so this directly bounds wall-clock time and outbound request volume per cycle. Task 11 calls the collector repeatedly rather than this module looping unboundedly. */
export const DUE_BATCH_LIMIT = 20;

export type ExistingMatch = { id: string; status: MatchStatus };

export type DueObservationRow = {
  id: string;
  signalId: string;
  matchId: string;
  venue: Venue;
  requestedDelayMs: number;
  fireAt: string;
  /** From the joined sports_market_matches row — what to pass to fetchPmusBook/fetchKalshiBook. Null only if the schema/data is unexpectedly incomplete. */
  targetFetchKey: string | null;
  /** Serialized target side from the joined match row (e.g. "YES"/"NO"/"TEAM:NYY"). */
  selectedSide: string | null;
};

/** Repository abstraction — the ONLY thing that talks to Postgres. Swappable in tests for an in-memory fake; the default (see supabaseObservationRepository) is the real Supabase-backed implementation. */
export type ObservationRepository = {
  getExistingMatch(signalId: string, venue: Venue): Promise<ExistingMatch | null>;
  upsertMatch(row: MatchRow): Promise<{ id: string }>;
  /** Idempotent insert (ON CONFLICT (signal_id, venue, requested_delay_ms) DO NOTHING). Returns the count actually inserted (0 on a pure retry). */
  scheduleObservations(rows: ObservationScheduleRow[]): Promise<number>;
  findDueObservations(nowIso: string, limit: number): Promise<DueObservationRow[]>;
  /** CAS: only a row still `observed_at IS NULL` may transition. Returns whether THIS call won. */
  claimObservationTerminal(id: string, patch: ObservationCapturePatch): Promise<boolean>;
};

function toDbPatch(patch: ObservationCapturePatch): Record<string, unknown> {
  return {
    observed_at: patch.observedAt,
    fetch_started_at: patch.fetchStartedAt,
    fetch_ended_at: patch.fetchEndedAt,
    detection_latency_ms: patch.detectionLatencyMs,
    best_bid: patch.bestBid,
    best_ask: patch.bestAsk,
    spread: patch.spread,
    bid_depth: patch.bidDepth,
    ask_depth: patch.askDepth,
    market_status: patch.marketStatus,
    stale: patch.stale,
    error_code: patch.errorCode,
    reason: patch.reason,
    raw_metadata: patch.rawMetadata,
  };
}

/**
 * Real Supabase-backed repository. Table names are cast `as never` (matching the
 * existing http_rate_limits/reserve_http_request_slot pattern in
 * http-rate-limit.server.ts) since generated Supabase types lag an unapplied
 * migration — supabase/migrations/20260819220000_sports_forward_shadow_phase1.sql has
 * not been applied to any live database as of this task.
 */
export const supabaseObservationRepository: ObservationRepository = {
  async getExistingMatch(signalId, venue) {
    const { data, error } = await supabaseAdmin
      .from("sports_market_matches" as never)
      .select("id, match_status")
      .eq("signal_id", signalId)
      .eq("venue", venue)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = data as { id: string; match_status: MatchStatus } | null;
    return row ? { id: row.id, status: row.match_status } : null;
  },

  async upsertMatch(row) {
    const { data, error } = await supabaseAdmin
      .from("sports_market_matches" as never)
      .upsert(
        {
          signal_id: row.signalId,
          venue: row.venue,
          match_status: row.matchStatus,
          target_event_id: row.targetEventId,
          target_market_id: row.targetMarketId,
          target_identifier: row.targetIdentifier,
          normalized_game_id: row.normalizedGameId,
          line: row.line,
          selected_side: row.selectedSide,
          settlement_compatibility: row.settlementCompatibility,
          reason: row.reason,
          metadata: row.metadata,
        } as never,
        { onConflict: "signal_id,venue" },
      )
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: (data as { id: string }).id };
  },

  async scheduleObservations(rows) {
    if (rows.length === 0) return 0;
    const { data, error } = await supabaseAdmin
      .from("sports_quote_observations" as never)
      .upsert(
        rows.map((r) => ({
          signal_id: r.signalId,
          match_id: r.matchId,
          venue: r.venue,
          requested_delay_ms: r.requestedDelayMs,
          source_timestamp: r.sourceTimestamp,
          fire_at: r.fireAt,
        })) as never,
        { onConflict: "signal_id,venue,requested_delay_ms", ignoreDuplicates: true },
      )
      .select("id");
    if (error) throw new Error(error.message);
    return (data as unknown[] | null)?.length ?? 0;
  },

  async findDueObservations(nowIso, limit) {
    const { data, error } = await supabaseAdmin
      .from("sports_quote_observations" as never)
      .select("id, signal_id, match_id, venue, requested_delay_ms, fire_at, sports_market_matches(target_market_id, selected_side)")
      .is("observed_at", null)
      .lte("fire_at", nowIso)
      .order("fire_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(error.message);
    type Row = {
      id: string;
      signal_id: string;
      match_id: string;
      venue: Venue;
      requested_delay_ms: number;
      fire_at: string;
      sports_market_matches: { target_market_id: string | null; selected_side: string | null } | null;
    };
    return ((data ?? []) as unknown as Row[]).map((r) => ({
      id: r.id,
      signalId: r.signal_id,
      matchId: r.match_id,
      venue: r.venue,
      requestedDelayMs: r.requested_delay_ms,
      fireAt: r.fire_at,
      targetFetchKey: r.sports_market_matches?.target_market_id ?? null,
      selectedSide: r.sports_market_matches?.selected_side ?? null,
    }));
  },

  async claimObservationTerminal(id, patch) {
    const { data, error } = await supabaseAdmin
      .from("sports_quote_observations" as never)
      .update(toDbPatch(patch) as never)
      .eq("id", id)
      .is("observed_at", null)
      .select("id");
    if (error) throw new Error(error.message);
    return ((data as unknown[] | null)?.length ?? 0) > 0;
  },
};

export type ObservationDeps = {
  repo: ObservationRepository;
  fetchPmusBook: typeof fetchPmusBook;
  fetchKalshiBook: typeof fetchKalshiBook;
  now: () => number;
};

const defaultDeps: ObservationDeps = {
  repo: supabaseObservationRepository,
  fetchPmusBook,
  fetchKalshiBook,
  now: () => Date.now(),
};

export type PersistMatchResult = { matchId: string; scheduled: number; downgradeSkipped: boolean };

/**
 * Persists one venue's resolver result (EXACT/NEAR/NONE/UNVERIFIED all persisted — the
 * mission's first-100 experiment needs true match-rate accounting), then schedules
 * exactly 5 observation rows ONLY when the result is genuinely schedulable
 * (isSchedulable: EXACT + fetch key + resolved side). Idempotent: re-processing the
 * identical signal+venue is a harmless no-op beyond the upsert itself (the DB's
 * UNIQUE(signal_id,venue,requested_delay_ms) plus ignoreDuplicates makes repeated
 * scheduling calls insert 0 new rows). `detectedAtMs` is REQUIRED and used as the sole
 * fire_at anchor — never `result`'s source-side timestamps.
 */
export async function persistVenueMatch(
  signalId: string,
  result: VenueMatchResult,
  detectedAtMs: number,
  sourceTimestampIso: string,
  deps: Partial<ObservationDeps> = {},
): Promise<PersistMatchResult> {
  const d: ObservationDeps = { ...defaultDeps, ...deps };

  const existing = await d.repo.getExistingMatch(signalId, result.venue);
  if (existing && existing.status === "EXACT" && result.status !== "EXACT") {
    return { matchId: existing.id, scheduled: 0, downgradeSkipped: true };
  }

  const row = buildMatchRow(signalId, result);
  const { id: matchId } = await d.repo.upsertMatch(row);

  if (!isSchedulable(result)) return { matchId, scheduled: 0, downgradeSkipped: false };

  const scheduleRows = buildObservationRows(signalId, matchId, result.venue, detectedAtMs, sourceTimestampIso);
  if (scheduleRows === null) return { matchId, scheduled: 0, downgradeSkipped: false };

  const scheduled = await d.repo.scheduleObservations(scheduleRows);
  return { matchId, scheduled, downgradeSkipped: false };
}

export type DueCollectionResult = { captured: number; failed: number; skipped: number };

/**
 * Collects every currently-due observation (observed_at IS NULL AND fire_at <= now),
 * bounded to DUE_BATCH_LIMIT, oldest fire_at first. For each row: fetches the genuine
 * live book (never cached), builds the persistence patch (capture or explicit
 * failure), and attempts the CAS terminal write. A row whose CAS is lost to a
 * concurrent worker (observed_at was no longer null by the time this call's UPDATE
 * ran) is counted as `skipped`, never `captured`/`failed` — the network fetch that
 * "wasted" is an accepted cost (see the mission's network-race note), not corruption.
 */
export async function takeDueSportsShadowObservations(deps: Partial<ObservationDeps> = {}): Promise<DueCollectionResult> {
  const d: ObservationDeps = { ...defaultDeps, ...deps };
  const nowIso = new Date(d.now()).toISOString();
  const due = await d.repo.findDueObservations(nowIso, DUE_BATCH_LIMIT);

  let captured = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of due) {
    if (!row.targetFetchKey) {
      const patch = buildTerminalFailurePatch(d.now(), "MISSING_TARGET_IDENTIFIER", "due observation's linked match has no usable fetch key", row.fireAt, row.requestedDelayMs);
      if (await d.repo.claimObservationTerminal(row.id, patch)) failed += 1;
      else skipped += 1;
      continue;
    }

    if (row.venue === "PMUS") {
      const book = await d.fetchPmusBook(row.targetFetchKey);
      const patch = buildPmusObservationPatch(book, row.fireAt, row.requestedDelayMs);
      if (await d.repo.claimObservationTerminal(row.id, patch)) {
        if (patch.errorCode) failed += 1;
        else captured += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    // KALSHI
    const side = row.selectedSide === "YES" ? "YES" : row.selectedSide === "NO" ? "NO" : null;
    if (!side) {
      const patch = buildTerminalFailurePatch(
        d.now(),
        "UNRESOLVED_SIDE_ORIENTATION",
        `linked match has an unexpected/unresolved selected_side '${row.selectedSide ?? "null"}' for a Kalshi observation`,
        row.fireAt,
        row.requestedDelayMs,
      );
      if (await d.repo.claimObservationTerminal(row.id, patch)) failed += 1;
      else skipped += 1;
      continue;
    }
    const book = await d.fetchKalshiBook(row.targetFetchKey);
    const patch = buildKalshiObservationPatch(book, side, row.fireAt, row.requestedDelayMs);
    if (await d.repo.claimObservationTerminal(row.id, patch)) {
      if (patch.errorCode) failed += 1;
      else captured += 1;
    } else {
      skipped += 1;
    }
  }

  return { captured, failed, skipped };
}
