/**
 * Master Portfolio read model (PAPER SIMULATION / DERIVED).
 *
 * Pure aggregation only: no shared cash account exists and nothing here mutates
 * an experiment. The master layer is a presentation rollup over independent
 * underlying experiments.
 *
 * Inclusion is deliberately explicit rather than discovered:
 *  - WEATHER  = the five V2 fair-comparison experiments.
 *  - V3 CAPACITY follows the SAME wallets, so including it would double-count.
 *  - CANDIDATE / GENERAL SHADOW / frozen V1 experiments are excluded.
 */

import { V2_COHORT, v2ExperimentName } from "./v2-cohort";

/** Future sleeves plug in here; no discovery or category tables in this phase. */
export type MasterCategoryKey = "WEATHER" | "CRYPTO" | "MENTIONS" | "WORLD_POLITICS";

export type MasterCategoryConfig = {
  key: MasterCategoryKey;
  label: string;
  /** Exact experiment names included in master totals for this category. */
  experimentNames: readonly string[];
};

export const MASTER_CATEGORIES: readonly MasterCategoryConfig[] = Object.freeze([
  Object.freeze({
    key: "WEATHER" as const,
    label: "Weather",
    experimentNames: Object.freeze(V2_COHORT.map((m) => v2ExperimentName(m.handle))),
  }),
]);

/** Category a given experiment contributes to, or null when it is excluded. */
export function masterCategoryForExperiment(name: string): MasterCategoryKey | null {
  for (const category of MASTER_CATEGORIES) {
    if (category.experimentNames.includes(name)) return category.key;
  }
  return null;
}

export function isIncludedInMaster(name: string): boolean {
  return masterCategoryForExperiment(name) !== null;
}

export type MasterTotals = {
  startingCapital: number;
  cash: number;
  openCostBasis: number;
  realizedPnl: number;
  /** Null when any included open position lacks a fresh mark (fail closed). */
  markedOpenValue: number | null;
  equity: number | null;
  unrealizedPnl: number | null;
  totalPnl: number | null;
  roiPct: number | null;
  openPositions: number;
  markedPositions: number;
  markCoveragePct: number | null;
};

export type MasterWalletInput = {
  experimentId: string;
  name: string;
  label: string;
  wallet: string;
  startingCapital: number;
  cash: number;
  openCostBasis: number;
  realizedPnl: number;
  markedOpenValue: number | null;
  openPositions: number;
  markedPositions: number;
  workerState: string | null;
  lagSeconds: number | null;
  lastError: string | null;
};

export type MasterWallet = MasterTotals & {
  experimentId: string;
  name: string;
  label: string;
  wallet: string;
  workerState: string | null;
  lagSeconds: number | null;
  lastError: string | null;
};

export type MasterCategory = MasterTotals & {
  key: MasterCategoryKey;
  label: string;
  wallets: MasterWallet[];
};

export type ReconciliationCheck = {
  metric: string;
  master: number;
  sumOfParts: number;
  ok: boolean;
};

export type MasterPortfolio = {
  generatedAt: string;
  master: MasterTotals;
  categories: MasterCategory[];
  reconciliation: {
    ok: boolean;
    checks: ReconciliationCheck[];
    /** Metrics that are Unavailable because open-position marks are incomplete. */
    unavailableMetrics: string[];
  };
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function derive(base: {
  startingCapital: number;
  cash: number;
  openCostBasis: number;
  realizedPnl: number;
  markedOpenValue: number | null;
  openPositions: number;
  markedPositions: number;
}): MasterTotals {
  const markedOpenValue = base.markedOpenValue === null ? null : round2(base.markedOpenValue);
  const equity = markedOpenValue === null ? null : round2(base.cash + markedOpenValue);
  const unrealizedPnl = markedOpenValue === null ? null : round2(markedOpenValue - base.openCostBasis);
  const totalPnl = equity === null ? null : round2(equity - base.startingCapital);
  return {
    startingCapital: round2(base.startingCapital),
    cash: round2(base.cash),
    openCostBasis: round2(base.openCostBasis),
    realizedPnl: round2(base.realizedPnl),
    markedOpenValue,
    equity,
    unrealizedPnl,
    totalPnl,
    roiPct:
      totalPnl === null || base.startingCapital <= 0
        ? null
        : Math.round((totalPnl / base.startingCapital) * 10000) / 100,
    openPositions: base.openPositions,
    markedPositions: base.markedPositions,
    markCoveragePct:
      base.openPositions === 0
        ? null
        : Math.round((base.markedPositions / base.openPositions) * 1000) / 10,
  };
}

export function walletTotals(input: MasterWalletInput): MasterWallet {
  // Fail closed: a wallet with unmarked open positions has no trustworthy equity.
  const markedOpenValue =
    input.openPositions > 0 && input.markedPositions < input.openPositions ? null : input.markedOpenValue;
  return {
    ...derive({ ...input, markedOpenValue }),
    experimentId: input.experimentId,
    name: input.name,
    label: input.label,
    wallet: input.wallet,
    workerState: input.workerState,
    lagSeconds: input.lagSeconds,
    lastError: input.lastError,
  };
}

/** Sums parts; any missing mark propagates as Unavailable, never as a zero. */
export function aggregateTotals(parts: MasterTotals[]): MasterTotals {
  const anyUnmarked = parts.some((p) => p.markedOpenValue === null);
  return derive({
    startingCapital: parts.reduce((s, p) => s + p.startingCapital, 0),
    cash: parts.reduce((s, p) => s + p.cash, 0),
    openCostBasis: parts.reduce((s, p) => s + p.openCostBasis, 0),
    realizedPnl: parts.reduce((s, p) => s + p.realizedPnl, 0),
    markedOpenValue: anyUnmarked ? null : parts.reduce((s, p) => s + (p.markedOpenValue ?? 0), 0),
    openPositions: parts.reduce((s, p) => s + p.openPositions, 0),
    markedPositions: parts.reduce((s, p) => s + p.markedPositions, 0),
  });
}

function checks(master: MasterTotals, parts: MasterTotals[]): ReconciliationCheck[] {
  const sum = (pick: (t: MasterTotals) => number) => round2(parts.reduce((s, p) => s + pick(p), 0));
  const entries: [string, (t: MasterTotals) => number][] = [
    ["startingCapital", (t) => t.startingCapital],
    ["cash", (t) => t.cash],
    ["openCostBasis", (t) => t.openCostBasis],
    ["realizedPnl", (t) => t.realizedPnl],
    ["openPositions", (t) => t.openPositions],
    ["markedPositions", (t) => t.markedPositions],
  ];
  return entries.map(([metric, pick]) => {
    const sumOfParts = sum(pick);
    const value = round2(pick(master));
    return { metric, master: value, sumOfParts, ok: Math.abs(value - sumOfParts) < 0.01 };
  });
}

export function buildMasterPortfolio(
  generatedAt: string,
  walletsByCategory: Map<MasterCategoryKey, MasterWallet[]>,
): MasterPortfolio {
  const categories: MasterCategory[] = MASTER_CATEGORIES.map((config) => {
    const wallets = (walletsByCategory.get(config.key) ?? []).slice().sort((a, b) =>
      a.label.localeCompare(b.label),
    );
    return {
      ...aggregateTotals(wallets),
      key: config.key,
      label: config.label,
      wallets,
    };
  });
  const master = aggregateTotals(categories);

  const categoryChecks = checks(master, categories).map((c) => ({
    ...c,
    metric: `master.${c.metric}`,
  }));
  const walletChecks = categories.flatMap((category) =>
    checks(category, category.wallets).map((c) => ({ ...c, metric: `${category.key}.${c.metric}` })),
  );
  const all = [...categoryChecks, ...walletChecks];
  const unavailableMetrics =
    master.markedOpenValue === null ? ["markedOpenValue", "equity", "unrealizedPnl", "totalPnl", "roiPct"] : [];

  return {
    generatedAt,
    master,
    categories,
    reconciliation: { ok: all.every((c) => c.ok), checks: all, unavailableMetrics },
  };
}
