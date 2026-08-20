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
import type { MatchStatus, ResolverReasonCode, SettlementCompatibility as ResolverSettlementCompatibility, SettlementProfile, TargetSide, VenueMatchResult } from "./resolver";
import type { BookSnapshot, DepthLevel, Venue } from "./types";

/** The five and only legal requested delays (matches the Task 1 DB CHECK constraint exactly). Defined once here — no module duplicates a slightly different array. */
export const SPORTS_SHADOW_DELAYS_MS = [0, 5_000, 10_000, 30_000, 60_000] as const;
export type SportsShadowDelayMs = (typeof SPORTS_SHADOW_DELAYS_MS)[number];

/* ------------------------------- Match persistence ------------------------------- */

/** DB CHECK constraint on sports_market_matches.settlement_compatibility uses 'UNKNOWN'; the resolver's SettlementCompatibility type uses 'UNVERIFIED' for the identical concept. Mapped here, once. */
export type DbSettlementCompatibility = "COMPATIBLE" | "INCOMPATIBLE" | "UNKNOWN";

export function toDbSettlementCompatibility(v: ResolverSettlementCompatibility): DbSettlementCompatibility {
  return v === "UNVERIFIED" ? "UNKNOWN" : v;
}

/** Serializes a resolved TargetSide into the plain-text form sports_market_matches.selected_side expects. */
export function serializeTargetSide(side: TargetSide | null): string | null {
  if (side === null) return null;
  if (side.kind === "TEAM") return `TEAM:${side.team}`;
  return side.kind;
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
};

/** Builds the durable row for one venue's resolver result. Persisted for EVERY status (EXACT/NEAR/NONE/UNVERIFIED) — the mission's first-100 experiment needs true match-rate accounting, not only successful matches. */
export function buildMatchRow(signalId: string, result: VenueMatchResult): MatchRow {
  return {
    signalId,
    venue: result.venue,
    matchStatus: result.status,
    targetEventId: result.targetEventId,
    targetMarketId: result.targetFetchKey,
    targetIdentifier: result.targetMarketId,
    normalizedGameId: result.targetGameIdentifier,
    line: result.targetLine,
    selectedSide: serializeTargetSide(result.targetSide),
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
  };
}

/**
 * Observations may be scheduled ONLY when the resolver positively proved: EXACT status,
 * a concrete fetchable target market, and a resolved target side. Resolver status is
 * authoritative — NEAR/NONE/UNVERIFIED are never promoted here, and a match missing its
 * fetch key or side (should not happen for a genuine EXACT result, but checked
 * defensively) is also refused rather than scheduled with a hole in it.
 */
export function isSchedulable(result: VenueMatchResult): boolean {
  return result.status === "EXACT" && result.targetFetchKey !== null && result.targetSide !== null;
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
 * Builds the persistence patch for a PM-US due observation. `staleReason === null`
 * (Task 5's own contract) is what distinguishes a genuinely VALID_EMPTY_BOOK
 * (stale=false, errorCode=null, possibly-empty bidDepth/askDepth) from a real
 * TRANSPORT/malformed/crossed failure (stale=true, errorCode set) — never collapsed.
 */
export function buildPmusObservationPatch(book: BookSnapshot, fireAt: string, requestedDelayMs: number): ObservationCapturePatch {
  const hasError = book.staleReason !== null;
  return {
    observedAt: new Date(book.observedAt).toISOString(),
    fetchStartedAt: null,
    fetchEndedAt: null,
    detectionLatencyMs: computeDetectionLatencyMs(book.observedAt, fireAt, requestedDelayMs),
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    spread: book.bestBid !== null && book.bestAsk !== null ? book.bestAsk - book.bestBid : null,
    bidDepth: book.bidLevels,
    askDepth: book.askLevels,
    marketStatus: book.marketStatus,
    stale: hasError,
    errorCode: hasError ? classifyPmusFailure(book.staleReason!) : null,
    reason: book.staleReason,
    rawMetadata: { venue: "PMUS" as const },
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
