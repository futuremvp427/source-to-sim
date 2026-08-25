import { describe, expect, it } from "vitest";

import { canonicalLeagueLabel, getSportAdapter, kalshiDiscoverySeries, listSportAdapters, pmusDiscoveryLeagues } from "./sport-registry";

describe("sport registry (sport-agnostic orchestration)", () => {
  it("recognizes the required multi-sport scope, not MLB only", () => {
    const leagues = listSportAdapters().map((a) => a.league);
    for (const league of ["mlb", "nba", "wnba", "nfl", "nhl", "epl", "mls", "atp", "wta", "lol"]) {
      expect(leagues).toContain(league);
    }
    const sports = new Set(listSportAdapters().map((a) => a.sport));
    expect(sports.size).toBeGreaterThan(1);
  });

  it("PM-US discovery covers every registered league that has a proven catalog path", () => {
    const paths = pmusDiscoveryLeagues();
    expect(paths).toContain("mlb");
    expect(paths).toContain("nba");
    expect(paths.length).toBe(listSportAdapters().filter((a) => a.pmusLeaguePath).length);
  });

  it("Kalshi discovery queries ONLY verified series -- unverified tickers are documentation, never fetched", () => {
    const series = kalshiDiscoverySeries();
    expect(series).toEqual(["KXMLBGAME", "KXMLBSPREAD", "KXMLBTOTAL"]);
    for (const adapterEntry of listSportAdapters()) {
      for (const unverified of adapterEntry.kalshiSeriesUnverified) {
        expect(series).not.toContain(unverified);
      }
    }
  });

  it("fails closed for an unknown league: no adapter, no slug fallback", () => {
    expect(getSportAdapter("cricket-ipl")).toBeNull();
    expect(getSportAdapter(null)).toBeNull();
    expect(getSportAdapter("")).toBeNull();
  });

  it("gives no slug-derived identity to sports without an audited code table", () => {
    for (const adapterEntry of listSportAdapters()) {
      if (adapterEntry.league === "mlb") {
        expect(adapterEntry.canonicalSlugParticipants).not.toBeNull();
      } else {
        expect(adapterEntry.canonicalSlugParticipants).toBeNull();
        expect(adapterEntry.canonicalSlugShape).toBeNull();
      }
    }
  });

  it("MLB adapter still parses canonical full-game slugs and rejects derivatives", () => {
    const parse = getSportAdapter("mlb")!.canonicalSlugParticipants!;
    expect(parse("mlb-tex-cws-2026-08-25-total-7pt5")).toEqual({ away: "Texas Rangers", home: "Chicago White Sox", betType: "TOTAL", line: 7.5 });
    expect(parse("mlb-tex-cws-2026-08-25")?.betType).toBe("MONEYLINE");
    expect(parse("mlb-tex-cws-2026-08-25-f5-total-4pt5")).toBeNull();
    expect(parse("mlb-tex-cws-2026-08-25-judge-hr")).toBeNull();
    expect(parse("mlb-zzz-yyy-2026-08-25")).toBeNull();
  });

  it("canonicalLeagueLabel never defaults to a hard-coded sport", () => {
    expect(canonicalLeagueLabel("mlb")).toBe("MLB");
    expect(canonicalLeagueLabel("nhl")).toBe("NHL");
    expect(canonicalLeagueLabel(null)).toBeNull();
    expect(canonicalLeagueLabel("  ")).toBeNull();
    expect(canonicalLeagueLabel("kbo")).toBe("KBO");
  });
});
