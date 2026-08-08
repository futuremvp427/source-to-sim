import { describe, expect, it } from "vitest";

import {
  applySell,
  cashBreakdown,
  computeBuySize,
  decideDynamicBuy,
  EMPTY_POSITION,
  SIZING_RULE_VERSION,
} from "./shadow-core";
import { settlementCredit } from "./settlement-core";

const S = 380;

describe("dynamic paper BUY sizing", () => {
  it("sizes $3.80 at $380 cash", () => {
    expect(computeBuySize({ startingCash: S, cash: 380 })).toMatchObject({ ok: true, amount: 3.8 });
  });

  it("sizes $2 at $200 cash", () => {
    expect(computeBuySize({ startingCash: S, cash: 200 })).toMatchObject({ ok: true, amount: 2 });
  });

  it("sizes $1 at $100 cash (minimum floor)", () => {
    expect(computeBuySize({ startingCash: S, cash: 100 })).toMatchObject({ ok: true, amount: 1 });
  });

  it("never breaches the 10% starting-bankroll reserve", () => {
    const b = cashBreakdown({ startingCash: S, cash: 80 });
    expect(b.reservedCash).toBe(38);
    expect(b.spendableCash).toBe(42);
    const size = computeBuySize({ startingCash: S, cash: 38.5 });
    expect(size.ok).toBe(false);
    const edge = computeBuySize({ startingCash: S, cash: 38.6 });
    expect(edge.ok).toBe(true);
    if (edge.ok) expect(edge.amount).toBeLessThanOrEqual(edge.spendableCash);
    const skip = decideDynamicBuy({ price: 0.5, startingCash: S, cash: 38 });
    expect(skip.action).toBe("SKIP");
    expect(skip.reason).toContain("INSUFFICIENT_CASH_RESERVE");
  });

  it("labels the persisted sizing rule version on every BUY", () => {
    const d = decideDynamicBuy({ price: 0.5, startingCash: S, cash: 380 });
    expect(d.action).toBe("BUY");
    expect(d.notional).toBe(3.8);
    expect(d.shares).toBeCloseTo(7.6, 6);
    expect(d.reason).toContain(SIZING_RULE_VERSION);
  });

  it("restores spendable cash from SELL proceeds", () => {
    const blocked = computeBuySize({ startingCash: S, cash: 38 });
    expect(blocked.ok).toBe(false);
    const sold = applySell({ ...EMPTY_POSITION, shares: 20, costBasis: 8, avgPrice: 0.4 }, 38, 20, 0.6);
    expect(sold.cash).toBe(50);
    expect(computeBuySize({ startingCash: S, cash: sold.cash }).ok).toBe(true);
  });

  it("restores spendable cash from verified settlement payouts", () => {
    const credit = settlementCredit({ shares: 20, costBasis: 8, payoutPerShare: 1 });
    expect(credit.payout).toBe(20);
    const cash = 38 + credit.payout;
    const size = computeBuySize({ startingCash: S, cash });
    expect(size).toMatchObject({ ok: true, amount: 1 });
  });

  it("keeps sizing isolated per experiment bankroll", () => {
    const a = computeBuySize({ startingCash: 380, cash: 380 });
    const b = computeBuySize({ startingCash: 1000, cash: 380 });
    expect(a).toMatchObject({ ok: true, amount: 3.8, reservedCash: 38 });
    expect(b).toMatchObject({ ok: true, amount: 3.8, reservedCash: 100 });
    expect(a.spendableCash).not.toBe(b.spendableCash);
  });
});
