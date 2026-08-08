/**
 * Pure comparison metrics for the parallel shadow experiments.
 * Every number here is PAPER / DERIVED: it describes the simulated book only.
 */

import { roundUsd } from "./shadow-core";

export type TradeLite = {
  action: string;
  realizedPnl: number;
  createdAt: string;
};

export type ExperimentSummaryInput = {
  startingCash: number;
  cash: number;
  realizedPnl: number;
  /** Mark-to-market value of open paper positions; null when marks are unavailable. */
  openValue: number | null;
  trades: TradeLite[];
  /** Total pipeline latency in seconds per audited event. */
  latencies: number[];
};

export type ExperimentSummary = {
  equity: number | null;
  totalPnl: number | null;
  roiPct: number | null;
  realizedPnl: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  maxDrawdown: number;
  buys: number;
  sells: number;
  medianLatencySeconds: number | null;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round(value * 100) / 100;
}

/** Peak-to-trough drawdown of the realized-P&L equity curve (0 when never underwater). */
export function maxDrawdown(startingCash: number, trades: TradeLite[]): number {
  const ordered = [...trades].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let equity = startingCash;
  let peak = startingCash;
  let worst = 0;
  for (const t of ordered) {
    equity += t.realizedPnl;
    if (equity > peak) peak = equity;
    worst = Math.max(worst, peak - equity);
  }
  return roundUsd(worst);
}

export function summarizeExperiment(input: ExperimentSummaryInput): ExperimentSummary {
  const settled = input.trades.filter((t) => t.realizedPnl !== 0);
  const wins = settled.filter((t) => t.realizedPnl > 0).length;
  const losses = settled.filter((t) => t.realizedPnl < 0).length;
  const decided = wins + losses;
  const equity = input.openValue === null ? null : roundUsd(input.cash + input.openValue);
  const totalPnl = equity === null ? null : roundUsd(equity - input.startingCash);
  return {
    equity,
    totalPnl,
    roiPct:
      totalPnl === null || input.startingCash <= 0
        ? null
        : Math.round((totalPnl / input.startingCash) * 10000) / 100,
    realizedPnl: roundUsd(input.realizedPnl),
    wins,
    losses,
    winRatePct: decided === 0 ? null : Math.round((wins / decided) * 1000) / 10,
    maxDrawdown: maxDrawdown(input.startingCash, input.trades),
    buys: input.trades.filter((t) => t.action === "BUY").length,
    sells: input.trades.filter((t) => t.action === "SELL").length,
    medianLatencySeconds: median(input.latencies),
  };
}
