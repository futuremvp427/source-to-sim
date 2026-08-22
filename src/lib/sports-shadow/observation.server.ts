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

import { DeadlineExceededError } from "../http-rate-limit.server";
import { fetchKalshiBook } from "./kalshi.server";
import { fetchPmusBook } from "./pmus.server";
import {
  buildKalshiObservationPatch,
  buildMatchRow,
  buildObservationRows,
  buildPmusObservationPatch,
  buildTerminalFailurePatch,
  clampPastCutoffResult,
  computeCutoffMs,
  computeRecheckDecision,
  isSchedulable,
  type MatchRow,
  type ObservationCapturePatch,
  type ObservationScheduleRow,
} from "./observation";
import type { MatchStatus, VenueMatchResult } from "./resolver";
import type { Venue } from "./types";

/** Bounded due-observation batch per collector call — each due row issues one real book fetch, sequentially (never Promise.all), so this directly bounds wall-clock time and outbound request volume per cycle. Task 11 calls the collector repeatedly rather than this module looping unboundedly. */
export const DUE_BATCH_LIMIT = 20;

/** Task 12H / P1-M: firstMatchStatus/recheckCount are read back so persistVenueMatch can preserve the immutable audit field and increment the durable counter without a second round trip. */
export type ExistingMatch = { id: string; status: MatchStatus; firstMatchStatus: MatchStatus; recheckCount: number };

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
  /** Task 12H / P1-N: scoped to ONE venue — see worker.server.ts's per-venue observation lane doc comment for why a shared cross-venue query is unsafe. */
  findDueObservations(venue: Venue, nowIso: string, limit: number): Promise<DueObservationRow[]>;
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
      .select("id, match_status, first_match_status, recheck_count")
      .eq("signal_id", signalId)
      .eq("venue", venue)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = data as { id: string; match_status: MatchStatus; first_match_status: MatchStatus; recheck_count: number } | null;
    return row ? { id: row.id, status: row.match_status, firstMatchStatus: row.first_match_status, recheckCount: row.recheck_count } : null;
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
          rule_fingerprint: row.ruleFingerprint,
          rule_fingerprint_version: row.ruleFingerprintVersion,
          first_match_status: row.firstMatchStatus,
          recheck_count: row.recheckCount,
          next_recheck_at: row.nextRecheckAt,
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

  async findDueObservations(venue, nowIso, limit) {
    const { data, error } = await supabaseAdmin
      .from("sports_quote_observations" as never)
      .select("id, signal_id, match_id, venue, requested_delay_ms, fire_at, sports_market_matches(target_market_id, selected_side)")
      .eq("venue", venue)
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
  /**
   * FINAL BUILD Part 9/10/12: fired once a due row's CAS claim WINS (this call
   * durably owns the terminal write for that observation) -- regardless of whether the
   * capture was a genuine success or a real failure, since computePaperFillsForObservation
   * itself is what decides whether a stale/errored observation produces any paper fill
   * (Section 13's stale-book gate lives there, not here). Never awaited by the CAS-loss
   * `skipped` path -- only the worker that actually won the claim triggers downstream
   * paper-execution work for it. Best-effort: a failure here must never turn an
   * otherwise-successful book capture into a reported failure for THIS function's own
   * captured/failed/skipped accounting.
   */
  onObservationClaimed: (observationId: string) => Promise<void>;
};

const defaultDeps: ObservationDeps = {
  repo: supabaseObservationRepository,
  fetchPmusBook,
  fetchKalshiBook,
  now: () => Date.now(),
  onObservationClaimed: async (observationId) => {
    const { computePaperFillsForObservation } = await import("./paper.server");
    await computePaperFillsForObservation(observationId);
  },
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
 * fire_at anchor — never `result`'s source-side timestamps, and NEVER the re-check time
 * either (Task 12H/P1-M, M8): a signal that only becomes EXACT on a later recheck still
 * schedules its +0/+5/+10/+30/+60 burst against the ORIGINAL detection time, so an
 * already-past checkpoint stays visibly late rather than being rewritten to look timely.
 *
 * Task 12H / P1-M: `scheduledStartAtIso` (the signal's own game start time, or null)
 * drives computeRecheckDecision's cutoff — see observation.ts's doc comment. The
 * existing EXACT-never-downgraded ratchet below is unchanged and is exactly what makes
 * an EXACT row's next_recheck_at permanently null in practice (a downgrade attempt
 * returns before ever reaching buildMatchRow).
 *
 * Task 12I / P1-O, O2/O3: a SECOND, execution-time cutoff guard runs after the ratchet
 * check, using `d.now()` at the moment of THIS call (never the time the row was
 * selected/scheduled) — see observation.ts's clampPastCutoffResult doc comment. This is
 * deliberately independent of the RPC-level selection-time guard (Layer A, in the
 * migration): a row can be legitimately selected as due just before cutoff and then
 * actually get processed by a delayed worker after cutoff has since passed, and only a
 * fresh client-side check at persistence time catches that race. A result that is
 * already a re-confirmation of an existing EXACT (the ratchet's "both EXACT" pass-through
 * above) is never clamped — it is not creating a NEW EXACT.
 */
export async function persistVenueMatch(
  signalId: string,
  result: VenueMatchResult,
  detectedAtMs: number,
  sourceTimestampIso: string,
  scheduledStartAtIso: string | null,
  deps: Partial<ObservationDeps> = {},
): Promise<PersistMatchResult> {
  const d: ObservationDeps = { ...defaultDeps, ...deps };

  const existing = await d.repo.getExistingMatch(signalId, result.venue);
  if (existing && existing.status === "EXACT" && result.status !== "EXACT") {
    return { matchId: existing.id, scheduled: 0, downgradeSkipped: true };
  }

  const nowMs = d.now();
  const cutoffMs = computeCutoffMs(detectedAtMs, scheduledStartAtIso);
  const isNewExactPastCutoff = result.status === "EXACT" && existing?.status !== "EXACT" && nowMs >= cutoffMs;
  const effectiveResult = isNewExactPastCutoff ? clampPastCutoffResult(result) : result;

  const { nextRecheckAt } = computeRecheckDecision(effectiveResult.status, nowMs, detectedAtMs, scheduledStartAtIso);
  const row = buildMatchRow(signalId, effectiveResult, {
    firstMatchStatus: existing?.firstMatchStatus ?? effectiveResult.status,
    recheckCount: existing ? existing.recheckCount + 1 : 0,
    nextRecheckAt,
  });
  const { id: matchId } = await d.repo.upsertMatch(row);

  if (!isSchedulable(effectiveResult)) return { matchId, scheduled: 0, downgradeSkipped: false };

  const scheduleRows = buildObservationRows(signalId, matchId, result.venue, detectedAtMs, sourceTimestampIso);
  if (scheduleRows === null) return { matchId, scheduled: 0, downgradeSkipped: false };

  const scheduled = await d.repo.scheduleObservations(scheduleRows);
  return { matchId, scheduled, downgradeSkipped: false };
}

export type DueCollectionResult = { captured: number; failed: number; skipped: number };

/**
 * Collects every currently-due observation (observed_at IS NULL AND fire_at <= now),
 * bounded to `maxRows` (defaults to DUE_BATCH_LIMIT, preserving prior behavior exactly
 * when omitted), oldest fire_at first. For each row: fetches the genuine live book
 * (never cached), builds the persistence patch (capture or explicit failure), and
 * attempts the CAS terminal write. A row whose CAS is lost to a concurrent worker
 * (observed_at was no longer null by the time this call's UPDATE ran) is counted as
 * `skipped`, never `captured`/`failed` — the network fetch that "wasted" is an accepted
 * cost (see the mission's network-race note), not corruption.
 *
 * `maxRows` exists for callers with a tighter wall-clock budget than the default 20-row
 * batch (each due row issues one real, sequential, up-to-~12s-timeout network fetch) —
 * e.g. Task 11's sub-minute sports-shadow observation lane, which needs a small enough
 * cap that its worst-case wall time stays comfortably inside its own lease TTL. Passing
 * a smaller maxRows never changes anything else about this function's behavior.
 *
 * `deadlineAtMs` (epoch ms, default null = no deadline, identical to prior behavior) is
 * checked BETWEEN rows (bounding how many further rows this pass STARTS), and (Task 13I /
 * P1-T) is now ALSO threaded into the row already being started: fetchPmusBook/
 * fetchKalshiBook accept an optional `deadlineAtMs` and re-check it before their own
 * cooldown/reservation/pacing stages (see pmus.server.ts/kalshi.server.ts's pacedGetJson).
 * Before this task those stages had NO bound of their own, so a single row could
 * genuinely consume up to ~30-35s (5s cooldown read + up to 5s reservation RPC + up to 8s
 * granted pacing wait + the ~12s upstream fetch + up to 5s on a 429's rate-limit-recording
 * write) even though only the LAST of those stages (the upstream fetch itself) had any
 * timeout at all — the previously-assumed "~12s per row" was never the true worst case.
 * Threading the deadline in caps everything EXCEPT the upstream fetch already in flight:
 * once a row's fetch passes its last internal deadline check and the real HTTP request
 * starts, that request is a genuine already-started operation with its own fixed
 * REQUEST_TIMEOUT_MS AbortController this function still cannot reach in from outside, so
 * it can still legitimately run up to its own ~12s ceiling regardless of the deadline.
 * `DeadlineExceededError` thrown from either fetcher is caught explicitly and treated
 * exactly like "no more rows started" — the row is left completely untouched
 * (`observed_at` stays null, no `claimObservationTerminal` call at all), never converted
 * into a TRANSPORT_TIMEOUT/MALFORMED/any other persisted venue-failure patch, because a
 * scheduler deadline is not evidence about the market (Section 7). This is what lets a
 * caller with a strict lane-hold budget (Task 11) bound worst-case wall time to roughly
 * `deadlineAtMs budget + one already-started row's own worst-case UPSTREAM-FETCH time
 * (~12s)`, instead of `deadlineAtMs budget + one row's full ~30-35s uninterruptible stack`.
 *
 * Task 12H / P1-N: `venue` scopes the due-row query itself, so a PM-US backlog can never
 * consume Kalshi's batch slots (or vice versa) — see worker.server.ts's per-venue
 * observation lane doc comment for the full root cause and design. The per-row
 * `row.venue === "PMUS"` branch below is kept as a second, defense-in-depth guarantee
 * that a row is never handed to the wrong venue's book fetcher, even though the query
 * itself already guarantees every returned row belongs to `venue`.
 */
export async function takeDueSportsShadowObservations(
  venue: Venue,
  deps: Partial<ObservationDeps> = {},
  maxRows: number = DUE_BATCH_LIMIT,
  deadlineAtMs: number | null = null,
): Promise<DueCollectionResult> {
  const d: ObservationDeps = { ...defaultDeps, ...deps };
  const nowIso = new Date(d.now()).toISOString();
  const due = await d.repo.findDueObservations(venue, nowIso, maxRows);

  let captured = 0;
  let failed = 0;
  let skipped = 0;
  const fetchDeadline = deadlineAtMs ?? undefined;

  for (const row of due) {
    if (deadlineAtMs !== null && d.now() >= deadlineAtMs) break;
    if (!row.targetFetchKey) {
      const patch = buildTerminalFailurePatch(d.now(), "MISSING_TARGET_IDENTIFIER", "due observation's linked match has no usable fetch key", row.fireAt, row.requestedDelayMs);
      if (await d.repo.claimObservationTerminal(row.id, patch)) failed += 1;
      else skipped += 1;
      continue;
    }

    if (row.venue === "PMUS") {
      // Task 12G / P1-J: LONG/SHORT orientation is durably encoded as a `:LONG`/`:SHORT`
      // suffix on the persisted selected_side (see observation.ts's serializeTargetSide).
      // J9: missing/unresolvable orientation must NEVER silently default to LONG --
      // fails closed to a terminal failure, mirroring Kalshi's existing
      // UNRESOLVED_SIDE_ORIENTATION contract below exactly.
      const pmusOrientation = row.selectedSide?.endsWith(":LONG") ? "LONG" : row.selectedSide?.endsWith(":SHORT") ? "SHORT" : null;
      if (!pmusOrientation) {
        const patch = buildTerminalFailurePatch(
          d.now(),
          "UNRESOLVED_SIDE_ORIENTATION",
          `linked match has no resolvable PM-US LONG/SHORT orientation ('${row.selectedSide ?? "null"}')`,
          row.fireAt,
          row.requestedDelayMs,
        );
        if (await d.repo.claimObservationTerminal(row.id, patch)) failed += 1;
        else skipped += 1;
        continue;
      }
      let pmusBook;
      try {
        pmusBook = await d.fetchPmusBook(row.targetFetchKey, {}, fetchDeadline);
      } catch (err) {
        // Task 13I / P1-T: our own scheduler budget ran out mid-fetch -- not evidence
        // about the market. Leave THIS row (and every row after it) completely untouched.
        if (err instanceof DeadlineExceededError) break;
        throw err;
      }
      const patch = buildPmusObservationPatch(pmusBook, pmusOrientation, row.fireAt, row.requestedDelayMs);
      if (await d.repo.claimObservationTerminal(row.id, patch)) {
        if (patch.errorCode) failed += 1;
        else captured += 1;
        try {
          await d.onObservationClaimed(row.id);
        } catch {
          // Best-effort: a paper-execution trigger failure must never turn an
          // otherwise-successful book capture into a reported failure here.
        }
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
    let kalshiBook;
    try {
      kalshiBook = await d.fetchKalshiBook(row.targetFetchKey, {}, fetchDeadline);
    } catch (err) {
      // Task 13I / P1-T: same rationale as the PM-US branch above.
      if (err instanceof DeadlineExceededError) break;
      throw err;
    }
    const patch = buildKalshiObservationPatch(kalshiBook, side, row.fireAt, row.requestedDelayMs);
    if (await d.repo.claimObservationTerminal(row.id, patch)) {
      if (patch.errorCode) failed += 1;
      else captured += 1;
      try {
        await d.onObservationClaimed(row.id);
      } catch {
        // Best-effort -- see the identical PM-US branch above for the full rationale.
      }
    } else {
      skipped += 1;
    }
  }

  return { captured, failed, skipped };
}
