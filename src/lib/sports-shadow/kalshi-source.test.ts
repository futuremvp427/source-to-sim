import { describe, expect, it } from "vitest";

import { buildSameVenueKalshiRoute, kalshiSourceDedupeKey, type KalshiSourceTrade } from "./kalshi-source";

function trade(overrides: Partial<KalshiSourceTrade> = {}): KalshiSourceTrade {
  return {
    sourceTradeId: "trade-123",
    traderHandle: "TopTrader",
    marketTicker: "kxmlbgame-26sep17-nyybos-nyy",
    side: "YES",
    action: "BUY",
    contracts: 25,
    price: 0.63,
    sourceTsMs: Date.parse("2026-09-17T16:00:00Z"),
    ...overrides,
  };
}

describe("same-venue Kalshi source routing", () => {
  it("routes directly to the exact source ticker without a cross-venue match", () => {
    const decision = buildSameVenueKalshiRoute(trade());
    expect(decision.status).toBe("ROUTABLE");
    if (decision.status !== "ROUTABLE") return;

    expect(decision.route.routeKind).toBe("KALSHI_SAME_VENUE");
    expect(decision.route.marketTicker).toBe("KXMLBGAME-26SEP17-NYYBOS-NYY");
    expect(decision.route.side).toBe("YES");
    expect(decision.route.action).toBe("BUY");
    expect(decision.route.matchingBasis).toBe("SOURCE_MARKET_TICKER");
  });

  it("preserves SELL and NO instead of translating either field", () => {
    const decision = buildSameVenueKalshiRoute(trade({ side: "NO", action: "SELL" }));
    expect(decision.status).toBe("ROUTABLE");
    if (decision.status !== "ROUTABLE") return;
    expect(decision.route.side).toBe("NO");
    expect(decision.route.action).toBe("SELL");
  });

  it("fails closed when the source ticker is unavailable", () => {
    const decision = buildSameVenueKalshiRoute(trade({ marketTicker: "" }));
    expect(decision).toEqual({
      status: "REJECTED",
      reasonCode: "INVALID_MARKET_TICKER",
      reason: "Kalshi market ticker is missing or malformed",
    });
  });

  it("rejects invalid economics instead of fabricating quantity or price", () => {
    expect(buildSameVenueKalshiRoute(trade({ contracts: 0 }))).toMatchObject({ status: "REJECTED", reasonCode: "INVALID_CONTRACTS" });
    expect(buildSameVenueKalshiRoute(trade({ price: Number.NaN }))).toMatchObject({ status: "REJECTED", reasonCode: "INVALID_PRICE" });
    expect(buildSameVenueKalshiRoute(trade({ price: 1.01 }))).toMatchObject({ status: "REJECTED", reasonCode: "INVALID_PRICE" });
  });

  it("builds a stable case-insensitive trader/source idempotency key", () => {
    expect(kalshiSourceDedupeKey(trade())).toBe("kalshi:toptrader:trade-123");
    expect(kalshiSourceDedupeKey({ traderHandle: "", sourceTradeId: "trade-123" })).toBeNull();
  });
});
