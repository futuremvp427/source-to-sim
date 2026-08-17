/**
 * Presentation-only view model for the Master Portfolio screens.
 *
 * Nothing here computes financial truth: every number is read straight from the
 * derived master read model (`getMasterPortfolio`). The only job of this module
 * is formatting and display state, in particular the rule that a null metric
 * (incomplete marks) must NEVER be rendered as $0.
 */

import { formatUsd } from "@/lib/mirror-trader";
import {
  MASTER_CATEGORIES,
  type MasterCategoryKey,
  type MasterPortfolio,
  type MasterTotals,
  type MasterWallet,
} from "@/lib/master-portfolio";

export const UNAVAILABLE = "Unavailable";

export type Tone = "positive" | "negative" | "muted";

export function formatMoneyOrUnavailable(value: number | null | undefined): string {
  if (value === null || value === undefined) return UNAVAILABLE;
  return formatUsd(value);
}

export function formatPctOrUnavailable(value: number | null | undefined): string {
  if (value === null || value === undefined) return UNAVAILABLE;
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function pnlTone(value: number | null | undefined): Tone {
  if (value === null || value === undefined) return "muted";
  return value >= 0 ? "positive" : "negative";
}

export function shortWallet(wallet: string | null | undefined): string {
  if (!wallet) return "—";
  return wallet.length <= 12 ? wallet : `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

export function walletBadge(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9]/g, "");
  return (cleaned.slice(0, 2) || "?").toUpperCase();
}

export type MarkCoverageView = {
  label: string;
  complete: boolean;
  pctLabel: string;
};

export function markCoverageView(totals: MasterTotals | null | undefined): MarkCoverageView {
  if (!totals) return { label: UNAVAILABLE, complete: false, pctLabel: UNAVAILABLE };
  if (totals.openPositions === 0) {
    return { label: "0 open positions", complete: true, pctLabel: "—" };
  }
  const pctLabel =
    totals.markCoveragePct === null ? UNAVAILABLE : `${totals.markCoveragePct.toFixed(1)}%`;
  return {
    label: `${totals.markedPositions}/${totals.openPositions} marked`,
    complete: totals.markedPositions >= totals.openPositions,
    pctLabel,
  };
}

export type EquityHeroView = {
  /** True only when the derived model returned a non-null equity. */
  trusted: boolean;
  headline: string;
  value: string;
  /** Realized P&L is always exact and stays prominent when equity is pending. */
  realizedLabel: string;
  realizedTone: Tone;
  coverage: MarkCoverageView;
};

export function equityHeroView(portfolio: MasterPortfolio | undefined): EquityHeroView {
  const master = portfolio?.master ?? null;
  const coverage = markCoverageView(master);
  const trusted = master?.equity !== null && master?.equity !== undefined;
  return {
    trusted,
    headline: trusted ? "Simulated equity" : "Total equity pending complete marks",
    value: trusted ? formatUsd(master!.equity!) : UNAVAILABLE,
    realizedLabel: formatMoneyOrUnavailable(master?.realizedPnl),
    realizedTone: pnlTone(master?.realizedPnl ?? null),
    coverage,
  };
}

export type CategoryStatus = "ACTIVE" | "RESEARCH";

export type CategoryCardView = {
  key: MasterCategoryKey;
  label: string;
  status: CategoryStatus;
  /** False for planned sleeves: they hold no master allocation at all. */
  allocated: boolean;
  /** Null whenever the sleeve contributes nothing to master totals. */
  totals: MasterTotals | null;
  walletCount: number;
  note: string;
};

/** Sleeves shown as forward-looking research, with no master allocation yet. */
export const PLANNED_CATEGORIES: readonly { key: MasterCategoryKey; label: string }[] =
  Object.freeze([
    Object.freeze({ key: "CRYPTO" as const, label: "Crypto" }),
    Object.freeze({ key: "MENTIONS" as const, label: "Mentions" }),
    Object.freeze({ key: "WORLD_POLITICS" as const, label: "World / Politics" }),
  ]);

export function categoryCards(portfolio: MasterPortfolio | undefined): CategoryCardView[] {
  const active: CategoryCardView[] = MASTER_CATEGORIES.map((config) => {
    const category = portfolio?.categories.find((c) => c.key === config.key) ?? null;
    const walletCount = category?.wallets.length ?? config.experimentNames.length;
    return {
      key: config.key,
      label: config.label.toUpperCase(),
      status: "ACTIVE" as const,
      allocated: true,
      totals: category ? stripWallets(category) : null,
      walletCount,
      note: `${walletCount} V2 paper wallets included in master totals`,
    };
  });
  const planned: CategoryCardView[] = PLANNED_CATEGORIES.filter(
    (p) => !active.some((a) => a.key === p.key),
  ).map((p) => ({
    key: p.key,
    label: p.label.toUpperCase(),
    status: "RESEARCH" as const,
    allocated: false,
    totals: null,
    walletCount: 0,
    note: "Research only — no master allocation",
  }));
  return [...active, ...planned];
}

function stripWallets(totals: MasterTotals): MasterTotals {
  const {
    startingCapital,
    cash,
    openCostBasis,
    realizedPnl,
    markedOpenValue,
    equity,
    unrealizedPnl,
    totalPnl,
    roiPct,
    openPositions,
    markedPositions,
    markCoveragePct,
  } = totals;
  return {
    startingCapital,
    cash,
    openCostBasis,
    realizedPnl,
    markedOpenValue,
    equity,
    unrealizedPnl,
    totalPnl,
    roiPct,
    openPositions,
    markedPositions,
    markCoveragePct,
  };
}

/** Wallets of one master category, realized P&L descending. */
export function categoryWallets(
  portfolio: MasterPortfolio | undefined,
  key: MasterCategoryKey,
): MasterWallet[] {
  const category = portfolio?.categories.find((c) => c.key === key);
  return (category?.wallets ?? []).slice().sort((a, b) => b.realizedPnl - a.realizedPnl);
}

export type ContributionView = {
  experimentId: string;
  label: string;
  wallet: string;
  realizedPnl: number;
  /** Bar width relative to the largest absolute realized P&L in the set. */
  barPct: number;
  tone: Tone;
};

/**
 * Realized-P&L contributions of every master-included wallet. Realized P&L is
 * used deliberately because total equity is unavailable while marks are
 * incomplete; the bar is a relative magnitude, never a fabricated percentage.
 */
export function realizedContributions(portfolio: MasterPortfolio | undefined): ContributionView[] {
  const wallets = (portfolio?.categories ?? []).flatMap((c) => c.wallets);
  const max = wallets.reduce((m, w) => Math.max(m, Math.abs(w.realizedPnl)), 0);
  return wallets
    .slice()
    .sort((a, b) => b.realizedPnl - a.realizedPnl)
    .map((w) => ({
      experimentId: w.experimentId,
      label: w.label,
      wallet: w.wallet,
      realizedPnl: w.realizedPnl,
      barPct: max === 0 ? 0 : Math.round((Math.abs(w.realizedPnl) / max) * 100),
      tone: pnlTone(w.realizedPnl),
    }));
}

export type WorkerBadgeView = { label: string; tone: "ok" | "warn" | "bad" };

export function workerBadge(wallet: {
  workerState: string | null;
  lagSeconds: number | null;
  lastError: string | null;
}): WorkerBadgeView {
  if (wallet.lastError) return { label: "error", tone: "bad" };
  if (!wallet.workerState) return { label: "unknown", tone: "warn" };
  const lag = wallet.lagSeconds;
  const suffix = lag === null ? "" : ` · lag ${lag}s`;
  return { label: `${wallet.workerState}${suffix}`, tone: "ok" };
}