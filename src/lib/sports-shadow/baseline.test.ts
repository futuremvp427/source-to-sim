import { describe, expect, it } from "vitest";

import type { EpisodeOutcomeRow } from "./analytics";
import { computeMarketImpliedBaseline } from "./baseline";

function row(overrides: Partial<EpisodeOutcomeRow> = {}): EpisodeOutcomeRow {
  return {
    signalId: "sig-1",
    clusterKey: "cluster-1",
    sourceWallet: "0xa",
    betType: "MONEYLINE",
    scheduledStartAtIso: null,
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
    fireAtIso: null,
    observedAtIso: null,
    pmusResult: null,
    kalshiResult: null,
    settlementStatus: "SETTLED_WIN",
    grossPnlUsd: 25,
    totalFeesUsd: 0.5,
    netPnlUsd: 24.5,
    ...overrides,
  };
}

describe("computeMarketImpliedBaseline", () => {
  it("baseline expectancy is exactly -average(fee), independent of win/loss outcome", () => {
    const rows = [row({ signalId: "a", feeUsd: 1, settlementStatus: "SETTLED_WIN" }), row({ signalId: "b", feeUsd: 3, settlementStatus: "SETTLED_LOSS" })];
    const baseline = computeMarketImpliedBaseline(rows, 10);
    expect(baseline.baselineExpectancyPerEpisodeUsd).toBe(-2); // -(1+3)/2
    expect(baseline.sampleSize).toBe(2);
  });

  it("edge is strategy expectancy minus baseline expectancy", () => {
    const rows = [row({ feeUsd: 1 })];
    const baseline = computeMarketImpliedBaseline(rows, 5);
    expect(baseline.baselineExpectancyPerEpisodeUsd).toBe(-1);
    expect(baseline.edgeUsd).toBe(5 - -1);
  });

  it("ignores unsettled episodes and episodes missing a known fee", () => {
    const rows = [row({ settlementStatus: "PENDING", feeUsd: null }), row({ feeUsd: 2 })];
    const baseline = computeMarketImpliedBaseline(rows, 0);
    expect(baseline.sampleSize).toBe(1);
    expect(baseline.baselineExpectancyPerEpisodeUsd).toBe(-2);
  });

  it("carries a stable, versioned provenance tag", () => {
    const baseline = computeMarketImpliedBaseline([], 0);
    expect(baseline.version).toBe("MARKET_IMPLIED_V1");
    expect(baseline.method).toBe("MARKET_IMPLIED_EXPECTANCY");
    expect(baseline.sampleSize).toBe(0);
    expect(baseline.baselineExpectancyPerEpisodeUsd).toBe(0);
  });
});
