import { describe, expect, it } from "vitest";

import { maxDrawdown, summarizeExperiment } from "./comparison-core";

const trade = (realizedPnl: number, createdAt: string, action = "SELL") => ({
  action,
  realizedPnl,
  createdAt,
});

describe("comparison metrics", () => {
  it("reports equity, ROI and win rate from the paper book", () => {
    const s = summarizeExperiment({
      startingCash: 380,
      cash: 360,
      realizedPnl: 5,
      openValue: 30,
      trades: [trade(10, "2026-01-01"), trade(-5, "2026-01-02"), trade(0, "2026-01-03", "BUY")],
      latencies: [12, 30, 60],
    });
    expect(s.equity).toBe(390);
    expect(s.totalPnl).toBe(10);
    expect(s.roiPct).toBeCloseTo(2.63, 2);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.winRatePct).toBe(50);
    expect(s.medianLatencySeconds).toBe(30);
  });

  it("returns Unavailable-style nulls instead of guessing when marks are missing", () => {
    const s = summarizeExperiment({
      startingCash: 380,
      cash: 380,
      realizedPnl: 0,
      openValue: null,
      trades: [],
      latencies: [],
    });
    expect(s.equity).toBeNull();
    expect(s.totalPnl).toBeNull();
    expect(s.roiPct).toBeNull();
    expect(s.winRatePct).toBeNull();
    expect(s.medianLatencySeconds).toBeNull();
  });

  it("measures peak-to-trough drawdown in chronological order", () => {
    expect(maxDrawdown(100, [trade(20, "2026-01-01"), trade(-50, "2026-01-02"), trade(10, "2026-01-03")])).toBe(50);
    expect(maxDrawdown(100, [trade(5, "2026-01-01")])).toBe(0);
  });
});
