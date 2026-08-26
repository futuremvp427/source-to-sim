import { describe, expect, it } from "vitest";
import {
  assessSettlement,
  settlementChanged,
  settlementFingerprint,
  settlementRuleFromKalshi,
  type SettlementRule,
} from "./settlement";

const VERIFIED: SettlementRule = {
  provider: "The Weather Company",
  providerUrl: "https://weather.com/kalshi",
  station: "CLINYC",
  measurement: "maximum temperature",
  timezone: "America/New_York",
  unit: "F",
  roundingNote: null,
  revisionNote: null,
};

describe("settlementFingerprint", () => {
  it("is stable across calls", () => {
    expect(settlementFingerprint(VERIFIED)).toBe(settlementFingerprint({ ...VERIFIED }));
  });

  it("ignores key order", () => {
    const reordered = JSON.parse(JSON.stringify({ ...VERIFIED })) as SettlementRule;
    expect(settlementFingerprint(reordered)).toBe(settlementFingerprint(VERIFIED));
  });

  it("changes when the provider changes", () => {
    const nws = { ...VERIFIED, provider: "National Weather Service" };
    expect(settlementFingerprint(nws)).not.toBe(settlementFingerprint(VERIFIED));
  });

  it("changes when the station changes", () => {
    expect(settlementFingerprint({ ...VERIFIED, station: "CLICHI" })).not.toBe(settlementFingerprint(VERIFIED));
  });

  it("changes when the timezone changes", () => {
    expect(settlementFingerprint({ ...VERIFIED, timezone: "UTC" })).not.toBe(settlementFingerprint(VERIFIED));
  });
});

describe("assessSettlement", () => {
  it("verifies an audited provider and station", () => {
    const a = assessSettlement(VERIFIED);
    expect(a.status).toBe("SETTLEMENT_VERIFIED");
    expect(a.problems).toEqual([]);
  });

  it("fails closed on a null rule", () => {
    expect(assessSettlement(null).status).toBe("SETTLEMENT_UNVERIFIED");
  });

  it("fails closed on the superseded NWS provider", () => {
    const a = assessSettlement({ ...VERIFIED, provider: "National Weather Service" });
    expect(a.status).toBe("SETTLEMENT_UNVERIFIED");
    expect(a.problems.join(" ")).toMatch(/not audited/);
  });

  it("fails closed on an unaudited station rather than inferring from a sibling city", () => {
    const a = assessSettlement({ ...VERIFIED, station: "CLIAUS" });
    expect(a.status).toBe("SETTLEMENT_UNVERIFIED");
  });

  it("fails closed when a required field is missing", () => {
    const { timezone, ...withoutTz } = VERIFIED;
    void timezone;
    const a = assessSettlement(withoutTz);
    expect(a.status).toBe("SETTLEMENT_UNVERIFIED");
    expect(a.problems.join(" ")).toMatch(/missing timezone/);
  });

  it("never returns a usable fingerprint for an unverified rule", () => {
    expect(assessSettlement(null).fingerprint).toBe("sfp1-unknown");
  });
});

describe("settlementRuleFromKalshi", () => {
  const rulesPrimary =
    "If the maximum temperature recorded at New York City (CLINYC) for Aug 27, 2026, is between 84-85° fahrenheit according to The Weather Company, then the market resolves to Yes.";

  it("extracts provider, station, measurement and unit from the venue payload", () => {
    const r = settlementRuleFromKalshi({
      seriesSettlementSources: [{ name: "The Weather Company", url: "https://weather.com/kalshi" }],
      rulesPrimary,
      timezone: "America/New_York",
    });
    expect(r).not.toBeNull();
    expect(r!.provider).toBe("The Weather Company");
    expect(r!.station).toBe("CLINYC");
    expect(r!.measurement).toBe("maximum temperature");
    expect(r!.unit).toBe("F");
  });

  it("round-trips into a verified assessment", () => {
    const r = settlementRuleFromKalshi({
      seriesSettlementSources: [{ name: "The Weather Company", url: "https://weather.com/kalshi" }],
      rulesPrimary,
      timezone: "America/New_York",
    });
    expect(assessSettlement(r).status).toBe("SETTLEMENT_VERIFIED");
  });

  it("returns null when the venue names no settlement source", () => {
    expect(settlementRuleFromKalshi({ seriesSettlementSources: [], rulesPrimary, timezone: "UTC" })).toBeNull();
  });

  it("returns null when the rules text does not pin the station", () => {
    const r = settlementRuleFromKalshi({
      seriesSettlementSources: [{ name: "The Weather Company" }],
      rulesPrimary: "Resolves per some unspecified source.",
      timezone: "UTC",
    });
    expect(r).toBeNull();
  });

  it("captures the venue's preliminary-revision warning", () => {
    const r = settlementRuleFromKalshi({
      seriesSettlementSources: [{ name: "The Weather Company" }],
      rulesPrimary: `${rulesPrimary} Preliminary Weather Company data may be subject to rounding and conversion differences.`,
      timezone: "America/New_York",
    });
    expect(r!.revisionNote).toMatch(/revised/);
    expect(r!.roundingNote).toMatch(/rounding/);
  });
});

describe("settlementChanged", () => {
  it("detects a mid-experiment rule change", () => {
    const before = settlementFingerprint(VERIFIED);
    const after = settlementFingerprint({ ...VERIFIED, provider: "National Weather Service" });
    expect(settlementChanged(before, after)).toBe(true);
    expect(settlementChanged(before, before)).toBe(false);
  });
});
