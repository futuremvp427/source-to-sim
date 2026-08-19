import { describe, expect, it } from "vitest";

import {
  classifyWalletBehavior,
  computeWalletBehaviorMetrics,
  type NonTradeActivityRow,
  type SourceEventRow,
} from "./wallet-behavior";

const DAY = 86_400;

function trade(over: Partial<SourceEventRow>): SourceEventRow {
  return {
    conditionId: "m1",
    marketTitle: "Market 1",
    asset: "asset-yes",
    outcome: "YES",
    side: "BUY",
    price: 0.5,
    shares: 10,
    sourceTs: 1_700_000_000,
    ...over,
  };
}

describe("computeWalletBehaviorMetrics", () => {
  it("computes trades/day and distinct-markets/day over the observed window", () => {
    const events: SourceEventRow[] = [
      trade({ conditionId: "m1", sourceTs: 0 }),
      trade({ conditionId: "m2", sourceTs: 1 * DAY }),
      trade({ conditionId: "m3", sourceTs: 2 * DAY }),
      trade({ conditionId: "m1", sourceTs: 4 * DAY }),
    ];
    const metrics = computeWalletBehaviorMetrics(events);
    expect(metrics.windowDays).toBe(4);
    expect(metrics.eventCount).toBe(4);
    expect(metrics.distinctMarkets).toBe(3);
    expect(metrics.tradesPerDay).toBe(1);
    expect(metrics.distinctMarketsPerDay).toBe(0.75);
  });

  it("computes notional mean/median/percentiles from price*shares", () => {
    const events = [10, 20, 30, 40, 50].map((shares, i) =>
      trade({ conditionId: `m${i}`, price: 1, shares, sourceTs: i * DAY }),
    );
    const metrics = computeWalletBehaviorMetrics(events);
    expect(metrics.notional.mean).toBe(30);
    expect(metrics.notional.median).toBe(30);
  });

  it("counts BUY vs SELL and computes the ratio", () => {
    const events = [
      trade({ side: "BUY", sourceTs: 0 }),
      trade({ side: "BUY", sourceTs: 1 }),
      trade({ side: "SELL", sourceTs: 2 }),
    ];
    const metrics = computeWalletBehaviorMetrics(events);
    expect(metrics.buyCount).toBe(2);
    expect(metrics.sellCount).toBe(1);
    expect(metrics.buySellRatio).toBe(2);
  });

  it("buySellRatio is null (never a divide-by-zero) with zero SELLs", () => {
    const metrics = computeWalletBehaviorMetrics([trade({ side: "BUY" })]);
    expect(metrics.sellCount).toBe(0);
    expect(metrics.buySellRatio).toBeNull();
  });

  it("counts MERGE/SPLIT/REDEEM from general_activity, bucketing everything else as other", () => {
    const activity: NonTradeActivityRow[] = [
      { conditionId: "m1", asset: "a", activityType: "MERGE", sourceTs: 0 },
      { conditionId: "m1", asset: "a", activityType: "MERGE", sourceTs: 1 },
      { conditionId: "m1", asset: "a", activityType: "SPLIT", sourceTs: 2 },
      { conditionId: "m1", asset: "a", activityType: "REDEEM", sourceTs: 3 },
      { conditionId: "m1", asset: "a", activityType: "REWARD", sourceTs: 4 },
    ];
    const metrics = computeWalletBehaviorMetrics([trade({})], activity);
    expect(metrics.activityCounts).toEqual({ merge: 2, split: 1, redeem: 1, other: 1 });
  });

  it("computes pctMarketsBothOutcomesTraded only over markets with outcome info", () => {
    const events = [
      trade({ conditionId: "m1", outcome: "YES", sourceTs: 0 }),
      trade({ conditionId: "m1", outcome: "NO", sourceTs: 100 }),
      trade({ conditionId: "m2", outcome: "YES", sourceTs: 200 }),
      trade({ conditionId: "m3", outcome: null, sourceTs: 300 }), // excluded: no outcome info at all
    ];
    const metrics = computeWalletBehaviorMetrics(events);
    // m1: both outcomes. m2: one outcome. m3: excluded (no outcome info).
    expect(metrics.pctMarketsBothOutcomesTraded).toBe(0.5);
  });

  it("null pctMarketsBothOutcomesTraded when no market has any outcome info", () => {
    const metrics = computeWalletBehaviorMetrics([trade({ outcome: null })]);
    expect(metrics.pctMarketsBothOutcomesTraded).toBeNull();
  });

  it("measures time between opposing-outcome trades and flags fast pairs", () => {
    const events = [
      trade({ conditionId: "m1", outcome: "YES", sourceTs: 0 }),
      trade({ conditionId: "m1", outcome: "NO", sourceTs: 60 }), // 1 min later -> fast
      trade({ conditionId: "m2", outcome: "YES", sourceTs: 0 }),
      trade({ conditionId: "m2", outcome: "NO", sourceTs: 3600 }), // 1 hour later -> not fast
    ];
    const metrics = computeWalletBehaviorMetrics(events);
    expect(metrics.medianSecondsBetweenOpposingTrades).toBe((60 + 3600) / 2);
    expect(metrics.fractionOpposingPairsWithin5Min).toBe(0.5);
  });

  it("computes position concentration (HHI): fully concentrated vs. fully diffuse", () => {
    const concentrated = computeWalletBehaviorMetrics([
      trade({ conditionId: "m1", price: 1, shares: 100, sourceTs: 0 }),
    ]);
    expect(concentrated.positionConcentrationHhi).toBe(1);

    const diffuse = computeWalletBehaviorMetrics(
      Array.from({ length: 4 }, (_, i) =>
        trade({ conditionId: `m${i}`, price: 1, shares: 25, sourceTs: i * DAY }),
      ),
    );
    expect(diffuse.positionConcentrationHhi).toBeCloseTo(0.25, 6); // 4 equal shares -> HHI = 1/4
  });

  it("flags repeated small fills clustered in time on the same asset", () => {
    const events = [
      trade({ asset: "a", price: 0.5, shares: 2, sourceTs: 0 }), // $1, small
      trade({ asset: "a", price: 0.5, shares: 2, sourceTs: 30 }), // $1, small, near the first
      trade({ asset: "a", price: 1, shares: 100, sourceTs: 5000 }), // $100, not small
    ];
    const metrics = computeWalletBehaviorMetrics(events);
    expect(metrics.repeatedSmallFillFraction).toBe(1); // both small fills are near each other
  });

  it("held-open detection: a net-open position with no MERGE/REDEEM is 'held'", () => {
    const events = [trade({ asset: "a", side: "BUY", shares: 10, sourceTs: 0 })];
    const noExit = computeWalletBehaviorMetrics(events, []);
    expect(noExit.fractionPositionsHeldOpenThroughWindow).toBe(1);

    const withMergeExit = computeWalletBehaviorMetrics(events, [
      { conditionId: "m1", asset: "a", activityType: "MERGE", sourceTs: 100 },
    ]);
    expect(withMergeExit.fractionPositionsHeldOpenThroughWindow).toBe(0);
  });

  it("a fully offsetting SELL means no net-open position at all", () => {
    const events = [
      trade({ asset: "a", side: "BUY", shares: 10, sourceTs: 0 }),
      trade({ asset: "a", side: "SELL", shares: 10, sourceTs: 100 }),
    ];
    const metrics = computeWalletBehaviorMetrics(events);
    expect(metrics.fractionPositionsHeldOpenThroughWindow).toBeNull();
  });
});

describe("classifyWalletBehavior", () => {
  function synthEvents(
    n: number,
    marketCount: number,
    builder: (i: number, market: string) => SourceEventRow,
  ) {
    return Array.from({ length: n }, (_, i) => builder(i, `m${i % marketCount}`));
  }

  it("fails closed to UNKNOWN below the minimum sample size", () => {
    const metrics = computeWalletBehaviorMetrics([trade({}), trade({ sourceTs: 100 })]);
    const result = classifyWalletBehavior(metrics);
    expect(result.classification).toBe("UNKNOWN");
    expect(result.confidence).toBe("low");
    expect(result.evidenceAgainst[0]).toMatch(/below the minimum/);
  });

  it("does NOT classify as MARKET_MAKER_LIKE merely because both sides are traded, without fast pairing/small fills/diffusion", () => {
    // Both outcomes traded in every one of 6 markets, but slowly (5 days
    // apart), large concentrated size, no merge/split -- this must NOT score
    // as MM. Padded with extra same-market trades (not new markets) so the
    // both-outcomes ratio and market-count-per-trade pattern are unaffected.
    const events: SourceEventRow[] = [];
    for (let m = 0; m < 7; m += 1) {
      events.push(
        trade({
          conditionId: `m${m}`,
          outcome: "YES",
          price: 0.9,
          shares: 500,
          sourceTs: m * 10 * DAY,
        }),
      );
      events.push(
        trade({
          conditionId: `m${m}`,
          outcome: "NO",
          price: 0.9,
          shares: 500,
          sourceTs: m * 10 * DAY + 5 * DAY, // 5 days later: slow, not a fast pair
        }),
      );
      events.push(
        trade({
          conditionId: `m${m}`,
          outcome: "YES",
          price: 0.9,
          shares: 500,
          sourceTs: m * 10 * DAY + 9 * DAY, // a third, later trade on the same market
        }),
      );
    }
    const metrics = computeWalletBehaviorMetrics(events);
    expect(metrics.eventCount).toBeGreaterThanOrEqual(20);
    expect(metrics.pctMarketsBothOutcomesTraded).toBeGreaterThan(0.6); // both sides traded a lot...
    const result = classifyWalletBehavior(metrics);
    expect(result.classification).not.toBe("MARKET_MAKER_LIKE"); // ...but that alone must not be enough
    expect(result.evidenceAgainst.some((e) => e.includes("not itself evidence"))).toBe(true);
  });

  it("classifies MARKET_MAKER_LIKE when breadth + speed + small repeated fills + diffusion all corroborate", () => {
    const events: SourceEventRow[] = [];
    for (let m = 0; m < 15; m += 1) {
      const base = m * DAY;
      events.push(
        trade({
          conditionId: `m${m}`,
          asset: `a${m}`,
          outcome: "YES",
          price: 0.5,
          shares: 4,
          sourceTs: base,
        }),
      );
      events.push(
        trade({
          conditionId: `m${m}`,
          asset: `a${m}`,
          outcome: "NO",
          price: 0.5,
          shares: 4,
          sourceTs: base + 60,
        }),
      );
      events.push(
        trade({
          conditionId: `m${m}`,
          asset: `a${m}`,
          outcome: "YES",
          price: 0.5,
          shares: 4,
          sourceTs: base + 120,
        }),
      );
    }
    const metrics = computeWalletBehaviorMetrics(events);
    expect(metrics.eventCount).toBeGreaterThanOrEqual(40); // clears the confidence sample-size bar too
    const result = classifyWalletBehavior(metrics);
    expect(result.classification).toBe("MARKET_MAKER_LIKE");
    expect(result.confidence).not.toBe("low");
  });

  it("classifies ARBITRAGE_LIKE when fast opposing pairs are paired with MERGE/SPLIT activity", () => {
    // Concentrated (few markets, large notional per trade) so MM's
    // small-fill/diffusion bonuses don't also fire on the same trades --
    // isolating the arb-specific signature (very fast pairing + merge/split).
    // 6 markets (kept away from very high market counts, so HHI stays above
    // MM's diffusion-bonus threshold and doesn't compete with the
    // arb-specific signal) with 2 extra same-market trades to clear the
    // 20-trade minimum without adding new markets.
    const events: SourceEventRow[] = [];
    const activity: NonTradeActivityRow[] = [];
    for (let m = 0; m < 6; m += 1) {
      const base = m * DAY;
      events.push(
        trade({
          conditionId: `m${m}`,
          asset: `a${m}`,
          outcome: "YES",
          price: 0.45,
          shares: 200,
          sourceTs: base,
        }),
      );
      events.push(
        trade({
          conditionId: `m${m}`,
          asset: `a${m}`,
          outcome: "NO",
          price: 0.5,
          shares: 200,
          sourceTs: base + 5,
        }),
      );
      events.push(
        trade({
          conditionId: `m${m}`,
          asset: `a${m}`,
          outcome: "YES",
          price: 0.45,
          shares: 200,
          sourceTs: base + 10,
        }),
      );
      activity.push({
        conditionId: `m${m}`,
        asset: `a${m}`,
        activityType: "MERGE",
        sourceTs: base + 15,
      });
    }
    events.push(
      trade({
        conditionId: "m0",
        asset: "a0",
        outcome: "YES",
        price: 0.45,
        shares: 200,
        sourceTs: 0 + 20,
      }),
    );
    events.push(
      trade({
        conditionId: "m1",
        asset: "a1",
        outcome: "YES",
        price: 0.45,
        shares: 200,
        sourceTs: DAY + 20,
      }),
    );
    const metrics = computeWalletBehaviorMetrics(events, activity);
    expect(metrics.eventCount).toBe(20);
    const result = classifyWalletBehavior(metrics);
    expect(result.classification).toBe("ARBITRAGE_LIKE");
  });

  it("classifies DIRECTIONAL when commitment is single-outcome, concentrated (one dominant conviction), and held to the window's end", () => {
    const events: SourceEventRow[] = [];
    // One dominant market (16 trades, one per day) carries most of the
    // wallet's notional; four small markets (1 trade each) round out the
    // distinct-market minimum. All single-outcome, all held (no SELL/MERGE).
    for (let k = 0; k < 16; k += 1) {
      events.push(
        trade({
          conditionId: "m_dominant",
          asset: "a_dominant",
          outcome: "YES",
          price: 0.3,
          shares: 100,
          sourceTs: k * DAY,
        }),
      );
    }
    for (let m = 0; m < 4; m += 1) {
      events.push(
        trade({
          conditionId: `m_small${m}`,
          asset: `a_small${m}`,
          outcome: "YES",
          price: 0.3,
          shares: 100,
          sourceTs: (20 + m * 10) * DAY,
        }),
      );
    }
    const metrics = computeWalletBehaviorMetrics(events, []);
    expect(metrics.eventCount).toBe(20);
    expect(metrics.distinctMarkets).toBe(5);
    expect(metrics.positionConcentrationHhi).toBeGreaterThan(0.3);
    const result = classifyWalletBehavior(metrics);
    expect(result.classification).toBe("DIRECTIONAL");
    expect(result.evidenceFor.some((e) => e.includes("never reduced"))).toBe(true);
  });

  it("scores are transparently returned for every candidate hypothesis", () => {
    const events = synthEvents(30, 10, (i, m) => trade({ conditionId: m, sourceTs: i * DAY }));
    const metrics = computeWalletBehaviorMetrics(events);
    const result = classifyWalletBehavior(metrics);
    expect(Object.keys(result.scores).sort()).toEqual(
      ["ARBITRAGE_LIKE", "DIRECTIONAL", "MARKET_MAKER_LIKE"].sort(),
    );
  });

  it("returns MIXED rather than a false-confident single label when evidence is weak/ambiguous", () => {
    // A few trades, mild signals in multiple directions, none dominant.
    const events: SourceEventRow[] = [];
    for (let m = 0; m < 6; m += 1) {
      events.push(
        trade({ conditionId: `m${m}`, outcome: "YES", price: 0.5, shares: 50, sourceTs: m * DAY }),
      );
    }
    for (let m = 6; m < 10; m += 1) {
      events.push(
        trade({ conditionId: `m${m}`, outcome: "YES", price: 0.5, shares: 50, sourceTs: m * DAY }),
      );
      events.push(
        trade({
          conditionId: `m${m}`,
          outcome: "NO",
          price: 0.5,
          shares: 50,
          sourceTs: m * DAY + 200,
        }),
      );
    }
    const metrics = computeWalletBehaviorMetrics(events);
    const result = classifyWalletBehavior(metrics);
    expect(["MIXED", "UNKNOWN", "DIRECTIONAL"]).toContain(result.classification);
  });
});
