/**
 * Pure settlement rules for the SHADOW / PAPER book.
 * A shadow position may only be settled from a VERIFIED public resolution.
 * Anything ambiguous leaves the position OPEN / UNRESOLVED — we never guess.
 */

import { roundUsd } from "./shadow-core";

export type ResolutionToken = {
  tokenId: string;
  outcome: string | null;
  winner: boolean;
};

export type PublicMarketResolution = {
  closed: boolean;
  tokens: ResolutionToken[];
};

export type ResolutionDecision =
  | { verified: false; reason: string }
  | { verified: true; won: boolean; outcome: string | null; payoutPerShare: 0 | 1 };

/** VERIFIED only when the market is closed and exactly one outcome is the declared winner. */
export function decideResolution(asset: string, market: PublicMarketResolution): ResolutionDecision {
  if (!market.closed) return { verified: false, reason: "Market is not closed" };
  const winners = market.tokens.filter((t) => t.winner);
  if (winners.length !== 1) {
    return { verified: false, reason: `Unconfirmed resolution (${winners.length} winning outcomes)` };
  }
  const token = market.tokens.find((t) => t.tokenId === asset);
  if (!token) return { verified: false, reason: "Held asset is not part of the resolved market" };
  return {
    verified: true,
    won: token.winner,
    outcome: token.outcome,
    payoutPerShare: token.winner ? 1 : 0,
  };
}

export type SettlementCredit = {
  payout: number;
  realizedPnl: number;
};

export const SETTLEMENT_BATCH_SIZE = 25;

export type SettlementBatch = { offset: number; size: number; batchIndex: number; batchCount: number };

/**
 * Deterministic rotating batch selection.
 *
 * Keeps at most `batchSize` expensive public resolution lookups per pass while
 * guaranteeing that every open position becomes eligible within
 * ceil(openCount / batchSize) passes: the cycle index advances the batch by one
 * each pass and wraps around after the final batch. Callers MUST pair this with
 * a stable ORDER BY (asset ASC) — Postgres row order is otherwise undefined.
 */
export function selectSettlementBatch(
  openCount: number,
  cycleIndex: number,
  batchSize: number = SETTLEMENT_BATCH_SIZE,
): SettlementBatch {
  if (openCount <= 0 || batchSize <= 0) {
    return { offset: 0, size: 0, batchIndex: 0, batchCount: 0 };
  }
  const batchCount = Math.ceil(openCount / batchSize);
  const batchIndex = ((Math.trunc(cycleIndex) % batchCount) + batchCount) % batchCount;
  const offset = batchIndex * batchSize;
  return { offset, size: Math.min(batchSize, openCount - offset), batchIndex, batchCount };
}

/** $1 per winning share, $0 otherwise. Realized P&L is payout minus the paper cost basis. */
export function settlementCredit(input: {
  shares: number;
  costBasis: number;
  payoutPerShare: 0 | 1;
}): SettlementCredit {
  const payout = roundUsd(input.shares * input.payoutPerShare);
  return { payout, realizedPnl: roundUsd(payout - input.costBasis) };
}
