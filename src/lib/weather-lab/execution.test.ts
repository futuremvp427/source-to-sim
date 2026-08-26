import { describe, expect, it } from "vitest";
import {
  noAskLadderFromYesBids,
  simulateAllScenarios,
  simulateFill,
  yesAskLadderFromNoBids,
  type LadderLevel,
} from "./execution";
import type { FeeSchedule } from "./fees";

const SCHEDULE: FeeSchedule = { feeType: "quadratic", feeMultiplier: 1 };
const LADDER: LadderLevel[] = [
  { price: 0.08, size: 25 },
  { price: 0.09, size: 50 },
  { price: 0.12, size: 200 },
];

const base = {
  ladder: LADDER,
  schedule: SCHEDULE,
  maxPriceUsd: 1,
  scenario: "BASE" as const,
};

describe("simulateFill", () => {
  it("fills entirely at the best level when depth suffices", () => {
    const r = simulateFill({ ...base, contracts: 10 });
    expect(r.status).toBe("FILLED");
    expect(r.filledContracts).toBe(10);
    expect(r.averagePriceUsd).toBeCloseTo(0.08, 6);
    expect(r.levelsConsumed).toBe(1);
  });

  it("walks deeper levels and pays a worse average than the best quote", () => {
    const r = simulateFill({ ...base, contracts: 60 });
    expect(r.status).toBe("FILLED");
    // 25@0.08 + 35@0.09 = 2.00 + 3.15 = 5.15 over 60
    expect(r.averagePriceUsd).toBeCloseTo(5.15 / 60, 6);
    expect(r.averagePriceUsd!).toBeGreaterThan(0.08);
    expect(r.levelsConsumed).toBe(2);
  });

  it("charges fees on top of premium", () => {
    const r = simulateFill({ ...base, contracts: 10 });
    expect(r.feeUsd).toBeGreaterThan(0);
    expect(r.allInCostUsd).toBeCloseTo(r.notionalUsd + r.feeUsd, 6);
  });

  it("returns NO_FILL on an empty book", () => {
    const r = simulateFill({ ...base, ladder: [], contracts: 10 });
    expect(r.status).toBe("NO_FILL");
    expect(r.reason).toBe("EMPTY_BOOK");
    expect(r.filledContracts).toBe(0);
  });

  it("returns NO_FILL rather than a partial trade when depth is short", () => {
    const r = simulateFill({ ...base, contracts: 10_000 });
    expect(r.status).toBe("NO_FILL");
    expect(r.reason).toBe("INSUFFICIENT_DEPTH");
  });

  it("reports PARTIAL only when the caller explicitly allows it", () => {
    const r = simulateFill({ ...base, contracts: 10_000, allowPartial: true });
    expect(r.status).toBe("PARTIAL");
    expect(r.filledContracts).toBe(275);
  });

  it("stops at the price limit instead of paying through it", () => {
    const r = simulateFill({ ...base, contracts: 60, maxPriceUsd: 0.08 });
    expect(r.status).toBe("NO_FILL");
    expect(r.reason).toBe("PRICE_LIMIT_EXCEEDED");
  });

  it("refuses a stale quote", () => {
    const r = simulateFill({ ...base, contracts: 10, quoteStale: true });
    expect(r.reason).toBe("QUOTE_STALE");
  });

  it("refuses a closed market", () => {
    expect(simulateFill({ ...base, contracts: 10, marketClosed: true }).reason).toBe("MARKET_CLOSED");
  });

  it("refuses when the collector was rate limited and the book may be behind", () => {
    expect(simulateFill({ ...base, contracts: 10, rateLimited: true }).reason).toBe("RATE_LIMITED");
  });

  it("respects a per-market notional cap", () => {
    const r = simulateFill({ ...base, contracts: 200, maxNotionalUsd: 1, allowPartial: true });
    expect(r.notionalUsd).toBeLessThanOrEqual(1);
    expect(r.filledContracts).toBeGreaterThan(0);
  });

  it("rejects a non-positive requested size", () => {
    expect(() => simulateFill({ ...base, contracts: 0 })).toThrow(RangeError);
  });

  it("never reports a fill price above $1 even under adverse shift", () => {
    const r = simulateFill({
      ...base,
      ladder: [{ price: 0.99, size: 100 }],
      contracts: 10,
      scenario: "PLUS_3C",
    });
    expect(r.averagePriceUsd).toBeLessThanOrEqual(1);
  });
});

describe("adverse scenarios", () => {
  it("makes every scenario at least as expensive as BASE", () => {
    const all = simulateAllScenarios({ ...base, contracts: 10 });
    const prices = (["BASE", "PLUS_1C", "PLUS_2C", "PLUS_3C"] as const).map(
      (s) => all[s].averagePriceUsd ?? Number.POSITIVE_INFINITY,
    );
    for (let i = 1; i < prices.length; i++) expect(prices[i]!).toBeGreaterThan(prices[i - 1]!);
  });

  it("shifts by exactly the scenario amount at a single level", () => {
    const all = simulateAllScenarios({ ...base, contracts: 10 });
    expect(all.PLUS_2C.averagePriceUsd).toBeCloseTo(0.1, 6);
  });

  it("returns a result for every scenario", () => {
    const all = simulateAllScenarios({ ...base, contracts: 10 });
    expect(Object.keys(all).sort()).toEqual(["BASE", "PLUS_1C", "PLUS_2C", "PLUS_3C"]);
  });
});

describe("ladder conversion", () => {
  it("mirrors YES bids into the NO ask ladder", () => {
    // A YES bid at 0.05 is a NO ask at 0.95 for the same size.
    const ladder = noAskLadderFromYesBids([
      ["0.0100", "725.76"],
      ["0.0500", "25.00"],
    ]);
    expect(ladder[0]).toEqual({ price: 0.95, size: 25 });
    expect(ladder[1]?.price).toBeCloseTo(0.99, 6);
  });

  it("mirrors NO bids into the YES ask ladder", () => {
    const ladder = yesAskLadderFromNoBids([["0.9300", "14.00"]]);
    expect(ladder[0]?.price).toBeCloseTo(0.07, 6);
  });

  it("drops zero-size and malformed levels", () => {
    const ladder = noAskLadderFromYesBids([
      ["0.05", "0"],
      ["nonsense", "10"],
      ["0.10", "5"],
    ]);
    expect(ladder).toHaveLength(1);
    expect(ladder[0]?.size).toBe(5);
  });
});
