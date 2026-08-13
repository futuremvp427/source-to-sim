/**
 * Pure math for the V2 vs V3 capacity comparison.
 *
 * Every number here is PAPER / DERIVED. The drawdown is a CASH-basis drawdown
 * computed from the persisted paper_trades.cash_after sequence: it reflects
 * realized simulated cash only and does NOT include unrealized open-position
 * value, so it is not a mark-to-market equity drawdown.
 */

import { roundUsd, SIZING_RESERVE_FRACTION } from "./shadow-core";

export type CapacityCohort = "V2" | "V3";

export type CashPoint = {
  createdAt: string;
  cashAfter: number | null;
};

export type MarkCandidate = {
  mark: unknown;
  markTs: string | null;
};

export type CapacityRowInput = {
  id: string;
  name: string;
  cohort: CapacityCohort;
  handle: string;
  wallet: string;
  startingBankroll: number;
  cash: number;
  realizedPnl: number;
  openCostBasis: number;
  openPositions: number;
  markedOpenPositions: number;
  buys: number;
  sells: number;
  insufficientCashSkips: number;
  settledMarkets: number;
  cashPoints: CashPoint[];
};

export type CapacityRow = Omit<CapacityRowInput, "cashPoints"> & {
  reserve: number;
  spendable: number;
  roi: number | null;
  markCoveragePct: number | null;
  /** CASH-basis drawdown (realized cash only, no unrealized open value). */
  maxDrawdownCash: number;
};

export type CapacityWalletGroup = {
  handle: string;
  wallet: string;
  v2: CapacityRow | null;
  v3: CapacityRow | null;
};

/** Reserved cash for an experiment: a fixed fraction of its starting bankroll. */
export function reserveFor(startingBankroll: number): number {
  return roundUsd(Math.max(0, startingBankroll) * SIZING_RESERVE_FRACTION);
}

/**
 * Count only marks that are both present and fresh at the measurement instant.
 * Missing/invalid/future timestamps fail closed rather than making capacity
 * coverage look more complete than it is.
 */
export function countFreshMarks(
  candidates: MarkCandidate[],
  nowMs: number,
  maxAgeMs: number,
): number {
  return candidates.filter((candidate) => {
    if (candidate.mark === null || candidate.mark === undefined || candidate.markTs === null) return false;
    const markMs = new Date(candidate.markTs).getTime();
    if (!Number.isFinite(markMs)) return false;
    const ageMs = nowMs - markMs;
    return ageMs >= 0 && ageMs <= maxAgeMs;
  }).length;
}

/**
 * Running-peak minus current cash over the ordered cash_after sequence.
 * Rows without a cash_after value are ignored (no cash movement recorded).
 */
export function cashMaxDrawdown(startingBankroll: number, points: CashPoint[]): number {
  const ordered = [...points]
    .filter((p): p is CashPoint & { cashAfter: number } => typeof p.cashAfter === "number")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let peak = startingBankroll;
  let worst = 0;
  for (const point of ordered) {
    if (point.cashAfter > peak) peak = point.cashAfter;
    worst = Math.max(worst, peak - point.cashAfter);
  }
  return roundUsd(worst);
}

export function buildCapacityRow(input: CapacityRowInput): CapacityRow {
  const { cashPoints, ...rest } = input;
  const reserve = reserveFor(input.startingBankroll);
  return {
    ...rest,
    reserve,
    spendable: roundUsd(Math.max(0, input.cash - reserve)),
    roi: input.startingBankroll > 0 ? input.realizedPnl / input.startingBankroll : null,
    markCoveragePct:
      input.openPositions > 0 ? (input.markedOpenPositions / input.openPositions) * 100 : null,
    maxDrawdownCash: cashMaxDrawdown(input.startingBankroll, cashPoints),
  };
}

/** Pairs each wallet's V2 row with its V3 row, preserving the given wallet order. */
export function groupCapacityRows(
  rows: CapacityRow[],
  order: readonly { handle: string; wallet: string }[],
): CapacityWalletGroup[] {
  const groups: CapacityWalletGroup[] = order.map((m) => ({
    handle: m.handle,
    wallet: m.wallet,
    v2: null,
    v3: null,
  }));
  for (const row of rows) {
    let group = groups.find((g) => g.handle === row.handle);
    if (!group) {
      group = { handle: row.handle, wallet: row.wallet, v2: null, v3: null };
      groups.push(group);
    }
    if (row.cohort === "V2") group.v2 = row;
    else group.v3 = row;
  }
  return groups;
}
