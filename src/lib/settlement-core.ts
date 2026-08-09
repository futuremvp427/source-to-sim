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

/**
 * Secondary official Polymarket (Gamma) evidence used only when the CLOB market
 * is closed but does not expose a usable winner flag. Arrays must map 1:1.
 */
export type GammaResolutionEvidence = {
  closed: boolean;
  conditionId: string;
  outcomes: string[];
  outcomePrices: number[];
  clobTokenIds: string[];
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

/**
 * Fail-closed fallback for a CLOB response that is explicitly closed but has no
 * usable `winner` flag. Gamma is also an official public Polymarket API. We only
 * accept terminal evidence when Gamma independently says closed, the outcome /
 * token / price arrays map 1:1, and prices are exactly one 1 and all remaining
 * 0. Anything less remains unresolved.
 */
export function decideResolutionWithGammaFallback(
  asset: string,
  clob: PublicMarketResolution,
  gamma: GammaResolutionEvidence | null,
): ResolutionDecision {
  const primary = decideResolution(asset, clob);
  if (primary.verified || !clob.closed) return primary;
  if (!gamma?.closed) return primary;

  const n = gamma.outcomes.length;
  if (n < 2 || gamma.outcomePrices.length !== n || gamma.clobTokenIds.length !== n) {
    return { verified: false, reason: "Gamma resolution arrays do not map 1:1" };
  }
  if (new Set(gamma.clobTokenIds).size !== n || gamma.clobTokenIds.some((id) => !id)) {
    return { verified: false, reason: "Gamma resolution token mapping is invalid" };
  }

  const clobTokenIds = new Set(clob.tokens.map((t) => t.tokenId).filter((id) => !!id));
  const gammaTokenIds = new Set(gamma.clobTokenIds);
  const sameTokenSet =
    clobTokenIds.size === gammaTokenIds.size && [...gammaTokenIds].every((id) => clobTokenIds.has(id));
  if (!sameTokenSet) {
    return { verified: false, reason: "Gamma token IDs do not match the CLOB token set for this market" };
  }

  const heldIndexForLabel = gamma.clobTokenIds.findIndex((id) => id === asset);
  if (heldIndexForLabel < 0) {
    return { verified: false, reason: "Held asset is not part of the Gamma-resolved market" };
  }
  const clobHeldOutcome = clob.tokens.find((t) => t.tokenId === asset)?.outcome ?? null;
  const gammaHeldOutcome = gamma.outcomes[heldIndexForLabel] ?? null;
  if (clobHeldOutcome !== null && clobHeldOutcome !== gammaHeldOutcome) {
    return { verified: false, reason: "CLOB and Gamma disagree on the outcome label for the held asset" };
  }

  const winnerIndexes = gamma.outcomePrices
    .map((price, index) => ({ price, index }))
    .filter(({ price }) => price === 1)
    .map(({ index }) => index);
  const terminal = gamma.outcomePrices.every((price) => price === 0 || price === 1);
  if (!terminal || winnerIndexes.length !== 1) {
    return { verified: false, reason: "Gamma does not provide a single terminal 1/0 outcome" };
  }

  const heldIndex = gamma.clobTokenIds.findIndex((id) => id === asset);
  if (heldIndex < 0) return { verified: false, reason: "Held asset is not part of the Gamma-resolved market" };

  const winnerIndex = winnerIndexes[0]!;
  const won = heldIndex === winnerIndex;
  return {
    verified: true,
    won,
    outcome: gamma.outcomes[heldIndex] ?? null,
    payoutPerShare: won ? 1 : 0,
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
