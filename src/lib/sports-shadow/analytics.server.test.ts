import { describe, expect, it } from "vitest";

import { computeEpisodeAnalysisReport } from "./analytics.server";
import type { EpisodeOutcomeRow } from "./analytics";

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

describe("computeEpisodeAnalysisReport", () => {
  it("filters to the requested notional tier for the headline analytics/robustness/bootstrap/baseline result", () => {
    const rows = [row({ signalId: "a", notionalTierUsd: 5, netPnlUsd: 1000 }), row({ signalId: "b", notionalTierUsd: 25, netPnlUsd: 10 })];
    const report = computeEpisodeAnalysisReport(rows, { sinceIso: null, untilIso: null }, 25);
    expect(report.notionalTierUsd).toBe(25);
    expect(report.analytics.core.netPnlUsd).toBe(10);
  });

  it("size-tier capacity comparison sees ALL tiers even though the headline result is tier-filtered", () => {
    const rows = [row({ signalId: "a", notionalTierUsd: 5 }), row({ signalId: "b", notionalTierUsd: 25 }), row({ signalId: "c", notionalTierUsd: 100 })];
    const report = computeEpisodeAnalysisReport(rows, { sinceIso: null, untilIso: null }, 25);
    expect(report.robustness.sizeTierCapacity.map((b) => b.key).sort()).toEqual(["100", "25", "5"]);
  });

  it("applies the window filter by signal_created_at (calibration/OOS windowing)", () => {
    const rows = [
      row({ signalId: "a", signalCreatedAtIso: "2026-08-01T00:00:00Z", netPnlUsd: 10 }),
      row({ signalId: "b", signalCreatedAtIso: "2026-09-01T00:00:00Z", netPnlUsd: 20 }),
    ];
    const report = computeEpisodeAnalysisReport(rows, { sinceIso: "2026-08-15T00:00:00Z", untilIso: null }, 25);
    expect(report.analytics.core.netPnlUsd).toBe(20);
  });

  it("untilIso is exclusive -- an episode created exactly at the boundary belongs to the NEXT window, not this one", () => {
    const rows = [row({ signalId: "a", signalCreatedAtIso: "2026-08-15T00:00:00Z", netPnlUsd: 10 })];
    const report = computeEpisodeAnalysisReport(rows, { sinceIso: null, untilIso: "2026-08-15T00:00:00Z" }, 25);
    expect(report.analytics.core.rawEpisodeCount).toBe(0);
  });

  it("baseline uses the SAME declared-tier row set the headline analytics does, never a different sample", () => {
    const rows = [row({ notionalTierUsd: 25, totalFeesUsd: 1 })];
    const report = computeEpisodeAnalysisReport(rows, { sinceIso: null, untilIso: null }, 25);
    expect(report.baseline.sampleSize).toBe(1);
    expect(report.baseline.strategyExpectancyPerEpisodeUsd).toBe(report.analytics.core.expectancyPerIndependentEpisode);
  });

  it("bootstrap runs over independent cluster returns from the declared tier only", () => {
    const rows = [
      row({ signalId: "a", clusterKey: "g1", notionalTierUsd: 25, netPnlUsd: 10 }),
      row({ signalId: "b", clusterKey: "g1", notionalTierUsd: 25, netPnlUsd: 10 }), // same cluster
      row({ signalId: "c", clusterKey: "g2", notionalTierUsd: 25, netPnlUsd: -5 }),
    ];
    const report = computeEpisodeAnalysisReport(rows, { sinceIso: null, untilIso: null }, 25, 1);
    expect(report.bootstrap.sampleSize).toBe(2); // 2 clusters, not 3 raw rows
  });
});
