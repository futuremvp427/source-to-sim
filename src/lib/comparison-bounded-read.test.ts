/**
 * Proves the comparison read path no longer paginates raw paper_trades history:
 * counts/averages/skip metrics come from the exact database aggregate, while
 * performance chronology uses only realized-P&L-bearing rows.
 */

import { describe, expect, it } from "vitest";

import { parseDecisionStats } from "./comparison.server";
import { summarizeExperiment } from "./comparison-core";

describe("comparison decision stats (database-side aggregation)", () => {
  it("parses exact counts, averages, top skip reasons and last source activity", () => {
    const stats = parseDecisionStats({
      eligible_decisions: 1000,
      buys: 180,
      sells: 20,
      skips: 800,
      avg_buy_usd: 4.987654,
      avg_sell_usd: 3.5,
      last_source_ts: 1755400000,
      skip_reasons: [
        { reason: "Cash reserve", count: 600 },
        { reason: "Unknown side", count: 150 },
        { reason: "Unspecified", count: 50 },
      ],
    });
    expect(stats.eligibleDecisions).toBe(1000);
    expect(stats.buys).toBe(180);
    expect(stats.sells).toBe(20);
    expect(stats.skips).toBe(800);
    expect(stats.avgBuyUsd).toBe(4.99);
    expect(stats.avgSellUsd).toBe(3.5);
    expect(stats.lastSourceTs).toBe(1755400000);
    expect(stats.skipReasons).toHaveLength(3);
    expect(stats.skipReasons[0]).toEqual({ reason: "Cash reserve", count: 600 });
    // Skip rate keeps its existing semantics: skips / eligible decisions.
    expect(Math.round((stats.skips / stats.eligibleDecisions) * 1000) / 10).toBe(80);
  });

  it("treats missing averages/last activity as Unavailable, not zero", () => {
    const stats = parseDecisionStats({ eligible_decisions: 0, skip_reasons: [] });
    expect(stats.avgBuyUsd).toBeNull();
    expect(stats.avgSellUsd).toBeNull();
    expect(stats.lastSourceTs).toBeNull();
    expect(stats.skipReasons).toEqual([]);
  });
});

describe("performance semantics from the narrowed realized stream", () => {
  it("realized-only rows plus exact counts reproduce the full-history summary", () => {
    const full = summarizeExperiment({
      startingCash: 380,
      cash: 350,
      realizedPnl: 5,
      openValue: 40,
      trades: [
        { action: "BUY", realizedPnl: 0, createdAt: "2026-01-01" },
        { action: "SKIP", realizedPnl: 0, createdAt: "2026-01-01" },
        { action: "SELL", realizedPnl: 20, createdAt: "2026-01-02" },
        { action: "BUY", realizedPnl: 0, createdAt: "2026-01-03" },
        { action: "SELL", realizedPnl: -15, createdAt: "2026-01-04" },
      ],
      latencies: [10],
    });
    const bounded = summarizeExperiment({
      startingCash: 380,
      cash: 350,
      realizedPnl: 5,
      openValue: 40,
      trades: [
        { action: "SELL", realizedPnl: 20, createdAt: "2026-01-02" },
        { action: "SELL", realizedPnl: -15, createdAt: "2026-01-04" },
      ],
      counts: { buys: 2, sells: 2 },
      latencies: [10],
    });
    expect(bounded).toEqual(full);
  });
});