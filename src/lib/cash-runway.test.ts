import { describe, expect, it } from "vitest";

import { decideCashAlerts, estimateCashRunway } from "./cash-runway";

describe("cash runway", () => {
  it("estimates remaining BUYs from dynamic-v1 sizing and the 10% reserve", () => {
    const r = estimateCashRunway({ startingCash: 380, cash: 380 });
    expect(r.reservedCash).toBe(38);
    expect(r.spendableCash).toBe(342);
    expect(r.nextBuyUsd).toBe(3.8);
    expect(r.estimatedRemainingBuys).toBeGreaterThan(50);
    expect(r.reserveReached).toBe(false);
  });

  it("reports the reserve boundary once spendable cash is gone", () => {
    const r = estimateCashRunway({ startingCash: 380, cash: 38 });
    expect(r.spendableCash).toBe(0);
    expect(r.nextBuyUsd).toBeNull();
    expect(r.estimatedRemainingBuys).toBe(0);
    expect(r.reserveReached).toBe(true);
  });
});

const ctx = { experimentId: "exp-1", experimentName: "SHADOW V2: badatmath." };

describe("cash alerts", () => {
  it("does not alert while cash is healthy", () => {
    expect(decideCashAlerts({ ...ctx, startingCash: 380, cash: 380 })).toEqual([]);
  });

  it("raises LOW_SPENDABLE_CASH below 25% of the starting bankroll", () => {
    const above = decideCashAlerts({ ...ctx, startingCash: 380, cash: 133 + 38 });
    expect(above).toEqual([]);
    const below = decideCashAlerts({ ...ctx, startingCash: 380, cash: 120 });
    expect(below).toHaveLength(1);
    expect(below[0]!.kind).toBe("LOW_SPENDABLE_CASH");
  });

  it("raises CASH_RESERVE_REACHED at the reserve boundary and suppresses the low-cash warning", () => {
    const alerts = decideCashAlerts({ ...ctx, startingCash: 380, cash: 38 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("CASH_RESERVE_REACHED");
  });

  it("uses a stable dedup key so the same condition is never alerted twice", () => {
    const a = decideCashAlerts({ ...ctx, startingCash: 380, cash: 100 });
    const b = decideCashAlerts({ ...ctx, startingCash: 380, cash: 90 });
    expect(a[0]!.dedupKey).toBe("LOW_SPENDABLE_CASH:exp-1");
    expect(b[0]!.dedupKey).toBe(a[0]!.dedupKey);
    expect(new Set([a[0]!.dedupKey, b[0]!.dedupKey]).size).toBe(1);
  });
});