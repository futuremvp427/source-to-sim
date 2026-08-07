import { describe, expect, it } from "vitest";

import {
  applyBuy,
  applySell,
  decideBuy,
  decideProportionalSell,
  normalizeSourceEvents,
  openPnl,
  reconcileSourceState,
  replaySourcePositions,
  resolveMark,
  MARK_MAX_AGE_MS,
} from "./shadow-core";

const WALLET = "0xWALLET";

const sameSecondBuy = {
  side: "BUY",
  asset: "a1",
  conditionId: "c1",
  size: 10,
  price: 0.5,
  timestamp: 1786120000,
  title: "Same second market",
  outcome: "Yes",
  transactionHash: "0xsametx",
};

describe("event identity + idempotent replay", () => {
  it("keeps two identical same-second BUYs distinct", () => {
    const events = normalizeSourceEvents([sameSecondBuy, { ...sameSecondBuy }], WALLET);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.eventKey)).size).toBe(2);
    expect(events.every((e) => e.identityDegraded)).toBe(true);
  });

  it("keeps two identical same-second SELLs distinct", () => {
    const sell = { ...sameSecondBuy, side: "SELL" };
    const events = normalizeSourceEvents([sell, { ...sell }], WALLET);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.eventKey)).size).toBe(2);
  });

  it("produces identical keys when the same window is re-fetched (idempotent)", () => {
    const a = normalizeSourceEvents([sameSecondBuy, { ...sameSecondBuy }], WALLET);
    const b = normalizeSourceEvents([sameSecondBuy, { ...sameSecondBuy }], WALLET);
    expect(a.map((e) => e.eventKey)).toEqual(b.map((e) => e.eventKey));
  });

  it("re-fetching a window with a newer trade in front keeps old keys stable", () => {
    const first = normalizeSourceEvents([sameSecondBuy], WALLET);
    const second = normalizeSourceEvents(
      [{ ...sameSecondBuy, timestamp: 1786120500, transactionHash: "0xnew" }, sameSecondBuy],
      WALLET,
    );
    expect(second.map((e) => e.eventKey)).toContain(first[0]!.eventKey);
  });

  it("prefers source id, then tx hash + log index", () => {
    expect(normalizeSourceEvents([{ ...sameSecondBuy, id: "t1" }], WALLET)[0]!.identityBasis).toBe(
      "source_id",
    );
    expect(
      normalizeSourceEvents([{ ...sameSecondBuy, logIndex: 4 }], WALLET)[0]!.identityBasis,
    ).toBe("tx_hash_log_index");
  });

  it("dedupes true repeats that carry a source id", () => {
    const events = normalizeSourceEvents(
      [
        { ...sameSecondBuy, id: "t1" },
        { ...sameSecondBuy, id: "t1" },
      ],
      WALLET,
    );
    expect(events).toHaveLength(1);
  });
});

describe("proportional SELL", () => {
  it("sells the same fraction of the paper position as the source sold", () => {
    const d = decideProportionalSell({
      price: 0.5,
      sourceSharesBefore: 100,
      sourceSoldShares: 25,
      paperShares: 40,
    });
    expect(d.action).toBe("SELL");
    expect(d.shares).toBeCloseTo(10, 6);
  });

  it("fully exits when the source fully exits", () => {
    const d = decideProportionalSell({
      price: 0.4,
      sourceSharesBefore: 80,
      sourceSoldShares: 80,
      paperShares: 33,
    });
    expect(d.shares).toBeCloseTo(33, 6);
  });

  it("never sells more than held when the source oversells", () => {
    const d = decideProportionalSell({
      price: 0.4,
      sourceSharesBefore: 10,
      sourceSoldShares: 50,
      paperShares: 12,
    });
    expect(d.shares).toBeCloseTo(12, 6);
  });

  it("skips with a reason when source state is missing", () => {
    const d = decideProportionalSell({
      price: 0.4,
      sourceSharesBefore: null,
      sourceSoldShares: 10,
      paperShares: 5,
    });
    expect(d.action).toBe("SKIP");
    expect(d.reason).toMatch(/No source position state/);
  });

  it("skips when the paper side holds nothing", () => {
    expect(
      decideProportionalSell({
        price: 0.4,
        sourceSharesBefore: 100,
        sourceSoldShares: 10,
        paperShares: 0,
      }).action,
    ).toBe("SKIP");
  });
});

describe("BUY sizing and cash", () => {
  it("buys a fixed simulated notional", () => {
    const d = decideBuy({ price: 0.25, buyAmount: 10, availableCash: 380 });
    expect(d.action).toBe("BUY");
    expect(d.shares).toBeCloseTo(40, 6);
    expect(d.notional).toBe(10);
  });

  it("skips when simulated cash is insufficient", () => {
    const d = decideBuy({ price: 0.25, buyAmount: 10, availableCash: 4 });
    expect(d.action).toBe("SKIP");
    expect(d.reason).toMatch(/Insufficient simulated cash/);
  });

  it("skips invalid prices", () => {
    expect(decideBuy({ price: 0, buyAmount: 10, availableCash: 380 }).action).toBe("SKIP");
  });
});

describe("paper accounting", () => {
  it("tracks basis, cash and realized P&L across a partial exit", () => {
    let cash = 380;
    let pos = { shares: 0, costBasis: 0, avgPrice: 0, realizedPnl: 0 };
    const buy = applyBuy(pos, cash, 40, 10);
    pos = buy.position;
    cash = buy.cash;
    expect(cash).toBe(370);
    expect(pos.avgPrice).toBeCloseTo(0.25, 6);

    const sell = applySell(pos, cash, 20, 0.5);
    expect(sell.realized).toBeCloseTo(5, 6);
    expect(sell.cash).toBeCloseTo(380, 6);
    expect(sell.position.shares).toBeCloseTo(20, 6);
    expect(sell.position.costBasis).toBeCloseTo(5, 6);
  });
});

describe("reconciliation", () => {
  it("replays source share counts and floors at zero", () => {
    const replayed = replaySourcePositions([
      { asset: "a", side: "BUY", shares: 10 },
      { asset: "a", side: "SELL", shares: 4 },
      { asset: "b", side: "SELL", shares: 3 },
    ]);
    expect(replayed.get("a")).toBeCloseTo(6, 6);
    expect(replayed.get("b")).toBe(0);
  });

  it("detects drift between compact state and the replay", () => {
    const result = reconcileSourceState(new Map([["a", 5]]), new Map([["a", 6]]));
    expect(result.ok).toBe(false);
    expect(result.mismatches[0]).toEqual({ asset: "a", compact: 5, replayed: 6 });
  });
});

describe("marks and open P&L", () => {
  const now = 1_700_000_000_000;

  it("uses a fresh book mid", () => {
    const m = resolveMark({ bestBid: 0.4, bestAsk: 0.5, midpoint: null, markTs: now, nowMs: now });
    expect(m.mark).toBeCloseTo(0.45, 6);
    expect(m.source).toBe("clob_book_mid");
  });

  it("refuses a stale mark", () => {
    const m = resolveMark({
      bestBid: 0.4,
      bestAsk: 0.5,
      midpoint: null,
      markTs: now - MARK_MAX_AGE_MS - 1,
      nowMs: now,
    });
    expect(m.mark).toBeNull();
  });

  it("reports open P&L as Unavailable without a mark", () => {
    expect(openPnl(10, 5, null)).toBeNull();
    expect(openPnl(10, 5, 0.8)).toBeCloseTo(3, 6);
  });
});
