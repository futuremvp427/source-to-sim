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

/**
 * Parse Gamma outcomePrices without JavaScript's permissive Number(null/""/true)
 * coercions. Gamma may return the array directly or as a JSON-encoded string;
 * each member must itself be a finite number or a non-empty numeric string.
 */
export function parseGammaOutcomePrices(value: unknown): number[] | null {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!Array.isArray(raw)) return null;

  const numbers: number[] = [];
  for (const item of raw) {
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return null;
      numbers.push(item);
      continue;
    }
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (!trimmed) return null;
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) return null;
      numbers.push(parsed);
      continue;
    }
    return null;
  }
  return numbers;
}

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

  // Gamma is only a fallback for a CLOB payload that declares NO winner. If
  // CLOB declares multiple winners, the authoritative views are already
  // contradictory/ambiguous and another source must not override it.
  const clobWinnerCount = clob.tokens.filter((t) => t.winner).length;
  if (clobWinnerCount !== 0) {
    return { verified: false, reason: `Conflicting CLOB resolution (${clobWinnerCount} winning outcomes)` };
  }

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

  // Verify the token->outcome mapping for EVERY token, not just the held one.
  for (let index = 0; index < n; index += 1) {
    const tokenId = gamma.clobTokenIds[index]!;
    const clobOutcome = clob.tokens.find((t) => t.tokenId === tokenId)?.outcome ?? null;
    const gammaOutcome = gamma.outcomes[index] ?? null;
    if (clobOutcome !== null && clobOutcome !== gammaOutcome) {
      return { verified: false, reason: "CLOB and Gamma disagree on token outcome mapping" };
    }
  }

  const heldIndex = gamma.clobTokenIds.findIndex((id) => id === asset);
  if (heldIndex < 0) {
    return { verified: false, reason: "Held asset is not part of the Gamma-resolved market" };
  }

  const winnerIndexes = gamma.outcomePrices
    .map((price, index) => ({ price, index }))
    .filter(({ price }) => price === 1)
    .map(({ index }) => index);
  const terminal = gamma.outcomePrices.every((price) => price === 0 || price === 1);
  if (!terminal || winnerIndexes.length !== 1) {
    return { verified: false, reason: "Gamma does not provide a single terminal 1/0 outcome" };
  }

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

export type CursorSettlementBatch = {
  assets: string[];
  startIndex: number;
  batchIndex: number;
  batchCount: number;
  wrapped: boolean;
  nextCursor: string | null;
};

/**
 * Select the next settlement batch from a stable asset-sorted open book using
 * the last asset that was ACTUALLY scanned. This makes progress depend on
 * completed settlement passes rather than wall-clock minute parity.
 *
 * If the previous cursor asset disappeared because the position settled, the
 * scan resumes at the first lexicographically greater asset. The final batch
 * wraps to the beginning so newly-added lower-sorting assets are not starved.
 */
export function selectSettlementBatchByCursor(
  sortedAssets: string[],
  cursorAsset: string | null,
  batchSize: number = SETTLEMENT_BATCH_SIZE,
): CursorSettlementBatch {
  const assets = [...sortedAssets];
  const openCount = assets.length;
  if (openCount === 0 || batchSize <= 0) {
    return {
      assets: [],
      startIndex: 0,
      batchIndex: 0,
      batchCount: 0,
      wrapped: false,
      nextCursor: cursorAsset,
    };
  }

  const size = Math.min(batchSize, openCount);
  let startIndex = 0;
  if (cursorAsset) {
    const next = assets.findIndex((asset) => asset > cursorAsset);
    startIndex = next >= 0 ? next : 0;
  }

  const selected: string[] = [];
  for (let i = 0; i < size; i += 1) {
    selected.push(assets[(startIndex + i) % openCount]!);
  }

  const wrapped = startIndex + size > openCount || (cursorAsset !== null && startIndex === 0);
  const batchCount = Math.ceil(openCount / batchSize);
  const batchIndex = Math.min(Math.floor(startIndex / batchSize), Math.max(0, batchCount - 1));
  return {
    assets: selected,
    startIndex,
    batchIndex,
    batchCount,
    wrapped,
    nextCursor: selected.at(-1) ?? cursorAsset,
  };
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
