import { describe, expect, it } from "vitest";

import {
  breakdownByChosenVenue,
  breakdownByWallet,
  computeClusterReturns,
  computeCoreMetrics,
  computeExecutionMetrics,
  computeFullAnalyticsReport,
  computeRiskMetrics,
  effectiveClusterKey,
  filterToTier,
  percentile,
  priceBucket,
  type EpisodeOutcomeRow,
} from "./analytics";

function row(overrides: Partial<EpisodeOutcomeRow> = {}): EpisodeOutcomeRow {
  return {
    signalId: "sig-1",
    clusterKey: "cluster-1",
    sourceWallet: "0xa",
    betType: "MONEYLINE",
    scheduledStartAtIso: "2026-08-01T00:00:00Z",
    signalCreatedAtIso: "2026-08-01T00:00:00Z",
    notionalTierUsd: 25,
    chosenVenue: "PMUS",
    fillStatus: "FULL",
    contracts: 50,
    vwap: 0.5,
    feeUsd: 0.5,
    allInCostUsd: 25,
    rejectReason: null,
    routingTimestampIso: "2026-08-01T00:05:00Z",
    spread: 0.02,
    detectionLatencyMs: 500,
    fireAtIso: "2026-08-01T00:05:00Z",
    observedAtIso: "2026-08-01T00:05:00.300Z",
    pmusResult: { depthWalk: { priceImpactCents: 1.2 } },
    kalshiResult: null,
    settlementStatus: "SETTLED_WIN",
    grossPnlUsd: 25,
    totalFeesUsd: 0.5,
    netPnlUsd: 24.5,
    ...overrides,
  };
}

describe("effectiveClusterKey / filterToTier", () => {
  it("falls back to signalId when clusterKey is null -- never merges two unknown signals", () => {
    expect(effectiveClusterKey(row({ clusterKey: null, signalId: "s1" }))).toBe("s1");
    expect(effectiveClusterKey(row({ clusterKey: "c1" }))).toBe("c1");
  });

  it("filterToTier keeps only the requested notional tier", () => {
    const rows = [row({ notionalTierUsd: 5 }), row({ notionalTierUsd: 25 }), row({ notionalTierUsd: 25 })];
    expect(filterToTier(rows, 25)).toHaveLength(2);
  });
});

describe("computeClusterReturns", () => {
  it("sums net P&L within a cluster, excludes unsettled episodes entirely", () => {
    const rows = [
      row({ signalId: "a", clusterKey: "game-1", netPnlUsd: 10, settlementStatus: "SETTLED_WIN" }),
      row({ signalId: "b", clusterKey: "game-1", netPnlUsd: 5, settlementStatus: "SETTLED_WIN" }),
      row({ signalId: "c", clusterKey: "game-2", netPnlUsd: -3, settlementStatus: "SETTLED_LOSS" }),
      row({ signalId: "d", clusterKey: "game-3", netPnlUsd: null, settlementStatus: "PENDING" }),
    ];
    const clusters = computeClusterReturns(rows);
    expect(clusters).toHaveLength(2);
    expect(clusters.find((c) => c.clusterKey === "game-1")).toEqual({ clusterKey: "game-1", netPnlUsd: 15, episodeCount: 2 });
    expect(clusters.find((c) => c.clusterKey === "game-2")).toEqual({ clusterKey: "game-2", netPnlUsd: -3, episodeCount: 1 });
  });
});

describe("computeCoreMetrics", () => {
  it("counts independent (clustered) episodes separately from raw episodes", () => {
    const rows = [
      row({ signalId: "a", clusterKey: "game-1", settlementStatus: "SETTLED_WIN" }),
      row({ signalId: "b", clusterKey: "game-1", settlementStatus: "SETTLED_WIN" }), // same game -- correlated
      row({ signalId: "c", clusterKey: "game-2", settlementStatus: "SETTLED_LOSS", netPnlUsd: -10 }),
    ];
    const core = computeCoreMetrics(rows);
    expect(core.rawEpisodeCount).toBe(3);
    expect(core.independentEpisodeCount).toBe(2);
    expect(core.independentSettledCount).toBe(2);
    expect(core.wins).toBe(2);
    expect(core.losses).toBe(1);
  });

  it("expectancyPerIndependentEpisode divides net P&L by the INDEPENDENT count, not raw count", () => {
    const rows = [
      row({ signalId: "a", clusterKey: "game-1", netPnlUsd: 20 }),
      row({ signalId: "b", clusterKey: "game-1", netPnlUsd: 20 }), // correlated duplicate
    ];
    const core = computeCoreMetrics(rows);
    expect(core.netPnlUsd).toBe(40);
    expect(core.independentSettledCount).toBe(1);
    expect(core.expectancyPerIndependentEpisode).toBe(40); // 40 / 1 independent cluster, NOT 40/2
  });

  it("roi and expectancy are 0 (not NaN/Infinity) when nothing settled", () => {
    const core = computeCoreMetrics([row({ settlementStatus: "PENDING", netPnlUsd: null, grossPnlUsd: null, totalFeesUsd: null, allInCostUsd: null })]);
    expect(core.roi).toBe(0);
    expect(core.expectancyPerIndependentEpisode).toBe(0);
    expect(Number.isFinite(core.roi)).toBe(true);
  });
});

describe("breakdowns", () => {
  it("breakdownByWallet groups and sorts by descending net P&L", () => {
    const rows = [
      row({ signalId: "a", sourceWallet: "0xa", clusterKey: "g1", netPnlUsd: 5 }),
      row({ signalId: "b", sourceWallet: "0xb", clusterKey: "g2", netPnlUsd: 50 }),
    ];
    const breakdown = breakdownByWallet(rows);
    expect(breakdown[0]?.key).toBe("0xb");
    expect(breakdown[1]?.key).toBe("0xa");
  });

  it("breakdownByChosenVenue labels a null venue as NONE rather than dropping the row", () => {
    const rows = [row({ chosenVenue: null, settlementStatus: "PENDING", netPnlUsd: null })];
    const breakdown = breakdownByChosenVenue(rows);
    expect(breakdown[0]?.key).toBe("NONE");
  });

  it("priceBucket buckets into deciles and handles null", () => {
    expect(priceBucket(0.53)).toBe("0.5-0.6");
    expect(priceBucket(null)).toBe("UNKNOWN");
    expect(priceBucket(0.999)).toBe("0.9-1");
  });
});

describe("computeExecutionMetrics", () => {
  it("computes match/reject/liquidity-failure rates from fill_status distribution", () => {
    const rows = [
      row({ fillStatus: "FULL" }),
      row({ fillStatus: "PARTIAL" }),
      row({ fillStatus: "REJECTED" }),
      row({ fillStatus: "NONE" }),
    ];
    const exec = computeExecutionMetrics(rows);
    expect(exec.matchRate).toBe(0.5);
    expect(exec.rejectRate).toBe(0.25);
    expect(exec.liquidityFailureRate).toBe(0.25);
  });

  it("Codex-caught P1 regression: UNROUTED signals (never even reached a routing decision) count in the denominator and as a liquidity failure -- match rate must reflect ALL detected signals, not only routed ones", () => {
    const rows = [row({ fillStatus: "FULL" }), row({ fillStatus: "UNROUTED" }), row({ fillStatus: "UNROUTED" }), row({ fillStatus: "UNROUTED" })];
    const exec = computeExecutionMetrics(rows);
    expect(exec.matchRate).toBe(0.25); // 1 filled out of 4 total, not 100% of routed-only
    expect(exec.liquidityFailureRate).toBe(0.75);
  });

  it("pulls slippage from the CHOSEN venue's own depthWalk result, not the other venue's counterfactual", () => {
    const rows = [
      row({ chosenVenue: "PMUS", pmusResult: { depthWalk: { priceImpactCents: 2 } }, kalshiResult: { depthWalk: { priceImpactCents: 99 } } }),
      row({ chosenVenue: "KALSHI", pmusResult: { depthWalk: { priceImpactCents: 99 } }, kalshiResult: { depthWalk: { priceImpactCents: 4 } } }),
    ];
    const exec = computeExecutionMetrics(rows);
    expect(exec.averageSlippageCents).toBe(3);
  });

  it("observation lateness is derived from observed_at - fire_at", () => {
    const rows = [row({ fireAtIso: "2026-08-01T00:00:00.000Z", observedAtIso: "2026-08-01T00:00:00.400Z" })];
    const exec = computeExecutionMetrics(rows);
    expect(exec.observationLatenessMsP50).toBe(400);
  });

  it("percentile is null for an empty array, never NaN", () => {
    expect(percentile([], 95)).toBeNull();
  });
});

describe("computeRiskMetrics", () => {
  it("builds a chronological equity curve and computes max drawdown correctly (peak-to-trough, not just final-vs-peak)", () => {
    const rows = [
      row({ signalId: "a", routingTimestampIso: "2026-08-01T00:00:00Z", netPnlUsd: 10 }),
      row({ signalId: "b", routingTimestampIso: "2026-08-02T00:00:00Z", netPnlUsd: 20 }), // cumulative 30, new peak
      row({ signalId: "c", routingTimestampIso: "2026-08-03T00:00:00Z", netPnlUsd: -25 }), // cumulative 5, drawdown 25
      row({ signalId: "d", routingTimestampIso: "2026-08-04T00:00:00Z", netPnlUsd: 5 }), // cumulative 10, still below peak
    ];
    const risk = computeRiskMetrics(rows);
    expect(risk.peakEquityUsd).toBe(30);
    expect(risk.maxDrawdownUsd).toBe(25);
    expect(risk.equityCurve.map((p) => p.cumulativeNetPnlUsd)).toEqual([10, 30, 5, 10]);
    expect(risk.largestWinUsd).toBe(20);
    expect(risk.largestLossUsd).toBe(-25);
  });

  it("profitConcentration is 0 when there is no positive P&L to concentrate", () => {
    const risk = computeRiskMetrics([row({ netPnlUsd: -5 })]);
    expect(risk.profitConcentration).toBe(0);
  });
});

describe("computeFullAnalyticsReport", () => {
  it("assembles core/execution/risk/breakdowns without throwing on an empty row set", () => {
    const report = computeFullAnalyticsReport([]);
    expect(report.core.rawEpisodeCount).toBe(0);
    expect(report.breakdowns.byWallet).toHaveLength(0);
  });
});
