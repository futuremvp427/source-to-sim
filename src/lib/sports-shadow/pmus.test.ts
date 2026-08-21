import { describe, expect, it } from "vitest";
import { eventToCandidates, normalizePmusBook, type PmusRawEvent } from "./pmus";

const NYY: { abbreviation: string; name: string; league: string; ordering: string } = {
  abbreviation: "nyy",
  name: "New York Yankees",
  league: "mlb",
  ordering: "away",
};
const BAL = { abbreviation: "bal", name: "Baltimore Orioles", league: "mlb", ordering: "home" };

function moneylineMarket(overrides: Partial<PmusRawEvent["markets"] extends (infer M)[] | null | undefined ? M : never> = {}) {
  return {
    id: "444031",
    slug: "aec-mlb-nyy-bal-2026-08-19",
    question: "New York Yankees vs. Baltimore Orioles",
    marketType: "moneyline",
    sportsMarketType: "baseball_team_full_game_winner",
    sportsMarketTypeV2: "SPORTS_MARKET_TYPE_MONEYLINE",
    line: null,
    status: "MARKET_STATUS_OPEN",
    active: true,
    closed: false,
    gameStartTime: "2026-08-19T22:35:00Z",
    marketSides: [
      { description: "New York Yankees", price: "1", long: true, team: NYY },
      { description: "Baltimore Orioles", price: "0", long: false, team: BAL },
    ],
    ...overrides,
  };
}

function baseEvent(overrides: Partial<PmusRawEvent> = {}): PmusRawEvent {
  return {
    id: "83041",
    slug: "mlb-nyy-bal-2026-08-19",
    title: "New York Yankees vs. Baltimore Orioles",
    startTime: "2026-08-19T22:35:00Z",
    gameId: 10079194,
    active: true,
    closed: false,
    teams: [NYY, BAL],
    markets: [moneylineMarket()],
    ...overrides,
  };
}

describe("eventToCandidates — discovery", () => {
  it("1. a current MLB event yields an MLB candidate", () => {
    const [c] = eventToCandidates(baseEvent());
    expect(c?.status).toBe("ELIGIBLE");
    expect(c?.league).toBe("mlb");
  });

  it("2. a non-MLB event is excluded (UNSUPPORTED, never silently ELIGIBLE)", () => {
    const nflAway = { ...NYY, league: "nfl" };
    const nflHome = { ...BAL, league: "nfl" };
    const event = baseEvent({
      teams: [nflAway, nflHome],
      markets: [moneylineMarket({ marketSides: [{ description: "a", price: "1", long: true, team: nflAway }, { description: "b", price: "0", long: false, team: nflHome }] })],
    });
    const [c] = eventToCandidates(event);
    expect(c?.status).toBe("UNSUPPORTED");
    expect(c?.reasonCode).toBe("REJECT_NON_MLB");
  });

  it("3. moneyline candidate normalized", () => {
    const [c] = eventToCandidates(baseEvent());
    expect(c?.betType).toBe("MONEYLINE");
    expect(c?.reasonCode).toBe("ELIGIBLE_FULL_GAME_MONEYLINE");
    expect(c?.line).toBeNull();
  });

  it("4/5. spread candidate normalized with exact line preserved", () => {
    const spreadMarket = moneylineMarket({
      id: "444036",
      slug: "asc-mlb-nyy-bal-2026-08-19-neg-1pt5",
      marketType: "spreads",
      sportsMarketType: "baseball_team_full_game_spread",
      sportsMarketTypeV2: "SPORTS_MARKET_TYPE_SPREAD",
      line: -1.5,
      marketSides: [
        { description: "-1.50", price: "1", long: true, team: NYY },
        { description: "+1.50", price: "0", long: false, team: BAL },
      ],
    });
    const event = baseEvent({ markets: [moneylineMarket(), spreadMarket] });
    const c = eventToCandidates(event).find((x) => x.betType === "SPREAD");
    expect(c?.status).toBe("ELIGIBLE");
    expect(c?.line).toBe(-1.5);
    expect(c?.awayTeam).toBe("NYY");
    expect(c?.homeTeam).toBe("BAL");
  });

  it("6/7. total candidate normalized with exact line preserved (no team on sides)", () => {
    const totalMarket = moneylineMarket({
      id: "463989",
      slug: "tsc-mlb-nyy-bal-2026-08-19-8pt5",
      marketType: "totals",
      sportsMarketType: "baseball_team_full_game_total",
      sportsMarketTypeV2: "SPORTS_MARKET_TYPE_TOTAL",
      line: 8.5,
      marketSides: [
        { description: "Over", price: "0.11", long: true, team: null },
        { description: "Under", price: "0.89", long: false, team: null },
      ],
    });
    const event = baseEvent({ markets: [moneylineMarket(), totalMarket] });
    const c = eventToCandidates(event).find((x) => x.betType === "TOTAL");
    expect(c?.status).toBe("ELIGIBLE");
    expect(c?.line).toBe(8.5);
    // TOTAL derives away/home from event-level team resolution, not the side (which has none).
    expect(c?.awayTeam).toBe("NYY");
    expect(c?.homeTeam).toBe("BAL");
  });

  it("8. F5 candidate is not treated as full-game", () => {
    const f5 = moneylineMarket({
      id: "458721",
      slug: "asc-mlb-nyy-bal-2026-08-19-f5-neg-1pt5",
      sportsMarketType: "baseball_team_first_five_spread",
      sportsMarketTypeV2: "SPORTS_MARKET_TYPE_SPREAD",
      line: -1.5,
    });
    const event = baseEvent({ markets: [moneylineMarket(), f5] });
    const c = eventToCandidates(event).find((x) => x.marketSlug === f5.slug);
    expect(c?.status).toBe("UNSUPPORTED");
    expect(c?.reasonCode).toBe("REJECT_F5");
  });

  it("9. prop candidate is not treated as full-game", () => {
    const prop = moneylineMarket({
      id: "1",
      slug: "astatc-mlb-nyy-bal-2026-08-19-hr-judge-gte1",
      marketType: "props",
      sportsMarketType: "baseball_player_home_runs",
      sportsMarketTypeV2: null,
      line: 1,
    });
    const event = baseEvent({ markets: [moneylineMarket(), prop] });
    const c = eventToCandidates(event).find((x) => x.marketSlug === prop.slug);
    expect(c?.status).toBe("UNSUPPORTED");
    expect(c?.reasonCode).toBe("REJECT_PROP");
  });

  it("10. futures candidate is not treated as full-game", () => {
    const futures = moneylineMarket({
      id: "2",
      slug: "tec-mlb-champ-2026-09-27-nyy",
      sportsMarketType: "futures",
      sportsMarketTypeV2: null,
      line: null,
    });
    const event = baseEvent({ markets: [moneylineMarket(), futures] });
    const c = eventToCandidates(event).find((x) => x.marketSlug === futures.slug);
    expect(c?.status).toBe("UNSUPPORTED");
    expect(c?.reasonCode).toBe("REJECT_FUTURE");
  });

  it("11. an unrecognized market type fails closed (UNSUPPORTED, not ELIGIBLE)", () => {
    const weird = moneylineMarket({ id: "3", slug: "weird-market", sportsMarketType: "baseball_team_extra_innings_winner", sportsMarketTypeV2: null });
    const event = baseEvent({ markets: [moneylineMarket(), weird] });
    const c = eventToCandidates(event).find((x) => x.marketSlug === weird.slug);
    expect(c?.status).toBe("UNSUPPORTED");
    expect(c?.betType).toBeNull();
  });

  it("12. an unknown/unrecognized team fails closed to UNVERIFIED", () => {
    const unknownAway = { ...NYY, name: "Some Minor League Team", abbreviation: "xxx" };
    const event = baseEvent({
      teams: [unknownAway, BAL],
      markets: [moneylineMarket({ marketSides: [{ description: "a", price: "1", long: true, team: unknownAway }, { description: "b", price: "0", long: false, team: BAL }] })],
    });
    const [c] = eventToCandidates(event);
    expect(c?.status).toBe("UNVERIFIED");
    expect(c?.reasonCode).toBe("UNVERIFIED_UNKNOWN_TEAM");
  });

  it("13. home/away orientation is preserved correctly", () => {
    const [c] = eventToCandidates(baseEvent());
    expect(c?.awayTeam).toBe("NYY");
    expect(c?.homeTeam).toBe("BAL");
  });

  it("14. scheduled start time is preserved", () => {
    const [c] = eventToCandidates(baseEvent());
    expect(c?.scheduledStartAt).toBe("2026-08-19T22:35:00Z");
  });

  it("15. game/event ID is preserved", () => {
    const [c] = eventToCandidates(baseEvent());
    expect(c?.gameId).toBe("10079194");
    expect(c?.eventId).toBe("83041");
    expect(c?.eventSlug).toBe("mlb-nyy-bal-2026-08-19");
  });

  it("16. two same-team/date games with different IDs/start times remain separate candidates", () => {
    const gameA = baseEvent({ gameId: 111, id: "1", slug: "mlb-nyy-bal-2026-08-19" });
    const gameB = baseEvent({
      gameId: 222,
      id: "2",
      slug: "mlb-nyy-bal-2026-08-19-g2",
      startTime: "2026-08-19T18:00:00Z",
      markets: [moneylineMarket({ id: "999", slug: "aec-mlb-nyy-bal-2026-08-19-g2", gameStartTime: "2026-08-19T18:00:00Z" })],
    });
    const [ca] = eventToCandidates(gameA);
    const [cb] = eventToCandidates(gameB);
    expect(ca?.gameId).not.toBe(cb?.gameId);
    expect(ca?.marketSlug).not.toBe(cb?.marketSlug);
  });

  it("no markets on an event yields no candidates, not a crash", () => {
    expect(eventToCandidates(baseEvent({ markets: [] }))).toEqual([]);
  });

  it("18. producing candidates twice from identical event data is deterministic (supports caller-side dedupe by marketSlug)", () => {
    const a = eventToCandidates(baseEvent());
    const b = eventToCandidates(baseEvent());
    expect(a).toEqual(b);
  });

  it("no team metadata at all (no moneyline, no event.teams) fails closed to UNVERIFIED_METADATA_MISSING", () => {
    const event = baseEvent({ teams: null, markets: [moneylineMarket({ marketSides: [] })] });
    const [c] = eventToCandidates(event);
    expect(c?.status).toBe("UNVERIFIED");
    expect(c?.reasonCode).toBe("UNVERIFIED_METADATA_MISSING");
  });

  it("missing line on a structurally-spread market fails closed, never ELIGIBLE", () => {
    const spreadNoLine = moneylineMarket({
      id: "5",
      slug: "asc-mlb-nyy-bal-2026-08-19-neg-1pt5",
      sportsMarketType: "baseball_team_full_game_spread",
      sportsMarketTypeV2: "SPORTS_MARKET_TYPE_SPREAD",
      line: null,
    });
    const event = baseEvent({ markets: [moneylineMarket(), spreadNoLine] });
    const c = eventToCandidates(event).find((x) => x.marketSlug === spreadNoLine.slug);
    expect(c?.status).toBe("UNVERIFIED");
    expect(c?.reasonCode).toBe("UNVERIFIED_MISSING_LINE");
  });

  it("sportsMarketType/sportsMarketTypeV2 disagreement fails closed to UNVERIFIED_CONFLICTING_METADATA", () => {
    const conflicting = moneylineMarket({ sportsMarketTypeV2: "SPORTS_MARKET_TYPE_TOTAL" });
    const event = baseEvent({ markets: [conflicting] });
    const [c] = eventToCandidates(event);
    expect(c?.status).toBe("UNVERIFIED");
    expect(c?.reasonCode).toBe("UNVERIFIED_CONFLICTING_METADATA");
  });

  it("a market's own side teams disagreeing with the event-level team pair fails closed", () => {
    // The moneyline market establishes the event-level truth (NYY/BAL). This sibling spread
    // market's sides reference a different team entirely (LAD) -- a genuine data anomaly, not
    // something Task 5 should silently trust.
    const wrongSides = moneylineMarket({
      id: "9",
      slug: "asc-mlb-nyy-bal-2026-08-19-neg-1pt5",
      sportsMarketType: "baseball_team_full_game_spread",
      sportsMarketTypeV2: "SPORTS_MARKET_TYPE_SPREAD",
      line: -1.5,
      marketSides: [
        { description: "-1.50", price: "1", long: true, team: { abbreviation: "lad", name: "Los Angeles Dodgers", league: "mlb", ordering: "away" } },
        { description: "+1.50", price: "0", long: false, team: BAL },
      ],
    });
    const event = baseEvent({ markets: [moneylineMarket(), wrongSides] });
    const c = eventToCandidates(event).find((x) => x.marketSlug === wrongSides.slug);
    expect(c?.status).toBe("UNVERIFIED");
    expect(c?.reasonCode).toBe("UNVERIFIED_CONFLICTING_METADATA");
  });
});

describe("normalizePmusBook — real confirmed shape (marketData.bids/offers, {px:{value},qty})", () => {
  const observedAt = 1_700_000_000_000;

  it("21/23/27. normalizes valid bid depth, sorted best (highest) first", () => {
    const raw = { marketData: { marketSlug: "s", bids: [{ px: { value: "0.40" }, qty: "10" }, { px: { value: "0.45" }, qty: "5" }], offers: [] } };
    const snap = normalizePmusBook(raw, "s", observedAt);
    expect(snap.bidLevels).toEqual([{ price: 0.45, size: 5 }, { price: 0.4, size: 10 }]);
    expect(snap.bestBid).toBe(0.45);
  });

  it("22/24/27. normalizes valid ask depth, sorted best (lowest) first", () => {
    const raw = { marketData: { marketSlug: "s", bids: [], offers: [{ px: { value: "0.55" }, qty: "10" }, { px: { value: "0.50" }, qty: "5" }] } };
    const snap = normalizePmusBook(raw, "s", observedAt);
    expect(snap.askLevels).toEqual([{ price: 0.5, size: 5 }, { price: 0.55, size: 10 }]);
    expect(snap.bestAsk).toBe(0.5);
  });

  it("25. retains up to the top 5 levels per side", () => {
    const bids = Array.from({ length: 8 }, (_, i) => ({ px: { value: (0.5 - i * 0.01).toFixed(2) }, qty: "1" }));
    const raw = { marketData: { marketSlug: "s", bids, offers: [] } };
    const snap = normalizePmusBook(raw, "s", observedAt);
    expect(snap.bidLevels).toHaveLength(5);
    expect(snap.bidLevels[0]?.price).toBeCloseTo(0.5, 9);
  });

  it("26. fewer than five levels are retained without fabricating more", () => {
    const raw = { marketData: { marketSlug: "s", bids: [{ px: { value: "0.4" }, qty: "1" }], offers: [] } };
    const snap = normalizePmusBook(raw, "s", observedAt);
    expect(snap.bidLevels).toHaveLength(1);
  });

  it("28. spread is derivable as bestAsk - bestBid from real depth", () => {
    const raw = { marketData: { marketSlug: "s", bids: [{ px: { value: "0.45" }, qty: "1" }], offers: [{ px: { value: "0.46" }, qty: "1" }] } };
    const snap = normalizePmusBook(raw, "s", observedAt);
    expect(snap.bestAsk! - snap.bestBid!).toBeCloseTo(0.01, 9);
  });

  it("29/31. invalid/non-finite price is rejected, not fabricated", () => {
    const raw = { marketData: { marketSlug: "s", bids: [{ px: { value: "not-a-number" }, qty: "1" }, { px: { value: "NaN" }, qty: "1" }, { px: { value: "0.4" }, qty: "1" }], offers: [] } };
    const snap = normalizePmusBook(raw, "s", observedAt);
    expect(snap.bidLevels).toEqual([{ price: 0.4, size: 1 }]);
  });

  it("30/33. invalid/negative size is rejected", () => {
    const raw = { marketData: { marketSlug: "s", bids: [{ px: { value: "0.4" }, qty: "-5" }, { px: { value: "0.41" }, qty: "0" }, { px: { value: "0.42" }, qty: "3" }], offers: [] } };
    const snap = normalizePmusBook(raw, "s", observedAt);
    expect(snap.bidLevels).toEqual([{ price: 0.42, size: 3 }]);
  });

  it("31. Infinity is rejected", () => {
    const raw = { marketData: { marketSlug: "s", bids: [{ px: { value: "Infinity" }, qty: "1" }], offers: [] } };
    expect(normalizePmusBook(raw, "s", observedAt).bidLevels).toEqual([]);
  });

  it("32. an impossible prediction-market price (>1 or <=0) is rejected", () => {
    const raw = { marketData: { marketSlug: "s", bids: [{ px: { value: "1.5" }, qty: "1" }, { px: { value: "0" }, qty: "1" }, { px: { value: "-0.1" }, qty: "1" }], offers: [] } };
    expect(normalizePmusBook(raw, "s", observedAt).bidLevels).toEqual([]);
  });

  it("34. a malformed payload fails closed with an explicit staleReason, no throw", () => {
    expect(normalizePmusBook(null, "s", observedAt).staleReason).toMatch(/malformed/i);
    expect(normalizePmusBook({}, "s", observedAt).staleReason).toMatch(/malformed/i);
    expect(normalizePmusBook({ marketData: { bids: "not-an-array", offers: [] } }, "s", observedAt).staleReason).toMatch(/malformed/i);
  });

  it("35. a crossed book (best bid >= best ask) is handled explicitly, never a fabricated tradable quote", () => {
    const raw = { marketData: { marketSlug: "s", bids: [{ px: { value: "0.60" }, qty: "1" }], offers: [{ px: { value: "0.50" }, qty: "1" }] } };
    const snap = normalizePmusBook(raw, "s", observedAt);
    expect(snap.bestBid).toBeNull();
    expect(snap.bestAsk).toBeNull();
    expect(snap.staleReason).toMatch(/crossed/i);
    // Raw levels are still preserved for diagnostics even though best*/tradability is nulled.
    expect(snap.bidLevels).toHaveLength(1);
    expect(snap.askLevels).toHaveLength(1);
  });

  it("36. an empty side (no bids or no offers) is handled explicitly, not as an error", () => {
    const raw = { marketData: { marketSlug: "s", bids: [], offers: [{ px: { value: "0.5" }, qty: "1" }] } };
    const snap = normalizePmusBook(raw, "s", observedAt);
    expect(snap.bestBid).toBeNull();
    expect(snap.bestAsk).toBe(0.5);
    expect(snap.staleReason).toBeNull();
  });

  it("preserves market state and venue/marketId/observedAt", () => {
    const raw = { marketData: { marketSlug: "ignored-in-favor-of-param", bids: [], offers: [], state: "MARKET_STATE_OPEN" } };
    const snap = normalizePmusBook(raw, "the-slug", observedAt);
    expect(snap.venue).toBe("PMUS");
    expect(snap.marketId).toBe("the-slug");
    expect(snap.marketStatus).toBe("MARKET_STATE_OPEN");
    expect(snap.observedAt).toBe(observedAt);
  });
});
