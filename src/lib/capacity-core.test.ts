import { describe, expect, it } from "vitest";

import {
  buildCapacityRow,
  cashMaxDrawdown,
  groupCapacityRows,
  reserveFor,
  type CapacityRowInput,
} from "./capacity-core";
import { SIZING_RESERVE_FRACTION } from "./shadow-core";

function baseInput(over: Partial<CapacityRowInput> = {}): CapacityRowInput {
  return {
    id: "e1",
    name: "SHADOW V3 CAPACITY: badatmath.",
    cohort: "V3",
    handle: "badatmath.",
    wallet: "0xabc",
    startingBankroll: 1000,
    cash: 950,
    realizedPnl: -20,
    openCostBasis: 70,
    buys: 10,
    sells: 2,
    insufficientCashSkips: 0,
    settledMarkets: 1,
    cashPoints: [],
    ...over,
  };
}

describe("reserveFor", () => {
  it("is 10% of the starting bankroll", () => {
    expect(SIZING_RESERVE_FRACTION).toBe(0.1);
    expect(reserveFor(1000)).toBe(100);
    expect(reserveFor(380)).toBe(38);
  });

  it("never goes negative", () => {
    expect(reserveFor(-5)).toBe(0);
  });
});

describe("cashMaxDrawdown", () => {
  it("is zero when cash never falls below its running peak", () => {
    expect(
      cashMaxDrawdown(1000, [
        { createdAt: "2026-08-01T00:00:00Z", cashAfter: 1000 },
        { createdAt: "2026-08-02T00:00:00Z", cashAfter: 1010 },
      ]),
    ).toBe(0);
  });

  it("measures running peak minus current cash", () => {
    expect(
      cashMaxDrawdown(1000, [
        { createdAt: "2026-08-01T00:00:00Z", cashAfter: 995 },
        { createdAt: "2026-08-03T00:00:00Z", cashAfter: 940 },
        { createdAt: "2026-08-04T00:00:00Z", cashAfter: 1005 },
        { createdAt: "2026-08-05T00:00:00Z", cashAfter: 980 },
      ]),
    ).toBe(60);
  });

  it("orders by created_at regardless of input order and ignores null cash", () => {
    expect(
      cashMaxDrawdown(1000, [
        { createdAt: "2026-08-05T00:00:00Z", cashAfter: 900 },
        { createdAt: "2026-08-01T00:00:00Z", cashAfter: 1100 },
        { createdAt: "2026-08-03T00:00:00Z", cashAfter: null },
      ]),
    ).toBe(200);
  });

  it("returns 0 with no cash points", () => {
    expect(cashMaxDrawdown(1000, [])).toBe(0);
  });
});

describe("buildCapacityRow", () => {
  it("derives reserve, spendable, roi and cash drawdown", () => {
    const row = buildCapacityRow(
      baseInput({
        cashPoints: [
          { createdAt: "2026-08-01T00:00:00Z", cashAfter: 990 },
          { createdAt: "2026-08-02T00:00:00Z", cashAfter: 950 },
        ],
      }),
    );
    expect(row.reserve).toBe(100);
    expect(row.spendable).toBe(850);
    expect(row.roi).toBeCloseTo(-0.02, 10);
    expect(row.maxDrawdownCash).toBe(50);
  });

  it("floors spendable at zero and nulls roi without a bankroll", () => {
    const row = buildCapacityRow(baseInput({ cash: 40, startingBankroll: 0 }));
    expect(row.spendable).toBe(0);
    expect(row.roi).toBeNull();
  });
});

describe("groupCapacityRows", () => {
  it("pairs V2 and V3 rows per wallet in cohort order", () => {
    const v3 = buildCapacityRow(baseInput());
    const v2 = buildCapacityRow(
      baseInput({ id: "e2", cohort: "V2", name: "SHADOW V2: badatmath.", startingBankroll: 380, cash: 300 }),
    );
    const groups = groupCapacityRows([v3, v2], [
      { handle: "badatmath.", wallet: "0xabc" },
      { handle: "gghff", wallet: "0xdef" },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.v2?.id).toBe("e2");
    expect(groups[0]!.v3?.id).toBe("e1");
    expect(groups[0]!.v2?.reserve).toBe(38);
    expect(groups[1]!.v2).toBeNull();
    expect(groups[1]!.v3).toBeNull();
  });
});
