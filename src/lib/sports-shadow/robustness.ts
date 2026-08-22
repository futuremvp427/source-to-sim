/**
 * FINAL BUILD Part 2: robustness analytics — PURE math only.
 *
 * Every check here answers "does the headline result survive a specific stress or
 * exclusion test", computed against the SAME declared-strategy row set analytics.ts's
 * computeFullAnalyticsReport uses -- never a retroactively hand-picked subgroup
 * presented as the main result (the mission's own explicit anti-cherry-picking rule).
 * The headline number always stays whatever analytics.ts reports for the full,
 * unmodified row set; every function below is a SEPARATE, clearly labeled stress applied
 * on top of it, never a replacement for it.
 */

import { computeClusterReturns, computeCoreMetrics, effectiveClusterKey, type ClusterReturn, type CoreMetrics, type EpisodeOutcomeRow } from "./analytics";
import { breakdownBySizeTier, type BreakdownEntry } from "./analytics";

function isSettled(row: EpisodeOutcomeRow): boolean {
  return row.settlementStatus === "SETTLED_WIN" || row.settlementStatus === "SETTLED_LOSS" || row.settlementStatus === "SETTLED_PUSH";
}

/** Removes the N settled episodes with the largest net P&L, then reports metrics over what remains -- proves the headline result is not dependent on a small number of outsized wins. */
export function removeTopNWins(rows: readonly EpisodeOutcomeRow[], n: number): { removedCount: number; removedNetPnlUsd: number; remaining: CoreMetrics } {
  const settled = rows.filter(isSettled).filter((r) => r.netPnlUsd !== null);
  const sortedByWin = [...settled].sort((a, b) => (b.netPnlUsd ?? 0) - (a.netPnlUsd ?? 0));
  const toRemove = new Set(sortedByWin.slice(0, n).map((r) => r.signalId));
  const removedNetPnlUsd = sortedByWin.slice(0, n).reduce((acc, r) => acc + (r.netPnlUsd ?? 0), 0);
  const remainingRows = rows.filter((r) => !toRemove.has(r.signalId));
  return { removedCount: Math.min(n, sortedByWin.length), removedNetPnlUsd, remaining: computeCoreMetrics(remainingRows) };
}

export const removeLargestWin = (rows: readonly EpisodeOutcomeRow[]) => removeTopNWins(rows, 1);

/** Removes the single largest-LOSS settled episode (separately from wins -- Part 2's own explicit "largest loss removed separately" requirement). */
export function removeLargestLoss(rows: readonly EpisodeOutcomeRow[]): { removedNetPnlUsd: number; remaining: CoreMetrics } {
  const settled = rows.filter(isSettled).filter((r) => r.netPnlUsd !== null);
  if (settled.length === 0) return { removedNetPnlUsd: 0, remaining: computeCoreMetrics(rows) };
  const worst = settled.reduce((a, b) => ((a.netPnlUsd ?? 0) <= (b.netPnlUsd ?? 0) ? a : b));
  const remainingRows = rows.filter((r) => r.signalId !== worst.signalId);
  return { removedNetPnlUsd: worst.netPnlUsd ?? 0, remaining: computeCoreMetrics(remainingRows) };
}

/**
 * Simulates N adverse cents of execution cost per contract, holding the settlement
 * OUTCOME fixed (a documented approximation -- a genuinely re-priced execution could in
 * rare cases flip FULL<->PARTIAL<->NONE fill classification, which this does not model;
 * it answers "how much would N cents of worse execution cost have eaten into the
 * P&L we actually realized", not "what if the market had actually moved"). Never
 * fabricates a different settlement result.
 */
export function applyAdverseExecutionStressCents(rows: readonly EpisodeOutcomeRow[], adverseCents: number): CoreMetrics {
  const stressed = rows.map((row) => {
    if (!isSettled(row) || row.netPnlUsd === null) return row;
    const extraCostUsd = (adverseCents / 100) * row.contracts;
    return { ...row, netPnlUsd: row.netPnlUsd - extraCostUsd, grossPnlUsd: (row.grossPnlUsd ?? 0) - extraCostUsd };
  });
  return computeCoreMetrics(stressed);
}

export const applyOneCentAdverseStress = (rows: readonly EpisodeOutcomeRow[]) => applyAdverseExecutionStressCents(rows, 1);
export const applyTwoCentAdverseStress = (rows: readonly EpisodeOutcomeRow[]) => applyAdverseExecutionStressCents(rows, 2);

export type LatencyStressResult =
  | { available: true; metrics: CoreMetrics; excludedCount: number }
  | { available: false; reason: string };

/**
 * Configurable additional-latency stress: recomputes each episode's outcome as though
 * execution had happened `additionalDelayMs` later, using an alternate-delay quote
 * price the caller supplies (from the +0/+5/+10/+30/+60 observation series already
 * captured per signal). Deliberately does NOT fabricate a later price when the caller
 * has not supplied one for a given signal -- that episode is excluded from the stressed
 * result and counted in `excludedCount`, never silently zero-filled. When `laterQuotes`
 * is entirely absent (the common case until a caller wires the multi-delay observation
 * fetch), returns `available:false` with an explicit reason rather than a fabricated
 * number -- honest "not yet computable" beats a fake result.
 */
export function applyLatencyStress(
  rows: readonly EpisodeOutcomeRow[],
  laterQuotes: ReadonlyMap<string, number> | undefined,
): LatencyStressResult {
  if (!laterQuotes || laterQuotes.size === 0) {
    return { available: false, reason: "no alternate-delay quote series supplied -- requires the +0/+5/+10/+30/+60 observation series per signal, not yet wired into this call site" };
  }
  let excludedCount = 0;
  const stressed: EpisodeOutcomeRow[] = [];
  for (const row of rows) {
    if (!isSettled(row) || row.netPnlUsd === null || row.vwap === null) {
      stressed.push(row);
      continue;
    }
    const laterPrice = laterQuotes.get(row.signalId);
    if (laterPrice === undefined) {
      excludedCount += 1;
      continue;
    }
    const priceDeltaUsd = (laterPrice - row.vwap) * row.contracts;
    stressed.push({ ...row, netPnlUsd: row.netPnlUsd - priceDeltaUsd, grossPnlUsd: (row.grossPnlUsd ?? 0) - priceDeltaUsd });
  }
  return { available: true, metrics: computeCoreMetrics(stressed), excludedCount };
}

export type HalfComparison = { firstHalf: CoreMetrics; secondHalf: CoreMetrics };

/** Chronological (by routing_timestamp) first-half vs second-half split -- catches a result driven entirely by an early hot streak that later reverted. */
export function compareFirstHalfSecondHalf(rows: readonly EpisodeOutcomeRow[]): HalfComparison {
  const sorted = [...rows].sort((a, b) => Date.parse(a.routingTimestampIso) - Date.parse(b.routingTimestampIso));
  const mid = Math.ceil(sorted.length / 2);
  return { firstHalf: computeCoreMetrics(sorted.slice(0, mid)), secondHalf: computeCoreMetrics(sorted.slice(mid)) };
}

export type WalletConcentration = { walletCount: number; topWalletShareOfNetPnl: number; herfindahlIndex: number };

/**
 * Herfindahl-Hirschman-style concentration over GROSS positive contribution per wallet
 * (never net, since a wallet with large offsetting wins/losses should not look
 * "diversified" by cancellation) -- 1/walletCount is the maximally diversified floor,
 * 1.0 means one wallet produced all of it.
 */
export function computeWalletConcentration(rows: readonly EpisodeOutcomeRow[]): WalletConcentration {
  const byWallet = new Map<string, number>();
  for (const row of rows) {
    if (!isSettled(row) || row.netPnlUsd === null) continue;
    byWallet.set(row.sourceWallet, (byWallet.get(row.sourceWallet) ?? 0) + Math.max(0, row.netPnlUsd));
  }
  const totals = [...byWallet.values()];
  const grandTotal = totals.reduce((a, b) => a + b, 0);
  if (grandTotal <= 0) return { walletCount: byWallet.size, topWalletShareOfNetPnl: 0, herfindahlIndex: 0 };
  const shares = totals.map((t) => t / grandTotal);
  return {
    walletCount: byWallet.size,
    topWalletShareOfNetPnl: Math.max(...shares),
    herfindahlIndex: shares.reduce((acc, s) => acc + s * s, 0),
  };
}

/** "Game/cluster-adjusted results" -- Part 2's own name for exactly what analytics.ts's computeClusterReturns already computes: one aggregated return per independent cluster, never per raw correlated fill. */
export const computeClusterAdjustedReturns = (rows: readonly EpisodeOutcomeRow[]): ClusterReturn[] => computeClusterReturns(rows);

/** Compares core metrics ACROSS all captured notional tiers -- `rows` must be the UNFILTERED, all-tier row set (never pre-filtered to the declared tier), since the whole point is comparing tiers against each other. */
export function compareSizeTierCapacity(allTierRows: readonly EpisodeOutcomeRow[]): BreakdownEntry[] {
  return breakdownBySizeTier(allTierRows);
}

export { effectiveClusterKey };
