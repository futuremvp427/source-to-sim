/**
 * SAME-VENUE (Kalshi -> Kalshi) PAPER settlement — PURE module.
 *
 * Terminal P&L for an OPEN same-venue paper position, computed ONLY from the venue's own
 * exchange-authoritative resolution (settlement.server.ts's `checkKalshiSettlement`, which
 * the injected `checkSettlement` supplies) plus the position's own persisted cost basis.
 * Never infers a resolution from anything else, and never fabricates a payoff.
 *
 * ACCOUNTING CONTRACT (matches the DB hardening patch):
 *   - `realized_pnl_usd` on the position is GROSS prior EXIT P&L; `fees_usd` is separate.
 *   - WIN  remaining gross = contractsOpen * (1 - avgEntryPrice)
 *   - LOSS remaining gross = contractsOpen * (0 - avgEntryPrice)
 *   - PUSH / VOID / CANCELED add ZERO remaining gross.
 *   - gross total = prior realized gross + remaining gross
 *   - net = gross total - fees_usd, subtracted EXACTLY ONCE.
 *
 * PAPER/RESEARCH ONLY. No order construction, no order endpoint, no live-execution switch.
 */

import type { SettlementCheckResult, SettlementStatus } from "./settlement.server";

import type { KalshiContractSide } from "./kalshi-source";

/** One due OPEN position, as returned by find_open_sports_shadow_kalshi_positions. */
export type SameVenueSettlementPosition = {
  traderId: string;
  marketTicker: string;
  contractSide: KalshiContractSide;
  notionalTierUsd: number;
  contractsOpen: number;
  /** null is a fail-closed condition when contracts are still open: no cost basis, no P&L. */
  avgEntryPrice: number | null;
  /** GROSS prior EXIT P&L already realized on this position. Fees are NOT netted into it. */
  realizedPnlUsd: number;
  /** All fees accrued on this position so far (entry + adds + exits). Netted exactly once. */
  feesUsd: number;
  checkAttemptCount: number;
};

export type SameVenueSettlementRow = {
  traderId: string;
  marketTicker: string;
  contractSide: KalshiContractSide;
  notionalTierUsd: number;
  settlementStatus: SettlementStatus;
  settlementTimestampMs: number | null;
  settlementValue: number | null;
  settlementSource: string;
  grossPnlUsd: number | null;
  totalFeesUsd: number;
  netPnlUsd: number | null;
  /** null once terminal — no further checks needed. */
  nextCheckAtMs: number | null;
  checkAttemptCount: number;
};

export type SameVenueSettlementRepository = {
  /** Only positions that are OPEN and DUE (next_check_at in the past or unset). */
  findDuePositions(limit: number): Promise<SameVenueSettlementPosition[]>;
  finalizeSettlement(row: SameVenueSettlementRow): Promise<void>;
};

/**
 * Same backoff shape as the cross-venue settlement orchestrator: 10-minute base, doubling
 * per attempt, capped at 6 hours (and the exponent itself clamped so it can never grow
 * unbounded). Defined locally so this module stays pure — the cross-venue orchestrator
 * lives in a server module that imports the privileged Supabase client.
 */
export const SAME_VENUE_RECHECK_BASE_MS = 10 * 60 * 1000;
export const SAME_VENUE_RECHECK_MAX_MS = 6 * 60 * 60 * 1000;
const MAX_BACKOFF_EXPONENT = 6;

export function computeSameVenueNextCheckAtMs(nowMs: number, attemptCountAfterThisCheck: number): number {
  const exponent = Math.min(Math.max(0, attemptCountAfterThisCheck - 1), MAX_BACKOFF_EXPONENT);
  return nowMs + Math.min(SAME_VENUE_RECHECK_MAX_MS, SAME_VENUE_RECHECK_BASE_MS * 2 ** exponent);
}

function isValidBasis(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * PURE terminal-P&L math for one position + one authoritative check result.
 * `checkAttemptCount` here is the count INCLUDING this check.
 */
export function computeSameVenueSettlementRow(
  position: SameVenueSettlementPosition,
  check: SettlementCheckResult,
  nowMs: number,
  checkAttemptCount: number,
): SameVenueSettlementRow {
  const base = {
    traderId: position.traderId,
    marketTicker: position.marketTicker,
    contractSide: position.contractSide,
    notionalTierUsd: position.notionalTierUsd,
    totalFeesUsd: position.feesUsd,
    checkAttemptCount,
  };

  if (check.status === "PENDING") {
    return {
      ...base,
      settlementStatus: "PENDING",
      settlementTimestampMs: null,
      settlementValue: null,
      settlementSource: check.settlementSource,
      grossPnlUsd: null,
      netPnlUsd: null,
      nextCheckAtMs: computeSameVenueNextCheckAtMs(nowMs, checkAttemptCount),
    };
  }

  // FAIL CLOSED: open contracts with no valid recorded cost basis cannot be priced at all.
  // Recorded as terminal VOID with NULL P&L — never a fabricated payoff, never re-polled.
  if (position.contractsOpen > 0 && !isValidBasis(position.avgEntryPrice)) {
    return {
      ...base,
      settlementStatus: "VOID",
      settlementTimestampMs: nowMs,
      settlementValue: null,
      settlementSource: "position has no valid recorded average entry price; terminal P&L is not computable",
      grossPnlUsd: null,
      netPnlUsd: null,
      nextCheckAtMs: null,
    };
  }

  const avg = position.avgEntryPrice ?? 0;
  const remainingGross =
    check.status === "SETTLED_WIN"
      ? position.contractsOpen * (1 - avg)
      : check.status === "SETTLED_LOSS"
        ? position.contractsOpen * (0 - avg)
        : 0; // SETTLED_PUSH / VOID / CANCELED add zero remaining gross

  const grossTotal = position.realizedPnlUsd + remainingGross;

  return {
    ...base,
    settlementStatus: check.status,
    settlementTimestampMs: check.settlementTimestampMs,
    settlementValue: check.settlementValue,
    settlementSource: check.settlementSource,
    grossPnlUsd: grossTotal,
    netPnlUsd: grossTotal - position.feesUsd, // fees subtracted exactly once
    nextCheckAtMs: null,
  };
}

export type SameVenueSettlementBatchResult = { checked: number; settled: number; errors: number; deadlineReached: boolean };

/**
 * Bounded settlement runner. Each position's authoritative check owns a fixed upstream
 * fetch ceiling that cannot be aborted mid-flight, so the deadline is checked BEFORE each
 * position: once reached, every remaining position is left completely untouched at its
 * existing next_check_at and picked up by a later invocation. Never a partial fabrication.
 *
 * NOT SCHEDULED: no cron/schedule is registered for this runner yet.
 */
export async function runSameVenueSettlementBatch(deps: {
  repo: SameVenueSettlementRepository;
  checkSettlement: (ticker: string, side: KalshiContractSide) => Promise<SettlementCheckResult>;
  limit?: number;
  now?: () => number;
  deadlineAtMs?: number;
}): Promise<SameVenueSettlementBatchResult> {
  const now = deps.now ?? Date.now;
  const deadlineAtMs = deps.deadlineAtMs ?? Infinity;
  const positions = await deps.repo.findDuePositions(deps.limit ?? 50);

  const result: SameVenueSettlementBatchResult = { checked: 0, settled: 0, errors: 0, deadlineReached: false };
  for (const position of positions) {
    if (now() >= deadlineAtMs) {
      result.deadlineReached = true;
      break;
    }
    result.checked += 1;
    try {
      const check = await deps.checkSettlement(position.marketTicker, position.contractSide);
      const row = computeSameVenueSettlementRow(position, check, now(), position.checkAttemptCount + 1);
      await deps.repo.finalizeSettlement(row);
      if (row.settlementStatus !== "PENDING") result.settled += 1;
    } catch {
      result.errors += 1; // stays OPEN at its existing next_check_at; retried later
    }
  }
  return result;
}
