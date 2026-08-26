import { describe, expect, it } from "vitest";
import { normalizeKnownLeagueTeamName, normalizeTeamName, normalizeWnbaTeamName, teamsMatch } from "./team-normalization";

describe("normalizeTeamName", () => {
  it("normalizes full names, aliases, and abbreviations from every venue to one canonical code", () => {
    expect(normalizeTeamName("New York Yankees")).toBe("NYY");
    expect(normalizeTeamName("nyy")).toBe("NYY");
    expect(normalizeTeamName("Yankees")).toBe("NYY");
    expect(normalizeTeamName("Baltimore Orioles")).toBe("BAL");
    expect(normalizeTeamName("bal")).toBe("BAL");
    // Kalshi sometimes truncates city names in sub_titles (e.g. "Los Angeles D").
    expect(normalizeTeamName("Los Angeles D")).toBe("LAD");
    expect(normalizeTeamName("Los Angeles A")).toBe("LAA");
    expect(normalizeTeamName("Chicago C")).toBe("CHC");
    expect(normalizeTeamName("Chicago WS")).toBe("CWS");
    expect(normalizeTeamName("New York Y")).toBe("NYY");
    expect(normalizeTeamName("New York M")).toBe("NYM");
    expect(normalizeTeamName("AZ")).toBe("ARI");
    expect(normalizeTeamName("Athletics")).toBe("ATH");
    expect(normalizeTeamName("A's")).toBe("ATH");
    // Kalshi event.title uses bare city names (confirmed live, e.g. "Minnesota vs San Diego"),
    // not full franchise names -- only safe to add for cities with exactly one MLB team.
    expect(normalizeTeamName("Minnesota")).toBe("MIN");
    expect(normalizeTeamName("San Diego")).toBe("SD");
    expect(normalizeTeamName("San Francisco")).toBe("SF");
    expect(normalizeTeamName("Cleveland")).toBe("CLE");
    expect(normalizeTeamName("St. Louis")).toBe("STL");
    expect(normalizeTeamName("Cincinnati")).toBe("CIN");
    expect(normalizeTeamName("Washington")).toBe("WSH");
    expect(normalizeTeamName("Texas")).toBe("TEX");
  });

  it("does NOT map ambiguous shared-city bare names (Chicago/Los Angeles/New York host two teams each) -- fails closed rather than guessing", () => {
    expect(normalizeTeamName("Chicago")).toBeNull();
    expect(normalizeTeamName("Los Angeles")).toBeNull();
    expect(normalizeTeamName("New York")).toBeNull();
  });

  it("maps WNBA city-only aliases only when league evidence says WNBA", () => {
    expect(normalizeWnbaTeamName("Chicago Sky")).toBe("WNBA:CHI");
    expect(normalizeWnbaTeamName("Chicago")).toBe("WNBA:CHI");
    expect(normalizeKnownLeagueTeamName("Connecticut", "wnba")).toBe("WNBA:CONN");
    expect(normalizeTeamName("Chicago")).toBeNull();
    expect(normalizeTeamName("Chicago Sky")).toBe("GENERIC:chicago sky");
  });

  it("returns null for an unrecognized team string instead of guessing", () => {
    expect(normalizeTeamName("Some Minor League Team")).toBeNull();
    expect(normalizeTeamName("")).toBeNull();
  });
});

describe("teamsMatch", () => {
  it("matches across representations of the same team", () => {
    expect(teamsMatch("New York Yankees", "nyy")).toBe(true);
    expect(teamsMatch("Los Angeles Dodgers", "Los Angeles D")).toBe(true);
  });

  it("does not match different teams, including same-city teams", () => {
    expect(teamsMatch("Los Angeles Dodgers", "Los Angeles Angels")).toBe(false);
    expect(teamsMatch("New York Yankees", "New York Mets")).toBe(false);
  });

  it("fails closed when either side is unrecognized", () => {
    expect(teamsMatch("New York Yankees", "Unknown Team")).toBe(false);
  });
});
