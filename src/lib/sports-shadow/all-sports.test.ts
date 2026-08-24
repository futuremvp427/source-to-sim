import { describe, expect, it } from "vitest";
import { classifyGammaMarket, type GammaMarket } from "./eligibility";
import { eventToCandidates, type PmusRawEvent } from "./pmus";
import { normalizeMlbTeamName, normalizeTeamName } from "./team-normalization";

function gamma(overrides: Partial<GammaMarket> = {}): GammaMarket {
  return {
    slug: "wnba-ind-chi-2026-08-23",
    question: "Indiana Fever vs. Chicago Sky",
    groupItemTitle: null,
    sportsMarketType: "moneyline",
    line: null,
    events: [
      {
        sport: { sport: "wnba" },
        teams: [
          { name: "Indiana Fever", ordering: "away" },
          { name: "Chicago Sky", ordering: "home" },
        ],
      },
    ],
    ...overrides,
  };
}

describe("sport-agnostic Gamma classification", () => {
  it("accepts a full-contest WNBA moneyline without an allow-list", () => {
    const r = classifyGammaMarket(gamma());
    expect(r.status).toBe("ELIGIBLE");
    expect(r.league).toBe("wnba");
    expect(r.betType).toBe("MONEYLINE");
    expect(r.awayTeam).toBe("GENERIC:indiana fever");
    expect(r.homeTeam).toBe("GENERIC:chicago sky");
  });

  it("infers WNBA from the canonical slug when structured sport is absent", () => {
    const r = classifyGammaMarket(gamma({ events: [{ sport: null, teams: gamma().events?.[0]?.teams ?? [] }] }));
    expect(r.status).toBe("ELIGIBLE");
    expect(r.league).toBe("wnba");
  });

  it("accepts a full-match WTA winner from an A-vs-B question even without team objects", () => {
    const r = classifyGammaMarket(
      gamma({
        slug: "wta-bondar-liang-2026-08-23",
        question: "Monterrey Open, Qualification: Anna Bondar vs En-Shuo Liang",
        sportsMarketType: "moneyline",
        events: [{ sport: { sport: "wta" }, teams: [] }],
      }),
    );
    expect(r.status).toBe("ELIGIBLE");
    expect(r.league).toBe("wta");
    expect(r.awayTeam).toBe("GENERIC:anna bondar");
    expect(r.homeTeam).toBe("GENERIC:en shuo liang");
  });

  it("accepts a WNBA full-game spread and preserves its line", () => {
    const r = classifyGammaMarket(
      gamma({
        slug: "wnba-wsh-por-2026-08-23-spread-away-4pt5",
        question: "Spread: Washington Mystics (-4.5)",
        sportsMarketType: "spreads",
        line: -4.5,
        events: [
          {
            sport: { sport: "wnba" },
            teams: [
              { name: "Washington Mystics", ordering: "away" },
              { name: "Portland Fire", ordering: "home" },
            ],
          },
        ],
      }),
    );
    expect(r.status).toBe("ELIGIBLE");
    expect(r.betType).toBe("SPREAD");
    expect(r.line).toBe(-4.5);
  });

  it("still rejects a Valorant Map 1 winner as a partial contest", () => {
    const r = classifyGammaMarket(
      gamma({
        slug: "val-eg2-kru1-2026-08-23-game1",
        question: "Valorant: Evil Geniuses vs KRÜ Esports - Map 1 Winner",
        sportsMarketType: "moneyline",
        events: [{ sport: { sport: "val" }, teams: [] }],
      }),
    );
    expect(r.status).toBe("INELIGIBLE");
    expect(r.reasonCode).toBe("REJECT_PARTIAL_CONTEST");
  });

  it("still rejects a tennis set-level winner", () => {
    const r = classifyGammaMarket(
      gamma({
        slug: "wta-player-a-player-b-2026-08-23-set1",
        question: "Player A vs Player B - Set 1 Winner",
        sportsMarketType: "moneyline",
        events: [{ sport: { sport: "wta" }, teams: [] }],
      }),
    );
    expect(r.status).toBe("INELIGIBLE");
    expect(r.reasonCode).toBe("REJECT_PARTIAL_CONTEST");
  });
});

function pmusWnbaEvent(overrides: Partial<PmusRawEvent> = {}): PmusRawEvent {
  const away = { abbreviation: "ind", name: "Indiana Fever", league: "wnba", ordering: "away" };
  const home = { abbreviation: "chi", name: "Chicago Sky", league: "wnba", ordering: "home" };
  return {
    id: "wnba-event-1",
    slug: "wnba-ind-chi-2026-08-23",
    title: "Indiana Fever vs. Chicago Sky",
    startTime: "2026-08-23T19:00:00Z",
    gameId: "wnba-game-1",
    active: true,
    closed: false,
    participants: [away, home],
    markets: [
      {
        id: "wnba-ml-1",
        slug: "wnba-ind-chi-2026-08-23",
        question: "Indiana Fever vs. Chicago Sky",
        sportsMarketType: "basketball_team_full_game_winner",
        sportsMarketTypeV2: "SPORTS_MARKET_TYPE_MONEYLINE",
        line: null,
        status: "MARKET_STATUS_OPEN",
        active: true,
        closed: false,
        gameStartTime: "2026-08-23T19:00:00Z",
        marketSides: [
          { description: "Indiana Fever", long: true, team: away },
          { description: "Chicago Sky", long: false, team: home },
        ],
      },
    ],
    ...overrides,
  };
}

describe("sport-agnostic PM-US candidate normalization", () => {
  it("accepts a non-MLB full-contest MONEYLINE from the coarse V2 type", () => {
    const [c] = eventToCandidates(pmusWnbaEvent());
    expect(c?.status).toBe("ELIGIBLE");
    expect(c?.league).toBe("wnba");
    expect(c?.betType).toBe("MONEYLINE");
    expect(c?.awayTeam).toBe("GENERIC:indiana fever");
    expect(c?.homeTeam).toBe("GENERIC:chicago sky");
    expect(c?.sides[0]?.teamAbbreviation).toBe("Indiana Fever");
  });

  it("rejects a set-level tennis market even if V2 says MONEYLINE", () => {
    const p1 = { name: "Anna Bondar", league: "wta", ordering: "away" };
    const p2 = { name: "En-Shuo Liang", league: "wta", ordering: "home" };
    const [c] = eventToCandidates({
      id: "wta-1",
      slug: "wta-bondar-liang-2026-08-23",
      title: "Anna Bondar vs En-Shuo Liang",
      startTime: "2026-08-23T20:00:00Z",
      participants: [p1, p2],
      markets: [
        {
          id: "set-1",
          slug: "wta-bondar-liang-2026-08-23-set1",
          question: "Anna Bondar vs En-Shuo Liang - Set 1 Winner",
          sportsMarketType: "tennis_set_winner",
          sportsMarketTypeV2: "SPORTS_MARKET_TYPE_MONEYLINE",
          marketSides: [
            { description: "Anna Bondar", long: true, team: p1 },
            { description: "En-Shuo Liang", long: false, team: p2 },
          ],
        },
      ],
    });
    expect(c?.status).toBe("UNSUPPORTED");
    expect(c?.reasonCode).toBe("REJECT_PARTIAL_CONTEST");
  });
});

describe("generic resolver-facing participant identity", () => {
  it("keeps strict MLB classification separate from generic full-name identity", () => {
    expect(normalizeMlbTeamName("Chicago Sky")).toBeNull();
    expect(normalizeTeamName("Chicago Sky")).toBe("GENERIC:chicago sky");
    expect(normalizeMlbTeamName("New York Yankees")).toBe("NYY");
    expect(normalizeTeamName("New York Yankees")).toBe("NYY");
  });
});
