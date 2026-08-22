import { describe, expect, it } from "vitest";

import type { EpisodeOutcomeRow } from "./analytics";
import {
  applyAdverseExecutionStressCents,
  applyLatencyStress,
  compareFirstHalfSecondHalf,
  compareSizeTierCapacity,
  computeWalletConcentration,
  removeLargestLoss,
  removeLargestWin,
  removeTopNWins,
} from "./robustness";

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
    fireAtIso: null,
    observedAtIso: null,
    pmusResult: { depthWalk: { priceImpactCents: 1 } },
    kalshiResult: null,
    settlementStatus: "SETTLED_WIN",
    grossPnlUsd: 25,
    totalFeesUsd: 0.5,
    netPnlUsd: 24.5,
    ...overrides,
  };
}

describe("removeTopNWins / removeLargestWin / removeLargestLoss", () => {
  it("removes exactly N largest wins and reports what was removed", () => {
    const rows = [row({ signalId: "a", clusterKey: "g1", netPnlUsd: 100 }), row({ signalId: "b", clusterKey: "g2", netPnlUsd: 10 }), row({ signalId: "c", clusterKey: "g3", netPnlUsd: 5 })];
    const result = removeTopNWins(rows, 1);
    expect(result.removedCount).toBe(1);
    expect(result.removedNetPnlUsd).toBe(100);
    expect(result.remaining.netPnlUsd).toBe(15);
  });

  it("removeLargestWin is removeTopNWins(rows, 1)", () => {
    const rows = [row({ signalId: "a", clusterKey: "g1", netPnlUsd: 100 }), row({ signalId: "b", clusterKey: "g2", netPnlUsd: 10 })];
    expect(removeLargestWin(rows).remaining.netPnlUsd).toBe(10);
  });

  it("removeLargestLoss removes only the worst loss, not the best win", () => {
    const rows = [row({ signalId: "a", clusterKey: "g1", netPnlUsd: 50, settlementStatus: "SETTLED_WIN" }), row({ signalId: "b", clusterKey: "g2", netPnlUsd: -30, settlementStatus: "SETTLED_LOSS" })];
    const result = removeLargestLoss(rows);
    expect(result.removedNetPnlUsd).toBe(-30);
    expect(result.remaining.netPnlUsd).toBe(50);
  });
});

describe("applyAdverseExecutionStressCents", () => {
  it("reduces net P&L by cents-per-contract for settled episodes only", () => {
    const rows = [row({ contracts: 100, netPnlUsd: 20, grossPnlUsd: 20 })];
    const stressed1c = applyAdverseExecutionStressCents(rows, 1);
    expect(stressed1c.netPnlUsd).toBe(20 - 1); // 1 cent * 100 contracts = $1
    const stressed2c = applyAdverseExecutionStressCents(rows, 2);
    expect(stressed2c.netPnlUsd).toBe(20 - 2);
  });

  it("never touches unsettled episodes", () => {
    const rows = [row({ settlementStatus: "PENDING", netPnlUsd: null, grossPnlUsd: null })];
    const stressed = applyAdverseExecutionStressCents(rows, 1);
    expect(stressed.settledCount).toBe(0);
  });
});

describe("applyLatencyStress", () => {
  it("reports unavailable (never fabricated) when no alternate-delay quotes are supplied", () => {
    const result = applyLatencyStress([row()], undefined);
    expect(result.available).toBe(false);
  });

  it("excludes (never zero-fills) episodes missing an alternate quote, and recomputes using the supplied ones", () => {
    const rows = [row({ signalId: "a", vwap: 0.5, contracts: 100, netPnlUsd: 10, grossPnlUsd: 10 }), row({ signalId: "b", vwap: 0.5, contracts: 100, netPnlUsd: 10, grossPnlUsd: 10 })];
    const quotes = new Map([["a", 0.52]]); // only "a" has a later quote
    const result = applyLatencyStress(rows, quotes);
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.excludedCount).toBe(1);
      // (0.52 - 0.5) * 100 = $2 worse
      expect(result.metrics.netPnlUsd).toBeCloseTo(8, 5);
      expect(result.metrics.settledCount).toBe(1);
    }
  });
});

describe("compareFirstHalfSecondHalf", () => {
  it("splits chronologically by routing_timestamp, not by array order", () => {
    const rows = [
      row({ signalId: "b", routingTimestampIso: "2026-08-02T00:00:00Z", netPnlUsd: 5 }),
      row({ signalId: "a", routingTimestampIso: "2026-08-01T00:00:00Z", netPnlUsd: 100 }),
    ];
    const { firstHalf, secondHalf } = compareFirstHalfSecondHalf(rows);
    expect(firstHalf.netPnlUsd).toBe(100);
    expect(secondHalf.netPnlUsd).toBe(5);
  });
});

describe("computeWalletConcentration", () => {
  it("returns 0 concentration when nothing settled", () => {
    const result = computeWalletConcentration([row({ settlementStatus: "PENDING", netPnlUsd: null })]);
    expect(result.herfindahlIndex).toBe(0);
    expect(result.topWalletShareOfNetPnl).toBe(0);
  });

  it("one wallet producing everything has HHI 1 and 100% share", () => {
    const rows = [row({ sourceWallet: "0xa", netPnlUsd: 50 }), row({ sourceWallet: "0xa", netPnlUsd: 50 })];
    const result = computeWalletConcentration(rows);
    expect(result.topWalletShareOfNetPnl).toBe(1);
    expect(result.herfindahlIndex).toBe(1);
  });

  it("two equal wallets split evenly have HHI 0.5", () => {
    const rows = [row({ sourceWallet: "0xa", netPnlUsd: 50 }), row({ sourceWallet: "0xb", netPnlUsd: 50 })];
    const result = computeWalletConcentration(rows);
    expect(result.herfindahlIndex).toBeCloseTo(0.5, 5);
  });
});

describe("compareSizeTierCapacity", () => {
  it("groups by notional tier across the full, unfiltered row set", () => {
    const rows = [row({ notionalTierUsd: 5, netPnlUsd: 1 }), row({ notionalTierUsd: 100, netPnlUsd: 50 })];
    const breakdown = compareSizeTierCapacity(rows);
    expect(breakdown.map((b) => b.key).sort()).toEqual(["100", "5"]);
  });
});
