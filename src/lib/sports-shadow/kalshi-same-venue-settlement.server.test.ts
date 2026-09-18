import { describe, expect, it } from "vitest";

import {
  runSameVenueSettlementBatch,
  settleSameVenuePosition,
  type SameVenueSettlementPosition,
  type SameVenueSettlementRepository,
  type SameVenueSettlementRow,
} from "./kalshi-same-venue-settlement.server";
import type { SettlementCheckResult } from "./settlement.server";

function position(overrides: Partial<SameVenueSettlementPosition> = {}): SameVenueSettlementPosition {
  return {
    traderId: "trader-1",
    marketTicker: "KXTEST-26SEP18-A",
    contractSide: "YES",
    notionalTierUsd: 20,
    contractsOpen: 10,
    avgEntryPrice: 0.4,
    realizedPnlUsd: 0.5,
    feesUsd: 0.2,
    checkAttemptCount: 0,
    ...overrides,
  };
}

function check(overrides: Partial<SettlementCheckResult> = {}): SettlementCheckResult {
  return {
    status: "SETTLED_WIN",
    settlementValue: 1,
    settlementTimestampMs: 1_800_000_000_000,
    settlementSource: "Kalshi market status: finalized",
    ...overrides,
  };
}

describe("same-venue Kalshi settlement", () => {
  it("settles a WIN using remaining contracts, prior gross exits, and fees exactly once", async () => {
    const row = await settleSameVenuePosition(position(), async () => check());
    expect(row.settlementStatus).toBe("SETTLED_WIN");
    expect(row.grossPnlUsd).toBeCloseTo(0.5 + 10 * (1 - 0.4), 8);
    expect(row.totalFeesUsd).toBeCloseTo(0.2, 8);
    expect(row.netPnlUsd).toBeCloseTo(0.5 + 10 * 0.6 - 0.2, 8);
  });

  it("settles a LOSS without fabricating a payout", async () => {
    const row = await settleSameVenuePosition(
      position(),
      async () => check({ status: "SETTLED_LOSS", settlementValue: 0 }),
    );
    expect(row.grossPnlUsd).toBeCloseTo(0.5 - 10 * 0.4, 8);
    expect(row.netPnlUsd).toBeCloseTo(0.5 - 10 * 0.4 - 0.2, 8);
  });

  it("keeps an unresolved market PENDING with null P&L", async () => {
    const row = await settleSameVenuePosition(
      position(),
      async () =>
        check({
          status: "PENDING",
          settlementValue: null,
          settlementTimestampMs: null,
          settlementSource: "not yet resolved",
        }),
    );
    expect(row.settlementStatus).toBe("PENDING");
    expect(row.grossPnlUsd).toBeNull();
    expect(row.netPnlUsd).toBeNull();
  });

  it("fails closed on an invalid open position without calling the venue", async () => {
    let calls = 0;
    const row = await settleSameVenuePosition(position({ avgEntryPrice: null }), async () => {
      calls += 1;
      return check();
    });
    expect(calls).toBe(0);
    expect(row.settlementStatus).toBe("VOID");
    expect(row.netPnlUsd).toBeNull();
  });

  it("persists PENDING with backoff and terminal settlements without a next check", async () => {
    const finalized: SameVenueSettlementRow[] = [];
    const repo: SameVenueSettlementRepository = {
      async findOpenPositions() {
        return [position({ marketTicker: "PENDING", checkAttemptCount: 1 }), position({ marketTicker: "DONE", checkAttemptCount: 2 })];
      },
      async finalizeSettlement(row) {
        finalized.push(row);
      },
    };
    const nowMs = 1_800_000_100_000;
    const result = await runSameVenueSettlementBatch(
      50,
      repo,
      async (ticker) =>
        ticker === "PENDING"
          ? check({ status: "PENDING", settlementValue: null, settlementTimestampMs: null, settlementSource: "not yet resolved" })
          : check(),
      () => nowMs,
    );
    expect(result).toEqual({ checked: 2, settled: 1, errors: 0, deadlineReached: false });
    expect(finalized[0]?.settlementStatus).toBe("PENDING");
    expect(finalized[0]?.checkAttemptCount).toBe(2);
    expect(finalized[0]?.nextCheckAtMs).toBeGreaterThan(nowMs);
    expect(finalized[1]?.settlementStatus).toBe("SETTLED_WIN");
    expect(finalized[1]?.checkAttemptCount).toBe(3);
    expect(finalized[1]?.nextCheckAtMs).toBeNull();
  });

  it("honors a deadline before starting another settlement check", async () => {
    const finalized: SameVenueSettlementRow[] = [];
    const repo: SameVenueSettlementRepository = {
      async findOpenPositions() {
        return [position({ marketTicker: "A" }), position({ marketTicker: "B" })];
      },
      async finalizeSettlement(row) {
        finalized.push(row);
      },
    };
    let nowCalls = 0;
    const result = await runSameVenueSettlementBatch(
      50,
      repo,
      async () => check(),
      () => (++nowCalls === 1 ? 0 : 1_000),
      500,
    );
    expect(result.deadlineReached).toBe(true);
    expect(result.checked).toBe(1);
    expect(finalized).toHaveLength(1);
  });
});
