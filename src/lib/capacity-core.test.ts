import { describe, expect, it } from "vitest";

import {
  buildCapacityRow,
  cashMaxDrawdown,
  countFreshMarks,
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
    openPositions: 4,
    markedOpenPositions: 3,
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

describe("countFreshMarks", () => {
  const now = Date.parse("2026-08-13T18:00:00.000Z");
  const maxAge = 5 * 60 * 1000;

  it("counts only present marks inside the freshness window", () => {
    expect(
      countFreshMarks(
        [
          { mark: 0.52, markTs: "2026-08-13T17:59:00.000Z" },
          { mark: 0.48, markTs: "2026-08-13T17:55:00.000Z" },
          { mark: 0.61, markTs: "2026-08-13T17:54:59.999Z" },
          { mark: null, markTs: "2026-08-13T17:59:30.000Z" },
          { mark: 0.4, markTs: null },
        ],
        now,
        maxAge,
      ),
    ).toBe(2);
  });

  it("fails closed on invalid or future timestamps", () => {
    expect(
      countFreshMarks(
        [
          { mark: 0.5, markTs: "not-a-date" },
          { mark: 0.5, markTs: "2026-08-13T18:00:00.001Z" },
        ],
        now,
        maxAge,
      ),
    ).toBe(0);
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
  it("derives reserve, spendable, roi, mark coverage and cash deployment", () => {
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
    expect(row.markCoveragePct).toBe(75);
    expect(row.maxDrawdownCash).toBe(50);
  });

  it("reports unavailable mark coverage when there are no open positions", () => {
    expect(buildCapacityRow(baseInput({ openPositions: 0, markedOpenPositions: 0 })).markCoveragePct).toBeNull();
  });

  it("floors spendable at zero when cash sits below the reserve", () => {
    const row = buildCapacityRow(baseInput({ cash: 20, startingBankroll: 380 }));
    expect(row.reserve).toBe(38);
    expect(row.spendable).toBe(0);
  });

  it("nulls roi without a bankroll", () => {
    expect(buildCapacityRow(baseInput({ startingBankroll: 0 })).roi).toBeNull();
  });
});

describe("buildCapacityRow labels raw vs. execution-adjusted P&L (Phase 0A remediation, item 2)", () => {
  it("always carries an explicit RAW IDEALIZED label alongside the unchanged realizedPnl field", () => {
    const row = buildCapacityRow(baseInput({ realizedPnl: 149.84 }));
    // realizedPnl is untouched (backward compatible; no historical/existing
    // consumer field is renamed or silently replaced).
    expect(row.realizedPnl).toBe(149.84);
    expect(row.rawIdealizedPnl.value).toBe(149.84);
    expect(row.rawIdealizedPnl.label).toBe("RAW IDEALIZED P&L");
    expect(row.rawIdealizedPnl.isIdealized).toBe(true);
    expect(row.rawIdealizedPnl.isExecutable).toBe(false);
    expect(row.rawIdealizedPnl.caveat).toMatch(/source wallet/i);
    expect(row.rawIdealizedPnl.caveat).toMatch(/NOT a realistic or executable/i);
  });

  it("defaults executionAdjustedPnl to explicitly unavailable when no adjusted figure is supplied", () => {
    const row = buildCapacityRow(baseInput());
    expect(row.executionAdjustedPnl.available).toBe(false);
    expect(row.executionAdjustedPnl.value).toBeNull();
    if (!row.executionAdjustedPnl.available) {
      expect(row.executionAdjustedPnl.reason.length).toBeGreaterThan(0);
    }
  });

  it("surfaces the execution-adjusted figure distinctly from the raw one when supplied", () => {
    const row = buildCapacityRow(
      baseInput({ realizedPnl: -655.39, executionAdjustedCumulativePnl: -720.1 }),
    );
    expect(row.rawIdealizedPnl.value).toBe(-655.39);
    expect(row.executionAdjustedPnl.available).toBe(true);
    if (row.executionAdjustedPnl.available) {
      expect(row.executionAdjustedPnl.value).toBe(-720.1);
      expect(row.executionAdjustedPnl.label).toBe("EXECUTION-ADJUSTED / SLIPPAGE-ADJUSTED P&L");
      expect(row.executionAdjustedPnl.isExecutable).toBe(false); // still an estimate, never claims to be executable
      expect(row.executionAdjustedPnl.source).toBe("observation_log");
    }
    // The two figures must never collapse to the same field/value silently.
    expect(row.executionAdjustedPnl.value).not.toBe(row.rawIdealizedPnl.value);
  });

  it("an execution-adjusted value of exactly 0 is treated as available, not confused with unavailable", () => {
    const row = buildCapacityRow(baseInput({ executionAdjustedCumulativePnl: 0 }));
    expect(row.executionAdjustedPnl.available).toBe(true);
    if (row.executionAdjustedPnl.available) expect(row.executionAdjustedPnl.value).toBe(0);
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
