import { describe, expect, it } from "vitest";
import { normalizeTeamName, teamsMatch } from "./team-normalization";

describe("normalizeTeamName", () => {
  it("normalizes full names, aliases, and abbreviations from every venue to one canonical code", () => {
    expect(normalizeTeamName("New York Yankees")).toBe("NYY");
    expect(normalizeTeamName("nyy")).toBe("NYY");
    expect(normalizeTeamName("Yankees")).toBe("NYY");
    expect(normalizeTeamName("Baltimore Orioles")).toBe("BAL");
    expect(normalizeTeamName("bal")).toBe("BAL");
    // Kalshi sometimes truncates city names in sub_titles (e.g. "Los Angeles D").
    expect(normalizeTeamName("Los Angeles D")).toBe("LAD");
    expect(normalizeTeamName("Athletics")).toBe("ATH");
    expect(normalizeTeamName("A's")).toBe("ATH");
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
