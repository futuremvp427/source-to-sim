import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { computeExitFraction, isEpisodeOpen, processFillsForTest, remainingShares } from "./episode";
import {
  admitKalshiSourceEvent,
  deriveKalshiSourceEventKey,
  isTraderQualified,
  normalizeKalshiTraderEvent,
  requiresCrossVenueResolution,
  targetLegForTrade,
  toEligibleFill,
  type KalshiTraderQualification,
  type KalshiTraderSourceEvent,
  type KalshiTraderWatchlist,
} from "./kalshi-source";
import { LIVE_EXECUTION_IMPLEMENTED } from "../live-safety/core";

const TICKER = "KXMLBGAME-26AUG25CHCCIN-CHC";
const TRADER = "kalshi-trader-0001";

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`expected a decision at index ${index}`);
  return value;
}

function watchlistWith(...traderIds: string[]): KalshiTraderWatchlist {
  const map = new Map<string, KalshiTraderQualification>(traderIds.map((id) => [id, { traderId: id, approvedForPaperCopy: true }]));
  return { get: (traderId) => map.get(traderId) ?? null };
}

function rawEvent(overrides: Partial<KalshiTraderSourceEvent> = {}): KalshiTraderSourceEvent {
  return {
    traderId: TRADER,
    sourceTradeId: "trade-1",
    marketTicker: TICKER,
    contractSide: "YES",
    action: "BUY",
    quantity: 100,
    priceCents: 42,
    sourceTsSeconds: 1_756_000_000,
    ...overrides,
  };
}

function admitOk(overrides: Partial<KalshiTraderSourceEvent> = {}) {
  const result = admitKalshiSourceEvent(rawEvent(overrides), watchlistWith(TRADER));
  if (!result.ok) throw new Error(`expected admission, got ${result.reasonCode}`);
  return result.trade;
}

describe("kalshi same-venue source adapter", () => {
  it("keeps the exact Kalshi ticker exact", () => {
    const trade = admitOk();
    expect(trade.marketTicker).toBe(TICKER);
    expect(targetLegForTrade(trade)).toEqual({ venue: "KALSHI", ticker: TICKER, side: "YES" });
  });

  it("never routes through the cross-venue resolver", () => {
    const trade = admitOk();
    expect(trade.route).toBe("SAME_VENUE_KALSHI");
    expect(requiresCrossVenueResolution(trade)).toBe(false);
    const source = readFileSync(new URL("./kalshi-source.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+"\.\/resolver"/);
    expect(source).not.toMatch(/from\s+"\.\/pmus/);
  });

  it("preserves YES/NO orientation and separates the two legs", () => {
    const yes = admitOk({ sourceTradeId: "y", contractSide: "YES" });
    const no = admitOk({ sourceTradeId: "n", contractSide: "NO" });
    const yesFill = toEligibleFill(yes, 1_756_000_001_000);
    const noFill = toEligibleFill(no, 1_756_000_001_000);
    expect(yesFill.asset).toBe(`${TICKER}:YES`);
    expect(noFill.asset).toBe(`${TICKER}:NO`);
    expect(yesFill.asset).not.toBe(noFill.asset);
    expect(yes.price).toBeCloseTo(0.42, 12);
  });

  it("a BUY produces an entry intent via the existing lifecycle reducer", () => {
    const fill = toEligibleFill(admitOk(), 1_756_000_001_000);
    const decision = at(processFillsForTest([fill]), 0);
    expect(decision.kind).toBe("NEW_EPISODE");
    expect(decision.shouldTriggerBurst).toBe(true);
  });

  it("a second BUY uses the existing ADD/DCA aggregation logic", () => {
    const first = toEligibleFill(admitOk({ sourceTradeId: "a", quantity: 100, priceCents: 40 }), 1_000);
    const second = toEligibleFill(admitOk({ sourceTradeId: "b", quantity: 100, priceCents: 50, sourceTsSeconds: 1_756_000_060 }), 2_000);
    const decisions = processFillsForTest([first, second]);
    expect(at(decisions, 0).kind).toBe("NEW_EPISODE");
    const add = at(decisions, 1);
    expect(add.kind).toBe("AGGREGATED_BUY");
    if (add.kind !== "AGGREGATED_BUY") throw new Error("unreachable");
    expect(add.nextState.totalShares).toBe(200);
    expect(add.nextState.vwap).toBeCloseTo(0.45, 12);
  });

  it("a partial SELL uses proportional exit logic", () => {
    const buy = toEligibleFill(admitOk({ sourceTradeId: "a", quantity: 100 }), 1_000);
    const sell = toEligibleFill(admitOk({ sourceTradeId: "s", action: "SELL", quantity: 40, sourceTsSeconds: 1_756_000_120 }), 2_000);
    const exit = at(processFillsForTest([buy, sell]), 1);
    if (exit.kind !== "SELL_RECORDED") throw new Error(`expected SELL_RECORDED, got ${exit.kind}`);
    expect(exit.trackedShares).toBe(40);
    expect(computeExitFraction(exit.trackedShares, 100)).toBeCloseTo(0.4, 12);
    if (exit.nextState === null) throw new Error("expected episode state");
    expect(remainingShares(exit.nextState)).toBe(60);
    expect(isEpisodeOpen(exit.nextState)).toBe(true);
  });

  it("a full SELL closes the copied paper position", () => {
    const buy = toEligibleFill(admitOk({ sourceTradeId: "a", quantity: 100 }), 1_000);
    const sell = toEligibleFill(admitOk({ sourceTradeId: "s", action: "SELL", quantity: 100, sourceTsSeconds: 1_756_000_120 }), 2_000);
    const exit = at(processFillsForTest([buy, sell]), 1);
    if (exit.kind !== "SELL_RECORDED") throw new Error(`expected SELL_RECORDED, got ${exit.kind}`);
    if (exit.nextState === null) throw new Error("expected episode state");
    expect(computeExitFraction(exit.trackedShares, 100)).toBe(1);
    expect(remainingShares(exit.nextState)).toBe(0);
    expect(isEpisodeOpen(exit.nextState)).toBe(false);
  });

  it("a duplicate source event cannot execute twice", () => {
    const trade = admitOk();
    expect(trade.eventKey).toBe(deriveKalshiSourceEventKey(TRADER, "trade-1"));
    const again = admitKalshiSourceEvent(rawEvent(), watchlistWith(TRADER), new Set([trade.eventKey]));
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("unreachable");
    expect(again.reasonCode).toBe("REJECT_DUPLICATE_EVENT");
    const fill = toEligibleFill(trade, 1_000);
    const decisions = processFillsForTest([fill, { ...fill, sourceTs: fill.sourceTs + 1 }]);
    expect(at(decisions, 1).kind).toBe("DUPLICATE_FILL");
  });

  it("malformed or incomplete trader events fail closed", () => {
    const cases: Array<[Partial<KalshiTraderSourceEvent>, string]> = [
      [{ traderId: "  " }, "REJECT_MISSING_TRADER_ID"],
      [{ sourceTradeId: null }, "REJECT_MISSING_TRADE_ID"],
      [{ marketTicker: "" }, "REJECT_MISSING_TICKER"],
      [{ marketTicker: "kxmlbgame lower case" }, "REJECT_MISSING_TICKER"],
      [{ contractSide: "yes" }, "REJECT_INVALID_SIDE"],
      [{ action: "ADD" }, "REJECT_INVALID_ACTION"],
      [{ quantity: 0 }, "REJECT_INVALID_QUANTITY"],
      [{ quantity: Number.NaN }, "REJECT_INVALID_QUANTITY"],
      [{ priceCents: 0 }, "REJECT_INVALID_PRICE"],
      [{ priceCents: 100 }, "REJECT_INVALID_PRICE"],
      [{ sourceTsSeconds: 0 }, "REJECT_INVALID_TIMESTAMP"],
    ];
    for (const [overrides, expected] of cases) {
      const result = normalizeKalshiTraderEvent(rawEvent(overrides));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reasonCode).toBe(expected);
    }
  });

  it("unqualified source activity produces no paper trade", () => {
    expect(isTraderQualified(null, TRADER)).toBe(false);
    expect(isTraderQualified(watchlistWith("someone-else"), TRADER)).toBe(false);
    const notApproved: KalshiTraderWatchlist = { get: () => ({ traderId: TRADER, approvedForPaperCopy: false }) };
    for (const watchlist of [null, watchlistWith("someone-else"), notApproved]) {
      const result = admitKalshiSourceEvent(rawEvent(), watchlist);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reasonCode).toBe("REJECT_TRADER_NOT_QUALIFIED");
    }
  });

  it("the live-order path remains unreachable from this adapter", () => {
    expect(LIVE_EXECUTION_IMPLEMENTED).toBe(false);
    const source = readFileSync(new URL("./kalshi-source.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/fetch\(/);
    expect(source).not.toMatch(/createOrder|placeOrder|\/portfolio\/orders|submitOrder/i);
    expect(source).toMatch(/export interface KalshiTraderActivitySource/);
    expect(source).not.toMatch(/implements KalshiTraderActivitySource/);
  });
});
