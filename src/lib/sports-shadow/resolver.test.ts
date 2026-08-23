import { describe, expect, it } from "vitest";
import { buildRuleFingerprint, resolveKalshiMatch, resolvePmusMatch, resolveSportsMarket, type SourceSignal } from "./resolver";
import type { KalshiCandidate } from "./kalshi";
import type { PmusCandidate } from "./pmus";

const COMPATIBLE_PMUS_RULES =
  "This market will settle to the winner of the game. Extra innings are included if played. If the game is delayed, postponed, or suspended, this market will remain open until the game has been completed.";
const COMPATIBLE_KALSHI_RULES =
  "If the named team wins the game, then the market resolves to Yes. Extra innings are included in this market. If this game is postponed or delayed, the market will remain open and close after the rescheduled game has finished.";
/**
 * CODEX P1-6: mirrors the SAME dual-dimension confirmed-compatible language as the
 * target-side constants above (extra innings included + postponement handled) --
 * matches the real gamma-api.polymarket.com `description` field's own resolution-rules
 * text style (live-confirmed, e.g. an MLB moneyline market's actual postponement clause).
 * Used as `source()`'s default so every PRE-EXISTING test in this file (written before
 * source-side rules existed at all) continues to see the SAME "both sides agree" EXACT
 * outcome its target-only rulesDescription already implied -- tests exercising a genuine
 * cross-venue MISMATCH override this explicitly (see the CODEX P1-6 describe block).
 */
const COMPATIBLE_SOURCE_RULES =
  "This market will resolve to the winner of the game. Extra innings are included in this market. If the game is postponed, this market will remain open until the game has been completed.";

function source(overrides: Partial<SourceSignal> = {}): SourceSignal {
  return {
    betType: "MONEYLINE",
    awayTeam: "NYY",
    homeTeam: "BAL",
    gameStartTime: "2026-08-19T22:35:00Z",
    line: null,
    selectedOutcomeRaw: "New York Yankees",
    conditionId: "0xcond",
    sourceRulesDescription: COMPATIBLE_SOURCE_RULES,
    sourceGameId: "game-1",
    eventSlug: "mlb-nyy-bal-2026-08-19",
    marketSlug: "mlb-nyy-bal-2026-08-19",
    ...overrides,
  };
}

function pmusCandidate(overrides: Partial<PmusCandidate> = {}): PmusCandidate {
  return {
    status: "ELIGIBLE",
    reasonCode: "ELIGIBLE_FULL_GAME_MONEYLINE",
    betType: "MONEYLINE",
    eventId: "ev-1",
    eventSlug: "mlb-nyy-bal-2026-08-19",
    gameId: "game-1",
    marketId: "mkt-1",
    marketSlug: "aec-mlb-nyy-bal-2026-08-19",
    scheduledStartAt: "2026-08-19T22:35:00Z",
    league: "mlb",
    awayTeam: "NYY",
    homeTeam: "BAL",
    line: null,
    active: true,
    closed: false,
    marketStatus: "MARKET_STATUS_OPEN",
    question: "New York Yankees vs. Baltimore Orioles",
    rulesDescription: COMPATIBLE_PMUS_RULES,
    sides: [
      { description: "New York Yankees", teamAbbreviation: "nyy", long: true },
      { description: "Baltimore Orioles", teamAbbreviation: "bal", long: false },
    ],
    ...overrides,
  };
}

function kalshiCandidate(overrides: Partial<KalshiCandidate> = {}): KalshiCandidate {
  return {
    status: "ELIGIBLE",
    reasonCode: "ELIGIBLE_FULL_GAME_MONEYLINE",
    betType: "MONEYLINE",
    seriesTicker: "KXMLBGAME",
    eventTicker: "KXMLBGAME-1",
    gameCode: "1",
    marketTicker: "KXMLBGAME-1-NYY",
    title: "New York Yankees wins",
    awayTeam: "NYY",
    homeTeam: "BAL",
    propositionTeam: "NYY",
    line: null,
    strikeType: "structured",
    marketStatus: "active",
    openTime: "2026-08-19T00:00:00Z",
    closeTime: "2026-08-20T00:00:00Z",
    latestExpirationTime: "2026-08-20T00:00:00Z",
    scheduledStartAt: "2026-08-19T22:35:00Z",
    rulesPrimary: COMPATIBLE_KALSHI_RULES,
    rulesSecondary: null,
    earlyCloseCondition: null,
    yesSubTitle: "New York Yankees",
    noSubTitle: "New York Yankees",
    summaryYesBidDollars: null,
    summaryYesAskDollars: null,
    summaryNoBidDollars: null,
    summaryNoAskDollars: null,
    priceLevelStructure: "linear_cent",
    priceRanges: [{ start: "0.0000", end: "1.0000", step: "0.0010" }],
    ...overrides,
  };
}

describe("resolvePmusMatch / resolveKalshiMatch — core game identity", () => {
  it("1. same teams + same start + same type is eligible for further exact checks", () => {
    const r = resolvePmusMatch(source(), [pmusCandidate()]);
    expect(r.status).toBe("EXACT");
  });

  it("2. away/home reversed is never treated as the same game (not exact)", () => {
    const reversed = pmusCandidate({ awayTeam: "BAL", homeTeam: "NYY" });
    const r = resolvePmusMatch(source(), [reversed]);
    expect(r.status).not.toBe("EXACT");
    expect(r.reasonCode).toBe("NONE_NO_CANDIDATE");
  });

  it("3. a different opponent yields NONE", () => {
    const other = pmusCandidate({ awayTeam: "BOS", homeTeam: "TOR" });
    const r = resolvePmusMatch(source(), [other]);
    expect(r.status).toBe("NONE");
  });

  it("4. same teams/date but a genuinely different game (different start) is not exact without disambiguation", () => {
    const gameA = pmusCandidate({ marketId: "a", gameId: "gameA", scheduledStartAt: "2026-08-19T22:35:00Z" });
    const gameB = pmusCandidate({ marketId: "b", gameId: "gameB", scheduledStartAt: "2026-08-20T18:00:00Z" });
    const r = resolvePmusMatch(source({ gameStartTime: null }), [gameA, gameB]);
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_AMBIGUOUS_GAME");
  });

  it("5. doubleheader candidate ambiguity yields UNVERIFIED", () => {
    const g1 = pmusCandidate({ marketId: "g1", gameId: "g1", scheduledStartAt: "2026-08-19T18:00:00Z" });
    const g2 = pmusCandidate({ marketId: "g2", gameId: "g2", scheduledStartAt: "2026-08-19T23:00:00Z" });
    const r = resolvePmusMatch(source({ gameStartTime: null }), [g1, g2]);
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_AMBIGUOUS_GAME");
  });

  it("6. a doubleheader IS resolved when the source start time exactly disambiguates it", () => {
    const g1 = pmusCandidate({ marketId: "g1", gameId: "g1", scheduledStartAt: "2026-08-19T18:00:00Z" });
    const g2 = pmusCandidate({ marketId: "g2", gameId: "g2", scheduledStartAt: "2026-08-19T23:00:00Z" });
    const r = resolvePmusMatch(source({ gameStartTime: "2026-08-19T23:00:00Z" }), [g1, g2]);
    expect(r.status).toBe("EXACT");
    expect(r.targetMarketId).toBe("g2");
  });

  it("7. multiple independently-exact-looking candidates never pick a first match", () => {
    const dup1 = pmusCandidate({ marketId: "m1" });
    const dup2 = pmusCandidate({ marketId: "m2" }); // structurally distinct market, same everything else -> both would independently qualify
    const r = resolvePmusMatch(source(), [dup1, dup2]);
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_AMBIGUOUS_TARGET");
  });

  it("8. the exact same candidate object twice dedupes deterministically (identical market ID)", () => {
    const c = pmusCandidate();
    const r1 = resolvePmusMatch(source(), [c, c]);
    const r2 = resolvePmusMatch(source(), [c]);
    expect(r1.status).toBe(r2.status);
    expect(r1.targetMarketId).toBe(r2.targetMarketId);
  });
});

describe("MONEYLINE resolution", () => {
  it("9. source away-team ML resolves to the corresponding PM-US side", () => {
    const r = resolvePmusMatch(source({ selectedOutcomeRaw: "New York Yankees" }), [pmusCandidate()]);
    expect(r.status).toBe("EXACT");
    expect(r.targetSide).toEqual({ kind: "TEAM", team: "NYY" });
  });

  it("10. source home-team ML resolves to the corresponding PM-US side", () => {
    const r = resolvePmusMatch(source({ selectedOutcomeRaw: "Baltimore Orioles" }), [pmusCandidate()]);
    expect(r.status).toBe("EXACT");
    expect(r.targetSide).toEqual({ kind: "TEAM", team: "BAL" });
  });

  it("11. source team maps to Kalshi YES when the ticker's own proposition is that team", () => {
    const r = resolveKalshiMatch(source({ selectedOutcomeRaw: "New York Yankees" }), [kalshiCandidate({ propositionTeam: "NYY" })]);
    expect(r.status).toBe("EXACT");
    expect(r.targetSide).toEqual({ kind: "YES" });
  });

  it("12. source opponent maps to Kalshi NO when the complement is proven (only the opponent's ticker exists)", () => {
    const balTicker = kalshiCandidate({ marketTicker: "KXMLBGAME-1-BAL", propositionTeam: "BAL" });
    const r = resolveKalshiMatch(source({ selectedOutcomeRaw: "New York Yankees" }), [balTicker]);
    expect(r.status).toBe("EXACT");
    expect(r.targetSide).toEqual({ kind: "NO" });
  });

  it("41. source BUY does not automatically mean target YES — it is the source TEAM, not the fill side, that determines target side", () => {
    // Same source selection (Yankees), evaluated against the opponent's ticker only -> NO, not YES,
    // proving the resolver never defaults to YES regardless of what the source "bought".
    const balTicker = kalshiCandidate({ marketTicker: "KXMLBGAME-1-BAL", propositionTeam: "BAL" });
    const r = resolveKalshiMatch(source({ selectedOutcomeRaw: "New York Yankees" }), [balTicker]);
    expect(r.targetSide).toEqual({ kind: "NO" });
  });

  it("42. favorite/underdog price does not determine target side (price is not even inspected)", () => {
    const r = resolveKalshiMatch(source({ selectedOutcomeRaw: "New York Yankees" }), [
      kalshiCandidate({ propositionTeam: "NYY", summaryYesBidDollars: 0.05, summaryYesAskDollars: 0.06 }),
    ]);
    expect(r.status).toBe("EXACT");
    expect(r.targetSide).toEqual({ kind: "YES" });
  });

  it("43/44. YES/NO and PM-US side orientation are both determined from structured proposition/side metadata, never array position", () => {
    // PM-US sides deliberately reordered (home first) -- must still resolve correctly by teamAbbreviation, not index.
    const reorderedSides = pmusCandidate({ sides: [{ description: "Baltimore Orioles", teamAbbreviation: "bal", long: false }, { description: "New York Yankees", teamAbbreviation: "nyy", long: true }] });
    const r = resolvePmusMatch(source({ selectedOutcomeRaw: "New York Yankees" }), [reorderedSides]);
    expect(r.targetSide).toEqual({ kind: "TEAM", team: "NYY" });
  });

  it("13. ambiguous PM-US side metadata (source team absent from sides) is UNVERIFIED", () => {
    const noSides = pmusCandidate({ sides: [] });
    const r = resolvePmusMatch(source(), [noSides]);
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_SIDE_ORIENTATION");
  });

  it("14/45. an ambiguous Kalshi proposition (neither team's ticker present) prevents EXACT", () => {
    const wrongTicker = kalshiCandidate({ propositionTeam: null });
    const r = resolveKalshiMatch(source(), [wrongTicker]);
    expect(r.status).not.toBe("EXACT");
    expect(r.status).toBe("NEAR");
  });
});

describe("SPREAD resolution", () => {
  const spreadSource = (overrides: Partial<SourceSignal> = {}) =>
    source({ betType: "SPREAD", line: -1.5, selectedOutcomeRaw: "New York Yankees", ...overrides });

  function pmusSpread(overrides: Partial<PmusCandidate> = {}): PmusCandidate {
    return pmusCandidate({
      betType: "SPREAD",
      reasonCode: "ELIGIBLE_FULL_GAME_SPREAD",
      marketSlug: "asc-mlb-nyy-bal-2026-08-19-neg-1pt5",
      line: -1.5,
      sides: [
        { description: "-1.50", teamAbbreviation: "nyy", long: true },
        { description: "+1.50", teamAbbreviation: "bal", long: false },
      ],
      ...overrides,
    });
  }

  function kalshiSpread(overrides: Partial<KalshiCandidate> = {}): KalshiCandidate {
    return kalshiCandidate({
      betType: "SPREAD",
      reasonCode: "ELIGIBLE_FULL_GAME_SPREAD",
      marketTicker: "KXMLBSPREAD-1-NYY15",
      propositionTeam: "NYY",
      line: 1.5,
      yesSubTitle: "New York Yankees wins by over 1.5 runs",
      noSubTitle: "New York Yankees wins by over 1.5 runs",
      ...overrides,
    });
  }

  it("15. same team -1.5 is an exact YES-equivalent proposition (PM-US: matching long side)", () => {
    const r = resolvePmusMatch(spreadSource(), [pmusSpread()]);
    expect(r.status).toBe("EXACT");
    expect(r.targetSide).toEqual({ kind: "TEAM", team: "NYY" });
  });

  it("15b. same team -1.5 is EXACT YES on the Kalshi 'wins by over 1.5' ticker", () => {
    const r = resolveKalshiMatch(spreadSource(), [kalshiSpread()]);
    expect(r.status).toBe("EXACT");
    expect(r.targetSide).toEqual({ kind: "YES" });
  });

  it("16. opponent +1.5 is the exact complementary NO when rules prove equivalence (Kalshi)", () => {
    const r = resolveKalshiMatch(spreadSource({ selectedOutcomeRaw: "Baltimore Orioles", line: 1.5 }), [kalshiSpread()]);
    expect(r.status).toBe("EXACT");
    expect(r.targetSide).toEqual({ kind: "NO" });
  });

  it("16b. opponent +1.5 resolves to the complementary PM-US side within the SAME market as -1.5", () => {
    const r = resolvePmusMatch(spreadSource({ selectedOutcomeRaw: "Baltimore Orioles", line: 1.5 }), [pmusSpread()]);
    expect(r.status).toBe("EXACT");
    expect(r.targetSide).toEqual({ kind: "TEAM", team: "BAL" });
  });

  it("17. same game but -1.5 vs -2.5 is NEAR, not EXACT", () => {
    const r = resolvePmusMatch(spreadSource(), [pmusSpread({ marketSlug: "asc-mlb-nyy-bal-2026-08-19-neg-2pt5", line: -2.5, sides: [{ description: "-2.50", teamAbbreviation: "nyy", long: true }, { description: "+2.50", teamAbbreviation: "bal", long: false }] })]);
    expect(r.status).toBe("NEAR");
    expect(r.reasonCode).toBe("NEAR_DIFFERENT_LINE");
  });

  it("18. same numeric magnitude but wrong team/sign is not EXACT", () => {
    // Source wants NYY -1.5; candidate only has a BAL -1.5 ticker (Kalshi) -- not the source's proposition at all.
    const wrongTeam = kalshiSpread({ propositionTeam: "BAL", marketTicker: "KXMLBSPREAD-1-BAL15" });
    const r = resolveKalshiMatch(spreadSource(), [wrongTeam]);
    expect(r.status).not.toBe("EXACT");
  });

  it("19. exact half-point line is preserved through matching (-1.5 stays -1.5, not rounded)", () => {
    const r = resolvePmusMatch(spreadSource(), [pmusSpread()]);
    expect(r.targetLine).toBe(-1.5);
  });

  it("20. an integer spread with unresolved push semantics is UNVERIFIED, not EXACT", () => {
    const integerSpreadSource = spreadSource({ line: -1 });
    const integerCandidate = pmusSpread({ line: -1, sides: [{ description: "-1", teamAbbreviation: "nyy", long: true }, { description: "+1", teamAbbreviation: "bal", long: false }] });
    const r = resolvePmusMatch(integerSpreadSource, [integerCandidate]);
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_RULES");
    expect(r.settlementProfile?.pushRisk).toBe("UNVERIFIED");
  });

  it("21. a proposition-team conflict (neither the team nor its opponent has a matching Kalshi ticker) is UNVERIFIED/NEAR, never EXACT", () => {
    const otherTeamTicker = kalshiSpread({ propositionTeam: "TOR", marketTicker: "KXMLBSPREAD-1-TOR15" });
    const r = resolveKalshiMatch(spreadSource(), [otherTeamTicker]);
    expect(r.status).not.toBe("EXACT");
  });

  it("22. multiple target spread lines exist; only the hard-exact one is selected", () => {
    const candidates = [
      pmusSpread({ marketId: "neg-1pt5", marketSlug: "neg-1pt5", line: -1.5, sides: [{ description: "-1.50", teamAbbreviation: "nyy", long: true }, { description: "+1.50", teamAbbreviation: "bal", long: false }] }),
      pmusSpread({ marketId: "neg-2pt5", marketSlug: "neg-2pt5", line: -2.5, sides: [{ description: "-2.50", teamAbbreviation: "nyy", long: true }, { description: "+2.50", teamAbbreviation: "bal", long: false }] }),
      pmusSpread({ marketId: "pos-1pt5", marketSlug: "pos-1pt5", line: 1.5, sides: [{ description: "+1.50", teamAbbreviation: "nyy", long: true }, { description: "-1.50", teamAbbreviation: "bal", long: false }] }),
    ];
    const r = resolvePmusMatch(spreadSource(), candidates);
    expect(r.status).toBe("EXACT");
    expect(r.targetLine).toBe(-1.5);
  });

  it("23. no exact target line but near lines exist yields NEAR", () => {
    const candidates = [
      pmusSpread({ marketId: "neg-2pt5", marketSlug: "neg-2pt5", line: -2.5, sides: [{ description: "-2.50", teamAbbreviation: "nyy", long: true }, { description: "+2.50", teamAbbreviation: "bal", long: false }] }),
      pmusSpread({ marketId: "pos-2pt5", marketSlug: "pos-2pt5", line: 2.5, sides: [{ description: "+2.50", teamAbbreviation: "nyy", long: true }, { description: "-2.50", teamAbbreviation: "bal", long: false }] }),
    ];
    const r = resolvePmusMatch(spreadSource(), candidates);
    expect(r.status).toBe("NEAR");
  });
});

describe("TOTAL resolution", () => {
  const totalSource = (overrides: Partial<SourceSignal> = {}) => source({ betType: "TOTAL", line: 8.5, selectedOutcomeRaw: "Over", ...overrides });

  function pmusTotal(overrides: Partial<PmusCandidate> = {}): PmusCandidate {
    return pmusCandidate({
      betType: "TOTAL",
      reasonCode: "ELIGIBLE_FULL_GAME_TOTAL",
      marketSlug: "tsc-mlb-nyy-bal-2026-08-19-8pt5",
      line: 8.5,
      sides: [
        { description: "Over", teamAbbreviation: null, long: true },
        { description: "Under", teamAbbreviation: null, long: false },
      ],
      ...overrides,
    });
  }

  function kalshiTotal(overrides: Partial<KalshiCandidate> = {}): KalshiCandidate {
    return kalshiCandidate({
      betType: "TOTAL",
      reasonCode: "ELIGIBLE_FULL_GAME_TOTAL",
      marketTicker: "KXMLBTOTAL-1-85",
      propositionTeam: null,
      line: 8.5,
      yesSubTitle: "Over 8.5 runs scored",
      noSubTitle: "Over 8.5 runs scored",
      ...overrides,
    });
  }

  it("24. OVER 8.5 is exact YES where the proposition is >8.5", () => {
    const r = resolveKalshiMatch(totalSource(), [kalshiTotal()]);
    expect(r.status).toBe("EXACT");
    expect(r.targetSide).toEqual({ kind: "YES" });
  });

  it("24b. OVER 8.5 is exact on the PM-US Over side", () => {
    const r = resolvePmusMatch(totalSource(), [pmusTotal()]);
    expect(r.status).toBe("EXACT");
    expect(r.targetSide).toEqual({ kind: "OVER" });
  });

  it("25. UNDER 8.5 is exact NO where the complement is proven", () => {
    const r = resolveKalshiMatch(totalSource({ selectedOutcomeRaw: "Under" }), [kalshiTotal()]);
    expect(r.status).toBe("EXACT");
    expect(r.targetSide).toEqual({ kind: "NO" });
  });

  it("25b. UNDER 8.5 resolves to the PM-US Under side", () => {
    const r = resolvePmusMatch(totalSource({ selectedOutcomeRaw: "Under" }), [pmusTotal()]);
    expect(r.targetSide).toEqual({ kind: "UNDER" });
  });

  it("26. source 8.5 vs target 9.5 is NEAR, not EXACT", () => {
    const r = resolvePmusMatch(totalSource(), [pmusTotal({ marketSlug: "9pt5", line: 9.5 })]);
    expect(r.status).toBe("NEAR");
  });

  it("27. source 8.0 (integer total) with unresolved push semantics is UNVERIFIED", () => {
    const integerTotal = pmusTotal({ line: 8, sides: [{ description: "Over", teamAbbreviation: null, long: true }, { description: "Under", teamAbbreviation: null, long: false }] });
    const r = resolvePmusMatch(totalSource({ line: 8 }), [integerTotal]);
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_RULES");
  });

  it("28. a missing target line is UNVERIFIED/NEAR, never EXACT", () => {
    const noLine = kalshiTotal({ line: null });
    const r = resolveKalshiMatch(totalSource(), [noLine]);
    expect(r.status).not.toBe("EXACT");
  });

  it("29. an ambiguous target direction (no Over/Under side found) is UNVERIFIED", () => {
    const ambiguousSides = pmusTotal({ sides: [{ description: "Yes", teamAbbreviation: null, long: true }, { description: "No", teamAbbreviation: null, long: false }] });
    const r = resolvePmusMatch(totalSource(), [ambiguousSides]);
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_SIDE_ORIENTATION");
  });
});

describe("period / market-type mismatch", () => {
  it("30. source full-game vs a target F5/period candidate is never EXACT (F5 candidates are UNSUPPORTED and excluded before matching)", () => {
    const f5 = pmusCandidate({ status: "UNSUPPORTED", reasonCode: "REJECT_F5" as never });
    const r = resolvePmusMatch(source(), [f5]);
    expect(r.status).not.toBe("EXACT");
    expect(r.status).toBe("NONE");
  });

  it("31. source MONEYLINE vs target SPREAD is not exact", () => {
    const spread = pmusCandidate({ betType: "SPREAD", line: -1.5 });
    const r = resolvePmusMatch(source(), [spread]);
    expect(r.status).toBe("NONE");
  });

  it("32. source TOTAL vs target SPREAD is not exact", () => {
    const spread = pmusCandidate({ betType: "SPREAD", line: -1.5 });
    const r = resolvePmusMatch(source({ betType: "TOTAL", line: 8.5, selectedOutcomeRaw: "Over" }), [spread]);
    expect(r.status).toBe("NONE");
  });

  it("33. a non-ELIGIBLE (prop/future) candidate can never become EXACT even if teams/time coincidentally match", () => {
    const prop = pmusCandidate({ status: "UNVERIFIED", reasonCode: "UNVERIFIED_MISSING_LINE" as never });
    const r = resolvePmusMatch(source(), [prop]);
    expect(r.status).not.toBe("EXACT");
  });
});

describe("settlement rule tests", () => {
  it("34. known-compatible settlement semantics allow EXACT", () => {
    const r = resolvePmusMatch(source(), [pmusCandidate()]);
    expect(r.status).toBe("EXACT");
    expect(r.settlementCompatibility).toBe("COMPATIBLE");
  });

  it("35. a known rule incompatibility prevents EXACT (NEAR/incompatible instead)", () => {
    const incompatible = pmusCandidate({ rulesDescription: "Extra innings are not included in this market." });
    const r = resolvePmusMatch(source(), [incompatible]);
    expect(r.status).not.toBe("EXACT");
    expect(r.settlementProfile?.extraInnings).toBe("KNOWN_INCOMPATIBLE");
  });

  it("36. unknown settlement semantics (no rules text at all) is UNVERIFIED", () => {
    const noRules = pmusCandidate({ rulesDescription: null });
    const r = resolvePmusMatch(source(), [noRules]);
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_RULES");
  });

  it("37. missing postponement-rule evidence prevents EXACT", () => {
    const noPostponement = pmusCandidate({ rulesDescription: "Extra innings are included if played." });
    const r = resolvePmusMatch(source(), [noPostponement]);
    expect(r.status).toBe("UNVERIFIED");
    expect(r.settlementProfile?.postponement).toBe("UNVERIFIED");
  });

  it("38. shortened-game-rule ambiguity (no rules text) prevents EXACT", () => {
    const r = resolvePmusMatch(source(), [pmusCandidate({ rulesDescription: "" })]);
    expect(r.status).not.toBe("EXACT");
  });

  it("39. a push-rule mismatch (integer line, unproven) prevents EXACT", () => {
    const spreadSrc = source({ betType: "SPREAD", line: -1, selectedOutcomeRaw: "New York Yankees" });
    const integerSpread = pmusCandidate({ betType: "SPREAD", line: -1, sides: [{ description: "-1", teamAbbreviation: "nyy", long: true }, { description: "+1", teamAbbreviation: "bal", long: false }] });
    const r = resolvePmusMatch(spreadSrc, [integerSpread]);
    expect(r.status).toBe("UNVERIFIED");
  });

  it("40. an extra-innings mismatch prevents EXACT", () => {
    const noExtraInnings = kalshiCandidate({ rulesPrimary: "If the team wins the game, resolves Yes.", rulesSecondary: null });
    const r = resolveKalshiMatch(source(), [noExtraInnings]);
    expect(r.status).not.toBe("EXACT");
    expect(r.settlementProfile?.extraInnings).toBe("UNVERIFIED");
  });
});

describe("status precedence", () => {
  it("46. one exact + several near candidates overall resolves to EXACT", () => {
    const exactCandidate = pmusCandidate({ betType: "SPREAD", line: -1.5, marketId: "neg-1pt5", reasonCode: "ELIGIBLE_FULL_GAME_SPREAD", sides: [{ description: "-1.50", teamAbbreviation: "nyy", long: true }, { description: "+1.50", teamAbbreviation: "bal", long: false }] });
    const nearCandidate = pmusCandidate({ betType: "SPREAD", line: -2.5, marketId: "neg-2pt5", marketSlug: "neg-2pt5", reasonCode: "ELIGIBLE_FULL_GAME_SPREAD", sides: [{ description: "-2.50", teamAbbreviation: "nyy", long: true }, { description: "+2.50", teamAbbreviation: "bal", long: false }] });
    const r = resolvePmusMatch(source({ betType: "SPREAD", line: -1.5, selectedOutcomeRaw: "New York Yankees" }), [exactCandidate, nearCandidate]);
    expect(r.status).toBe("EXACT");
  });

  it("47. zero exact + near-only candidates resolves to NEAR", () => {
    const r = resolvePmusMatch(
      source({ betType: "SPREAD", line: -1.5, selectedOutcomeRaw: "New York Yankees" }),
      [pmusCandidate({ betType: "SPREAD", line: -2.5, reasonCode: "ELIGIBLE_FULL_GAME_SPREAD", sides: [{ description: "-2.50", teamAbbreviation: "nyy", long: true }, { description: "+2.50", teamAbbreviation: "bal", long: false }] })],
    );
    expect(r.status).toBe("NEAR");
  });

  it("48. zero exact + an unresolved-plausible candidate resolves to UNVERIFIED", () => {
    const r = resolvePmusMatch(source(), [pmusCandidate({ sides: [] })]);
    expect(r.status).toBe("UNVERIFIED");
  });

  it("49. no credible candidates at all resolves to NONE", () => {
    const r = resolvePmusMatch(source(), []);
    expect(r.status).toBe("NONE");
  });

  it("50. two independently-exact candidates resolves to UNVERIFIED_AMBIGUOUS_TARGET", () => {
    const c1 = pmusCandidate({ marketId: "m1" });
    const c2 = pmusCandidate({ marketId: "m2" });
    const r = resolvePmusMatch(source(), [c1, c2]);
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_AMBIGUOUS_TARGET");
  });
});

describe("resolveSportsMarket — independent per-venue resolution", () => {
  it("resolves PM-US and Kalshi independently; both may be EXACT, and neither is chosen as a 'winner'", () => {
    const { pmusResult, kalshiResult } = resolveSportsMarket(source(), [pmusCandidate()], [kalshiCandidate({ propositionTeam: "NYY" })]);
    expect(pmusResult.status).toBe("EXACT");
    expect(kalshiResult.status).toBe("EXACT");
    expect(pmusResult.venue).toBe("PMUS");
    expect(kalshiResult.venue).toBe("KALSHI");
  });

  it("one venue can be EXACT while the other is NONE, independently", () => {
    const { pmusResult, kalshiResult } = resolveSportsMarket(source(), [pmusCandidate()], []);
    expect(pmusResult.status).toBe("EXACT");
    expect(kalshiResult.status).toBe("NONE");
  });
});

describe("source outcome parsing failure", () => {
  it("an unparseable source outcome fails closed to UNVERIFIED_SOURCE_OUTCOME rather than guessing", () => {
    const r = resolvePmusMatch(source({ selectedOutcomeRaw: "Some Unrecognized Text" }), [pmusCandidate()]);
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_SOURCE_OUTCOME");
  });

  it("a source outcome naming a team that is neither the source's away nor home team fails closed", () => {
    const r = resolvePmusMatch(source({ selectedOutcomeRaw: "Los Angeles Dodgers" }), [pmusCandidate()]);
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_SOURCE_OUTCOME");
  });
});

describe("Task 12G / P1-J: PM-US LONG/SHORT orientation preservation", () => {
  it("J1: moneyline matched side long=true durably carries orientation LONG", () => {
    const r = resolvePmusMatch(source(), [pmusCandidate()]); // default side "New York Yankees" has long:true
    expect(r.status).toBe("EXACT");
    expect(r.targetPmusOrientation).toBe("LONG");
  });

  it("J2: moneyline matched side long=false durably carries orientation SHORT", () => {
    const r = resolvePmusMatch(source({ selectedOutcomeRaw: "Baltimore Orioles" }), [pmusCandidate()]); // "Baltimore Orioles" side has long:false
    expect(r.status).toBe("EXACT");
    expect(r.targetPmusOrientation).toBe("SHORT");
  });

  it("J3: spread matching preserves the exact matched side's long flag (both LONG and SHORT sides of the same market)", () => {
    const spreadSource = (overrides: Partial<SourceSignal> = {}) => source({ betType: "SPREAD", line: -1.5, selectedOutcomeRaw: "New York Yankees", ...overrides });
    const pmusSpread = (overrides: Partial<PmusCandidate> = {}) =>
      pmusCandidate({
        betType: "SPREAD",
        reasonCode: "ELIGIBLE_FULL_GAME_SPREAD",
        marketSlug: "asc-mlb-nyy-bal-2026-08-19-neg-1pt5",
        line: -1.5,
        sides: [
          { description: "-1.50", teamAbbreviation: "nyy", long: true },
          { description: "+1.50", teamAbbreviation: "bal", long: false },
        ],
        ...overrides,
      });
    const longSide = resolvePmusMatch(spreadSource(), [pmusSpread()]);
    expect(longSide.status).toBe("EXACT");
    expect(longSide.targetPmusOrientation).toBe("LONG");

    const shortSide = resolvePmusMatch(spreadSource({ selectedOutcomeRaw: "Baltimore Orioles", line: 1.5 }), [pmusSpread()]);
    expect(shortSide.status).toBe("EXACT");
    expect(shortSide.targetPmusOrientation).toBe("SHORT");
  });

  it("J4: total OVER/UNDER matching preserves the actual matching side's long flag", () => {
    const totalSource = (overrides: Partial<SourceSignal> = {}) => source({ betType: "TOTAL", line: 8.5, selectedOutcomeRaw: "Over", ...overrides });
    const pmusTotal = (overrides: Partial<PmusCandidate> = {}) =>
      pmusCandidate({
        betType: "TOTAL",
        reasonCode: "ELIGIBLE_FULL_GAME_TOTAL",
        marketSlug: "tsc-mlb-nyy-bal-2026-08-19-8pt5",
        line: 8.5,
        sides: [
          { description: "Over", teamAbbreviation: null, long: true },
          { description: "Under", teamAbbreviation: null, long: false },
        ],
        ...overrides,
      });
    const over = resolvePmusMatch(totalSource(), [pmusTotal()]);
    expect(over.status).toBe("EXACT");
    expect(over.targetPmusOrientation).toBe("LONG");

    const under = resolvePmusMatch(totalSource({ selectedOutcomeRaw: "Under" }), [pmusTotal()]);
    expect(under.status).toBe("EXACT");
    expect(under.targetPmusOrientation).toBe("SHORT");
  });

  it("J5: serialization/persistence round-trip preserves semantic outcome + LONG/SHORT without ambiguity", async () => {
    const { buildMatchRow } = await import("./observation");
    const longResult = resolvePmusMatch(source(), [pmusCandidate()]);
    const shortResult = resolvePmusMatch(source({ selectedOutcomeRaw: "Baltimore Orioles" }), [pmusCandidate()]);
    const longRow = buildMatchRow("sig-1", longResult, { firstMatchStatus: "EXACT", recheckCount: 0, nextRecheckAt: null });
    const shortRow = buildMatchRow("sig-2", shortResult, { firstMatchStatus: "EXACT", recheckCount: 0, nextRecheckAt: null });
    expect(longRow.selectedSide).toBe("TEAM:NYY:LONG");
    expect(shortRow.selectedSide).toBe("TEAM:BAL:SHORT");
    // Round-trip is unambiguous: parsing the suffix back off recovers the exact orientation.
    expect(longRow.selectedSide?.endsWith(":LONG")).toBe(true);
    expect(shortRow.selectedSide?.endsWith(":SHORT")).toBe(true);
  });

  it("J9: a PM-US side missing the long flag entirely fails closed to UNVERIFIED, never defaults to LONG", () => {
    const missingOrientation = pmusCandidate({
      sides: [
        { description: "New York Yankees", teamAbbreviation: "nyy", long: null },
        { description: "Baltimore Orioles", teamAbbreviation: "bal", long: false },
      ],
    });
    const r = resolvePmusMatch(source(), [missingOrientation]);
    expect(r.status).not.toBe("EXACT");
    expect(r.status).toBe("UNVERIFIED");
    expect(r.targetPmusOrientation).toBeNull();
  });

  it("J10: Kalshi YES/NO results never carry a PM-US orientation (always null)", () => {
    const yes = resolveKalshiMatch(source(), [kalshiCandidate()]);
    expect(yes.status).toBe("EXACT");
    expect(yes.targetPmusOrientation).toBeNull();
  });
});

describe("Task 12G / P1-K: singleton same-team candidate must prove start-time identity", () => {
  it("K1: one candidate, exact teams, exact timestamp -> remains eligible for normal EXACT evaluation", () => {
    const r = resolvePmusMatch(source(), [pmusCandidate()]); // both default to 2026-08-19T22:35:00Z
    expect(r.status).toBe("EXACT");
  });

  it("K2: one candidate, exact teams, next-day timestamp -> NOT EXACT", () => {
    const nextDay = pmusCandidate({ scheduledStartAt: "2026-08-20T22:35:00Z" }); // same team pair, next day
    const r = resolvePmusMatch(source(), [nextDay]);
    expect(r.status).not.toBe("EXACT");
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_AMBIGUOUS_GAME");
  });

  it("K3: one candidate, exact teams, same date but different clock time -> NOT EXACT", () => {
    const sameDayDifferentTime = pmusCandidate({ scheduledStartAt: "2026-08-19T18:00:00Z" }); // same calendar day, different first pitch
    const r = resolvePmusMatch(source(), [sameDayDifferentTime]);
    expect(r.status).not.toBe("EXACT");
    expect(r.reasonCode).toBe("UNVERIFIED_AMBIGUOUS_GAME");
  });

  it("K4: source timestamp null -> NOT EXACT (even with a same-team singleton)", () => {
    const r = resolvePmusMatch(source({ gameStartTime: null }), [pmusCandidate()]);
    expect(r.status).not.toBe("EXACT");
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_MISSING_START_TIME");
  });

  it("K5: target timestamp null -> NOT EXACT (even with a same-team singleton)", () => {
    const noTimestamp = pmusCandidate({ scheduledStartAt: null });
    const r = resolvePmusMatch(source(), [noTimestamp]);
    expect(r.status).not.toBe("EXACT");
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_MISSING_START_TIME");
  });

  it("K6: two same-team game buckets -> existing exact timestamp disambiguation still works", () => {
    const g1 = pmusCandidate({ marketId: "g1", gameId: "g1", scheduledStartAt: "2026-08-19T18:00:00Z" });
    const g2 = pmusCandidate({ marketId: "g2", gameId: "g2", scheduledStartAt: "2026-08-19T23:00:00Z" });
    const r = resolvePmusMatch(source({ gameStartTime: "2026-08-19T23:00:00Z" }), [g1, g2]);
    expect(r.status).toBe("EXACT");
    expect(r.targetMarketId).toBe("g2");
  });

  it("K7: multiple buckets, no exact source timestamp -> remains UNVERIFIED (unaffected by the singleton fix)", () => {
    const g1 = pmusCandidate({ marketId: "g1", gameId: "g1", scheduledStartAt: "2026-08-19T18:00:00Z" });
    const g2 = pmusCandidate({ marketId: "g2", gameId: "g2", scheduledStartAt: "2026-08-19T23:00:00Z" });
    const r = resolvePmusMatch(source({ gameStartTime: null }), [g1, g2]);
    expect(r.status).toBe("UNVERIFIED");
    expect(r.reasonCode).toBe("UNVERIFIED_AMBIGUOUS_GAME");
  });

  it("K8: a Kalshi-style 3-hour timestamp discrepancy is NOT silently accepted through a new tolerance", () => {
    const threeHoursOff = pmusCandidate({ scheduledStartAt: "2026-08-20T01:35:00Z" }); // source is 2026-08-19T22:35:00Z, +3h off
    const r = resolvePmusMatch(source(), [threeHoursOff]);
    expect(r.status).not.toBe("EXACT");
    expect(r.reasonCode).toBe("UNVERIFIED_AMBIGUOUS_GAME");
  });

  it("K9: consecutive-day series regression -- the wrong game can never become EXACT merely because discovery returned a singleton for either day", () => {
    // Day 1 game only discovered, source is actually Day 2.
    const day1Only = pmusCandidate({ scheduledStartAt: "2026-08-18T22:35:00Z" });
    const r1 = resolvePmusMatch(source({ gameStartTime: "2026-08-19T22:35:00Z" }), [day1Only]);
    expect(r1.status).not.toBe("EXACT");

    // Day 2 game only discovered, source is actually Day 1.
    const day2Only = pmusCandidate({ scheduledStartAt: "2026-08-20T22:35:00Z" });
    const r2 = resolvePmusMatch(source({ gameStartTime: "2026-08-19T22:35:00Z" }), [day2Only]);
    expect(r2.status).not.toBe("EXACT");
  });

  it("K10: PM-US and Kalshi both use the identical fail-closed singleton game-identity rule (shared groupByGame)", () => {
    const nextDayKalshi = kalshiCandidate({ scheduledStartAt: "2026-08-20T22:35:00Z" });
    const r = resolveKalshiMatch(source(), [nextDayKalshi]);
    expect(r.status).not.toBe("EXACT");
    expect(r.reasonCode).toBe("UNVERIFIED_AMBIGUOUS_GAME");
  });

  it("confirms no timestamp tolerance was introduced anywhere -- even 1 millisecond off fails the singleton check", () => {
    const oneMsOff = pmusCandidate({ scheduledStartAt: "2026-08-19T22:35:00.001Z" });
    const r = resolvePmusMatch(source(), [oneMsOff]);
    expect(r.status).not.toBe("EXACT");
  });
});

describe("FINAL BUILD Part 6: buildRuleFingerprint", () => {
  it("captures every Part-6-required dimension explicitly, never collapsing them into one boolean", () => {
    const r = resolvePmusMatch(source(), [pmusCandidate()]);
    expect(r.status).toBe("EXACT");
    const fp = buildRuleFingerprint(r);
    expect(fp.teams.away).toBe(r.targetAwayTeam);
    expect(fp.teams.home).toBe(r.targetHomeTeam);
    expect(fp.gameIdentity.targetGameIdentifier).toBe(r.targetGameIdentifier);
    expect(fp.marketType).toBe(r.targetBetType);
    expect(fp.line.target).toBe(r.targetLine);
    expect(fp.selectedSide).toEqual(r.targetSide);
    expect(fp.fullGameScope).toBe(true);
    expect(fp.settlement.compatibility).toBe(r.settlementCompatibility);
  });

  it("settlement sub-dimensions are null (not fabricated) when the resolver never produced a settlementProfile at all", () => {
    const other = pmusCandidate({ awayTeam: "BOS", homeTeam: "TOR" });
    const r = resolvePmusMatch(source(), [other]); // NONE -- no settlementProfile computed
    const fp = buildRuleFingerprint(r);
    expect(fp.settlement.extraInnings).toBeNull();
    expect(fp.settlement.postponement).toBeNull();
    expect(fp.settlement.pushRisk).toBeNull();
  });
});

describe("CODEX P1-6: EXACT requires the SOURCE's own settlement rules to positively agree with the target's, not merely that the target's text alone looks safe", () => {
  it("same game/team/line but the SOURCE has no rules text at all (Gamma returned none) -- never a false EXACT, downgrades to UNVERIFIED", () => {
    const s = source({ sourceRulesDescription: null });
    const target = pmusCandidate(); // target text is COMPATIBLE_PMUS_RULES -- confirmed extra-innings-included + postponement-handled
    const r = resolvePmusMatch(s, [target]);
    expect(r.status).not.toBe("EXACT");
    expect(r.status).toBe("UNVERIFIED");
  });

  it("shortened/called-game divergence: source confirms extra innings are INCLUDED, target confirms they are EXCLUDED -- a genuine economic mismatch, never a false EXACT", () => {
    const s = source({ sourceRulesDescription: "This market resolves to the winner. Extra innings are included. If postponed, the market remains open until completed." });
    const target = pmusCandidate({ rulesDescription: "This market will settle to the winner of the regulation game. Extra innings are not included. If postponed, the market remains open until completed." });
    const r = resolvePmusMatch(s, [target]);
    expect(r.status).not.toBe("EXACT");
    expect(r.settlementProfile?.extraInnings).toBe("KNOWN_INCOMPATIBLE");
  });

  it("void/push divergence is orthogonal to text: a whole-integer line (genuine push risk) stays UNVERIFIED regardless of how confidently both sides' TEXT agrees on other dimensions -- never assumes numeric-line agreement implies push-safety", () => {
    const s = source({ betType: "TOTAL", line: 8, selectedOutcomeRaw: "Over", sourceRulesDescription: COMPATIBLE_SOURCE_RULES });
    const target = pmusCandidate({ betType: "TOTAL", line: 8, sides: [{ description: "Over", teamAbbreviation: null, long: true }], rulesDescription: COMPATIBLE_PMUS_RULES });
    const r = resolvePmusMatch(s, [target]);
    expect(r.status).not.toBe("EXACT");
    expect(r.settlementProfile?.pushRisk).toBe("UNVERIFIED");
  });

  it("reschedule/cancel divergence: source is silent on postponement (UNVERIFIED), target explicitly handles it -- still UNVERIFIED overall, never assumed compatible from the target's confidence alone", () => {
    const s = source({ sourceRulesDescription: "This market resolves to the winner of the game." }); // no postponement/extra-innings language at all
    const target = pmusCandidate(); // COMPATIBLE_PMUS_RULES -- confident target text
    const r = resolvePmusMatch(s, [target]);
    expect(r.status).not.toBe("EXACT");
    expect(r.settlementProfile?.postponement).toBe("UNVERIFIED");
    expect(r.settlementProfile?.extraInnings).toBe("UNVERIFIED");
  });

  it("both sides genuinely agree on every dimension -- correctly reaches EXACT (the fix does not make EXACT unreachable, only unearned)", () => {
    const s = source({ sourceRulesDescription: COMPATIBLE_SOURCE_RULES });
    const target = pmusCandidate({ rulesDescription: COMPATIBLE_PMUS_RULES });
    const r = resolvePmusMatch(s, [target]);
    expect(r.status).toBe("EXACT");
    expect(r.settlementProfile?.extraInnings).toBe("EXACT_COMPATIBLE");
    expect(r.settlementProfile?.postponement).toBe("EXACT_COMPATIBLE");
  });

  it("the same cross-venue agreement requirement applies to Kalshi, not just PM-US", () => {
    const s = source({ sourceRulesDescription: "Extra innings are included. If postponed, remains open." });
    const kalshi = kalshiCandidate({ rulesPrimary: "Extra innings are not included in this market.", rulesSecondary: null });
    const r = resolveKalshiMatch(s, [kalshi]);
    expect(r.status).not.toBe("EXACT");
    expect(r.settlementProfile?.extraInnings).toBe("KNOWN_INCOMPATIBLE");
  });
});

describe("CODEX P1-5: postponement/cancellation TREATMENT must be classified, not merely detected -- mentioning the topic is not proof of agreement", () => {
  it("REQUIRED TEST: source 'remains open until completed' vs. target 'void/cancel if postponed' -- both mention postponement, but must NEVER produce EXACT", () => {
    const s = source({
      sourceRulesDescription: "This market resolves to the winner of the game. Extra innings are included. If the game is postponed, this market will remain open until the game has been completed.",
    });
    const target = pmusCandidate({
      rulesDescription: "This market will settle to the winner of the game. Extra innings are included. This market will be void and cancelled if the game is postponed.",
    });
    const r = resolvePmusMatch(s, [target]);
    expect(r.status).not.toBe("EXACT");
    expect(r.settlementProfile?.postponement).toBe("KNOWN_INCOMPATIBLE");
  });

  it("adversarial pair 2: source void-on-postponement vs. target remains-open -- the reverse direction of the required test, same conclusion", () => {
    const s = source({
      sourceRulesDescription: "This market resolves to the winner of the game. Extra innings are included. This market is voided and all trades refunded if the game is postponed or suspended.",
    });
    const target = pmusCandidate({
      rulesDescription: "This market will settle to the winner of the game. Extra innings are included. If the game is delayed or postponed, this market stays open until the game has been completed.",
    });
    const r = resolvePmusMatch(s, [target]);
    expect(r.status).not.toBe("EXACT");
    expect(r.settlementProfile?.postponement).toBe("KNOWN_INCOMPATIBLE");
  });

  it("adversarial pair 3: both sides genuinely agree on VOID -- correctly reaches EXACT_COMPATIBLE for postponement (the fix does not make agreement unreachable, only unearned)", () => {
    const s = source({
      sourceRulesDescription: "This market resolves to the winner of the game. Extra innings are included. This market will be void if the game is postponed and not completed.",
    });
    const target = pmusCandidate({
      rulesDescription: "This market will settle to the winner of the game. Extra innings are included. This market is cancelled and refunded if the game is postponed.",
    });
    const r = resolvePmusMatch(s, [target]);
    expect(r.settlementProfile?.postponement).toBe("EXACT_COMPATIBLE");
    expect(r.status).toBe("EXACT");
  });

  it("adversarial pair 4: a called/shortened-game clause with no explicit void/remains-open language stays UNVERIFIED -- never guesses a treatment the text does not actually state", () => {
    const s = source({ sourceRulesDescription: COMPATIBLE_SOURCE_RULES });
    const target = pmusCandidate({
      rulesDescription: "This market will settle to the winner of the game. Extra innings are included. If the game is called early due to weather, standard rules apply.",
    });
    const r = resolvePmusMatch(s, [target]);
    expect(r.status).not.toBe("EXACT");
    expect(r.settlementProfile?.postponement).toBe("UNVERIFIED");
  });

  it("adversarial pair 5: merely mentioning 'rescheduled' with no declared treatment (the OLD naive regex's exact false-positive trigger) stays UNVERIFIED, not EXACT_COMPATIBLE", () => {
    const s = source({ sourceRulesDescription: COMPATIBLE_SOURCE_RULES });
    const target = pmusCandidate({
      rulesDescription: "This market will settle to the winner of the game. Extra innings are included. Games may be rescheduled by the league at any time.",
    });
    const r = resolvePmusMatch(s, [target]);
    expect(r.status).not.toBe("EXACT");
    expect(r.settlementProfile?.postponement).toBe("UNVERIFIED");
  });
});
