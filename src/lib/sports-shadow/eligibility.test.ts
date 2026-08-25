import { describe, expect, it } from "vitest";
import { classifyGammaMarket, classifyUnverifiedDisposition, type GammaMarket, type UnverifiedReasonCode } from "./eligibility";

const moneyline: GammaMarket = {
  slug: "mlb-nyy-bal-2026-08-19",
  question: "New York Yankees vs. Baltimore Orioles",
  groupItemTitle: null,
  sportsMarketType: "moneyline",
  line: null,
  events: [
    {
      sport: { sport: "mlb" },
      teams: [
        { name: "New York Yankees", ordering: "away" },
        { name: "Baltimore Orioles", ordering: "home" },
      ],
    },
  ],
};

const spread: GammaMarket = {
  ...moneyline,
  sportsMarketType: "spreads",
  line: -1.5,
  slug: "mlb-nyy-bal-2026-08-19-spread-away-1pt5",
  question: "New York Yankees -1.5",
};

const total: GammaMarket = {
  ...moneyline,
  sportsMarketType: "totals",
  line: 7.5,
  slug: "mlb-nyy-bal-2026-08-19-total-7pt5",
  question: "New York Yankees vs. Baltimore Orioles: O/U 7.5",
};

describe("classifyGammaMarket — ELIGIBLE", () => {
  it("1. accepts full-game MLB moneyline", () => {
    const r = classifyGammaMarket(moneyline);
    expect(r.status).toBe("ELIGIBLE");
    expect(r.betType).toBe("MONEYLINE");
    expect(r.reasonCode).toBe("ELIGIBLE_FULL_GAME_MONEYLINE");
  });

  it("2. accepts full-game MLB spread", () => {
    const r = classifyGammaMarket(spread);
    expect(r.status).toBe("ELIGIBLE");
    expect(r.betType).toBe("SPREAD");
    expect(r.reasonCode).toBe("ELIGIBLE_FULL_GAME_SPREAD");
  });

  it("3. accepts full-game MLB total", () => {
    const r = classifyGammaMarket(total);
    expect(r.status).toBe("ELIGIBLE");
    expect(r.betType).toBe("TOTAL");
    expect(r.reasonCode).toBe("ELIGIBLE_FULL_GAME_TOTAL");
  });

  it("4. preserves the exact spread line", () => {
    expect(classifyGammaMarket(spread).line).toBe(-1.5);
  });

  it("5. preserves the exact total line", () => {
    expect(classifyGammaMarket(total).line).toBe(7.5);
  });

  it("6. preserves home/away side as canonical team codes", () => {
    const r = classifyGammaMarket(moneyline);
    expect(r.awayTeam).toBe("NYY");
    expect(r.homeTeam).toBe("BAL");
  });
});

describe("classifyGammaMarket — REJECT", () => {
  it("7. rejects F5 moneyline", () => {
    const m: GammaMarket = { ...moneyline, question: "NYY vs BAL - First 5 Innings Winner", slug: "mlb-nyy-bal-2026-08-19-f5" };
    const r = classifyGammaMarket(m);
    expect(r.status).toBe("INELIGIBLE");
    expect(r.reasonCode).toBe("REJECT_F5");
  });

  it("8. rejects F5 spread", () => {
    const m: GammaMarket = { ...spread, question: "NYY -1.5 First 5 Innings" };
    expect(classifyGammaMarket(m).reasonCode).toBe("REJECT_F5");
  });

  it("9. rejects F5 total", () => {
    const m: GammaMarket = { ...total, question: "O/U 2.5 in the first five innings" };
    expect(classifyGammaMarket(m).reasonCode).toBe("REJECT_F5");
  });

  it("10. rejects first inning markets", () => {
    const m: GammaMarket = { ...moneyline, question: "Will the Yankees score in the 1st inning?", slug: "mlb-nyy-bal-2026-08-19-1st-inning" };
    expect(classifyGammaMarket(m).reasonCode).toBe("REJECT_INNING");
  });

  it("11. rejects a player home-run prop", () => {
    const m: GammaMarket = { ...moneyline, sportsMarketType: "player_prop", question: "Aaron Judge: Home Runs O/U 0.5" };
    expect(classifyGammaMarket(m).reasonCode).toBe("REJECT_PROP");
  });

  it("12. rejects a strikeout prop", () => {
    const m: GammaMarket = { ...moneyline, sportsMarketType: "player_prop", question: "Gerrit Cole: Strikeouts O/U 6.5" };
    expect(classifyGammaMarket(m).reasonCode).toBe("REJECT_PROP");
  });

  it("13. rejects team total (Phase 1 does not support it)", () => {
    const m: GammaMarket = { ...total, question: "Yankees Team Total O/U 4.5" };
    expect(classifyGammaMarket(m).reasonCode).toBe("REJECT_TEAM_TOTAL");
  });

  it("14. rejects series/futures", () => {
    const m: GammaMarket = { ...moneyline, sportsMarketType: "futures", question: "World Series Champion", line: null };
    expect(classifyGammaMarket(m).reasonCode).toBe("REJECT_FUTURE");
  });

  it("15. rejects parlay/combo markets", () => {
    const m: GammaMarket = { ...moneyline, question: "3-Leg Parlay: Yankees Moneyline + Over 7.5" };
    expect(classifyGammaMarket(m).reasonCode).toBe("REJECT_PARLAY");
  });

  it("16. rejects tennis", () => {
    const m: GammaMarket = { ...moneyline, events: [{ sport: { sport: "tennis" }, teams: [] }] };
    expect(classifyGammaMarket(m).reasonCode).toBe("REJECT_NON_MLB");
  });

  it("17. rejects UFC", () => {
    const m: GammaMarket = { ...moneyline, events: [{ sport: { sport: "ufc" }, teams: [] }] };
    expect(classifyGammaMarket(m).reasonCode).toBe("REJECT_NON_MLB");
  });

  it("18. rejects KBO", () => {
    const m: GammaMarket = { ...moneyline, events: [{ sport: { sport: "kbo" }, teams: [] }] };
    expect(classifyGammaMarket(m).reasonCode).toBe("REJECT_NON_MLB");
  });

  it("19. rejects esports", () => {
    const m: GammaMarket = { ...moneyline, events: [{ sport: { sport: "lol" }, teams: [] }] };
    expect(classifyGammaMarket(m).reasonCode).toBe("REJECT_ESPORTS");
  });
});

describe("classifyGammaMarket — FAIL CLOSED", () => {
  it("20. missing line on spread is never eligible", () => {
    const m: GammaMarket = { ...spread, line: null, slug: "mlb-nyy-bal-2026-08-19-spread-away" };
    const r = classifyGammaMarket(m);
    expect(r.status).not.toBe("ELIGIBLE");
    expect(r.reasonCode).toBe("UNVERIFIED_MISSING_LINE");
  });

  it("21. missing line on total is never eligible", () => {
    const m: GammaMarket = { ...total, line: null, slug: "mlb-nyy-bal-2026-08-19-total" };
    const r = classifyGammaMarket(m);
    expect(r.status).not.toBe("ELIGIBLE");
    expect(r.reasonCode).toBe("UNVERIFIED_MISSING_LINE");
  });

  it("22. unknown team is UNVERIFIED, not eligible", () => {
    const m: GammaMarket = {
      ...moneyline,
      events: [{ sport: { sport: "mlb" }, teams: [{ name: "Some Minor League Team", ordering: "away" }, { name: "Baltimore Orioles", ordering: "home" }] }],
    };
    const r = classifyGammaMarket(m);
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_UNKNOWN_TEAM");
  });

  it("23. ambiguous period language is UNVERIFIED, not eligible", () => {
    const m: GammaMarket = { ...total, question: "Total runs scored through 6 innings", slug: "mlb-nyy-bal-2026-08-19-total-7pt5" };
    const r = classifyGammaMarket(m);
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_AMBIGUOUS_PERIOD");
  });

  it("24. structured/text line conflict is UNVERIFIED, not eligible", () => {
    const m: GammaMarket = { ...total, line: 7.5, slug: "mlb-nyy-bal-2026-08-19-total-8pt5" };
    const r = classifyGammaMarket(m);
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_CONFLICTING_METADATA");
  });

  it("24b. structured/text team-identity conflict is UNVERIFIED, not eligible", () => {
    const m: GammaMarket = {
      ...moneyline,
      slug: "mlb-lad-sf-2026-08-19",
      events: [
        {
          sport: { sport: "mlb" },
          teams: [
            { name: "New York Yankees", ordering: "away" },
            { name: "Baltimore Orioles", ordering: "home" },
          ],
        },
      ],
    };
    const r = classifyGammaMarket(m);
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_CONFLICTING_METADATA");
  });

  it("25. malformed slug with no structured type is UNVERIFIED (parse failure)", () => {
    const m: GammaMarket = { ...moneyline, sportsMarketType: null, slug: "not-a-recognizable-slug-format" };
    const r = classifyGammaMarket(m);
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_PARSE_FAILURE");
  });

  it("no structured type and no slug at all is UNVERIFIED (metadata missing)", () => {
    const m: GammaMarket = { ...moneyline, sportsMarketType: null, slug: null };
    const r = classifyGammaMarket(m);
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_METADATA_MISSING");
  });

  it("unsupported structured market type is rejected, not silently ignored", () => {
    const m: GammaMarket = { ...moneyline, sportsMarketType: "outrights" };
    const r = classifyGammaMarket(m);
    expect(r.status).toBe("INELIGIBLE");
    expect(r.reasonCode).toBe("REJECT_UNSUPPORTED_MARKET_TYPE");
  });

  it("no league evidence at all is UNVERIFIED, never eligible", () => {
    const m: GammaMarket = { ...moneyline, events: null, slug: "unknown-league-game-2026-08-19" };
    const r = classifyGammaMarket(m);
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_METADATA_MISSING");
  });
});

describe("classifyGammaMarket — STRUCTURED PRIORITY", () => {
  it("29. structured/textual F5 evidence overrides an otherwise full-game-looking slug", () => {
    const m: GammaMarket = {
      ...total,
      slug: "mlb-nyy-bal-2026-08-19-total-2pt5",
      question: "Will the total in NYY vs BAL be more than 2.5 in the first 5 innings?",
      line: 2.5,
    };
    const r = classifyGammaMarket(m);
    expect(r.status).toBe("INELIGIBLE");
    expect(r.reasonCode).toBe("REJECT_F5");
  });

  it("30. structured full-game metadata is eligible when conservative slug fallback agrees", () => {
    const r = classifyGammaMarket(total);
    expect(r.status).toBe("ELIGIBLE");
  });

  it("31. a structured/text conflict never becomes ELIGIBLE", () => {
    const conflicting: GammaMarket = { ...total, line: 7.5, slug: "mlb-nyy-bal-2026-08-19-total-8pt5" };
    expect(classifyGammaMarket(conflicting).status).not.toBe("ELIGIBLE");
  });
});

describe("classifyGammaMarket — canonical MLB slug fallback after exclusions", () => {
  const missingTeams = (overrides: Partial<GammaMarket> = {}): GammaMarket => ({
    ...moneyline,
    question: null,
    groupItemTitle: null,
    events: [{ sport: { sport: "mlb" }, teams: null }],
    ...overrides,
  });

  it("derives participants for canonical MLB moneyline when Gamma teams are missing", () => {
    const r = classifyGammaMarket(missingTeams({ slug: "mlb-bos-mia-2026-08-25", sportsMarketType: "moneyline", line: null }));
    expect(r.status).toBe("ELIGIBLE");
    expect(r.betType).toBe("MONEYLINE");
    expect(r.awayTeam).toBe("BOS");
    expect(r.homeTeam).toBe("MIA");
  });

  it("derives participants for canonical MLB full-game spread when Gamma teams are missing", () => {
    const r = classifyGammaMarket(missingTeams({ slug: "mlb-bos-mia-2026-08-25-spread-away-1pt5", sportsMarketType: "spreads", line: -1.5 }));
    expect(r.status).toBe("ELIGIBLE");
    expect(r.betType).toBe("SPREAD");
    expect(r.awayTeam).toBe("BOS");
    expect(r.homeTeam).toBe("MIA");
  });

  it("derives participants for canonical MLB full-game total when Gamma teams are missing", () => {
    const r = classifyGammaMarket(missingTeams({ slug: "mlb-tex-cws-2026-08-25-total-7pt5", sportsMarketType: "totals", line: 7.5 }));
    expect(r.status).toBe("ELIGIBLE");
    expect(r.betType).toBe("TOTAL");
    expect(r.awayTeam).toBe("TEX");
    expect(r.homeTeam).toBe("CWS");
  });

  it("keeps Wilyer Abreu home-run prop rejected before slug fallback", () => {
    const r = classifyGammaMarket(
      missingTeams({
        slug: "mlb-bos-mia-2026-08-24-hr-wilyer-abreu-0pt5",
        question: "Wilyer Abreu: Home Runs O/U 0.5",
        sportsMarketType: "player_prop",
        line: 0.5,
      }),
    );
    expect(r.status).toBe("INELIGIBLE");
    expect(r.reasonCode).toBe("REJECT_PROP");
  });

  it("keeps F5 total rejected before slug fallback", () => {
    const r = classifyGammaMarket(missingTeams({ slug: "mlb-bos-mia-2026-08-25-f5-total-4pt5", question: "BOS vs MIA first 5 innings total 4.5", sportsMarketType: "totals", line: 4.5 }));
    expect(r.status).toBe("INELIGIBLE");
    expect(r.reasonCode).toBe("REJECT_F5");
  });

  it("keeps inning markets rejected before slug fallback", () => {
    const r = classifyGammaMarket(missingTeams({ slug: "mlb-bos-mia-2026-08-25-1st-inning", question: "Will Boston score in the 1st inning?", sportsMarketType: "moneyline" }));
    expect(r.status).toBe("INELIGIBLE");
    expect(r.reasonCode).toBe("REJECT_INNING");
  });

  it("malformed MLB slug remains UNVERIFIED", () => {
    const r = classifyGammaMarket(missingTeams({ slug: "mlb-bos-mia-2026-08-25-total-seven", sportsMarketType: null, line: null }));
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_PARSE_FAILURE");
  });

  it("unknown MLB team code remains fail-closed", () => {
    const r = classifyGammaMarket(missingTeams({ slug: "mlb-xxx-mia-2026-08-25-total-7pt5", sportsMarketType: "totals", line: 7.5 }));
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_UNKNOWN_TEAM");
  });

  it("structured teams conflicting with canonical slug remain UNVERIFIED_CONFLICTING_METADATA", () => {
    const r = classifyGammaMarket({ ...moneyline, slug: "mlb-bos-mia-2026-08-25", question: null, groupItemTitle: null });
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_CONFLICTING_METADATA");
  });
});

/**
 * Task 12F / P1-H: exhaustive over the real UnverifiedReasonCode union (9 members) --
 * H3/H4/H5 (retryable/transport) and H6/H7/H8/H9/H10 (terminal/classifier-level).
 */
describe("classifyUnverifiedDisposition", () => {
  const RETRYABLE: UnverifiedReasonCode[] = ["UNVERIFIED_FETCH_FAILED", "UNVERIFIED_EMPTY_RESPONSE", "UNVERIFIED_MALFORMED_RESPONSE"];
  const TERMINAL: UnverifiedReasonCode[] = [
    "UNVERIFIED_METADATA_MISSING",
    "UNVERIFIED_AMBIGUOUS_PERIOD",
    "UNVERIFIED_PARSE_FAILURE",
    "UNVERIFIED_CONFLICTING_METADATA",
    "UNVERIFIED_UNKNOWN_TEAM",
    "UNVERIFIED_MISSING_LINE",
  ];

  it("H3: UNVERIFIED_FETCH_FAILED is RETRYABLE", () => {
    expect(classifyUnverifiedDisposition("UNVERIFIED_FETCH_FAILED")).toBe("RETRYABLE");
  });

  it("H4: UNVERIFIED_EMPTY_RESPONSE is RETRYABLE", () => {
    expect(classifyUnverifiedDisposition("UNVERIFIED_EMPTY_RESPONSE")).toBe("RETRYABLE");
  });

  it("H5: UNVERIFIED_MALFORMED_RESPONSE is RETRYABLE", () => {
    expect(classifyUnverifiedDisposition("UNVERIFIED_MALFORMED_RESPONSE")).toBe("RETRYABLE");
  });

  it("H6: UNVERIFIED_AMBIGUOUS_PERIOD is TERMINAL", () => {
    expect(classifyUnverifiedDisposition("UNVERIFIED_AMBIGUOUS_PERIOD")).toBe("TERMINAL");
  });

  it("H7: UNVERIFIED_PARSE_FAILURE is TERMINAL", () => {
    expect(classifyUnverifiedDisposition("UNVERIFIED_PARSE_FAILURE")).toBe("TERMINAL");
  });

  it("H8: UNVERIFIED_CONFLICTING_METADATA is TERMINAL", () => {
    expect(classifyUnverifiedDisposition("UNVERIFIED_CONFLICTING_METADATA")).toBe("TERMINAL");
  });

  it("H9: UNVERIFIED_MISSING_LINE is TERMINAL", () => {
    expect(classifyUnverifiedDisposition("UNVERIFIED_MISSING_LINE")).toBe("TERMINAL");
  });

  it("H10: UNVERIFIED_UNKNOWN_TEAM is TERMINAL", () => {
    expect(classifyUnverifiedDisposition("UNVERIFIED_UNKNOWN_TEAM")).toBe("TERMINAL");
  });

  it("UNVERIFIED_METADATA_MISSING is TERMINAL (a successfully-read Gamma response simply lacking usable structured/slug fields is a deterministic property of that conditionId, not a transient failure)", () => {
    expect(classifyUnverifiedDisposition("UNVERIFIED_METADATA_MISSING")).toBe("TERMINAL");
  });

  it("the RETRYABLE and TERMINAL sets are exhaustive and disjoint over the full 9-member union", () => {
    const all = [...RETRYABLE, ...TERMINAL];
    expect(new Set(all).size).toBe(9); // no duplicates
    for (const code of RETRYABLE) expect(classifyUnverifiedDisposition(code)).toBe("RETRYABLE");
    for (const code of TERMINAL) expect(classifyUnverifiedDisposition(code)).toBe("TERMINAL");
  });
});
