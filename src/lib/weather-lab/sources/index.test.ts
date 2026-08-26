import { describe, expect, it } from "vitest";
import { forecastSigmaF, localDateFor, observationFloorApplies, SITES } from "./index";

describe("SITES", () => {
  it("carries a distinct settlement station per city", () => {
    const stations = Object.values(SITES).map((s) => s.station);
    expect(new Set(stations).size).toBe(stations.length);
  });

  it("is frozen so a city cannot be enabled at runtime without an audit", () => {
    expect(Object.isFrozen(SITES)).toBe(true);
  });

  it("keeps settlement station separate from observation station", () => {
    // Settlement comes from The Weather Company's CLI-style identifier; the
    // observation feed is a different NWS station. Conflating them would let an
    // observation masquerade as a settlement value.
    for (const site of Object.values(SITES)) {
      expect(site.station).not.toBe(site.observationStation);
    }
  });
});

describe("localDateFor", () => {
  it("returns the site-local calendar date, not the UTC date", () => {
    // 03:00 UTC on Aug 28 is still Aug 27 in New York.
    const at = new Date("2026-08-28T03:00:00Z");
    expect(localDateFor(SITES["NYC"]!, at)).toBe("2026-08-27");
  });

  it("differs across timezones for the same instant", () => {
    const at = new Date("2026-08-28T05:00:00Z");
    expect(localDateFor(SITES["NYC"]!, at)).toBe("2026-08-28");
    expect(localDateFor(SITES["LosAngeles"]!, at)).toBe("2026-08-27");
  });

  it("formats as ISO yyyy-mm-dd", () => {
    expect(localDateFor(SITES["Miami"]!, new Date("2026-01-05T18:00:00Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("forecastSigmaF", () => {
  it("prefers the ensemble's empirical spread over any table", () => {
    const r = forecastSigmaF({ ensembleSpreadF: 2.4, hoursToWindowClose: 30 });
    expect(r.basis).toBe("ENSEMBLE_SPREAD");
    expect(r.sigmaF).toBeCloseTo(2.4, 6);
  });

  it("falls back only when no usable ensemble spread exists, and says so", () => {
    const r = forecastSigmaF({ ensembleSpreadF: null, hoursToWindowClose: 30 });
    expect(r.basis).toBe("LEAD_TIME_FALLBACK");
    expect(r.sigmaF).toBeGreaterThan(0);
  });

  it("treats a degenerate ensemble spread as unusable", () => {
    expect(forecastSigmaF({ ensembleSpreadF: 0, hoursToWindowClose: 5 }).basis).toBe("LEAD_TIME_FALLBACK");
  });

  it("shrinks uncertainty as the settlement window closes", () => {
    const far = forecastSigmaF({ ensembleSpreadF: null, hoursToWindowClose: 40 });
    const near = forecastSigmaF({ ensembleSpreadF: null, hoursToWindowClose: 2 });
    expect(near.sigmaF).toBeLessThan(far.sigmaF);
  });

  it("never returns a non-positive sigma", () => {
    for (const h of [0, 1, 12, 48, 500]) {
      expect(forecastSigmaF({ ensembleSpreadF: null, hoursToWindowClose: h }).sigmaF).toBeGreaterThan(0);
    }
  });
});

describe("observationFloorApplies", () => {
  const nyc = SITES["NYC"]!;
  // 17:00 UTC on Aug 26 is 13:00 in New York, so the local day is Aug 26.
  const now = new Date("2026-08-26T17:00:00Z");

  it("applies to the event whose settlement window is running now", () => {
    expect(observationFloorApplies(nyc, "2026-08-26", now)).toBe(true);
  });

  it("does NOT apply to a next-day event", () => {
    // Today's observed maximum says nothing about tomorrow's maximum, and using
    // it would also mislabel the event as an intraday observation edge.
    expect(observationFloorApplies(nyc, "2026-08-27", now)).toBe(false);
  });

  it("does NOT apply to a past event", () => {
    expect(observationFloorApplies(nyc, "2026-08-25", now)).toBe(false);
  });

  it("uses the site-local day, not the UTC day", () => {
    // 03:00 UTC Aug 27 is still Aug 26 in New York.
    const lateUtc = new Date("2026-08-27T03:00:00Z");
    expect(observationFloorApplies(nyc, "2026-08-26", lateUtc)).toBe(true);
    expect(observationFloorApplies(nyc, "2026-08-27", lateUtc)).toBe(false);
  });
});
