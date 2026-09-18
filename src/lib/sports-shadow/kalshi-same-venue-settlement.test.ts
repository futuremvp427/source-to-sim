/**
 * SAME-VENUE (Kalshi -> Kalshi) PAPER settlement tests — pure, no I/O.
 *
 * Proves the terminal P&L accounting contract (gross realized + remaining gross, fees
 * netted exactly once), the PENDING backoff, the deadline bound, and the fail-closed
 * behaviour when a position has no valid recorded cost basis.
 */

import { describe, expect, it } from "vitest";

import {
  computeSameVenueNextCheckAtMs,
  computeSameVenueSettlementRow,
  runSameVenueSettlementBatch,
  SAME_VENUE_RECHECK_BASE_MS,
  SAME_VENUE_RECHECK_MAX_MS,
  type SameVenueSettlementPosition,
  type SameVenueSettlementRepository,
  type SameVenueSettlementRow,
} from "./kalshi-same-venue-settlement";
import type { SettlementCheckResult } from "./settlement.server";

const NOW = 1_700_000_000_000;

function position(overrides: Partial<SameVenueSettlementPosition> = {}): SameVenueSettlementPosition {
  return {
    traderId: "kalshi-trader-1",
    marketTicker: "KXMLBGAME-26AUG25CHCCIN-CHC",
    contractSide: "YES",
    notionalTierUsd: 100,
    contractsOpen: 100,
    avgEntryPrice: 0.6,
    realizedPnlUsd: 0,
    feesUsd: 1.5,
    checkAttemptCount: 0,
    ...overrides,
  };
}

const WIN: SettlementCheckResult = { status: "SETTLED_WIN", settlementValue: 1, settlementTimestampMs: NOW - 1000, settlementSource: "kalshi market result" };
const LOSS: SettlementCheckResult = { status: "SETTLED_LOSS", settlementValue: 0, settlementTimestampMs: NOW - 1000, settlementSource: "kalshi market result" };
const PUSH: SettlementCheckResult = { status: "SETTLED_PUSH", settlementValue: null, settlementTimestampMs: NOW - 1000, settlementSource: "kalshi market result" };
const PENDING: SettlementCheckResult = { status: "PENDING", settlementValue: null, settlementTimestampMs: null, settlementSource: "not yet resolved" };

class MemoryRepo implements SameVenueSettlementRepository {
  rows: SameVenueSettlementRow[] = [];
  constructor(private due: SameVenueSettlementPosition[]) {}
  async findDuePositions(limit: number): Promise<SameVenueSettlementPosition[]> {
    return this.due.slice(0, limit);
  }
  async finalizeSettlement(row: SameVenueSettlementRow): Promise<void> {
    this.rows.push(row);
  }
}

describe("same-venue Kalshi paper settlement", () => {
  it("WIN: remaining gross is contracts * (1 - avg entry), fees netted exactly once", () => {
    const row = computeSameVenueSettlementRow(position({ realizedPnlUsd: 2 }), WIN, NOW, 1);
    expect(row.settlementStatus).toBe("SETTLED_WIN");
    expect(row.grossPnlUsd).toBeCloseTo(2 + 100 * (1 - 0.6), 9); // 42
    expect(row.totalFeesUsd).toBeCloseTo(1.5, 9);
    expect(row.netPnlUsd).toBeCloseTo(42 - 1.5, 9);
    expect(row.nextCheckAtMs).toBeNull();
  });

  it("LOSS: remaining gross is contracts * (0 - avg entry) and prior realized gross is preserved", () => {
    const row = computeSameVenueSettlementRow(position({ realizedPnlUsd: 5 }), LOSS, NOW, 1);
    expect(row.grossPnlUsd).toBeCloseTo(5 - 100 * 0.6, 9); // -55
    expect(row.netPnlUsd).toBeCloseTo(-55 - 1.5, 9);
    expect(row.nextCheckAtMs).toBeNull();
  });

  it("PUSH adds zero remaining gross", () => {
    const row = computeSameVenueSettlementRow(position({ realizedPnlUsd: 3 }), PUSH, NOW, 1);
    expect(row.grossPnlUsd).toBeCloseTo(3, 9);
    expect(row.netPnlUsd).toBeCloseTo(3 - 1.5, 9);
  });

  it("PENDING records no P&L and schedules an exponential backoff recheck", () => {
    const first = computeSameVenueSettlementRow(position(), PENDING, NOW, 1);
    expect(first.grossPnlUsd).toBeNull();
    expect(first.netPnlUsd).toBeNull();
    expect(first.nextCheckAtMs).toBe(NOW + SAME_VENUE_RECHECK_BASE_MS);

    const third = computeSameVenueSettlementRow(position({ checkAttemptCount: 2 }), PENDING, NOW, 3);
    expect(third.nextCheckAtMs).toBe(NOW + SAME_VENUE_RECHECK_BASE_MS * 4);
    expect(computeSameVenueNextCheckAtMs(NOW, 50)).toBe(NOW + SAME_VENUE_RECHECK_MAX_MS);
  });

  it("a position with open contracts but no valid avg entry price fails closed to terminal VOID with null P&L", () => {
    const row = computeSameVenueSettlementRow(position({ avgEntryPrice: null }), WIN, NOW, 1);
    expect(row.settlementStatus).toBe("VOID");
    expect(row.grossPnlUsd).toBeNull();
    expect(row.netPnlUsd).toBeNull();
    expect(row.nextCheckAtMs).toBeNull();
  });

  it("the batch runner is bounded by its deadline and leaves remaining positions untouched", async () => {
    const repo = new MemoryRepo([position({ traderId: "a" }), position({ traderId: "b" }), position({ traderId: "c" })]);
    let clock = NOW;
    const result = await runSameVenueSettlementBatch({
      repo,
      checkSettlement: async () => {
        clock += 1000;
        return WIN;
      },
      now: () => clock,
      deadlineAtMs: NOW + 1500,
    });
    expect(result.checked).toBe(2);
    expect(result.settled).toBe(2);
    expect(result.deadlineReached).toBe(true);
    expect(repo.rows.map((r) => r.traderId)).toEqual(["a", "b"]);
  });

  it("a failing authoritative check is counted as an error and never persists a fabricated settlement", async () => {
    const repo = new MemoryRepo([position()]);
    const result = await runSameVenueSettlementBatch({
      repo,
      checkSettlement: async () => {
        throw new Error("HTTP 429");
      },
      now: () => NOW,
    });
    expect(result).toEqual({ checked: 1, settled: 0, errors: 1, deadlineReached: false });
    expect(repo.rows).toHaveLength(0);
  });
});
