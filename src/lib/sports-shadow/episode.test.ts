import { describe, expect, it } from "vitest";
import { AGGREGATION_WINDOW_SECONDS, decideFill, deriveEpisodeKey, processFillsForTest, type EligibleFill, type OpenEpisodeState } from "./episode";

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
