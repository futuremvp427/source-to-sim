import { describe, expect, it } from "vitest";
import { AGGREGATION_WINDOW_SECONDS, decideFill, deriveEpisodeKey, isEpisodeOpen, processFillsForTest, remainingShares, type EligibleFill, type OpenEpisodeState } from "./episode";

function fill(overrides: Partial<EligibleFill> = {}): EligibleFill {
  return {
    eventKey: "tx:0xabc:0",
    wallet: "0xwallet",
    conditionId: "0xcond",
    asset: "asset1",
    side: "BUY",
    shares: 10,
    price: 0.5,
    sourceTs: 1_000_000,
    detectedAt: 1_000_000_500,
    ...overrides,
  };
}

describe("deriveEpisodeKey", () => {
  it("is deterministic for the same wallet/condition/asset/anchor fill", () => {
    expect(deriveEpisodeKey("0xw", "0xc", "a1", "tx:0x1:0")).toBe(deriveEpisodeKey("0xw", "0xc", "a1", "tx:0x1:0"));
  });

  it("differs when the anchor fill differs", () => {
    expect(deriveEpisodeKey("0xw", "0xc", "a1", "tx:0x1:0")).not.toBe(deriveEpisodeKey("0xw", "0xc", "a1", "tx:0x2:0"));
  });

  it("differs across wallet, condition, and asset independently", () => {
    const base = deriveEpisodeKey("0xw", "0xc", "a1", "tx:0x1:0");
    expect(deriveEpisodeKey("0xother", "0xc", "a1", "tx:0x1:0")).not.toBe(base);
    expect(deriveEpisodeKey("0xw", "0xother", "a1", "tx:0x1:0")).not.toBe(base);
    expect(deriveEpisodeKey("0xw", "0xc", "a2", "tx:0x1:0")).not.toBe(base);
  });
});

describe("decideFill — episode creation and burst trigger", () => {
  it("1/2. first BUY creates one episode and triggers exactly once", () => {
    const d = decideFill(fill(), null);
    expect(d.kind).toBe("NEW_EPISODE");
    expect(d.shouldTriggerBurst).toBe(true);
    if (d.kind === "NEW_EPISODE") {
      expect(d.episodeKey).toBe(deriveEpisodeKey("0xwallet", "0xcond", "asset1", "tx:0xabc:0"));
      expect(d.anchorEventKey).toBe("tx:0xabc:0");
      expect(d.nextState.triggered).toBe(true);
      expect(d.nextState.processedEventKeys.has("tx:0xabc:0")).toBe(true);
    }
  });

  it("20. same market but different wallet is a separate episode", () => {
    const first = decideFill(fill(), null);
    if (first.kind !== "NEW_EPISODE") throw new Error("expected NEW_EPISODE");
    const second = decideFill(fill({ eventKey: "tx:0xother:0", wallet: "0xother-wallet" }), first.nextState);
    expect(second.kind).toBe("NEW_EPISODE");
  });

  it("21. same wallet/market but different asset/outcome is a separate episode", () => {
    const first = decideFill(fill(), null);
    if (first.kind !== "NEW_EPISODE") throw new Error("expected NEW_EPISODE");
    const second = decideFill(fill({ eventKey: "tx:0xother:0", asset: "asset2" }), first.nextState);
    expect(second.kind).toBe("NEW_EPISODE");
  });

  it("22. same wallet but different condition is a separate episode", () => {
    const first = decideFill(fill(), null);
    if (first.kind !== "NEW_EPISODE") throw new Error("expected NEW_EPISODE");
    const second = decideFill(fill({ eventKey: "tx:0xother:0", conditionId: "0xother-cond" }), first.nextState);
    expect(second.kind).toBe("NEW_EPISODE");
  });
});

describe("decideFill — 30-minute aggregation window", () => {
  const open: OpenEpisodeState = {
    episodeKey: "ep-1",
    anchorEventKey: "tx:0xabc:0",
    wallet: "0xwallet",
    conditionId: "0xcond",
    asset: "asset1",
    firstBuyAt: 1_000_000,
    lastFillAt: 1_000_000,
    vwap: 0.5,
    totalShares: 10,
    totalNotional: 5,
    buyFillCount: 1,
    sellSeen: false,
    firstSellAt: null,
    lastSellAt: null,
    sellCount: 0,
    sellShares: 0,
    sellNotional: 0,
    untrackedSellShares: 0,
    untrackedSellNotional: 0,
    triggered: true,
    processedEventKeys: new Set(["tx:0xabc:0"]),
  };

  it("3. a BUY within 30 minutes aggregates into the open episode", () => {
    const d = decideFill(fill({ eventKey: "tx:0xdef:0", sourceTs: 1_000_000 + 600 }), open);
    expect(d.kind).toBe("AGGREGATED_BUY");
    expect(d.shouldTriggerBurst).toBe(false);
    if (d.kind === "AGGREGATED_BUY") expect(d.episodeKey).toBe("ep-1");
  });

  it("4. an aggregated BUY does not trigger a burst", () => {
    const d = decideFill(fill({ eventKey: "tx:0xdef:0", sourceTs: 1_000_000 + 600 }), open);
    expect(d.shouldTriggerBurst).toBe(false);
  });

  it("5. chain grouping: 10:00 / 10:20 / 10:45 is one episode", () => {
    const base = 1_000_000;
    const fills: EligibleFill[] = [
      fill({ eventKey: "e1", sourceTs: base }), // 10:00
      fill({ eventKey: "e2", sourceTs: base + 20 * 60 }), // 10:20 (20m after e1)
      fill({ eventKey: "e3", sourceTs: base + 45 * 60 }), // 10:45 (25m after e2)
    ];
    const decisions = processFillsForTest(fills);
    expect(decisions.map((d) => d.kind)).toEqual(["NEW_EPISODE", "AGGREGATED_BUY", "AGGREGATED_BUY"]);
    const keys = new Set(decisions.map((d) => ("episodeKey" in d ? d.episodeKey : null)));
    expect(keys.size).toBe(1);
  });

  it("6. a BUY more than 30 minutes after the previous grouped BUY starts a new episode", () => {
    const d = decideFill(fill({ eventKey: "tx:0xghi:0", sourceTs: 1_000_000 + AGGREGATION_WINDOW_SECONDS + 1 }), open);
    expect(d.kind).toBe("NEW_EPISODE_AFTER_30M");
    expect(d.shouldTriggerBurst).toBe(true);
    if (d.kind === "NEW_EPISODE_AFTER_30M") expect(d.episodeKey).not.toBe("ep-1");
  });

  it("7. exactly the 30-minute boundary remains the same episode", () => {
    const d = decideFill(fill({ eventKey: "tx:0xexact:0", sourceTs: 1_000_000 + AGGREGATION_WINDOW_SECONDS }), open);
    expect(d.kind).toBe("AGGREGATED_BUY");
  });

  it("8. 30 minutes + 1ms creates a new episode", () => {
    const d = decideFill(fill({ eventKey: "tx:0xover:0", sourceTs: 1_000_000 + AGGREGATION_WINDOW_SECONDS + 0.001 }), open);
    expect(d.kind).toBe("NEW_EPISODE_AFTER_30M");
  });

  it("does not compare only against the first BUY: a fill 40 minutes after fill #1 but 15 after fill #2 still aggregates", () => {
    const base = 1_000_000;
    const fills: EligibleFill[] = [
      fill({ eventKey: "e1", sourceTs: base }),
      fill({ eventKey: "e2", sourceTs: base + 25 * 60 }), // 25m after e1
      fill({ eventKey: "e3", sourceTs: base + 25 * 60 + 15 * 60 }), // 40m after e1, but 15m after e2
    ];
    const decisions = processFillsForTest(fills);
    expect(decisions.map((d) => d.kind)).toEqual(["NEW_EPISODE", "AGGREGATED_BUY", "AGGREGATED_BUY"]);
  });
});

describe("decideFill — BUY entry metrics (VWAP/shares/notional/count)", () => {
  it("9/10/11/12. computes correct VWAP, total shares, total notional, and fill count across a burst", () => {
    const fills: EligibleFill[] = [
      fill({ eventKey: "e1", sourceTs: 1_000_000, shares: 10, price: 0.5 }),
      fill({ eventKey: "e2", sourceTs: 1_000_060, shares: 20, price: 0.6 }),
      fill({ eventKey: "e3", sourceTs: 1_000_120, shares: 30, price: 0.4 }),
    ];
    const decisions = processFillsForTest(fills);
    const last = decisions.at(-1);
    if (!last || !("nextState" in last) || !last.nextState) throw new Error("expected nextState");
    const expectedShares = 10 + 20 + 30;
    const expectedNotional = 10 * 0.5 + 20 * 0.6 + 30 * 0.4;
    expect(last.nextState.totalShares).toBeCloseTo(expectedShares, 9);
    expect(last.nextState.totalNotional).toBeCloseTo(expectedNotional, 9);
    expect(last.nextState.vwap).toBeCloseTo(expectedNotional / expectedShares, 9);
    expect(last.nextState.buyFillCount).toBe(3);
  });
});

describe("decideFill — SELL semantics", () => {
  const open: OpenEpisodeState = {
    episodeKey: "ep-1",
    anchorEventKey: "tx:0xabc:0",
    wallet: "0xwallet",
    conditionId: "0xcond",
    asset: "asset1",
    firstBuyAt: 1_000_000,
    lastFillAt: 1_000_000,
    vwap: 0.5,
    totalShares: 10,
    totalNotional: 5,
    buyFillCount: 1,
    sellSeen: false,
    firstSellAt: null,
    lastSellAt: null,
    sellCount: 0,
    sellShares: 0,
    sellNotional: 0,
    untrackedSellShares: 0,
    untrackedSellNotional: 0,
    triggered: true,
    processedEventKeys: new Set(["tx:0xabc:0"]),
  };

  it("13. SELL records sellSeen against the open episode", () => {
    const d = decideFill(fill({ side: "SELL", eventKey: "tx:0xsell:0", sourceTs: 1_000_000 + 10 }), open);
    expect(d.kind).toBe("SELL_RECORDED");
    if (d.kind === "SELL_RECORDED" && d.nextState) {
      expect(d.nextState.sellSeen).toBe(true);
      expect(d.nextState.sellCount).toBe(1);
      expect(d.nextState.firstSellAt).toBe(1_000_000 + 10);
      expect(d.nextState.lastSellAt).toBe(1_000_000 + 10);
    }
  });

  it("14. SELL does not alter BUY VWAP", () => {
    const d = decideFill(fill({ side: "SELL", eventKey: "tx:0xsell:0", sourceTs: 1_000_000 + 10, price: 0.9 }), open);
    if (d.kind === "SELL_RECORDED" && d.nextState) expect(d.nextState.vwap).toBeCloseTo(0.5, 9);
  });

  it("15. SELL does not alter BUY shares/notional", () => {
    const d = decideFill(fill({ side: "SELL", eventKey: "tx:0xsell:0", sourceTs: 1_000_000 + 10, shares: 999 }), open);
    if (d.kind === "SELL_RECORDED" && d.nextState) {
      expect(d.nextState.totalShares).toBe(10);
      expect(d.nextState.totalNotional).toBe(5);
      expect(d.nextState.buyFillCount).toBe(1);
    }
  });

  it("16. SELL never triggers a burst", () => {
    expect(decideFill(fill({ side: "SELL", eventKey: "tx:0xsell:0" }), null).shouldTriggerBurst).toBe(false);
    expect(decideFill(fill({ side: "SELL", eventKey: "tx:0xsell:0", sourceTs: 1_000_000 + 10 }), open).shouldTriggerBurst).toBe(false);
  });

  it("SELL with no existing episode is recorded as unassociated evidence, never creates one", () => {
    const d = decideFill(fill({ side: "SELL", eventKey: "tx:0xsell:0" }), null);
    expect(d.kind).toBe("SELL_RECORDED");
    if (d.kind === "SELL_RECORDED") {
      expect(d.episodeKey).toBeNull();
      expect(d.nextState).toBeNull();
    }
  });
});

describe("decideFill — duplicate/retry safety", () => {
  it("17. a duplicate BUY eventKey is a NOOP (DUPLICATE_FILL)", () => {
    const first = decideFill(fill(), null);
    if (first.kind !== "NEW_EPISODE") throw new Error("expected NEW_EPISODE");
    const withAgg = decideFill(fill({ eventKey: "e2", sourceTs: 1_000_060 }), first.nextState);
    if (withAgg.kind !== "AGGREGATED_BUY" || !withAgg.nextState) throw new Error("expected AGGREGATED_BUY");
    const replay = decideFill(fill({ eventKey: "e2", sourceTs: 1_000_060 }), withAgg.nextState);
    expect(replay.kind).toBe("DUPLICATE_FILL");
    expect(replay.shouldTriggerBurst).toBe(false);
    // NOOP: state is unaffected — shares/count must match withAgg's state exactly.
    expect(withAgg.nextState.totalShares).toBe(20);
    expect(withAgg.nextState.buyFillCount).toBe(2);
  });

  it("18. a duplicate SELL eventKey is a NOOP", () => {
    const first = decideFill(fill(), null);
    if (first.kind !== "NEW_EPISODE") throw new Error("expected NEW_EPISODE");
    const sell = decideFill(fill({ side: "SELL", eventKey: "s1", sourceTs: 1_000_010 }), first.nextState);
    if (sell.kind !== "SELL_RECORDED" || !sell.nextState) throw new Error("expected SELL_RECORDED");
    const replay = decideFill(fill({ side: "SELL", eventKey: "s1", sourceTs: 1_000_010 }), sell.nextState);
    expect(replay.kind).toBe("DUPLICATE_FILL");
    expect(sell.nextState.sellCount).toBe(1);
  });

  it("19. a duplicate of the first (anchor) BUY cannot create a second episode", () => {
    const first = decideFill(fill(), null);
    if (first.kind !== "NEW_EPISODE") throw new Error("expected NEW_EPISODE");
    const replay = decideFill(fill(), first.nextState);
    expect(replay.kind).toBe("DUPLICATE_FILL");
  });

  it("deciding the exact same fill twice against the exact same (null) state is deterministic", () => {
    expect(decideFill(fill(), null)).toEqual(decideFill(fill(), null));
  });
});

describe("decideFill — episode key stability", () => {
  it("23. episode key differs for a genuine >30m new episode on the same position", () => {
    const first = decideFill(fill(), null);
    if (first.kind !== "NEW_EPISODE") throw new Error("expected NEW_EPISODE");
    const later = decideFill(fill({ eventKey: "e2", sourceTs: 1_000_000 + AGGREGATION_WINDOW_SECONDS + 1 }), first.nextState);
    if (later.kind !== "NEW_EPISODE_AFTER_30M") throw new Error("expected NEW_EPISODE_AFTER_30M");
    expect(later.episodeKey).not.toBe(first.episodeKey);
  });

  it("24. episode key is stable across a retried decision", () => {
    const a = decideFill(fill(), null);
    const b = decideFill(fill(), null);
    if (a.kind !== "NEW_EPISODE" || b.kind !== "NEW_EPISODE") throw new Error("expected NEW_EPISODE");
    expect(a.episodeKey).toBe(b.episodeKey);
  });
});

describe("decideFill — source-time vs detection-time", () => {
  it("25. sourceTs and detectedAt remain distinct fields, never fabricated from one another", () => {
    const f = fill({ sourceTs: 1_000_000, detectedAt: 1_050_000_000 });
    const d = decideFill(f, null);
    expect(d.fill.sourceTs).toBe(1_000_000);
    expect(d.fill.detectedAt).toBe(1_050_000_000);
    expect(d.fill.detectedAt).not.toBe(d.fill.sourceTs);
  });
});

describe("decideFill — out-of-order fills", () => {
  const open: OpenEpisodeState = {
    episodeKey: "ep-1",
    anchorEventKey: "e1",
    wallet: "0xwallet",
    conditionId: "0xcond",
    asset: "asset1",
    firstBuyAt: 1_000_000,
    lastFillAt: 1_000_300, // high-water mark from a later fill already processed
    vwap: 0.5,
    totalShares: 20,
    totalNotional: 10,
    buyFillCount: 2,
    sellSeen: false,
    firstSellAt: null,
    lastSellAt: null,
    sellCount: 0,
    sellShares: 0,
    sellNotional: 0,
    untrackedSellShares: 0,
    untrackedSellNotional: 0,
    triggered: true,
    processedEventKeys: new Set(["e1", "e2"]),
  };

  it("26. an out-of-order BUY (sourceTs behind the high-water mark) never emits a duplicate trigger", () => {
    const d = decideFill(fill({ eventKey: "e-late", sourceTs: 1_000_150 }), open);
    expect(d.kind).toBe("LATE_RECONCILIATION");
    expect(d.shouldTriggerBurst).toBe(false);
  });

  it("28. out-of-order reconciliation updates BUY metrics but does not move the high-water mark backward", () => {
    const d = decideFill(fill({ eventKey: "e-late", sourceTs: 1_000_150, shares: 5, price: 0.5 }), open);
    if (d.kind !== "LATE_RECONCILIATION" || !d.nextState) throw new Error("expected LATE_RECONCILIATION");
    expect(d.nextState.totalShares).toBeCloseTo(25, 9);
    expect(d.nextState.buyFillCount).toBe(3);
    expect(d.nextState.lastFillAt).toBe(1_000_300); // unchanged — not moved backward
    expect(d.nextState.firstBuyAt).toBe(1_000_000); // unchanged — the late fill was not earlier than firstBuyAt
  });

  it("27. equal-timestamp fills are ordered deterministically by eventKey in the batch wrapper", () => {
    const fills: EligibleFill[] = [
      fill({ eventKey: "z-last", sourceTs: 5_000 }),
      fill({ eventKey: "a-first", sourceTs: 5_000 }),
    ];
    const decisions = processFillsForTest(fills);
    const [first, second] = decisions;
    if (!first || !second) throw new Error("expected two decisions");
    // "a-first" sorts before "z-last" at the same sourceTs, so it must be the anchor (NEW_EPISODE).
    expect(first.fill.eventKey).toBe("a-first");
    expect(first.kind).toBe("NEW_EPISODE");
    expect(second.fill.eventKey).toBe("z-last");
    expect(second.kind).toBe("AGGREGATED_BUY");
  });
});

describe("decideFill — validation / fail-closed", () => {
  it("29. a non-BUY/SELL side is rejected, not silently accepted", () => {
    const d = decideFill(fill({ side: "MERGE" as unknown as "BUY" }), null);
    expect(d.kind).toBe("INVALID_FILL");
    expect(d.shouldTriggerBurst).toBe(false);
  });

  it("30. zero size is rejected", () => {
    expect(decideFill(fill({ shares: 0 }), null).kind).toBe("INVALID_FILL");
  });

  it("30b. negative size is rejected", () => {
    expect(decideFill(fill({ shares: -5 }), null).kind).toBe("INVALID_FILL");
  });

  it("31. non-finite price is rejected", () => {
    expect(decideFill(fill({ price: Number.NaN }), null).kind).toBe("INVALID_FILL");
    expect(decideFill(fill({ price: Number.POSITIVE_INFINITY }), null).kind).toBe("INVALID_FILL");
  });

  it("31b. out-of-bounds price is rejected", () => {
    expect(decideFill(fill({ price: 0 }), null).kind).toBe("INVALID_FILL");
    expect(decideFill(fill({ price: 1.5 }), null).kind).toBe("INVALID_FILL");
    expect(decideFill(fill({ price: -0.1 }), null).kind).toBe("INVALID_FILL");
  });

  it("32. an invalid (non-finite/non-positive) timestamp is rejected", () => {
    expect(decideFill(fill({ sourceTs: Number.NaN }), null).kind).toBe("INVALID_FILL");
    expect(decideFill(fill({ sourceTs: 0 }), null).kind).toBe("INVALID_FILL");
    expect(decideFill(fill({ detectedAt: Number.NaN }), null).kind).toBe("INVALID_FILL");
  });
});

describe("processFillsForTest — batch convenience", () => {
  it("aggregates a burst of same-position BUYs and starts a second episode after a 31-minute gap", () => {
    const base = 1_000_000;
    const fills: EligibleFill[] = [
      fill({ eventKey: "e1", sourceTs: base }),
      fill({ eventKey: "e2", sourceTs: base + 60 }),
      fill({ eventKey: "e3", sourceTs: base + 1_200 }),
      fill({ eventKey: "e4", sourceTs: base + 1_200 + 1_860 }), // 31 min after e3
    ];
    const decisions = processFillsForTest(fills);
    expect(decisions.map((d) => d.kind)).toEqual(["NEW_EPISODE", "AGGREGATED_BUY", "AGGREGATED_BUY", "NEW_EPISODE_AFTER_30M"]);
    const keys = new Set(decisions.map((d) => ("episodeKey" in d ? d.episodeKey : null)));
    expect(keys.size).toBe(2);
  });

  it("does not aggregate fills for different wallets, conditions, or assets even at the same timestamp", () => {
    const fills: EligibleFill[] = [
      fill({ eventKey: "e1", wallet: "0xw1" }),
      fill({ eventKey: "e2", wallet: "0xw2" }),
      fill({ eventKey: "e3", conditionId: "0xother" }),
      fill({ eventKey: "e4", asset: "asset2" }),
    ];
    const decisions = processFillsForTest(fills);
    expect(decisions.every((d) => d.kind === "NEW_EPISODE")).toBe(true);
  });

  it("replaying the exact same fill list twice through fresh state is fully idempotent decision-for-decision", () => {
    const fills: EligibleFill[] = [
      fill({ eventKey: "e1", sourceTs: 1_000_000 }),
      fill({ eventKey: "e2", sourceTs: 1_000_060 }),
    ];
    expect(processFillsForTest(fills).map((d) => d.kind)).toEqual(processFillsForTest(fills).map((d) => d.kind));
  });
});

describe("CODEX P1-3: source episode inventory lifecycle (open/closed) -- a BUY after full closure must never reopen the old episode", () => {
  it("remainingShares/isEpisodeOpen are pure derived helpers over totalShares/sellShares", () => {
    expect(remainingShares({ totalShares: 10, sellShares: 4 })).toBe(6);
    expect(remainingShares({ totalShares: 10, sellShares: 10 })).toBe(0);
    expect(isEpisodeOpen({ totalShares: 10, sellShares: 4 })).toBe(true);
    expect(isEpisodeOpen({ totalShares: 10, sellShares: 10 })).toBe(false);
  });

  it("BUY 10 -> SELL 10 -> BUY again inside the 30-minute window starts a genuinely NEW episode, never reopening the closed one", () => {
    const buy1 = fill({ eventKey: "buy1", side: "BUY", shares: 10, sourceTs: 1_000_000 });
    const d1 = decideFill(buy1, null);
    expect(d1.kind).toBe("NEW_EPISODE");
    const afterBuy1 = "nextState" in d1 ? d1.nextState! : null;

    const sell1 = fill({ eventKey: "sell1", side: "SELL", shares: 10, sourceTs: 1_000_100 });
    const d2 = decideFill(sell1, afterBuy1);
    expect(d2.kind).toBe("SELL_RECORDED");
    if (d2.kind !== "SELL_RECORDED") throw new Error("unreachable");
    expect(d2.isPreEpoch).toBe(false);
    expect(d2.nextState).not.toBeNull();
    const closedState = d2.nextState!;
    expect(isEpisodeOpen(closedState)).toBe(false);
    expect(remainingShares(closedState)).toBe(0);

    // Well inside the 30-minute aggregation window relative to closedState.lastFillAt.
    const buy2 = fill({ eventKey: "buy2", side: "BUY", shares: 5, sourceTs: 1_000_200 });
    const d3 = decideFill(buy2, closedState);
    expect(d3.kind).toBe("NEW_EPISODE"); // NOT AGGREGATED_BUY -- the old episode is closed
    if (d3.kind !== "NEW_EPISODE") throw new Error("unreachable");
    expect(d3.episodeKey).not.toBe(closedState.episodeKey);
    expect(d3.nextState.totalShares).toBe(5); // a fresh episode, not 10+5
  });

  it("BUY 10 -> SELL 15 (oversell): tracked remaining is capped at 0, the extra 5 is recorded as untracked, never negative inventory", () => {
    const buy = fill({ eventKey: "buy1", side: "BUY", shares: 10, sourceTs: 1_000_000 });
    const d1 = decideFill(buy, null);
    const afterBuy = "nextState" in d1 ? d1.nextState! : null;

    const oversell = fill({ eventKey: "sell-over", side: "SELL", shares: 15, price: 0.6, sourceTs: 1_000_100 });
    const d2 = decideFill(oversell, afterBuy);
    expect(d2.kind).toBe("SELL_RECORDED");
    if (d2.kind !== "SELL_RECORDED") throw new Error("unreachable");
    expect(d2.trackedShares).toBe(10);
    expect(d2.untrackedShares).toBe(5);
    const state = d2.nextState!;
    expect(state.sellShares).toBe(10); // capped at totalShares -- never exceeds it
    expect(remainingShares(state)).toBe(0); // never negative
    expect(state.untrackedSellShares).toBe(5);
    expect(state.untrackedSellNotional).toBeCloseTo(0.6 * 5);
    expect(isEpisodeOpen(state)).toBe(false);
  });

  it("a SELL against an already-fully-closed same-position episode is treated as pre-epoch/untracked, not folded into the closed episode's ledger", () => {
    const buy = fill({ eventKey: "buy1", side: "BUY", shares: 10, sourceTs: 1_000_000 });
    const afterBuy = decideFill(buy, null);
    const closed = decideFill(fill({ eventKey: "sell1", side: "SELL", shares: 10, sourceTs: 1_000_050 }), "nextState" in afterBuy ? afterBuy.nextState! : null);
    const closedState = closed.kind === "SELL_RECORDED" ? closed.nextState! : (() => { throw new Error("unreachable"); })();

    const laterSell = fill({ eventKey: "sell2", side: "SELL", shares: 3, sourceTs: 1_000_100 });
    const decision = decideFill(laterSell, closedState);
    expect(decision.kind).toBe("SELL_RECORDED");
    if (decision.kind !== "SELL_RECORDED") throw new Error("unreachable");
    expect(decision.isPreEpoch).toBe(true);
    expect(decision.nextState).toBeNull(); // never mutates the already-closed episode's ledger
    expect(decision.untrackedShares).toBe(3);
  });

  it("partial SELL (does not fully close) followed by a BUY inside the DCA window still aggregates into the SAME still-open episode", () => {
    const buy1 = fill({ eventKey: "buy1", side: "BUY", shares: 10, sourceTs: 1_000_000 });
    const afterBuy1 = decideFill(buy1, null);
    const state1 = "nextState" in afterBuy1 ? afterBuy1.nextState! : null;

    const partialSell = fill({ eventKey: "sell1", side: "SELL", shares: 4, sourceTs: 1_000_100 });
    const afterSell = decideFill(partialSell, state1);
    expect(afterSell.kind).toBe("SELL_RECORDED");
    const state2 = afterSell.kind === "SELL_RECORDED" ? afterSell.nextState! : (() => { throw new Error("unreachable"); })();
    expect(isEpisodeOpen(state2)).toBe(true); // 10 - 4 = 6 remaining, still open
    expect(remainingShares(state2)).toBe(6);

    const buy2 = fill({ eventKey: "buy2", side: "BUY", shares: 5, sourceTs: 1_000_200 });
    const d3 = decideFill(buy2, state2);
    expect(d3.kind).toBe("AGGREGATED_BUY"); // folds into the SAME still-open episode
    if (d3.kind !== "AGGREGATED_BUY") throw new Error("unreachable");
    expect(d3.episodeKey).toBe(state2.episodeKey);
    expect(d3.nextState.totalShares).toBe(15); // 10 (original BUY) + 5 (new BUY) -- SELL never reduces totalShares
  });

  it("restart-safety: replaying BUY->SELL->BUY through fresh decideFill calls (simulating a process restart between each event, state only threaded via the pure nextState/return value) produces an IDENTICAL result to one continuous run", () => {
    function runSequence(): { kinds: string[]; finalTotalShares: number | null } {
      let state: OpenEpisodeState | null = null;
      const kinds: string[] = [];
      for (const f of [
        fill({ eventKey: "buy1", side: "BUY", shares: 10, sourceTs: 1_000_000 }),
        fill({ eventKey: "sell1", side: "SELL", shares: 10, sourceTs: 1_000_100 }),
        fill({ eventKey: "buy2", side: "BUY", shares: 7, sourceTs: 1_000_200 }),
      ]) {
        const decision = decideFill(f, state);
        kinds.push(decision.kind);
        state = "nextState" in decision ? decision.nextState : null;
      }
      return { kinds, finalTotalShares: state?.totalShares ?? null };
    }
    const first = runSequence();
    const second = runSequence(); // simulates a fresh restart -- decideFill is pure, no module-level state
    expect(second).toEqual(first);
    expect(first.kinds).toEqual(["NEW_EPISODE", "SELL_RECORDED", "NEW_EPISODE"]); // second BUY starts fresh, not AGGREGATED_BUY
    expect(first.finalTotalShares).toBe(7);
  });
});
