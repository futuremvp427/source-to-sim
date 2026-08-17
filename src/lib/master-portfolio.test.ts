import { describe, expect, it } from "vitest";

import {
  MASTER_CATEGORIES,
  aggregateTotals,
  buildMasterPortfolio,
  isIncludedInMaster,
  masterCategoryForExperiment,
  walletTotals,
  type MasterCategoryKey,
  type MasterWallet,
} from "./master-portfolio";
import { V2_COHORT, v2ExperimentName } from "./v2-cohort";
import { v3ExperimentName } from "./v3-cohort";

const wallet = (overrides: Partial<Parameters<typeof walletTotals>[0]> = {}): MasterWallet =>
  walletTotals({
    experimentId: "e1",
    name: v2ExperimentName("Poligarch"),
    label: "Poligarch",
    wallet: "0xabc",
    startingCapital: 380,
    cash: 300,
    openCostBasis: 60,
    realizedPnl: 10,
    markedOpenValue: 70,
    openPositions: 2,
    markedPositions: 2,
    workerState: "idle",
    lagSeconds: 4,
    lastError: null,
    ...overrides,
  });

describe("master portfolio inclusion", () => {
  it("includes exactly the five V2 weather experiments", () => {
    const weather = MASTER_CATEGORIES.find((c) => c.key === "WEATHER")!;
    expect(weather.experimentNames).toHaveLength(5);
    for (const member of V2_COHORT) {
      expect(isIncludedInMaster(v2ExperimentName(member.handle))).toBe(true);
      expect(masterCategoryForExperiment(v2ExperimentName(member.handle))).toBe("WEATHER");
    }
  });

  it("excludes V3 capacity, candidates, general shadow and frozen V1", () => {
    for (const member of V2_COHORT) {
      expect(isIncludedInMaster(v3ExperimentName(member.handle))).toBe(false);
    }
    expect(isIncludedInMaster("SHADOW")).toBe(false);
    expect(isIncludedInMaster("SHADOW:Poligarch")).toBe(false);
    expect(isIncludedInMaster("CANDIDATE: opopv.")).toBe(false);
    expect(isIncludedInMaster("GENERAL SHADOW: RN1")).toBe(false);
  });

  it("never double-counts the same wallet across V2 and V3", () => {
    const names = new Set(MASTER_CATEGORIES.flatMap((c) => c.experimentNames));
    expect(names.size).toBe(5);
  });
});

describe("master portfolio reconciliation", () => {
  it("category sums equal master and wallet sums equal category", () => {
    const wallets = [wallet(), wallet({ experimentId: "e2", label: "gghff", cash: 200, realizedPnl: -5 })];
    const portfolio = buildMasterPortfolio(
      "2026-08-17T00:00:00.000Z",
      new Map<MasterCategoryKey, MasterWallet[]>([["WEATHER", wallets]]),
    );
    expect(portfolio.reconciliation.ok).toBe(true);
    expect(portfolio.master.startingCapital).toBe(760);
    expect(portfolio.master.cash).toBe(500);
    expect(portfolio.master.realizedPnl).toBe(5);
    expect(portfolio.master.openCostBasis).toBe(120);
    expect(portfolio.categories[0]!.wallets).toHaveLength(2);
    expect(portfolio.categories[0]!.cash).toBe(portfolio.master.cash);
    for (const check of portfolio.reconciliation.checks) {
      expect(check.master).toBeCloseTo(check.sumOfParts, 2);
    }
  });

  it("marks equity/unrealized/total P&L Unavailable instead of zero when a mark is missing", () => {
    const unmarked = wallet({ markedPositions: 1, openPositions: 2 });
    expect(unmarked.markedOpenValue).toBeNull();
    expect(unmarked.equity).toBeNull();
    expect(unmarked.unrealizedPnl).toBeNull();
    expect(unmarked.totalPnl).toBeNull();
    expect(unmarked.roiPct).toBeNull();
    expect(unmarked.markCoveragePct).toBe(50);

    const portfolio = buildMasterPortfolio(
      "2026-08-17T00:00:00.000Z",
      new Map<MasterCategoryKey, MasterWallet[]>([["WEATHER", [wallet(), unmarked]]]),
    );
    expect(portfolio.master.equity).toBeNull();
    expect(portfolio.master.totalPnl).toBeNull();
    expect(portfolio.reconciliation.unavailableMetrics).toContain("equity");
    // Cash/realized/starting stay exact even while equity is unavailable.
    expect(portfolio.reconciliation.ok).toBe(true);
  });

  it("aggregating fully marked sleeves derives equity and ROI", () => {
    const totals = aggregateTotals([wallet(), wallet({ experimentId: "e2" })]);
    expect(totals.markedOpenValue).toBe(140);
    expect(totals.equity).toBe(740);
    expect(totals.unrealizedPnl).toBe(20);
    expect(totals.totalPnl).toBe(-20);
    expect(totals.roiPct).toBeCloseTo(-2.63, 2);
  });
});