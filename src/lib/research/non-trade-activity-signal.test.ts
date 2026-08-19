import { describe, expect, it } from "vitest";

import { evaluateNonTradeActivityHypotheses } from "./non-trade-activity-signal";
import type { WalletBehaviorMetrics } from "./wallet-behavior";

function baseMetrics(over: Partial<WalletBehaviorMetrics> = {}): WalletBehaviorMetrics {
  return {
    windowDays: 30,
    eventCount: 100,
    tradesPerDay: 3.3,
    distinctMarkets: 20,
    distinctMarketsPerDay: 0.67,
    notional: { mean: 50, median: 40, p10: 5, p25: 20, p75: 80, p90: 120 },
    buyCount: 60,
    sellCount: 10,
    buySellRatio: 6,
    activityCounts: { merge: 0, split: 0, redeem: 0, other: 0 },
    pctMarketsBothOutcomesTraded: 0.1,
    medianSecondsBetweenOpposingTrades: null,
    fractionOpposingPairsWithin5Min: null,
    positionConcentrationHhi: 0.4,
    avgEntryPrice: { buy: 0.4, sell: 0.6 },
    tradeSize: { mean: 100, median: 80, p10: 20, p90: 300 },
    repeatedSmallFillFraction: 0.05,
    fractionPositionsHeldOpenThroughWindow: 0.8,
    ...over,
  };
}

describe("evaluateNonTradeActivityHypotheses", () => {
  it("returns exactly the four named hypotheses", () => {
    const results = evaluateNonTradeActivityHypotheses(baseMetrics());
    expect(results.map((r) => r.hypothesis).sort()).toEqual(
      [
        "MARKET_MAKING",
        "COMPLETING_COMPLEMENTARY_POSITIONS",
        "HOLDING_TO_SETTLEMENT",
        "MERGE_REDEEM_AS_EXIT_MECHANISM",
      ].sort(),
    );
  });

  it("MARKET_MAKING: INSUFFICIENT_EVIDENCE when activity volume is too low", () => {
    const results = evaluateNonTradeActivityHypotheses(
      baseMetrics({ activityCounts: { merge: 1, split: 0, redeem: 0, other: 0 } }),
    );
    const mm = results.find((r) => r.hypothesis === "MARKET_MAKING")!;
    expect(mm.verdict).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("MARKET_MAKING: SUPPORTS when merge/split activity co-occurs with broad, fast two-sided trading", () => {
    const results = evaluateNonTradeActivityHypotheses(
      baseMetrics({
        activityCounts: { merge: 10, split: 5, redeem: 0, other: 0 },
        pctMarketsBothOutcomesTraded: 0.8,
        fractionOpposingPairsWithin5Min: 0.9,
      }),
    );
    expect(results.find((r) => r.hypothesis === "MARKET_MAKING")!.verdict).toBe("SUPPORTS");
  });

  it("MARKET_MAKING: WEAKENS when activity is present but not paired with broad+fast two-sided trading", () => {
    const results = evaluateNonTradeActivityHypotheses(
      baseMetrics({
        activityCounts: { merge: 10, split: 0, redeem: 0, other: 0 },
        pctMarketsBothOutcomesTraded: 0.1,
        fractionOpposingPairsWithin5Min: 0.1,
      }),
    );
    expect(results.find((r) => r.hypothesis === "MARKET_MAKING")!.verdict).toBe("WEAKENS");
  });

  it("COMPLETING_COMPLEMENTARY_POSITIONS: SUPPORTS when merge/split co-occurs with both-outcomes trading", () => {
    const results = evaluateNonTradeActivityHypotheses(
      baseMetrics({
        activityCounts: { merge: 8, split: 0, redeem: 0, other: 0 },
        pctMarketsBothOutcomesTraded: 0.5,
      }),
    );
    expect(
      results.find((r) => r.hypothesis === "COMPLETING_COMPLEMENTARY_POSITIONS")!.verdict,
    ).toBe("SUPPORTS");
  });

  it("COMPLETING_COMPLEMENTARY_POSITIONS: WEAKENS when both-outcomes trading is common but merge/split never occurs", () => {
    const results = evaluateNonTradeActivityHypotheses(
      baseMetrics({
        activityCounts: { merge: 0, split: 0, redeem: 6, other: 0 }, // redeem doesn't count toward "completing", only merge/split
        pctMarketsBothOutcomesTraded: 0.6,
      }),
    );
    expect(
      results.find((r) => r.hypothesis === "COMPLETING_COMPLEMENTARY_POSITIONS")!.verdict,
    ).toBe("WEAKENS");
  });

  it("HOLDING_TO_SETTLEMENT: INSUFFICIENT_EVIDENCE when there were no net-opened positions at all", () => {
    const results = evaluateNonTradeActivityHypotheses(
      baseMetrics({ fractionPositionsHeldOpenThroughWindow: null }),
    );
    expect(results.find((r) => r.hypothesis === "HOLDING_TO_SETTLEMENT")!.verdict).toBe(
      "INSUFFICIENT_EVIDENCE",
    );
  });

  it("HOLDING_TO_SETTLEMENT: SUPPORTS when most net-opened positions are held through the window", () => {
    const results = evaluateNonTradeActivityHypotheses(
      baseMetrics({ fractionPositionsHeldOpenThroughWindow: 0.9 }),
    );
    expect(results.find((r) => r.hypothesis === "HOLDING_TO_SETTLEMENT")!.verdict).toBe("SUPPORTS");
  });

  it("HOLDING_TO_SETTLEMENT: WEAKENS when most positions are actively reduced", () => {
    const results = evaluateNonTradeActivityHypotheses(
      baseMetrics({ fractionPositionsHeldOpenThroughWindow: 0.1 }),
    );
    expect(results.find((r) => r.hypothesis === "HOLDING_TO_SETTLEMENT")!.verdict).toBe("WEAKENS");
  });

  it("MERGE_REDEEM_AS_EXIT_MECHANISM: SUPPORTS when merge+redeem volume matches or exceeds SELL volume", () => {
    const results = evaluateNonTradeActivityHypotheses(
      baseMetrics({ sellCount: 5, activityCounts: { merge: 8, split: 0, redeem: 2, other: 0 } }),
    );
    const r = results.find((r) => r.hypothesis === "MERGE_REDEEM_AS_EXIT_MECHANISM")!;
    expect(r.verdict).toBe("SUPPORTS");
    expect(r.evidence[0]).toMatch(/Phase 0A/);
  });

  it("MERGE_REDEEM_AS_EXIT_MECHANISM: WEAKENS when SELL dominates over merge/redeem", () => {
    const results = evaluateNonTradeActivityHypotheses(
      baseMetrics({ sellCount: 50, activityCounts: { merge: 1, split: 0, redeem: 0, other: 0 } }),
    );
    expect(results.find((r) => r.hypothesis === "MERGE_REDEEM_AS_EXIT_MECHANISM")!.verdict).toBe(
      "WEAKENS",
    );
  });

  it("MERGE_REDEEM_AS_EXIT_MECHANISM: INSUFFICIENT_EVIDENCE when there is no exit activity of any kind", () => {
    const results = evaluateNonTradeActivityHypotheses(
      baseMetrics({ sellCount: 0, activityCounts: { merge: 0, split: 0, redeem: 0, other: 0 } }),
    );
    expect(results.find((r) => r.hypothesis === "MERGE_REDEEM_AS_EXIT_MECHANISM")!.verdict).toBe(
      "INSUFFICIENT_EVIDENCE",
    );
  });

  it("every result carries at least one evidence string", () => {
    const results = evaluateNonTradeActivityHypotheses(baseMetrics());
    for (const r of results) {
      expect(r.evidence.length).toBeGreaterThan(0);
      expect(r.evidence[0]!.length).toBeGreaterThan(0);
    }
  });
});
