/**
 * Sports Forward Shadow observation scheduling + persistence — PURE logic only.
 *
 * Turns a Task 7 VenueMatchResult into durable row shapes for
 * sports_market_matches / sports_quote_observations (see
 * supabase/migrations/20260819220000_sports_forward_shadow_phase1.sql), and turns a
 * Task 5/6 book snapshot into a persistable capture patch. No Supabase, no network, no
 * timers — see observation.server.ts for the DB/network orchestration that calls these.
 */

import type { KalshiBookSnapshot } from "./kalshi";
import type { MatchStatus, ResolverReasonCode, SettlementProfile, TargetSide, VenueMatchResult } from "./resolver";
import type { BookSnapshot, DepthLevel, SettlementCompatibility as ResolverSettlementCompatibility, Venue } from "./types";

/** The five and only legal requested delays (matches the Task 1 DB CHECK constraint exactly). Defined once here — no module duplicates a slightly different array. */
export const SPORTS_SHADOW_DELAYS_MS = [0, 5_000, 10_000, 30_000, 60_000] as const;
export type SportsShadowDelayMs = (typeof SPORTS_SHADOW_DELAYS_MS)[number];

/* ------------------------------- Match persistence ------------------------------- */

/** DB CHECK constraint on sports_market_matches.settlement_compatibility uses 'UNKNOWN'; the resolver's SettlementCompatibility type uses 'UNVERIFIED' for the identical concept. Mapped here, once. */
export type DbSettlementCompatibility = "COMPATIBLE" | "INCOMPATIBLE" | "UNKNOWN";

export function toDbSettlementCompatibility(v: ResolverSettlementCompatibility): DbSettlementCompatibility {
  return v === "UNVERIFIED" ? "UNKNOWN" : v;
}

/**
 * Serializes a resolved TargetSide into the plain-text form sports_market_matches.selected_side
 * expects. Task 12G / P1-J: when `pmusOrientation` is non-null (PMUS EXACT results only --
 * see resolver.ts's PmusOrientation doc comment), it is durably appended as a `:LONG`/`:SHORT`
 * suffix so the PM-US book orientation survives the round trip through the DB's plain-text
 * `selected_side` column without a schema migration. Kalshi's `YES`/`NO` serialization is
 * completely untouched (pmusOrientation is always null for Kalshi results), so this is a
 * strictly additive change for PMUS, zero behavior change for Kalshi.
 */
export function serializeTargetSide(side: TargetSide | null, pmusOrientation: "LONG" | "SHORT" | null = null): string | null {
  if (side === null) return null;
  const base = side.kind === "TEAM" ? `TEAM:${side.team}` : side.kind;
  return pmusOrientation === null ? base : `${base}:${pmusOrientation}`;
}

export type MatchRow = {
  signalId: string;
  venue: Venue;
  matchStatus: MatchStatus;
  targetEventId: string | null;
  /** The exact fetch key (PM-US slug / Kalshi ticker) — what a due observation actually calls fetchPmusBook/fetchKalshiBook with. Mapped to sports_market_matches.target_market_id, since that is the column Task 8 depends on being directly usable. */
  targetMarketId: string | null;
  /** The venue's raw numeric/opaque market id, kept as secondary diagnostic evidence (distinct from targetMarketId above, which is the actually-usable fetch key). */
  targetIdentifier: string | null;
  normalizedGameId: string | null;
  line: number | null;
  selectedSide: string | null;
  settlementCompatibility: DbSettlementCompatibility;
  reason: string | null;
  reasonCode: ResolverReasonCode;
  metadata: Record<string, unknown>;
  /** Task 12H / P1-M: the FIRST-EVER match_status this (signal, venue) pair ever received — set once, never updated again. Durable audit evidence distinguishing "what we first observed" from "current" for experiment match-rate accounting. */
  firstMatchStatus: MatchStatus;
  /** Task 12H / P1-M: durable per-row recheck bookkeeping — see computeRecheckDecision. */
  recheckCount: number;
  nextRecheckAt: string | null;
};

/**
 * ============================== TASK 12H / P1-M: DURABLE RECHECK SCHEDULING ==============================
 * ROOT CAUSE (Codex P1 finding): once ANY sports_market_matches row existed for a
 * (signal, venue) pair, find_pending_sports_shadow_signals's anti-join treated it as
 * permanently done — regardless of whether the persisted status was EXACT or a
 * NONE/NEAR/UNVERIFIED that only reflected a temporarily-incomplete discovery catalog.
 * A market listed moments after the first (failed) discovery pass could never be found.
 *
 * FIX: EXACT is the only truly terminal-success state (and is separately protected by
 * persistVenueMatch's existing never-downgrade ratchet). Every other status gets a
 * durable `next_recheck_at`: null once a well-justified cutoff is reached (this
 * experiment is about PRE-GAME price discovery — once the game has started, discovering
 * the target market later no longer serves the measurement, so scheduledStartAt is the
 * preferred cutoff; a fallback bounded window from detection covers the rare case where
 * scheduledStartAt itself is unknown), otherwise `now + RECHECK_INTERVAL_MS`.
 *
 * RECHECK_INTERVAL_MS = 5 minutes: this is not an arbitrary cadence — it exactly matches
 * PM-US's and Kalshi's own discovery-catalog cache TTL (DISCOVERY_CACHE_TTL_MS in
 * pmus.server.ts/kalshi.server.ts). Rechecking faster than the underlying discovery data
 * can possibly change would just re-observe the identical cached catalog; rechecking
 * slower would needlessly delay catching a newly-listed market.
 * ================================================================================
 */
export const RECHECK_INTERVAL_MS = 5 * 60 * 1000;
/** Fallback cutoff (from detection, not from "now") used ONLY when a signal's scheduledStartAt is unknown — conservative and rarely hit in practice, since Task 3/7 already require a structured game start time for eligibility in the overwhelming majority of cases. */
export const RECHECK_FALLBACK_CUTOFF_MS = 4 * 60 * 60 * 1000;

export type RecheckDecision = { nextRecheckAt: string | null };

/**
 * `status` is the just-computed resolver result for THIS call (not the previous stored
 * status) — EXACT always yields nextRecheckAt=null (terminal success, ratcheted by
 * persistVenueMatch before this is even reached for a downgrade attempt). For any other
 * status: null once `nowMs` has reached the cutoff (scheduledStartAt when known, else
 * detectedAtMs + RECHECK_FALLBACK_CUTOFF_MS), otherwise nowMs + RECHECK_INTERVAL_MS.
 */
export function computeRecheckDecision(status: MatchStatus, nowMs: number, detectedAtMs: number, scheduledStartAtIso: string | null): RecheckDecision {
  if (status === "EXACT") return { nextRecheckAt: null };
  const scheduledStartMs = scheduledStartAtIso !== null ? Date.parse(scheduledStartAtIso) : Number.NaN;
  const cutoffMs = Number.isFinite(scheduledStartMs) ? scheduledStartMs : detectedAtMs + RECHECK_FALLBACK_CUTOFF_MS;
  if (nowMs >= cutoffMs) return { nextRecheckAt: null };
  return { nextRecheckAt: new Date(nowMs + RECHECK_INTERVAL_MS).toISOString() };
}

/** Builds the durable row for one venue's resolver result. Persisted for EVERY status (EXACT/NEAR/NONE/UNVERIFIED) — the mission's first-100 experiment needs true match-rate accounting, not only successful matches. `recheck` carries the Task 12H/P1-M audit/scheduling fields, computed by the caller (persistVenueMatch) since they depend on durable prior state (existing.firstMatchStatus/recheckCount) this pure function does not have access to. */
export function buildMatchRow(signalId: string, result: VenueMatchResult, recheck: { firstMatchStatus: MatchStatus; recheckCount: number; nextRecheckAt: string | null }): MatchRow {
  return {
    signalId,
    venue: result.venue,
    matchStatus: result.status,
    targetEventId: result.targetEventId,
    targetMarketId: result.targetFetchKey,
    targetIdentifier: result.targetMarketId,
    normalizedGameId: result.targetGameIdentifier,
    line: result.targetLine,
    selectedSide: serializeTargetSide(result.targetSide, result.targetPmusOrientation),
    settlementCompatibility: toDbSettlementCompatibility(result.settlementCompatibility),
    reason: result.reason,
    reasonCode: result.reasonCode,
    metadata: {
      reasonCode: result.reasonCode,
      candidateCounts: result.candidateCounts,
      evidence: result.evidence,
      settlementProfile: result.settlementProfile,
      sourceLine: result.sourceLine,
      sourceStartTime: result.sourceStartTime,
      targetStartTime: result.targetStartTime,
      targetAwayTeam: result.targetAwayTeam,
      targetHomeTeam: result.targetHomeTeam,
      targetBetType: result.targetBetType,
      targetMarketIdRaw: result.targetMarketId,
    },
    firstMatchStatus: recheck.firstMatchStatus,
    recheckCount: recheck.recheckCount,
    nextRecheckAt: recheck.nextRecheckAt,
  };
}

/**
 * Observations may be scheduled ONLY when the resolver positively proved: EXACT status,
 * a concrete fetchable target market, and a resolved target side. Resolver status is
 * authoritative — NEAR/NONE/UNVERIFIED are never promoted here, and a match missing its
 * fetch key or side (should not happen for a genuine EXACT result, but checked
 * defensively) is also refused rather than scheduled with a hole in it.
 *
 * Task 12G / P1-J, J9: a PMUS EXACT result additionally requires a resolved
 * targetPmusOrientation — defense in depth on top of resolver.ts's own guarantee that
 * EXACT can never be reached with a null orientation, so a future regression there fails
 * closed to unschedulable rather than silently persisting an unoriented book.
 */
export function isSchedulable(result: VenueMatchResult): boolean {
  if (result.status !== "EXACT" || result.targetFetchKey === null || result.targetSide === null) return false;
  if (result.venue === "PMUS" && result.targetPmusOrientation === null) return false;
  return true;
}

/* ------------------------------- Observation scheduling ------------------------------- */

export type ObservationScheduleRow = {
  signalId: string;
  matchId: string;
  venue: Venue;
  requestedDelayMs: SportsShadowDelayMs;
  /** Preserved for schema NOT NULL + evidence purposes only — NEVER used to derive fireAt. */
  sourceTimestamp: string;
  fireAt: string;
};

/** Returns true only for a finite, positive epoch-ms value — used to fail closed on an invalid detection timestamp before scheduling anything. */
export function isValidDetectedAt(detectedAtMs: number): boolean {
  return Number.isFinite(detectedAtMs) && detectedAtMs > 0;
}

/**
 * Builds exactly 5 observation rows for one EXACT venue match. fireAt is derived
 * SOLELY from `detectedAtMs` (when WE detected the signal) — never from
 * `sourceTimestampIso` (the source wallet's historical trade time), which is carried
 * through only as required NOT NULL evidence and never influences scheduling. Returns
 * null (schedules nothing) when detectedAtMs is invalid — fail closed, per the mission.
 */
export function buildObservationRows(
  signalId: string,
  matchId: string,
  venue: Venue,
  detectedAtMs: number,
  sourceTimestampIso: string,
): ObservationScheduleRow[] | null {
  if (!isValidDetectedAt(detectedAtMs)) return null;
  return SPORTS_SHADOW_DELAYS_MS.map((delayMs) => ({
    signalId,
    matchId,
    venue,
    requestedDelayMs: delayMs,
    sourceTimestamp: sourceTimestampIso,
    fireAt: new Date(detectedAtMs + delayMs).toISOString(),
  }));
}

/* ------------------------------- Book capture -> persistence patch ------------------------------- */

export type ObservationCapturePatch = {
  observedAt: string;
  fetchStartedAt: string | null;
  fetchEndedAt: string | null;
  detectionLatencyMs: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  bidDepth: DepthLevel[];
  askDepth: DepthLevel[];
  marketStatus: string | null;
  stale: boolean;
  errorCode: string | null;
  reason: string | null;
  rawMetadata: Record<string, unknown>;
};

/** Real end-to-end latency from DETECTION (not from fire_at/requested delay): fireAt already encodes detectedAt+requestedDelayMs, so detectedAt = fireAt - requestedDelayMs is recoverable without a separate join, and detectionLatencyMs = observedAt - detectedAt. */
function computeDetectionLatencyMs(observedAtMs: number, fireAtIso: string, requestedDelayMs: number): number {
  const fireAtMs = new Date(fireAtIso).getTime();
  const detectedAtMs = fireAtMs - requestedDelayMs;
  return Math.round(observedAtMs - detectedAtMs);
}

/** Classifies a PM-US BookSnapshot.staleReason string into a stable error-code vocabulary. Free-text classification is safe here because these exact strings are authored in pmus.ts/pmus.server.ts (Tasks 5) — not arbitrary third-party text. */
export function classifyPmusFailure(staleReason: string): string {
  if (/crossed/i.test(staleReason)) return "CROSSED_BOOK";
  if (/malformed/i.test(staleReason)) return "MALFORMED_PAYLOAD";
  if (/429/.test(staleReason)) return "TRANSPORT_HTTP_429";
  if (/cooldown/i.test(staleReason)) return "TRANSPORT_COOLDOWN";
  if (/HTTP \d/i.test(staleReason)) return "TRANSPORT_HTTP_ERROR";
  if (/abort|timeout/i.test(staleReason)) return "TRANSPORT_TIMEOUT";
  return "TRANSPORT_FAILURE";
}

/** Same vocabulary/approach as classifyPmusFailure, for Kalshi's KalshiBookSnapshot.staleReason strings (authored in kalshi.ts/kalshi.server.ts, Task 6). */
export function classifyKalshiFailure(staleReason: string): string {
  if (/crossed/i.test(staleReason)) return "CROSSED_BOOK";
  if (/malformed/i.test(staleReason)) return "MALFORMED_PAYLOAD";
  if (/429/.test(staleReason)) return "TRANSPORT_HTTP_429";
  if (/cooldown/i.test(staleReason)) return "TRANSPORT_COOLDOWN";
  if (/HTTP \d/i.test(staleReason)) return "TRANSPORT_HTTP_ERROR";
  if (/abort|timeout/i.test(staleReason)) return "TRANSPORT_TIMEOUT";
  return "TRANSPORT_FAILURE";
}

/**
 * ============================== TASK 12G / P1-J: PM-US LONG/SHORT ORIENTATION ==============================
 * PM-US's /book endpoint returns exactly ONE order book per market slug. EMPIRICALLY
 * confirmed (live, read-only requests during this task -- never guessed): the book's
 * best bid/ask exactly match the market's own `stats.lastPriceSample.{longPx,shortPx}`
 * field, and longPx + shortPx sum to EXACTLY 1.0000 (verified on two independent real
 * markets, moneyline and spread). This proves the fetched book is the market's LONG
 * side, and the SHORT side is the standard complementary-binary-market transform:
 *   short_bid = 1 - long_ask   (price to SELL short / receive)
 *   short_ask = 1 - long_bid   (price to BUY short / pay)
 * applied per-level (price -> 1-price, size unchanged), with bids re-sorted descending
 * and asks re-sorted ascending -- see `deriveShortView` below. No cent rounding is
 * introduced; plain floating-point subtraction is used throughout.
 * ================================================================================
 */
function deriveShortView(book: BookSnapshot): { bestBid: number | null; bestAsk: number | null; bidLevels: DepthLevel[]; askLevels: DepthLevel[] } {
  return {
    bestBid: book.bestAsk === null ? null : 1 - book.bestAsk,
    bestAsk: book.bestBid === null ? null : 1 - book.bestBid,
    bidLevels: book.askLevels.map((l) => ({ price: 1 - l.price, size: l.size })).sort((a, b) => b.price - a.price),
    askLevels: book.bidLevels.map((l) => ({ price: 1 - l.price, size: l.size })).sort((a, b) => a.price - b.price),
  };
}

/**
 * Builds the persistence patch for a PM-US due observation. `staleReason === null`
 * (Task 5's own contract) is what distinguishes a genuinely VALID_EMPTY_BOOK
 * (stale=false, errorCode=null, possibly-empty bidDepth/askDepth) from a real
 * TRANSPORT/malformed/crossed failure (stale=true, errorCode set) — never collapsed.
 *
 * `orientation` is REQUIRED (never defaulted) -- see resolver.ts's PmusOrientation doc
 * comment and the module doc above. LONG leaves the raw fetched book completely
 * unchanged (J6). SHORT applies `deriveShortView` to bestBid/bestAsk/bidLevels/askLevels
 * (J7/J8) and retains the RAW fetched LONG-side book in rawMetadata for audit (the
 * persisted best_bid/best_ask/bid_depth/ask_depth/spread always represent the
 * source-selected EXECUTABLE contract, never merely the raw underlying LONG book). A
 * stale/failed fetch (bestBid/bestAsk already null) is unaffected by orientation either
 * way -- `1 - null` is never computed.
 */
export function buildPmusObservationPatch(book: BookSnapshot, orientation: "LONG" | "SHORT", fireAt: string, requestedDelayMs: number): ObservationCapturePatch {
  const hasError = book.staleReason !== null;
  const view = orientation === "LONG" ? { bestBid: book.bestBid, bestAsk: book.bestAsk, bidLevels: book.bidLevels, askLevels: book.askLevels } : deriveShortView(book);
  return {
    observedAt: new Date(book.observedAt).toISOString(),
    fetchStartedAt: null,
    fetchEndedAt: null,
    detectionLatencyMs: computeDetectionLatencyMs(book.observedAt, fireAt, requestedDelayMs),
    bestBid: view.bestBid,
    bestAsk: view.bestAsk,
    spread: view.bestBid !== null && view.bestAsk !== null ? view.bestAsk - view.bestBid : null,
    bidDepth: view.bidLevels,
    askDepth: view.askLevels,
    marketStatus: book.marketStatus,
    stale: hasError,
    errorCode: hasError ? classifyPmusFailure(book.staleReason!) : null,
    reason: book.staleReason,
    rawMetadata: orientation === "LONG" ? { venue: "PMUS" as const, orientation } : { venue: "PMUS" as const, orientation, rawLongBook: { bestBid: book.bestBid, bestAsk: book.bestAsk, bidLevels: book.bidLevels, askLevels: book.askLevels } },
  };
}

/**
 * Builds the persistence patch for a Kalshi due observation, using the EXECUTABLE view
 * for the Task 7-resolved target side (`resolvedSide`) — never defaults to YES, never
 * infers from source BUY/price/favorite status. The FULL raw book (both yes and no
 * sides, including the raw un-derived bids) is retained in rawMetadata for later
 * verification, even though only the resolved side's view becomes the persisted
 * best_bid/best_ask/bid_depth/ask_depth.
 */
export function buildKalshiObservationPatch(book: KalshiBookSnapshot, resolvedSide: "YES" | "NO", fireAt: string, requestedDelayMs: number): ObservationCapturePatch {
  const view = resolvedSide === "YES" ? book.yes : book.no;
  const hasError = book.staleReason !== null;
  return {
    observedAt: new Date(book.observedAt).toISOString(),
    fetchStartedAt: null,
    fetchEndedAt: null,
    detectionLatencyMs: computeDetectionLatencyMs(book.observedAt, fireAt, requestedDelayMs),
    bestBid: view.bestBid,
    bestAsk: view.bestAsk,
    spread: view.bestBid !== null && view.bestAsk !== null ? view.bestAsk - view.bestBid : null,
    bidDepth: view.bidLevels,
    askDepth: view.askLevels,
    marketStatus: null,
    stale: hasError,
    errorCode: hasError ? classifyKalshiFailure(book.staleReason!) : null,
    reason: book.staleReason,
    rawMetadata: {
      venue: "KALSHI" as const,
      resolvedSide,
      rawYesBids: book.rawYesBids,
      rawNoBids: book.rawNoBids,
      yes: book.yes,
      no: book.no,
    },
  };
}

/** Builds a terminal failure patch when the due observation could not even be attempted (e.g. a defensively-detected missing target/side at collection time) — never leaves the row permanently pending. */
export function buildTerminalFailurePatch(observedAtMs: number, errorCode: string, reason: string, fireAt: string, requestedDelayMs: number): ObservationCapturePatch {
  return {
    observedAt: new Date(observedAtMs).toISOString(),
    fetchStartedAt: null,
    fetchEndedAt: null,
    detectionLatencyMs: computeDetectionLatencyMs(observedAtMs, fireAt, requestedDelayMs),
    bestBid: null,
    bestAsk: null,
    spread: null,
    bidDepth: [],
    askDepth: [],
    marketStatus: null,
    stale: true,
    errorCode,
    reason,
    rawMetadata: {},
  };
}
