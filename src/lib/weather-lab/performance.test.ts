import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_THRESHOLDS,
  aggregateByStationDay,
  bootstrap,
  computeMetrics,
  edgeBand,
  evaluateAcceptance,
  groupBy,
  priceBand,
  trimTopWinners,
  type PaperTradeRow,
  type StationDayResult,
} from "./performance";

const row = (over: Partial<PaperTradeRow> = {}): PaperTradeRow => ({
  stationDay: "CLINYC:2026-08-27",
  city: "NYC",
  netPnlUsd: 10,
  costUsd: 100,
  entryPriceUsd: 0.08,
  netEdge: 0.12,
  entryLocalHour: 14,
  confidence: 0.6,
  settledAt: "2026-08-28T12:00:00Z",
  ...over,
});

const sd = (i: number, pnl: number, cost = 100): StationDayResult => ({
  stationDay: `CLINYC:day-${String(i).padStart(3, "0")}`,
  city: "NYC",
  netPnlUsd: pnl,
  costUsd: cost,
  settledAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T12:00:00Z`,
});

describe("aggregateByStationDay", () => {
  it("collapses correlated buckets from one station-day into one sample", () => {
    const rows = [
      row({ netPnlUsd: 10, costUsd: 50 }),
      row({ netPnlUsd: -4, costUsd: 30 }),
      row({ netPnlUsd: -3, costUsd: 20 }),
    ];
    const agg = aggregateByStationDay(rows);
    expect(agg).toHaveLength(1);
    expect(agg[0]?.netPnlUsd).toBeCloseTo(3, 6);
    expect(agg[0]?.costUsd).toBeCloseTo(100, 6);
  });

  it("keeps distinct station-days separate", () => {
    const agg = aggregateByStationDay([
      row({ stationDay: "CLINYC:2026-08-27" }),
      row({ stationDay: "CLICHI:2026-08-27", city: "Chicago" }),
    ]);
    expect(agg).toHaveLength(2);
  });

  it("prevents bucket-level counting from inflating the sample", () => {
    const sixBuckets = Array.from({ length: 6 }, (_, i) => row({ netPnlUsd: i === 0 ? 50 : -8 }));
    expect(sixBuckets).toHaveLength(6);
    expect(aggregateByStationDay(sixBuckets)).toHaveLength(1);
  });

  it("orders results chronologically", () => {
    const agg = aggregateByStationDay([
      row({ stationDay: "b", settledAt: "2026-09-01T00:00:00Z" }),
      row({ stationDay: "a", settledAt: "2026-08-01T00:00:00Z" }),
    ]);
    expect(agg.map((r) => r.stationDay)).toEqual(["a", "b"]);
  });
});

describe("computeMetrics", () => {
  it("computes win rate, ROI and profit factor", () => {
    const m = computeMetrics([sd(1, 30), sd(2, -10), sd(3, 20), sd(4, -10)]);
    expect(m.events).toBe(4);
    expect(m.wins).toBe(2);
    expect(m.winRate).toBeCloseTo(0.5, 6);
    expect(m.netPnlUsd).toBeCloseTo(30, 6);
    expect(m.roi).toBeCloseTo(30 / 400, 6);
    expect(m.profitFactor).toBeCloseTo(50 / 20, 6);
  });

  it("computes max drawdown along the chronological equity path", () => {
    const m = computeMetrics([sd(1, 100), sd(2, -60), sd(3, -20), sd(4, 50)]);
    expect(m.maxDrawdownUsd).toBeCloseTo(-80, 6);
  });

  it("reports a null profit factor when there are no losses", () => {
    expect(computeMetrics([sd(1, 10), sd(2, 20)]).profitFactor).toBeNull();
  });

  it("handles an empty set without dividing by zero", () => {
    const m = computeMetrics([]);
    expect(m.events).toBe(0);
    expect(m.winRate).toBeNull();
    expect(m.roi).toBeNull();
  });

  it("reports average win and average loss separately", () => {
    const m = computeMetrics([sd(1, 30), sd(2, -10)]);
    expect(m.averageWinUsd).toBeCloseTo(30, 6);
    expect(m.averageLossUsd).toBeCloseTo(-10, 6);
  });
});

describe("trimTopWinners", () => {
  it("removes the largest winners and can flip a result negative", () => {
    const results = [sd(1, 1000), ...Array.from({ length: 99 }, (_, i) => sd(i + 2, -5))];
    expect(computeMetrics(results).netPnlUsd).toBeCloseTo(505, 6);
    expect(trimTopWinners(results, 0.01).netPnlUsd).toBeCloseTo(-495, 6);
  });

  it("leaves a broad-based result positive", () => {
    const results = Array.from({ length: 100 }, (_, i) => sd(i, i % 3 === 0 ? -5 : 10));
    expect(trimTopWinners(results, 0.05).netPnlUsd).toBeGreaterThan(0);
  });
});

describe("bootstrap", () => {
  it("is deterministic across runs", () => {
    const results = Array.from({ length: 60 }, (_, i) => sd(i, i % 2 ? 10 : -5));
    expect(bootstrap(results)).toEqual(bootstrap(results));
  });

  it("brackets the observed win rate", () => {
    const results = Array.from({ length: 100 }, (_, i) => sd(i, i % 2 ? 10 : -5));
    const b = bootstrap(results)!;
    expect(b.winRate95[0]).toBeLessThanOrEqual(0.5);
    expect(b.winRate95[1]).toBeGreaterThanOrEqual(0.5);
  });

  it("returns null for an empty sample", () => {
    expect(bootstrap([])).toBeNull();
  });
});

describe("bands and grouping", () => {
  it("bands prices into the research cohorts", () => {
    expect(priceBand(0.03)).toBe("<5c");
    expect(priceBand(0.08)).toBe("5-10c");
    expect(priceBand(0.5)).toBe("20-55c");
    expect(priceBand(0.95)).toBe(">=90c");
  });

  it("bands net edge", () => {
    expect(edgeBand(0.01)).toBe("<2pt");
    expect(edgeBand(0.25)).toBe(">=20pt");
  });

  it("groups by city while preserving station-day independence", () => {
    const rows = [
      row({ city: "NYC", stationDay: "CLINYC:1", netPnlUsd: 10 }),
      row({ city: "NYC", stationDay: "CLINYC:1", netPnlUsd: -4 }),
      row({ city: "Chicago", stationDay: "CLICHI:1", netPnlUsd: 7 }),
    ];
    const groups = groupBy(rows, (r) => r.city);
    expect(groups.map((g) => g.group)).toEqual(["Chicago", "NYC"]);
    expect(groups.find((g) => g.group === "NYC")?.metrics.events).toBe(1);
  });
});

describe("evaluateAcceptance", () => {
  it("reports INSUFFICIENT_SAMPLE below the 50 station-day minimum", () => {
    const v = evaluateAcceptance(Array.from({ length: 20 }, (_, i) => sd(i, 10)));
    expect(v.verdict).toBe("INSUFFICIENT_SAMPLE");
    expect(v.sampleStrength).toBe("INSUFFICIENT");
  });

  it("does not declare victory from 20 profitable trades", () => {
    const v = evaluateAcceptance(Array.from({ length: 20 }, (_, i) => sd(i, 50)));
    expect(v.verdict).not.toBe("PASS");
  });

  it("passes a broad, well-sampled, robust result", () => {
    const results = Array.from({ length: 120 }, (_, i) => sd(i, i % 3 === 0 ? -10 : 12));
    const v = evaluateAcceptance(results);
    expect(v.sampleStrength).toBe("PREFERRED");
    expect(v.verdict).toBe("PASS");
    expect(v.failures).toEqual([]);
  });

  it("fails a result that depends on one huge winner", () => {
    const results = [sd(0, 5000), ...Array.from({ length: 99 }, (_, i) => sd(i + 1, -10))];
    const v = evaluateAcceptance(results);
    expect(v.verdict).toBe("FAIL");
    expect(v.failures).toContain("SINGLE_EVENT_CONCENTRATION");
    expect(v.failures).toContain("DEPENDS_ON_TOP_1PCT_WINNERS");
  });

  it("fails a profitable result whose profit factor is too thin", () => {
    const results = Array.from({ length: 100 }, (_, i) => sd(i, i % 2 ? 10.4 : -10));
    const v = evaluateAcceptance(results);
    expect(v.metrics.netPnlUsd).toBeGreaterThan(0);
    expect(v.failures).toContain("PROFIT_FACTOR_BELOW_1_3");
  });

  it("fails a losing result", () => {
    const v = evaluateAcceptance(Array.from({ length: 100 }, (_, i) => sd(i, -5)));
    expect(v.verdict).toBe("FAIL");
    expect(v.failures).toContain("NET_PNL_NOT_POSITIVE");
  });

  it("exposes trimmed and bootstrap evidence alongside the headline", () => {
    const v = evaluateAcceptance(Array.from({ length: 120 }, (_, i) => sd(i, i % 3 === 0 ? -10 : 12)));
    expect(v.trimmedTop1Pct.events).toBeLessThan(v.metrics.events);
    expect(v.trimmedTop5Pct.events).toBeLessThan(v.trimmedTop1Pct.events);
    expect(v.bootstrap).not.toBeNull();
  });

  it("uses the pre-registered thresholds", () => {
    expect(ACCEPTANCE_THRESHOLDS.minIndependentStationDays).toBe(50);
    expect(ACCEPTANCE_THRESHOLDS.minProfitFactor).toBe(1.3);
  });
});
