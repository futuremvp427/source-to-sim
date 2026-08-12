import { describe, expect, it } from "vitest";

import {
  GS_COHORT,
  GS_GO_LIVE_TS,
  classifyMarketCategory,
  dailyStatus,
  gsHandleFromName,
  isGeneralShadowName,
  normalizeActivity,
  periodStartMs,
  profitStatus,
} from "./general-shadow";

describe("general shadow cohort", () => {
  it("identifies both wallets by address", () => {
    expect(GS_COHORT.map((c) => c.wallet)).toEqual([
      "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
      "0x204f72f35326db932158cba6adff0b9a1da95e14",
    ]);
  });

  it("keeps naming isolated from the weather cohorts", () => {
    expect(isGeneralShadowName("GENERAL SHADOW: RN1")).toBe(true);
    expect(isGeneralShadowName("SHADOW V2: Poligarch")).toBe(false);
    expect(isGeneralShadowName("SHADOW V3 CAPACITY: Poligarch")).toBe(false);
    expect(gsHandleFromName("GENERAL SHADOW: swisstony")).toBe("swisstony");
  });
});

describe("category classification", () => {
  it("classifies without filtering", () => {
    expect(classifyMarketCategory("Tampa Bay Rays vs. Athletics: O/U 10.5", "mlb-tb-oak")).toBe("sports");
    expect(classifyMarketCategory("Presidential election winner")).toBe("politics");
    expect(classifyMarketCategory("Bitcoin above $150k")).toBe("crypto");
    expect(classifyMarketCategory("Highest temperature in Paris")).toBe("weather");
    expect(classifyMarketCategory("Something else entirely")).toBe("other");
  });
});

describe("non-trade activity", () => {
  const raw = [
    { type: "TRADE", side: "BUY", timestamp: GS_GO_LIVE_TS + 10, asset: "a", transactionHash: "0x1", size: 5 },
    { type: "REDEEM", timestamp: GS_GO_LIVE_TS + 20, asset: "a", transactionHash: "0x2", usdcSize: 12 },
    { type: "MERGE", timestamp: GS_GO_LIVE_TS - 100, asset: "b", transactionHash: "0x3", size: 2 },
  ];

  it("never turns MERGE or REDEEM into a trade and marks economics unresolved", () => {
    const out = normalizeActivity(raw, "0xABC", GS_GO_LIVE_TS);
    expect(out.map((a) => a.activityType)).toEqual(["MERGE", "REDEEM"]);
    expect(out.every((a) => a.economicsStatus === "UNKNOWN_UNRESOLVED")).toBe(true);
    expect(out.find((a) => a.activityType === "MERGE")?.postGoLive).toBe(false);
    expect(out.find((a) => a.activityType === "REDEEM")?.postGoLive).toBe(true);
  });

  it("is idempotent across identical re-reads", () => {
    const a = normalizeActivity(raw, "0xabc", GS_GO_LIVE_TS).map((x) => x.eventKey);
    const b = normalizeActivity(raw, "0xabc", GS_GO_LIVE_TS).map((x) => x.eventKey);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });
});

describe("profitability windows", () => {
  const nowMs = Date.UTC(2026, 7, 20);
  const goLiveMs = GS_GO_LIVE_TS * 1000;

  it("treats zero as FLAT, never GREEN", () => {
    expect(
      profitStatus({ pnl: 0, periodStartMs: goLiveMs, goLiveMs, hasObservations: true }),
    ).toBe("FLAT");
    expect(dailyStatus(0)).toBe("FLAT");
  });

  it("labels uncovered periods INCOMPLETE", () => {
    expect(
      profitStatus({ pnl: 25, periodStartMs: periodStartMs("YTD", nowMs, goLiveMs), goLiveMs, hasObservations: true }),
    ).toBe("INCOMPLETE");
  });

  it("is UNAVAILABLE without observations", () => {
    expect(
      profitStatus({ pnl: null, periodStartMs: goLiveMs, goLiveMs, hasObservations: false }),
    ).toBe("UNAVAILABLE");
  });

  it("ALL starts at our own go-live boundary, not wallet lifetime", () => {
    expect(periodStartMs("ALL", nowMs, goLiveMs)).toBe(goLiveMs);
  });

  it("GREEN only when measured P&L is positive", () => {
    expect(profitStatus({ pnl: 1, periodStartMs: goLiveMs, goLiveMs, hasObservations: true })).toBe("GREEN");
    expect(profitStatus({ pnl: -1, periodStartMs: goLiveMs, goLiveMs, hasObservations: true })).toBe("RED");
  });
});