import { describe, expect, it } from "vitest";

import {
  buildMasterPortfolio,
  walletTotals,
  type MasterCategoryKey,
  type MasterWallet,
} from "@/lib/master-portfolio";
import { V2_COHORT, v2ExperimentName } from "@/lib/v2-cohort";
import { v3ExperimentName } from "@/lib/v3-cohort";

import {
  UNAVAILABLE,
  categoryCards,
  categoryWallets,
  equityHeroView,
  formatMoneyOrUnavailable,
  formatPctOrUnavailable,
  markCoverageView,
  realizedContributions,
  shortWallet,
} from "./portfolio-view";

const cohortWallet = (index: number, overrides: Partial<MasterWallet> = {}): MasterWallet => {
  const member = V2_COHORT[index]!;
  return {
    ...walletTotals({
      experimentId: `e${index}`,
      name: v2ExperimentName(member.handle),
      label: member.handle,
      wallet: member.wallet,
      startingCapital: 380,
      cash: 300,
      openCostBasis: 60,
      realizedPnl: 10 * (index + 1),
      markedOpenValue: 70,
      openPositions: 2,
      markedPositions: 2,
      workerState: "idle",
      lagSeconds: 3,
      lastError: null,
    }),
    ...overrides,
  };
};

const portfolioOf = (wallets: MasterWallet[]) =>
  buildMasterPortfolio(
    "2026-08-17T00:00:00.000Z",
    new Map<MasterCategoryKey, MasterWallet[]>([["WEATHER", wallets]]),
  );

const fullCohort = () => portfolioOf(V2_COHORT.map((_, i) => cohortWallet(i)));

describe("null-safe formatting", () => {
  it("never renders a null metric as $0", () => {
    expect(formatMoneyOrUnavailable(null)).toBe(UNAVAILABLE);
    expect(formatMoneyOrUnavailable(undefined)).toBe(UNAVAILABLE);
    expect(formatMoneyOrUnavailable(0)).toBe("$0.00");
    expect(formatPctOrUnavailable(null)).toBe(UNAVAILABLE);
    expect(formatPctOrUnavailable(2.5)).toBe("+2.50%");
  });

  it("shortens wallets without inventing text", () => {
    expect(shortWallet(V2_COHORT[0]!.wallet)).toBe("0x8fbd…a959");
    expect(shortWallet(null)).toBe("—");
  });
});

describe("equity hero state", () => {
  it("shows pending equity plus exact realized P&L when marks are incomplete", () => {
    const portfolio = portfolioOf([
      cohortWallet(0),
      cohortWallet(1, { ...cohortWallet(1), markedOpenValue: null, equity: null, totalPnl: null }),
    ]);
    const hero = equityHeroView(portfolio);
    expect(hero.trusted).toBe(false);
    expect(hero.value).toBe(UNAVAILABLE);
    expect(hero.headline).toBe("Total equity pending complete marks");
    // Realized P&L stays exact and is never replaced by a derived total.
    expect(hero.realizedLabel).toBe("$30.00");
    expect(hero.realizedTone).toBe("positive");
  });

  it("shows equity when the model returns it", () => {
    const hero = equityHeroView(fullCohort());
    expect(hero.trusted).toBe(true);
    expect(hero.value).not.toBe(UNAVAILABLE);
  });

  it("renders an unavailable hero rather than zeros before data arrives", () => {
    const hero = equityHeroView(undefined);
    expect(hero.value).toBe(UNAVAILABLE);
    expect(hero.realizedLabel).toBe(UNAVAILABLE);
  });

  it("reports mark coverage as a ratio", () => {
    const coverage = markCoverageView(fullCohort().master);
    expect(coverage.label).toBe("10/10 marked");
    expect(coverage.complete).toBe(true);
  });
});

describe("category cards", () => {
  it("marks weather active and future sleeves as research with no allocation", () => {
    const cards = categoryCards(fullCohort());
    const weather = cards.find((c) => c.key === "WEATHER")!;
    expect(weather.status).toBe("ACTIVE");
    expect(weather.allocated).toBe(true);
    expect(weather.walletCount).toBe(5);
    expect(weather.totals?.startingCapital).toBe(1900);

    for (const key of ["CRYPTO", "MENTIONS", "WORLD_POLITICS"] as const) {
      const card = cards.find((c) => c.key === key)!;
      expect(card.status).toBe("RESEARCH");
      expect(card.allocated).toBe(false);
      // No fake zeros that could imply deployed capital.
      expect(card.totals).toBeNull();
    }
  });
});

describe("weather drilldown and contributions", () => {
  it("lists exactly the five V2 wallets, realized P&L descending", () => {
    const wallets = categoryWallets(fullCohort(), "WEATHER");
    expect(wallets).toHaveLength(5);
    expect(wallets.map((w) => w.label).sort()).toEqual(
      V2_COHORT.map((m) => m.handle).slice().sort(),
    );
    for (let i = 1; i < wallets.length; i += 1) {
      expect(wallets[i - 1]!.realizedPnl).toBeGreaterThanOrEqual(wallets[i]!.realizedPnl);
    }
  });

  it("excludes V3 capacity and candidate wallets from contributions", () => {
    const contributions = realizedContributions(fullCohort());
    expect(contributions).toHaveLength(5);
    const v3Names = V2_COHORT.map((m) => v3ExperimentName(m.handle));
    for (const c of contributions) {
      expect(v3Names).not.toContain(c.label);
      expect(c.label.startsWith("CANDIDATE")).toBe(false);
      expect(c.label.startsWith("GENERAL SHADOW")).toBe(false);
    }
    expect(contributions[0]!.barPct).toBe(100);
  });

  it("returns no contributions before the model loads", () => {
    expect(realizedContributions(undefined)).toEqual([]);
  });
});