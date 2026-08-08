import { describe, expect, it } from "vitest";

import {
  capacityScore,
  composite,
  computeFingerprint,
  computeMetrics,
  copyabilityScore,
  extractCity,
  finalCandidateScore,
  jaccard,
  ksDistance,
  mirrorSimilarity,
  profitQuality,
  rankCandidates,
  type CandidatePosition,
  type CandidateTrade,
} from "./scoring";

const T0 = 1_786_000_000;

function trade(o: Partial<CandidateTrade> = {}): CandidateTrade {
  return {
    asset: "a1",
    side: "BUY",
    size: 100,
    price: 0.1,
    ts: T0,
    title: "Will the highest temperature in Qingdao be 33°C on August 8?",
    slug: "highest-temperature-in-qingdao-on-august-8-2026-33c",
    outcome: "Yes",
    ...o,
  };
}

function position(o: Partial<CandidatePosition> = {}): CandidatePosition {
  return {
    asset: "a1",
    title: "t",
    slug: "highest-temperature-in-oslo-on-august-1-2026-20c",
    size: 10,
    initialValue: 10,
    currentValue: 0,
    cashPnl: 5,
    realizedPnl: 5,
    redeemable: true,
    endDate: new Date((T0 - 86_400) * 1000).toISOString(),
    ...o,
  };
}

describe("helpers", () => {
  it("extracts cities from weather slugs", () => {
    expect(extractCity("highest-temperature-in-qingdao-on-august-8-2026-33c")).toBe("qingdao");
    expect(extractCity("random-election-market")).toBeNull();
  });

  it("returns null jaccard when a set is empty (never 0)", () => {
    expect(jaccard(new Set(), new Set(["a"]))).toBeNull();
    expect(jaccard(new Set(["a", "b"]), new Set(["a"]))).toBeCloseTo(0.5);
  });

  it("returns null KS distance below the minimum sample", () => {
    expect(ksDistance([0.1, 0.2], [0.1, 0.2, 0.3])).toBeNull();
    expect(ksDistance([0.1, 0.1, 0.1], [0.1, 0.1, 0.1])).toBe(0);
  });
});

describe("missing-data handling", () => {
  it("never converts missing metrics to 0", () => {
    const m = computeMetrics({ trades: [], positions: [], nowSeconds: T0 });
    expect(m.metrics["pnl7d"]?.value).toBeNull();
    expect(m.metrics["winRate"]?.value).toBeNull();
    expect(m.sampleCount).toBe(0);
  });

  it("marks a composite INSUFFICIENT_DATA rather than scoring gaps as zero", () => {
    const r = composite([
      { key: "a", weight: 0.9, value: null },
      { key: "b", weight: 0.1, value: 1 },
    ]);
    expect(r.status).toBe("INSUFFICIENT_DATA");
    expect(r.score).toBeNull();
    expect(r.components["a"]).toBeNull();
  });

  it("renormalizes weights across available components", () => {
    const r = composite([
      { key: "a", weight: 0.5, value: 1 },
      { key: "b", weight: 0.25, value: 1 },
      { key: "c", weight: 0.25, value: null },
    ]);
    expect(r.status).toBe("SCORED");
    expect(r.score).toBe(100);
    expect(r.completeness).toBeCloseTo(0.75);
    expect(r.weightsUsed["a"]).toBeCloseTo(0.6667, 3);
  });

  it("keeps copyability unavailable when historical prices are missing", () => {
    const missing = copyabilityScore([
      { delaySeconds: 0, leaderPrice: 0.2, followerPrice: null },
      { delaySeconds: 30, leaderPrice: 0.2, followerPrice: null },
    ]);
    expect(missing.score).toBeNull();
    expect(missing.status).toBe("INSUFFICIENT_DATA");
    expect(missing.completeness).toBe(0);
  });

  it("scores copyability well when the follower price is unchanged", () => {
    const good = copyabilityScore([
      { delaySeconds: 0, leaderPrice: 0.2, followerPrice: 0.2 },
      { delaySeconds: 30, leaderPrice: 0.2, followerPrice: 0.2 },
      { delaySeconds: 60, leaderPrice: 0.2, followerPrice: 0.205 },
    ]);
    expect(good.status).toBe("SCORED");
    expect(good.score).toBeGreaterThan(80);
  });
});

describe("mirror similarity", () => {
  const trades = [
    trade({ ts: T0, price: 0.1 }),
    trade({ ts: T0 + 600, price: 0.2, asset: "a2" }),
    trade({ ts: T0 + 1200, price: 0.3, asset: "a3" }),
    trade({ ts: T0 + 1800, price: 0.4, asset: "a4" }),
  ];

  it("is deterministic and maximal against itself", () => {
    const fp = computeFingerprint(trades);
    const a = mirrorSimilarity(fp, fp);
    const b = mirrorSimilarity(fp, fp);
    expect(a).toEqual(b);
    expect(a.status).toBe("SCORED");
    expect(a.score).toBeGreaterThan(85);
  });

  it("scores a different strategy lower than an identical one", () => {
    const fp = computeFingerprint(trades);
    const other = computeFingerprint([
      trade({ slug: "will-dems-win-2026", title: "Will Dems win?", price: 0.9, asset: "b1", ts: T0 }),
      trade({ slug: "will-gop-win-2026", title: "Will GOP win?", price: 0.85, asset: "b2", ts: T0 + 400_000 }),
      trade({ slug: "will-x-happen", title: "Will X happen?", price: 0.8, asset: "b3", ts: T0 + 800_000 }),
      trade({ slug: "will-y-happen", title: "Will Y happen?", price: 0.95, asset: "b4", ts: T0 + 900_000 }),
    ]);
    expect((mirrorSimilarity(other, fp).score ?? 100)).toBeLessThan(mirrorSimilarity(fp, fp).score ?? 0);
  });

  it("exposes component scores instead of hiding them", () => {
    const fp = computeFingerprint(trades);
    const r = mirrorSimilarity(fp, fp);
    expect(Object.keys(r.components)).toContain("entryPriceDistribution");
    expect(Object.keys(r.components)).toContain("cadenceAutomation");
  });
});

describe("profit quality", () => {
  it("penalises extreme profit concentration", () => {
    const spread = computeMetrics({
      trades: [trade()],
      positions: Array.from({ length: 20 }, (_, i) =>
        position({ asset: `p${i}`, cashPnl: 50, initialValue: 100 }),
      ),
      nowSeconds: T0,
    });
    const jackpot = computeMetrics({
      trades: [trade()],
      positions: [
        position({ asset: "big", cashPnl: 1000, initialValue: 100 }),
        ...Array.from({ length: 19 }, (_, i) => position({ asset: `p${i}`, cashPnl: -5, initialValue: 100 })),
      ],
      nowSeconds: T0,
    });
    expect(spread.metrics["top1Concentration"]?.value).toBeLessThan(0.2);
    expect(jackpot.metrics["top1Concentration"]?.value).toBe(1);
    expect((profitQuality(jackpot).score ?? 0)).toBeLessThan(profitQuality(spread).score ?? 0);
  });

  it("stays unavailable with no settled data at all", () => {
    const m = computeMetrics({ trades: [], positions: [], nowSeconds: T0 });
    expect(profitQuality(m).status).toBe("INSUFFICIENT_DATA");
  });
});

describe("ranking", () => {
  const rows = [
    { handle: "b", finalScore: 50, mirrorSimilarity: 90, profitQuality: 10, copyability: null, weeklyRank: 2 },
    { handle: "a", finalScore: 50, mirrorSimilarity: 20, profitQuality: 80, copyability: 70, weeklyRank: 1 },
    { handle: "c", finalScore: null, mirrorSimilarity: 99, profitQuality: 99, copyability: 99, weeklyRank: 3 },
  ];

  it("is deterministic with nulls last and ties broken by handle", () => {
    const once = rankCandidates(rows, "final").map((r) => r.handle);
    const twice = rankCandidates([...rows].reverse(), "final").map((r) => r.handle);
    expect(once).toEqual(["a", "b", "c"]);
    expect(twice).toEqual(once);
  });

  it("sorts by each exposed key", () => {
    expect(rankCandidates(rows, "mirror")[0]?.handle).toBe("c");
    expect(rankCandidates(rows, "weeklyRank")[0]?.handle).toBe("a");
    expect(rankCandidates(rows, "copyability").map((r) => r.handle)).toEqual(["c", "a", "b"]);
  });
});

describe("final score", () => {
  it("renormalizes when copyability is unavailable", () => {
    const r = finalCandidateScore({ mirror: 80, profitQuality: 60, copyability: null, consistency: 100, capacity: 50 });
    expect(r.status).toBe("SCORED");
    expect(r.completeness).toBeCloseTo(0.8);
    expect(r.components["copyability"]).toBeNull();
  });

  it("is INSUFFICIENT_DATA when nearly everything is missing", () => {
    const r = finalCandidateScore({ mirror: null, profitQuality: null, copyability: null, consistency: null, capacity: 50 });
    expect(r.status).toBe("INSUFFICIENT_DATA");
    expect(r.score).toBeNull();
  });
});

describe("capacity + fingerprint", () => {
  it("flags automation indicators without asserting a bot", () => {
    const mechanical = computeFingerprint(
      Array.from({ length: 24 }, (_, i) =>
        trade({ asset: `m${i}`, ts: T0 + i * 3600, size: 100, price: 0.05 }),
      ),
    );
    expect(mechanical.botLabel).toBe("BEHAVIORAL / PROBABILISTIC");
    expect(mechanical.botLikelihood).toBeGreaterThan(50);
  });

  it("returns null capacity without size or cadence data", () => {
    expect(capacityScore(computeMetrics({ trades: [], positions: [], nowSeconds: T0 }))).toBeNull();
  });
});
