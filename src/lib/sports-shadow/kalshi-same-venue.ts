/**
 * SAME-VENUE (Kalshi -> Kalshi) PAPER pipeline orchestration — PURE module.
 *
 * Everything AFTER a future verified `KalshiTraderActivitySource` and BEFORE the database
 * driver: admission, durable-dedupe handshake, episode lifecycle replay, exact-ticker
 * target selection, book-driven paper execution per notional tier, and status
 * transitions. No I/O of its own — the repository, the book reader and the clock are all
 * injected, so this module is fully testable without Supabase or the network.
 *
 * ROUTING CONTRACT: a SAME_VENUE_KALSHI event NEVER touches resolver.ts, PM-US discovery,
 * Gamma metadata or cross-venue economic-equivalence matching. This module deliberately
 * imports none of those, and `assertSameVenueRoute` fails closed rather than falling back
 * to matching if a row somehow carries a different route.
 *
 * SAFETY: PAPER/RESEARCH ONLY. There is no order construction, no order endpoint, and no
 * live-execution switch anywhere in this file. LIVE_EXECUTION_IMPLEMENTED stays false.
 */

import { SPORTS_SHADOW_NOTIONALS_USD, walkBuyDepth, walkSellDepth, type ConsumedLevel } from "./depth-walk";
import { computeExitFraction, decideFill, remainingShares, type EligibleFill, type EpisodeDecision, type OpenEpisodeState } from "./episode";
import { computeTakerFeeForFills, type FeeResult } from "./fees";
import {
  isTraderQualified,
  normalizeKalshiTraderEvent,
  requiresCrossVenueResolution,
  targetLegForTrade,
  toEligibleFill,
  type KalshiContractSide,
  type KalshiSourceNormalizationResult,
  type KalshiTraderActivitySource,
  type KalshiTraderQualification,
  type KalshiTraderSourceEvent,
  type NormalizedKalshiSourceTrade,
} from "./kalshi-source";
import type { DepthLevel } from "./types";

/** Minimal book shape this pipeline needs for one already-resolved (ticker, side) leg. */
export type SameVenueBook = {
  observedAtMs: number;
  staleReason: string | null;
  askLevels: readonly DepthLevel[];
  bidLevels: readonly DepthLevel[];
};

/** A durably-admitted same-venue source event, as claimed back out of the database. */
export type AdmittedSameVenueEvent = {
  id: string;
  route: string;
  eventKey: string;
  traderId: string;
  sourceTradeId: string;
  marketTicker: string;
  contractSide: KalshiContractSide;
  action: "BUY" | "SELL";
  quantity: number;
  /** Probability form, (0,1]. */
  sourcePrice: number;
  /** Unix SECONDS, venue execution time. Never the detection time. */
  sourceTs: number;
  /** Epoch ms, when THIS system first saw the trade. Never the source time. */
  detectedAtMs: number;
};

export type SameVenuePaperFillInput = {
  sourceEventId: string;
  traderId: string;
  marketTicker: string;
  contractSide: KalshiContractSide;
  action: "ENTRY" | "ADD" | "EXIT";
  notionalTierUsd: number;
  contracts: number;
  vwap: number | null;
  feeUsd: number | null;
  feeModelVersion: string | null;
  allInCostUsd: number | null;
  fillStatus: "FULL" | "PARTIAL" | "NONE" | "INVALID" | "REJECTED";
  rejectReason: string | null;
  bookObservedAtMs: number | null;
  bookStaleReason: string | null;
  episodeKey: string | null;
  sourceTs: number;
  detectedAtMs: number;
};

export type SameVenueOpenPosition = { contractsOpen: number; avgEntryPrice: number | null };

export type SameVenueEventStatus = "PENDING" | "PROCESSING" | "PAPER_EXECUTED" | "SKIPPED" | "FAILED";

export type SameVenueRepository = {
  /** Durable qualification/watchlist row. null (absent) must fail closed. */
  getQualification(traderId: string): Promise<KalshiTraderQualification | null>;
  /**
   * Durable admission. MUST be idempotent at the database level on both `eventKey` and
   * (traderId, sourceTradeId) — an in-memory guard is never sufficient on its own.
   */
  admitEvent(trade: NormalizedKalshiSourceTrade, detectedAtMs: number, sourceName: string | null): Promise<{ admitted: boolean; duplicate: boolean; id: string | null }>;
  /** Atomic claim: PENDING -> PROCESSING, so overlapping workers cannot take the same row. */
  claimPendingEvents(workerId: string, limit: number): Promise<AdmittedSameVenueEvent[]>;
  /** Chronological already-persisted events for one position, used to replay episode state. */
  listPositionHistory(traderId: string, marketTicker: string, contractSide: KalshiContractSide): Promise<AdmittedSameVenueEvent[]>;
  getOpenPosition(traderId: string, marketTicker: string, contractSide: KalshiContractSide, notionalTierUsd: number): Promise<SameVenueOpenPosition | null>;
  /** Returns false when this (sourceEventId, tier) fill already existed — the retry no-op. */
  finalizePaperFill(input: SameVenuePaperFillInput): Promise<boolean>;
  markEvent(eventId: string, status: SameVenueEventStatus, statusReason: string | null, episodeKey: string | null): Promise<void>;
};

export const SAME_VENUE_ROUTE = "SAME_VENUE_KALSHI" as const;

/** Fails closed: never "falls back" to cross-venue matching for an unexpected route. */
export function assertSameVenueRoute(row: Pick<AdmittedSameVenueEvent, "route">): boolean {
  return row.route === SAME_VENUE_ROUTE && !requiresCrossVenueResolution({ route: SAME_VENUE_ROUTE });
}

export function toEligibleFillFromRow(row: AdmittedSameVenueEvent): EligibleFill {
  return {
    eventKey: row.eventKey,
    wallet: row.traderId,
    conditionId: row.marketTicker,
    asset: `${row.marketTicker}:${row.contractSide}`,
    side: row.action,
    shares: row.quantity,
    price: row.sourcePrice,
    sourceTs: row.sourceTs,
    detectedAt: row.detectedAtMs,
  };
}

/**
 * ADMISSION. normalize (fail closed) -> durable qualification gate -> durable insert.
 * A trader with no qualification row, or one not explicitly approved, produces no row at
 * all. `detectedAtMs` is stored ALONGSIDE the source timestamp, never in place of it.
 */
export async function admitSameVenueSourceEvent(
  raw: KalshiTraderSourceEvent,
  deps: { repo: SameVenueRepository; now: () => number; sourceName?: string | null },
): Promise<
  | { ok: false; reasonCode: string; reason: string }
  | { ok: true; duplicate: boolean; id: string | null; trade: NormalizedKalshiSourceTrade; detectedAtMs: number }
> {
  const normalized: KalshiSourceNormalizationResult = normalizeKalshiTraderEvent(raw);
  if (!normalized.ok) return normalized;

  const qualification = await deps.repo.getQualification(normalized.trade.traderId);
  const watchlist = { get: (traderId: string) => (qualification !== null && qualification.traderId === traderId ? qualification : null) };
  if (!isTraderQualified(watchlist, normalized.trade.traderId)) {
    return { ok: false, reasonCode: "REJECT_TRADER_NOT_QUALIFIED", reason: "trader is not approved for paper copy" };
  }

  const detectedAtMs = deps.now();
  const result = await deps.repo.admitEvent(normalized.trade, detectedAtMs, deps.sourceName ?? null);
  return { ok: true, duplicate: result.duplicate, id: result.id, trade: normalized.trade, detectedAtMs };
}

/** Replays this position's already-persisted history through the EXISTING reducer. */
export function replayEpisodeState(history: readonly AdmittedSameVenueEvent[], excludeEventKey: string): OpenEpisodeState | null {
  let state: OpenEpisodeState | null = null;
  for (const row of history) {
    if (row.eventKey === excludeEventKey) continue;
    const decision = decideFill(toEligibleFillFromRow(row), state);
    if ("nextState" in decision && decision.nextState !== null && decision.nextState !== undefined) {
      state = decision.nextState;
    }
  }
  return state;
}

export type FollowerAction = {
  action: "ENTRY" | "ADD" | "EXIT";
  episodeKey: string | null;
  exitFraction: number | null;
  /**
   * ADD sizing, matching the EXISTING cross-venue lifecycle semantics exactly
   * (source-poll.server.ts's own `addFraction`): new source BUY shares divided by the
   * source's remaining tracked shares BEFORE this add. The follower therefore scales the
   * SAME tier proportionally and never adds a fresh full tier for every DCA.
   */
  addFraction: number | null;
};

/** Maps an episode decision onto the follower action, or null when nothing should execute. */
export function followerActionForDecision(decision: EpisodeDecision, openBefore: OpenEpisodeState | null): FollowerAction | null {
  switch (decision.kind) {
    case "NEW_EPISODE":
    case "NEW_EPISODE_AFTER_30M":
      return { action: "ENTRY", episodeKey: decision.episodeKey, exitFraction: null, addFraction: null };
    case "AGGREGATED_BUY": {
      // Identical formula to the cross-venue path: shares / remaining-before-the-add.
      // Fails closed (no follower ADD at all) when there is no remaining source
      // inventory to scale against -- never silently promoted to a full extra tier.
      if (openBefore === null) return null;
      const remainingBefore = remainingShares(openBefore);
      if (!(remainingBefore > 0)) return null;
      const addFraction = decision.fill.shares / remainingBefore;
      if (!Number.isFinite(addFraction) || addFraction <= 0) return null;
      return { action: "ADD", episodeKey: decision.episodeKey, exitFraction: null, addFraction };
    }
    case "SELL_RECORDED": {
      if (decision.trackedShares <= 0 || openBefore === null) return null;
      const remainingBefore = remainingShares(openBefore);
      const fraction = computeExitFraction(decision.trackedShares, remainingBefore);
      if (fraction === null || fraction <= 0) return null;
      return { action: "EXIT", episodeKey: decision.episodeKey, exitFraction: fraction, addFraction: null };
    }
    default:
      return null;
  }
}

export type ProcessOutcome = {
  claimed: number;
  executed: number;
  skipped: number;
  failed: number;
  /** Tickers observed, in claim order — proof the byte-identical ticker was the target. */
  targetedTickers: string[];
};

/**
 * WORKER ROUTE. Claims already-admitted SAME_VENUE_KALSHI events and drives them through
 * the existing lifecycle + depth-walk + fee machinery against the EXACT same Kalshi
 * ticker and side. Never resolves, matches or translates a market.
 */
export async function processPendingSameVenueEvents(deps: {
  repo: SameVenueRepository;
  /** Read-only book reader for one exact (ticker, side) leg. */
  fetchBook: (input: { ticker: string; side: KalshiContractSide; signal?: AbortSignal }) => Promise<SameVenueBook>;
  workerId: string;
  limit?: number;
  signal?: AbortSignal;
  /**
   * Fee model. Defaults to the EXISTING documented Kalshi taker-fee model. Injectable so
   * the fee fail-closed branch and the sizing branch can each be exercised deterministically
   * in tests; production always uses the default.
   */
  computeFee?: (fills: readonly ConsumedLevel[]) => FeeResult;
}): Promise<ProcessOutcome> {
  const computeFee = deps.computeFee ?? ((fills: readonly ConsumedLevel[]) => computeTakerFeeForFills("KALSHI", fills));
  const rows = await deps.repo.claimPendingEvents(deps.workerId, deps.limit ?? 25);
  const outcome: ProcessOutcome = { claimed: rows.length, executed: 0, skipped: 0, failed: 0, targetedTickers: [] };

  for (const row of rows) {
    if (deps.signal?.aborted === true) break;

    if (!assertSameVenueRoute(row)) {
      await deps.repo.markEvent(row.id, "FAILED", "ROUTE_NOT_SAME_VENUE", null);
      outcome.failed += 1;
      continue;
    }

    const fill = toEligibleFillFromRow(row);
    const history = await deps.repo.listPositionHistory(row.traderId, row.marketTicker, row.contractSide);
    const openBefore = replayEpisodeState(history, row.eventKey);
    const decision = decideFill(fill, openBefore);

    if (decision.kind === "INVALID_FILL") {
      await deps.repo.markEvent(row.id, "FAILED", `INVALID_FILL:${decision.reason}`, null);
      outcome.failed += 1;
      continue;
    }
    if (decision.kind === "DUPLICATE_FILL") {
      await deps.repo.markEvent(row.id, "SKIPPED", "DUPLICATE_FILL", decision.episodeKey);
      outcome.skipped += 1;
      continue;
    }

    const follower = followerActionForDecision(decision, openBefore);
    if (follower === null) {
      await deps.repo.markEvent(row.id, "SKIPPED", `NO_FOLLOWER_ACTION:${decision.kind}`, null);
      outcome.skipped += 1;
      continue;
    }

    // Exact same-venue target: byte-identical ticker, identical side. No translation.
    const leg = targetLegForTrade({
      route: SAME_VENUE_ROUTE,
      traderId: row.traderId,
      sourceTradeId: row.sourceTradeId,
      marketTicker: row.marketTicker,
      contractSide: row.contractSide,
      action: row.action,
      quantity: row.quantity,
      price: row.sourcePrice,
      priceCents: Math.round(row.sourcePrice * 100),
      sourceTs: row.sourceTs,
      eventKey: row.eventKey,
    });
    outcome.targetedTickers.push(leg.ticker);

    const book = await deps.fetchBook({ ticker: leg.ticker, side: leg.side, ...(deps.signal ? { signal: deps.signal } : {}) });

    for (const tier of SPORTS_SHADOW_NOTIONALS_USD) {
      // Fail closed on a stale/failed book: record the attempt, never fabricate a fill.
      if (book.staleReason !== null) {
        await deps.repo.finalizePaperFill({
          sourceEventId: row.id,
          traderId: row.traderId,
          marketTicker: leg.ticker,
          contractSide: leg.side,
          action: follower.action,
          notionalTierUsd: tier,
          contracts: 0,
          vwap: null,
          feeUsd: null,
          feeModelVersion: null,
          allInCostUsd: null,
          fillStatus: "NONE",
          rejectReason: "STALE_BOOK",
          bookObservedAtMs: book.observedAtMs,
          bookStaleReason: book.staleReason,
          episodeKey: follower.episodeKey,
          sourceTs: row.sourceTs,
          detectedAtMs: row.detectedAtMs,
        });
        continue;
      }

      if (follower.action === "EXIT") {
        const position = await deps.repo.getOpenPosition(row.traderId, leg.ticker, leg.side, tier);
        if (position === null || position.contractsOpen <= 0) continue;
        const requested = position.contractsOpen * (follower.exitFraction ?? 0);
        if (!(requested > 0)) continue;
        const walk = walkSellDepth(book.bidLevels, requested);
        const fee = walk.fills.length > 0 ? computeTakerFeeForFills("KALSHI", walk.fills) : null;
        await deps.repo.finalizePaperFill({
          sourceEventId: row.id,
          traderId: row.traderId,
          marketTicker: leg.ticker,
          contractSide: leg.side,
          action: "EXIT",
          notionalTierUsd: tier,
          contracts: walk.filledContracts,
          vwap: walk.averageExecutionPrice,
          feeUsd: fee !== null && fee.valid ? fee.feeUsd : null,
          feeModelVersion: fee?.feeModelVersion ?? null,
          allInCostUsd: walk.filledContracts > 0 ? walk.proceedsUsd - (fee !== null && fee.valid ? fee.feeUsd : 0) : null,
          fillStatus: walk.status,
          rejectReason: walk.invalidReason,
          bookObservedAtMs: book.observedAtMs,
          bookStaleReason: null,
          episodeKey: follower.episodeKey,
          sourceTs: row.sourceTs,
          detectedAtMs: row.detectedAtMs,
        });
        continue;
      }

      const walk = walkBuyDepth(book.askLevels, tier);
      const fee = walk.fills.length > 0 ? computeTakerFeeForFills("KALSHI", walk.fills) : null;
      await deps.repo.finalizePaperFill({
        sourceEventId: row.id,
        traderId: row.traderId,
        marketTicker: leg.ticker,
        contractSide: leg.side,
        action: follower.action,
        notionalTierUsd: tier,
        contracts: walk.contractsFilled,
        vwap: walk.averageExecutionPrice,
        feeUsd: fee !== null && fee.valid ? fee.feeUsd : null,
        feeModelVersion: fee?.feeModelVersion ?? null,
        allInCostUsd: walk.contractsFilled > 0 ? walk.filledNotionalUsd + (fee !== null && fee.valid ? fee.feeUsd : 0) : null,
        fillStatus: walk.status,
        rejectReason: walk.invalidReason,
        bookObservedAtMs: book.observedAtMs,
        bookStaleReason: null,
        episodeKey: follower.episodeKey,
        sourceTs: row.sourceTs,
        detectedAtMs: row.detectedAtMs,
      });
    }

    await deps.repo.markEvent(row.id, "PAPER_EXECUTED", null, follower.episodeKey);
    outcome.executed += 1;
  }

  return outcome;
}

export type IngestCycleResult = { configured: boolean; fetched: number; admitted: number; duplicates: number; rejected: number };

/**
 * INGEST CYCLE. Inert by design: with no configured `KalshiTraderActivitySource` (the
 * current production state — no verified Kalshi trader feed exists) it fetches nothing
 * and admits nothing. It never synthesizes an event.
 */
export async function runKalshiSourceIngestCycle(deps: {
  source: KalshiTraderActivitySource | null;
  repo: SameVenueRepository;
  now: () => number;
  traders: readonly { traderId: string; sinceTsSeconds: number }[];
  signal?: AbortSignal;
}): Promise<IngestCycleResult> {
  if (deps.source === null) return { configured: false, fetched: 0, admitted: 0, duplicates: 0, rejected: 0 };

  const result: IngestCycleResult = { configured: true, fetched: 0, admitted: 0, duplicates: 0, rejected: 0 };
  for (const trader of deps.traders) {
    if (deps.signal?.aborted === true) break;
    const events = await deps.source.fetchNewActivity({ traderId: trader.traderId, sinceTsSeconds: trader.sinceTsSeconds, ...(deps.signal ? { signal: deps.signal } : {}) });
    result.fetched += events.length;
    for (const raw of events) {
      const admitted = await admitSameVenueSourceEvent(raw, { repo: deps.repo, now: deps.now, sourceName: deps.source.sourceName });
      if (!admitted.ok) result.rejected += 1;
      else if (admitted.duplicate) result.duplicates += 1;
      else result.admitted += 1;
    }
  }
  return result;
}
