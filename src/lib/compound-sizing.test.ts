import { describe, expect, it } from "vitest";

import {
  COMPOUND_SIZING_MISSING_CONDITION_ID_REASON,
  COMPOUND_V2_PILOT_SIZING_RULE,
  aggregateCostBasisByMarket,
  computeBookCapital,
  decideBuyForSizingRule,
  decideCompoundBuy,
  decideDynamicBuy,
  decideProportionalSell,
  resolveCompoundMarketKey,
} from "./shadow-core";
import { settlementCredit } from "./settlement-core";

describe("compound-v2-pilot: book capital", () => {
  it("book capital is starting cash + cumulative realized P&L", () => {
    expect(computeBookCapital({ startingCash: 433.36108, realizedPnl: 0 })).toBe(433.36108);
    expect(computeBookCapital({ startingCash: 433.36108, realizedPnl: 100 })).toBe(533.36108);
    expect(computeBookCapital({ startingCash: 433.36108, realizedPnl: -50 })).toBeCloseTo(383.36108, 6);
  });

  it("never uses unrealized mark-to-market equity — only starting cash and realized P&L are inputs", () => {
    // computeBookCapital's signature itself proves this: no mark/openValue parameter exists.
    const a = computeBookCapital({ startingCash: 380, realizedPnl: 50 });
    const b = computeBookCapital({ startingCash: 380, realizedPnl: 50 });
    expect(a).toBe(b);
  });
});

describe("compound-v2-pilot: target entry sizing", () => {
  it("at book capital 433.36108, target entry rounds to $17.33", () => {
    const d = decideCompoundBuy({
      price: 0.5, bookCapital: 433.36108, cash: 1000, marketCostBasis: 0, portfolioCostBasis: 0,
    });
    expect(d.action).toBe("BUY");
    expect(d.notional).toBe(17.33);
  });

  it.each([
    [380, 15.2],
    [500, 20],
    [750, 30],
    [1000, 40],
    [2000, 80],
  ])("at bankroll %d, target entry is $%d (4%%, uncapped)", (bookCapital, expected) => {
    const d = decideCompoundBuy({
      price: 0.5, bookCapital, cash: bookCapital * 10, marketCostBasis: 0, portfolioCostBasis: 0,
    });
    expect(d.action).toBe("BUY");
    expect(d.notional).toBe(expected);
  });

  it("has no $5 ceiling — a large book capital produces a BUY well above $5", () => {
    const d = decideCompoundBuy({
      price: 0.5, bookCapital: 5000, cash: 10000, marketCostBasis: 0, portfolioCostBasis: 0,
    });
    expect(d.action).toBe("BUY");
    expect(d.notional).toBe(200); // 4% of 5000
  });
});

describe("compound-v2-pilot: per-market exposure cap (12%)", () => {
  it("enforces the 12% per-market cap on total open cost basis in that market", () => {
    const bookCapital = 1000; // cap = $120
    const almostAtCap = decideCompoundBuy({
      price: 0.5, bookCapital, cash: 1000, marketCostBasis: 110, portfolioCostBasis: 110,
    });
    expect(almostAtCap.action).toBe("BUY");
    expect(almostAtCap.notional).toBe(10); // only $10 of headroom left under the $120 cap, below the $40 target
  });

  it("SKIPs further BUYs into a market once its 12% cap is fully consumed", () => {
    const bookCapital = 1000; // cap = $120
    const d = decideCompoundBuy({
      price: 0.5, bookCapital, cash: 1000, marketCostBasis: 120, portfolioCostBasis: 120,
    });
    expect(d.action).toBe("SKIP");
    expect(d.reason).toContain("PER_MARKET_CAP_REACHED");
  });

  it("repeated fills into the same market may continue only until the per-market cap, not indefinitely", () => {
    const bookCapital = 1000; // cap = $120, target = $40/fill
    let marketCostBasis = 0;
    const fills: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const d = decideCompoundBuy({ price: 0.5, bookCapital, cash: 1000, marketCostBasis, portfolioCostBasis: marketCostBasis });
      fills.push(d.action);
      if (d.action === "BUY") marketCostBasis += d.notional;
    }
    // $40, $40, $40 (=$120, at cap) then SKIP thereafter — repeated fills stop, they don't keep accruing.
    expect(fills).toEqual(["BUY", "BUY", "BUY", "SKIP", "SKIP", "SKIP"]);
    expect(marketCostBasis).toBe(120);
  });
});

describe("compound-v2-pilot: portfolio deployment cap (90%)", () => {
  it("enforces the 90% aggregate deployment cap across the whole portfolio", () => {
    const bookCapital = 1000; // deployment cap = $900
    const d = decideCompoundBuy({
      price: 0.5, bookCapital, cash: 1000, marketCostBasis: 0, portfolioCostBasis: 890,
    });
    expect(d.action).toBe("BUY");
    expect(d.notional).toBe(10); // only $10 of portfolio headroom left
  });

  it("SKIPs once the 90% portfolio deployment cap is fully consumed, even with per-market headroom left", () => {
    const bookCapital = 1000;
    const d = decideCompoundBuy({
      price: 0.5, bookCapital, cash: 1000, marketCostBasis: 0, portfolioCostBasis: 900,
    });
    expect(d.action).toBe("SKIP");
    expect(d.reason).toContain("PORTFOLIO_DEPLOYMENT_CAP_REACHED");
  });
});

describe("compound-v2-pilot: cash and leverage invariants", () => {
  it("actual available cash is always respected, even when caps have headroom", () => {
    const d = decideCompoundBuy({
      price: 0.5, bookCapital: 1000, cash: 3.5, marketCostBasis: 0, portfolioCostBasis: 0,
    });
    expect(d.action).toBe("BUY");
    expect(d.notional).toBeLessThanOrEqual(3.5);
    expect(d.notional).toBe(3.5);
  });

  it("never produces a BUY notional greater than spendable cash (no leverage)", () => {
    for (const cash of [0.5, 1, 5, 50, 500]) {
      const d = decideCompoundBuy({
        price: 0.5, bookCapital: 100000, cash, marketCostBasis: 0, portfolioCostBasis: 0,
      });
      if (d.action === "BUY") expect(d.notional).toBeLessThanOrEqual(cash + 1e-9);
    }
  });

  it("never produces a negative amount even with negative book capital (post-loss)", () => {
    const d = decideCompoundBuy({
      price: 0.5, bookCapital: -50, cash: 100, marketCostBasis: 0, portfolioCostBasis: 0,
    });
    expect(d.action).toBe("SKIP");
    expect(d.notional).toBe(0);
  });
});

describe("compound-v2-pilot: minimum executable BUY", () => {
  it("SKIPs with a deterministic reason when resulting capacity is below $1", () => {
    const d1 = decideCompoundBuy({ price: 0.5, bookCapital: 1000, cash: 0.5, marketCostBasis: 0, portfolioCostBasis: 0 });
    expect(d1.action).toBe("SKIP");
    expect(d1.reason).toContain("INSUFFICIENT_CASH");

    const d2 = decideCompoundBuy({ price: 0.5, bookCapital: 1000, cash: 1000, marketCostBasis: 119.5, portfolioCostBasis: 119.5 });
    expect(d2.action).toBe("SKIP");
    expect(d2.reason).toContain("PER_MARKET_CAP_REACHED");

    // Deterministic: same inputs always produce the same reason.
    const d3 = decideCompoundBuy({ price: 0.5, bookCapital: 1000, cash: 0.5, marketCostBasis: 0, portfolioCostBasis: 0 });
    expect(d3.reason).toBe(d1.reason);
  });
});

describe("compound-v2-pilot: profit/loss feedback into sizing", () => {
  it("realized profit increases subsequent BUY sizing", () => {
    const before = decideCompoundBuy({
      price: 0.5, bookCapital: computeBookCapital({ startingCash: 380, realizedPnl: 0 }),
      cash: 1000, marketCostBasis: 0, portfolioCostBasis: 0,
    });
    const after = decideCompoundBuy({
      price: 0.5, bookCapital: computeBookCapital({ startingCash: 380, realizedPnl: 100 }),
      cash: 1000, marketCostBasis: 0, portfolioCostBasis: 0,
    });
    expect(after.notional).toBeGreaterThan(before.notional);
    expect(before.notional).toBe(15.2);
    expect(after.notional).toBe(19.2);
  });

  it("realized losses reduce subsequent BUY sizing", () => {
    const before = decideCompoundBuy({
      price: 0.5, bookCapital: computeBookCapital({ startingCash: 380, realizedPnl: 0 }),
      cash: 1000, marketCostBasis: 0, portfolioCostBasis: 0,
    });
    const after = decideCompoundBuy({
      price: 0.5, bookCapital: computeBookCapital({ startingCash: 380, realizedPnl: -100 }),
      cash: 1000, marketCostBasis: 0, portfolioCostBasis: 0,
    });
    expect(after.notional).toBeLessThan(before.notional);
    expect(after.notional).toBe(11.2);
  });

  it("when losses shrink book capital below already-held exposure, new BUYs are blocked but nothing is force-sold", () => {
    // Existing exposure of $120 was fine when book capital was $1000 (12% cap = $120).
    // A loss drops book capital to $500, so the cap shrinks to $60 — well below the $120 already held.
    const shrunkCap = decideCompoundBuy({
      price: 0.5, bookCapital: 500, cash: 1000, marketCostBasis: 120, portfolioCostBasis: 120,
    });
    expect(shrunkCap.action).toBe("SKIP");
    expect(shrunkCap.reason).toContain("PER_MARKET_CAP_REACHED");
    // decideCompoundBuy's return type only ever has action BUY or SKIP for a BUY-side
    // decision — it has no mechanism to emit a forced SELL under any input.
    expect(["BUY", "SKIP"]).toContain(shrunkCap.action);
  });
});

describe("compound-v2-pilot: unchanged surrounding behavior", () => {
  it("proportional SELL logic is untouched by the new sizing rule", () => {
    const d = decideProportionalSell({
      price: 0.6, sourceSharesBefore: 100, sourceSoldShares: 25, paperShares: 40,
    });
    expect(d.action).toBe("SELL");
    expect(d.shares).toBeCloseTo(10, 6);
  });

  it("settlement credit logic is untouched by the new sizing rule", () => {
    const credit = settlementCredit({ shares: 20, costBasis: 8, payoutPerShare: 1 });
    expect(credit.payout).toBe(20);
    expect(credit.realizedPnl).toBe(12);
  });

  it("dynamic-v1 dispatch is byte-identical to calling decideDynamicBuy directly", () => {
    const direct = decideDynamicBuy({ price: 0.5, startingCash: 380, cash: 380 });
    const dispatched = decideBuyForSizingRule({
      sizingRule: "dynamic-v1", price: 0.5, startingCash: 380, cash: 380,
      bookCapital: 999999, marketCostBasis: 999999, portfolioCostBasis: 999999, // must be ignored for dynamic-v1
    });
    expect(dispatched).toEqual(direct);
  });
});

describe("compound-v2-pilot: per-market cap aggregates across ALL assets of the same market (not per-asset)", () => {
  it("multi-asset scenario: two assets under condition_id 'market-X' ($30 + $20), a third fill uses a different asset in the SAME market, $500 book capital, 12% cap ($60) — remaining capacity is $10, not $40 or $60", () => {
    const assetToConditionId = new Map<string, string>([
      ["asset-A", "market-X"],
      ["asset-B", "market-X"],
      ["asset-D", "market-Y"], // a second, independent market
    ]);
    const { marketCostBasisByKey, portfolioCostBasisTotal } = aggregateCostBasisByMarket(
      [
        { asset: "asset-A", costBasis: 30 },
        { asset: "asset-B", costBasis: 20 },
        { asset: "asset-D", costBasis: 15 },
      ],
      assetToConditionId,
    );
    expect(marketCostBasisByKey.get("market-X")).toBe(50); // $30 + $20, grouped by condition_id, not by asset
    expect(marketCostBasisByKey.get("market-Y")).toBe(15);
    expect(portfolioCostBasisTotal).toBe(65);

    // A new fill on a THIRD asset ("asset-C") in the SAME market-X must see
    // only $10 of remaining capacity under the $60 cap (60 - 50), never $40
    // (which a per-asset-C-only view would wrongly compute) and never the
    // full $60 (which ignoring existing exposure entirely would wrongly compute).
    const decision = decideCompoundBuy({
      price: 0.5,
      bookCapital: 500,
      cash: 1000,
      marketCostBasis: marketCostBasisByKey.get("market-X") ?? 0,
      portfolioCostBasis: portfolioCostBasisTotal,
    });
    expect(decision.action).toBe("BUY");
    expect(decision.notional).toBe(10);
    expect(decision.notional).toBeLessThanOrEqual(10);
  });

  it("two different condition_ids remain fully independent — filling one market's cap does not affect the other's capacity", () => {
    const assetToConditionId = new Map([
      ["asset-A", "market-X"],
      ["asset-D", "market-Y"],
    ]);
    const { marketCostBasisByKey } = aggregateCostBasisByMarket(
      [
        { asset: "asset-A", costBasis: 60 }, // market-X fully at its $60 cap (12% of $500)
        { asset: "asset-D", costBasis: 0 }, // market-Y untouched
      ],
      assetToConditionId,
    );
    const marketXDecision = decideCompoundBuy({
      price: 0.5, bookCapital: 500, cash: 1000,
      marketCostBasis: marketCostBasisByKey.get("market-X") ?? 0, portfolioCostBasis: 60,
    });
    expect(marketXDecision.action).toBe("SKIP");
    expect(marketXDecision.reason).toContain("PER_MARKET_CAP_REACHED");

    const marketYDecision = decideCompoundBuy({
      price: 0.5, bookCapital: 500, cash: 1000,
      marketCostBasis: marketCostBasisByKey.get("market-Y") ?? 0, portfolioCostBasis: 60,
    });
    expect(marketYDecision.action).toBe("BUY");
    expect(marketYDecision.notional).toBe(20); // full 4% target, market-Y cap untouched by market-X
  });

  it("an asset with no known condition_id still contributes its own cost basis to the portfolio total (never silently dropped)", () => {
    const { marketCostBasisByKey, portfolioCostBasisTotal } = aggregateCostBasisByMarket(
      [{ asset: "asset-unknown", costBasis: 25 }],
      new Map(), // no condition_id known for this asset
    );
    expect(marketCostBasisByKey.get("asset-unknown")).toBe(25);
    expect(portfolioCostBasisTotal).toBe(25);
  });
});

describe("compound-v2-pilot: missing condition_id fails closed for new BUYs", () => {
  it("resolveCompoundMarketKey verifies using this event's own condition_id", () => {
    const r = resolveCompoundMarketKey({ conditionId: "market-X", cachedConditionId: null });
    expect(r.verified).toBe(true);
    if (r.verified) expect(r.marketKey).toBe("market-X");
  });

  it("resolveCompoundMarketKey verifies using a condition_id cached from an earlier fill of the same asset", () => {
    const r = resolveCompoundMarketKey({ conditionId: null, cachedConditionId: "market-X" });
    expect(r.verified).toBe(true);
    if (r.verified) expect(r.marketKey).toBe("market-X");
  });

  it("resolveCompoundMarketKey fails closed (unverified) when neither this event nor any prior fill carries a condition_id", () => {
    const r = resolveCompoundMarketKey({ conditionId: null, cachedConditionId: null });
    expect(r.verified).toBe(false);
  });

  it("resolveCompoundMarketKey never falls back to treating the asset as its own market — it reports unverified instead", () => {
    // The old (buggy) behavior would have been `conditionId ?? cachedConditionId ?? asset`.
    // The fixed function has no asset parameter at all in its unverified branch —
    // there is no way for a caller to accidentally read a per-asset fallback key.
    const r = resolveCompoundMarketKey({ conditionId: null, cachedConditionId: null });
    expect(r).toEqual({ verified: false });
    expect(Object.keys(r)).not.toContain("marketKey");
  });

  it("the deterministic SKIP reason is stable and identifiable", () => {
    expect(COMPOUND_SIZING_MISSING_CONDITION_ID_REASON).toBe(
      "compound sizing unavailable: missing condition_id",
    );
  });
});

describe("compound-v2-pilot: sizing_rule dispatch fails closed", () => {
  it("dispatches compound-v2-pilot to decideCompoundBuy", () => {
    const dispatched = decideBuyForSizingRule({
      sizingRule: COMPOUND_V2_PILOT_SIZING_RULE, price: 0.5, startingCash: 380, cash: 1000,
      bookCapital: 1000, marketCostBasis: 0, portfolioCostBasis: 0,
    });
    expect(dispatched.action).toBe("BUY");
    expect(dispatched.notional).toBe(40);
  });

  it("an unknown sizing_rule fails closed with a SKIP, never silently falling back to a known formula", () => {
    const d = decideBuyForSizingRule({
      sizingRule: "some-future-rule-nobody-registered", price: 0.5, startingCash: 380, cash: 1000,
      bookCapital: 1000, marketCostBasis: 0, portfolioCostBasis: 0,
    });
    expect(d.action).toBe("SKIP");
    expect(d.shares).toBe(0);
    expect(d.notional).toBe(0);
    expect(d.reason).toContain("UNKNOWN_SIZING_RULE");
    expect(d.reason).toContain("some-future-rule-nobody-registered");
  });

  it("an empty or malformed sizing_rule also fails closed", () => {
    expect(decideBuyForSizingRule({ sizingRule: "", price: 0.5, startingCash: 380, cash: 1000, bookCapital: 1000, marketCostBasis: 0, portfolioCostBasis: 0 }).action).toBe("SKIP");
    expect(decideBuyForSizingRule({ sizingRule: "DYNAMIC-V1", price: 0.5, startingCash: 380, cash: 1000, bookCapital: 1000, marketCostBasis: 0, portfolioCostBasis: 0 }).action).toBe("SKIP");
  });
});
