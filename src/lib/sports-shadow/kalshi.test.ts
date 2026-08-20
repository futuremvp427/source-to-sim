import { describe, expect, it } from "vitest";
import { classifyKalshiMarket, deriveGameCode, normalizeKalshiBook, type KalshiRawEvent, type KalshiRawMarket } from "./kalshi";

const GAME_EVENT: KalshiRawEvent = {
  event_ticker: "KXMLBGAME-26AUG222040MINSD",
  series_ticker: "KXMLBGAME",
  title: "Minnesota vs San Diego",
  sub_title: "MIN vs SD (Aug 22)",
};

function gameMarket(overrides: Partial<KalshiRawMarket> = {}): KalshiRawMarket {
  return {
    ticker: "KXMLBGAME-26AUG222040MINSD-SD",
    event_ticker: "KXMLBGAME-26AUG222040MINSD",
    market_type: "binary",
    title: "San Diego wins",
    yes_sub_title: "San Diego",
    no_sub_title: "San Diego",
    status: "active",
    open_time: "2026-08-20T00:55:00Z",
    close_time: "2026-08-26T00:40:00Z",
    latest_expiration_time: "2026-08-26T00:40:00Z",
    expected_expiration_time: "2026-08-23T03:40:00Z",
    occurrence_datetime: "2026-08-23T03:40:00Z",
    floor_strike: null,
    strike_type: "structured",
    rules_primary: "If San Diego wins...",
    yes_bid_dollars: "0.5800",
    yes_ask_dollars: "0.6000",
    no_bid_dollars: "0.4000",
    no_ask_dollars: "0.4200",
    ...overrides,
  };
}

const SPREAD_EVENT: KalshiRawEvent = {
  event_ticker: "KXMLBSPREAD-26AUG201310SFCLE",
  series_ticker: "KXMLBSPREAD",
  title: "San Francisco vs Cleveland",
  sub_title: "SF vs CLE (Aug 20)",
};

function spreadMarket(overrides: Partial<KalshiRawMarket> = {}): KalshiRawMarket {
  return {
    ticker: "KXMLBSPREAD-26AUG201310SFCLE-CLE6",
    event_ticker: "KXMLBSPREAD-26AUG201310SFCLE",
    title: "Cleveland wins by over 5.5 runs?",
    yes_sub_title: "Cleveland wins by over 5.5 runs",
    no_sub_title: "Cleveland wins by over 5.5 runs",
    status: "active",
    occurrence_datetime: "2026-08-20T20:10:00Z",
    floor_strike: 5.5,
    strike_type: "greater",
    ...overrides,
  };
}

const TOTAL_EVENT: KalshiRawEvent = {
  event_ticker: "KXMLBTOTAL-26AUG201310SFCLE",
  series_ticker: "KXMLBTOTAL",
  title: "San Francisco vs Cleveland",
  sub_title: "SF vs CLE (Aug 20)",
};

function totalMarket(overrides: Partial<KalshiRawMarket> = {}): KalshiRawMarket {
  return {
    ticker: "KXMLBTOTAL-26AUG201310SFCLE-13",
    event_ticker: "KXMLBTOTAL-26AUG201310SFCLE",
    title: "Over 12.5 runs scored?",
    yes_sub_title: "Over 12.5 runs scored",
    no_sub_title: "Over 12.5 runs scored",
    status: "active",
    occurrence_datetime: "2026-08-20T20:10:00Z",
    floor_strike: 12.5,
    ...overrides,
  };
}

describe("classifyKalshiMarket — discovery", () => {
  it("1. KXMLBGAME candidate classifies as MONEYLINE", () => {
    const c = classifyKalshiMarket(gameMarket(), GAME_EVENT);
    expect(c.status).toBe("ELIGIBLE");
    expect(c.betType).toBe("MONEYLINE");
    expect(c.reasonCode).toBe("ELIGIBLE_FULL_GAME_MONEYLINE");
  });

  it("2. KXMLBSPREAD candidate classifies as SPREAD", () => {
    const c = classifyKalshiMarket(spreadMarket(), SPREAD_EVENT);
    expect(c.status).toBe("ELIGIBLE");
    expect(c.betType).toBe("SPREAD");
  });

  it("3. KXMLBTOTAL candidate classifies as TOTAL", () => {
    const c = classifyKalshiMarket(totalMarket(), TOTAL_EVENT);
    expect(c.status).toBe("ELIGIBLE");
    expect(c.betType).toBe("TOTAL");
  });

  it("4. F5 series is excluded (UNSUPPORTED, never silently ELIGIBLE)", () => {
    const f5Event: KalshiRawEvent = { event_ticker: "KXMLBF5SPREAD-26AUG201310SFCLE", series_ticker: "KXMLBF5SPREAD", title: "San Francisco vs Cleveland" };
    const c = classifyKalshiMarket(spreadMarket({ ticker: "KXMLBF5SPREAD-26AUG201310SFCLE-CLE2", event_ticker: "KXMLBF5SPREAD-26AUG201310SFCLE" }), f5Event);
    expect(c.status).toBe("UNSUPPORTED");
    expect(c.reasonCode).toBe("REJECT_UNKNOWN_SERIES");
  });

  it("5. an unknown series fails closed (UNSUPPORTED)", () => {
    const unknownEvent: KalshiRawEvent = { event_ticker: "KXNFLGAME-26AUG201310SFCLE", series_ticker: "KXNFLGAME", title: "San Francisco vs Cleveland" };
    const c = classifyKalshiMarket(gameMarket({ ticker: "KXNFLGAME-x-SF", event_ticker: "KXNFLGAME-26AUG201310SFCLE" }), unknownEvent);
    expect(c.status).toBe("UNSUPPORTED");
    expect(c.betType).toBeNull();
  });

  it("6. exact spread strike is preserved", () => {
    const c = classifyKalshiMarket(spreadMarket(), SPREAD_EVENT);
    expect(c.line).toBe(5.5);
  });

  it("7. exact total strike is preserved", () => {
    const c = classifyKalshiMarket(totalMarket(), TOTAL_EVENT);
    expect(c.line).toBe(12.5);
  });

  it("8/9. event_ticker and market ticker are preserved", () => {
    const c = classifyKalshiMarket(gameMarket(), GAME_EVENT);
    expect(c.eventTicker).toBe("KXMLBGAME-26AUG222040MINSD");
    expect(c.marketTicker).toBe("KXMLBGAME-26AUG222040MINSD-SD");
  });

  it("10. timestamps are preserved, occurrence_datetime preferred as scheduledStartAt", () => {
    const c = classifyKalshiMarket(gameMarket(), GAME_EVENT);
    expect(c.scheduledStartAt).toBe("2026-08-23T03:40:00Z");
    expect(c.openTime).toBe("2026-08-20T00:55:00Z");
    expect(c.closeTime).toBe("2026-08-26T00:40:00Z");
  });

  it("11. team identity/orientation preserved for moneyline and spread", () => {
    const ml = classifyKalshiMarket(gameMarket(), GAME_EVENT);
    expect(ml.awayTeam).toBe("MIN");
    expect(ml.homeTeam).toBe("SD");
    expect(ml.propositionTeam).toBe("SD");

    const sp = classifyKalshiMarket(spreadMarket(), SPREAD_EVENT);
    expect(sp.awayTeam).toBe("SF");
    expect(sp.homeTeam).toBe("CLE");
    expect(sp.propositionTeam).toBe("CLE");
  });

  it("total candidates have no propositionTeam (Over/Under, not team-scoped)", () => {
    const c = classifyKalshiMarket(totalMarket(), TOTAL_EVENT);
    expect(c.propositionTeam).toBeNull();
    expect(c.awayTeam).toBe("SF");
    expect(c.homeTeam).toBe("CLE");
  });

  it("12. two games with the same teams/date but different event_ticker/start-time remain separate", () => {
    const gameA = classifyKalshiMarket(gameMarket(), GAME_EVENT);
    const eventB: KalshiRawEvent = { event_ticker: "KXMLBGAME-26AUG222340MINSD", series_ticker: "KXMLBGAME", title: "Minnesota vs San Diego" };
    const gameB = classifyKalshiMarket(
      gameMarket({ ticker: "KXMLBGAME-26AUG222340MINSD-SD", event_ticker: "KXMLBGAME-26AUG222340MINSD", occurrence_datetime: "2026-08-23T06:40:00Z" }),
      eventB,
    );
    expect(gameA.eventTicker).not.toBe(gameB.eventTicker);
    expect(gameA.gameCode).not.toBe(gameB.gameCode);
    expect(gameA.scheduledStartAt).not.toBe(gameB.scheduledStartAt);
  });

  it("15. classifying the same market twice is deterministic (supports caller-side dedupe by ticker)", () => {
    expect(classifyKalshiMarket(gameMarket(), GAME_EVENT)).toEqual(classifyKalshiMarket(gameMarket(), GAME_EVENT));
  });

  it("missing line on a structurally-spread market fails closed, never ELIGIBLE", () => {
    const c = classifyKalshiMarket(spreadMarket({ floor_strike: null }), SPREAD_EVENT);
    expect(c.status).toBe("UNVERIFIED");
    expect(c.reasonCode).toBe("UNVERIFIED_MISSING_LINE");
  });

  it("no event supplied at all fails closed to UNVERIFIED_METADATA_MISSING (still classifies series via ticker fallback)", () => {
    const c = classifyKalshiMarket(gameMarket(), null);
    expect(c.status).toBe("UNVERIFIED");
    expect(c.reasonCode).toBe("UNVERIFIED_METADATA_MISSING");
    expect(c.seriesTicker).toBe("KXMLBGAME"); // derived from ticker prefix even without an event
  });

  it("an unrecognized team name in the event title fails closed to UNVERIFIED_UNKNOWN_TEAM", () => {
    const badEvent: KalshiRawEvent = { ...GAME_EVENT, title: "Some Minor League Team vs San Diego" };
    const c = classifyKalshiMarket(gameMarket(), badEvent);
    expect(c.status).toBe("UNVERIFIED");
    expect(c.reasonCode).toBe("UNVERIFIED_UNKNOWN_TEAM");
  });

  it("a market naming a team that is neither of the event's two teams fails closed as a conflict", () => {
    const c = classifyKalshiMarket(gameMarket({ yes_sub_title: "Los Angeles Dodgers" }), GAME_EVENT);
    expect(c.status).toBe("UNVERIFIED");
    expect(c.reasonCode).toBe("UNVERIFIED_CONFLICTING_METADATA");
  });
});

describe("deriveGameCode", () => {
  it("strips the series prefix to yield the shared cross-series game code", () => {
    expect(deriveGameCode("KXMLBSPREAD-26AUG201310SFCLE", "KXMLBSPREAD")).toBe("26AUG201310SFCLE");
    expect(deriveGameCode("KXMLBTOTAL-26AUG201310SFCLE", "KXMLBTOTAL")).toBe("26AUG201310SFCLE");
  });

  it("returns null on a non-matching prefix rather than guessing", () => {
    expect(deriveGameCode("KXMLBSPREAD-26AUG201310SFCLE", "KXMLBTOTAL")).toBeNull();
    expect(deriveGameCode(null, "KXMLBGAME")).toBeNull();
  });
});

describe("normalizeKalshiBook — real confirmed shape (orderbook_fp.{yes,no}_dollars, bids-only)", () => {
  const observedAt = 1_700_000_000_000;

  it("20/21. normalizes YES and NO raw bid depth", () => {
    const raw = { orderbook_fp: { yes_dollars: [["0.5800", "301.17"]], no_dollars: [["0.4000", "511.03"]] } };
    const snap = normalizeKalshiBook(raw, "t", observedAt);
    expect(snap.rawYesBids).toEqual([{ price: 0.58, size: 301.17 }]);
    expect(snap.rawNoBids).toEqual([{ price: 0.4, size: 511.03 }]);
  });

  it("22. YES ask is derived from NO bids (1 - price)", () => {
    const raw = { orderbook_fp: { yes_dollars: [], no_dollars: [["0.4000", "10"]] } };
    const snap = normalizeKalshiBook(raw, "t", observedAt);
    expect(snap.yes.bestAsk).toBeCloseTo(0.6, 9);
    expect(snap.yes.askLevels).toEqual([{ price: 0.6, size: 10 }]);
  });

  it("23. NO ask is derived from YES bids (1 - price)", () => {
    const raw = { orderbook_fp: { yes_dollars: [["0.5800", "10"]], no_dollars: [] } };
    const snap = normalizeKalshiBook(raw, "t", observedAt);
    expect(snap.no.bestAsk).toBeCloseTo(0.42, 9);
  });

  it("24. complement arithmetic is exact at venue cent precision (no float drift)", () => {
    const raw = { orderbook_fp: { yes_dollars: [], no_dollars: [["0.3000", "1"]] } };
    const snap = normalizeKalshiBook(raw, "t", observedAt);
    expect(snap.yes.bestAsk).toBe(0.7); // not 0.7000000000000001 or similar
  });

  it("25/26/27/28. best bid/ask derived correctly for both sides", () => {
    const raw = {
      orderbook_fp: {
        yes_dollars: [["0.10", "1"], ["0.20", "1"]],
        no_dollars: [["0.30", "1"], ["0.40", "1"]],
      },
    };
    const snap = normalizeKalshiBook(raw, "t", observedAt);
    expect(snap.yes.bestBid).toBeCloseTo(0.2, 9); // highest YES bid
    expect(snap.yes.bestAsk).toBeCloseTo(0.6, 9); // 1 - highest NO bid (0.40 -> 0.60)
    expect(snap.no.bestBid).toBeCloseTo(0.4, 9); // highest NO bid
    expect(snap.no.bestAsk).toBeCloseTo(0.8, 9); // 1 - highest YES bid (0.20 -> 0.80)
  });

  it("29. quantity is preserved exactly", () => {
    const raw = { orderbook_fp: { yes_dollars: [["0.50", "123.45"]], no_dollars: [] } };
    expect(normalizeKalshiBook(raw, "t", observedAt).rawYesBids[0]?.size).toBe(123.45);
  });

  it("30/31/32. top five levels retained per side, fewer than five not fabricated", () => {
    const yesLevels: [string, string][] = Array.from({ length: 8 }, (_, i) => [(0.9 - i * 0.05).toFixed(2), "1"]);
    const raw = { orderbook_fp: { yes_dollars: yesLevels, no_dollars: [["0.10", "1"]] } };
    const snap = normalizeKalshiBook(raw, "t", observedAt);
    expect(snap.rawYesBids).toHaveLength(5);
    expect(snap.rawNoBids).toHaveLength(1);
  });

  it("33. input ordering does not matter — output is always sorted", () => {
    const raw = { orderbook_fp: { yes_dollars: [["0.10", "1"], ["0.50", "1"], ["0.30", "1"]], no_dollars: [] } };
    const snap = normalizeKalshiBook(raw, "t", observedAt);
    expect(snap.rawYesBids.map((l) => l.price)).toEqual([0.5, 0.3, 0.1]);
  });

  it("34/38. a malformed price string is rejected (including NaN/Infinity), not fabricated", () => {
    const raw = { orderbook_fp: { yes_dollars: [["not-a-number", "1"], ["Infinity", "1"], ["0.40", "1"]], no_dollars: [] } };
    expect(normalizeKalshiBook(raw, "t", observedAt).rawYesBids).toEqual([{ price: 0.4, size: 1 }]);
  });

  it("35. a price outside the valid (0,1] dollar range is rejected", () => {
    const raw = { orderbook_fp: { yes_dollars: [["0.00", "1"], ["1.50", "1"], ["-0.10", "1"], ["1.00", "1"]], no_dollars: [] } };
    expect(normalizeKalshiBook(raw, "t", observedAt).rawYesBids).toEqual([{ price: 1, size: 1 }]);
  });

  it("36/37. malformed or negative quantity is rejected", () => {
    const raw = { orderbook_fp: { yes_dollars: [["0.40", "not-a-number"], ["0.41", "-5"], ["0.42", "0"], ["0.43", "3"]], no_dollars: [] } };
    expect(normalizeKalshiBook(raw, "t", observedAt).rawYesBids).toEqual([{ price: 0.43, size: 3 }]);
  });

  it("39/40. an empty YES or NO side is handled explicitly, not as an error", () => {
    const raw = { orderbook_fp: { yes_dollars: [], no_dollars: [["0.40", "1"]] } };
    const snap = normalizeKalshiBook(raw, "t", observedAt);
    expect(snap.yes.bestBid).toBeNull();
    expect(snap.no.bestBid).toBeCloseTo(0.4, 9);
    expect(snap.staleReason).toBeNull();
  });

  it("41. a completely empty book is a valid observation, not an error", () => {
    const raw = { orderbook_fp: { yes_dollars: [], no_dollars: [] } };
    const snap = normalizeKalshiBook(raw, "t", observedAt);
    expect(snap.yes.bestBid).toBeNull();
    expect(snap.yes.bestAsk).toBeNull();
    expect(snap.staleReason).toBeNull();
  });

  it("42. a crossed derived book fails closed (never a fabricated tradable quote), levels still preserved", () => {
    // YES bid 0.60, and a NO bid of 0.50 derives a YES ask of 0.50 -- crossed (0.60 > 0.50).
    const raw = { orderbook_fp: { yes_dollars: [["0.60", "1"]], no_dollars: [["0.50", "1"]] } };
    const snap = normalizeKalshiBook(raw, "t", observedAt);
    expect(snap.yes.bestBid).toBeNull();
    expect(snap.yes.bestAsk).toBeNull();
    expect(snap.staleReason).toMatch(/crossed YES/i);
    expect(snap.rawYesBids).toHaveLength(1);
  });

  it("a locked book (bid == ask) is left as a legitimate observation, not marked crossed", () => {
    // YES bid 0.50, NO bid 0.50 -> derived YES ask = 0.50 == bid. Not crossed per the mission.
    const raw = { orderbook_fp: { yes_dollars: [["0.50", "1"]], no_dollars: [["0.50", "1"]] } };
    const snap = normalizeKalshiBook(raw, "t", observedAt);
    expect(snap.yes.bestBid).toBe(0.5);
    expect(snap.yes.bestAsk).toBe(0.5);
    expect(snap.staleReason).toBeNull();
  });

  it("a malformed top-level payload fails closed with an explicit staleReason, never throws", () => {
    expect(normalizeKalshiBook(null, "t", observedAt).staleReason).toMatch(/malformed/i);
    expect(normalizeKalshiBook({}, "t", observedAt).staleReason).toMatch(/malformed/i);
    expect(normalizeKalshiBook({ orderbook_fp: { yes_dollars: "nope", no_dollars: [] } }, "t", observedAt).staleReason).toMatch(/malformed/i);
  });
});
