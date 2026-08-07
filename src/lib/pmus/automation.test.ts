import { describe, expect, it } from "vitest";

import {
  availabilityMessage,
  decidePreviewAction,
  isRelevantWeatherMarket,
  shouldRecheckCompatibility,
  shouldRunAvailabilityScan,
} from "./automation";

const NOW = Date.parse("2026-08-07T23:00:00Z");

describe("weather relevance filter", () => {
  it("accepts weather/temperature/rain/snow/hurricane/climate markets", () => {
    for (const question of [
      "Highest temperature in NYC on Aug 8?",
      "Will it rain in Chicago tomorrow?",
      "Snowfall in Denver above 3 inches?",
      "Will a hurricane make landfall in Florida?",
      "2026 climate record broken?",
      "NYC weather market",
    ]) {
      expect(isRelevantWeatherMarket({ question })).toBe(true);
    }
  });

  it("rejects unrelated markets", () => {
    expect(isRelevantWeatherMarket({ question: "Who wins the 2026 midterms?" })).toBe(false);
    expect(isRelevantWeatherMarket({ slug: "nba-finals-2026-lakers" })).toBe(false);
  });

  it("matches on category metadata too", () => {
    expect(isRelevantWeatherMarket({ question: "Phoenix high", category: "Weather" })).toBe(true);
  });
});

describe("scan cadence", () => {
  it("runs when there is no previous scan", () => {
    expect(shouldRunAvailabilityScan(null, NOW)).toBe(true);
  });
  it("does not run more often than every 15 minutes", () => {
    expect(shouldRunAvailabilityScan("2026-08-07T22:55:00Z", NOW)).toBe(false);
  });
  it("runs once the interval elapsed", () => {
    expect(shouldRunAvailabilityScan("2026-08-07T22:40:00Z", NOW)).toBe(true);
  });
});

describe("compatibility cache / recheck", () => {
  const cached = (status: string, checkedAt: string) => ({
    compatibility_status: status,
    checked_at: checkedAt,
  });

  it("checks a source market that was never checked", () => {
    expect(shouldRecheckCompatibility(null, { now: NOW })).toBe(true);
  });

  it("reuses a recent NO_MATCH result", () => {
    expect(
      shouldRecheckCompatibility(cached("NO_MATCH", "2026-08-07T22:00:00Z"), { now: NOW }),
    ).toBe(false);
  });

  it("rechecks NO_MATCH when new US weather markets appeared afterwards", () => {
    expect(
      shouldRecheckCompatibility(cached("NO_MATCH", "2026-08-07T22:00:00Z"), {
        newMarketsAt: "2026-08-07T22:30:00Z",
        now: NOW,
      }),
    ).toBe(true);
  });

  it("ignores new markets that predate the last check", () => {
    expect(
      shouldRecheckCompatibility(cached("NO_MATCH", "2026-08-07T22:00:00Z"), {
        newMarketsAt: "2026-08-07T21:00:00Z",
        now: NOW,
      }),
    ).toBe(false);
  });

  it("rechecks after the cache TTL expires", () => {
    expect(
      shouldRecheckCompatibility(cached("NO_MATCH", "2026-08-06T00:00:00Z"), { now: NOW }),
    ).toBe(true);
  });

  it("never rechecks a settled EXACT_MATCH", () => {
    expect(
      shouldRecheckCompatibility(cached("EXACT_MATCH", "2026-08-01T00:00:00Z"), { now: NOW }),
    ).toBe(false);
  });
});

describe("preview gate", () => {
  const gate = (compatibility: string, existingStatus: string | null = null) =>
    decidePreviewAction({
      compatibility,
      usMarketSlug: "us-nyc-high-temp-2026-08-08-above-90",
      outcomeSide: "OUTCOME_SIDE_YES",
      existingStatus,
    });

  it("NO_MATCH does not preview", () => {
    expect(gate("NO_MATCH")).toBe("NOT_ELIGIBLE");
  });

  it("POSSIBLE_MATCH does not preview", () => {
    expect(gate("POSSIBLE_MATCH")).toBe("NOT_ELIGIBLE");
  });

  it("AMBIGUOUS does not preview", () => {
    expect(gate("AMBIGUOUS")).toBe("NOT_ELIGIBLE");
  });

  it("an unrelated new market that classifies as NO_MATCH does not preview", () => {
    expect(
      decidePreviewAction({
        compatibility: "NO_MATCH",
        usMarketSlug: null,
        outcomeSide: "OUTCOME_SIDE_YES",
        existingStatus: null,
      }),
    ).toBe("NOT_ELIGIBLE");
  });

  it("EXACT_MATCH previews exactly once", () => {
    expect(gate("EXACT_MATCH")).toBe("PREVIEW");
    // Second pass: the preview now exists and is awaiting approval.
    expect(gate("EXACT_MATCH", "PENDING_APPROVAL")).toBe("SKIP_EXISTING");
  });

  it("a repeat scan never duplicates a decided preview", () => {
    for (const status of ["USER_APPROVED", "READY_FOR_MANUAL_EXECUTION", "REJECTED"]) {
      expect(gate("EXACT_MATCH", status)).toBe("SKIP_EXISTING");
    }
  });

  it("re-evaluates a row previously stored as not eligible", () => {
    expect(gate("EXACT_MATCH", "NOT_ELIGIBLE")).toBe("PREVIEW");
    expect(gate("NO_MATCH", "NOT_ELIGIBLE")).toBe("NOT_ELIGIBLE");
  });

  it("requires a mapped YES/NO side", () => {
    expect(
      decidePreviewAction({
        compatibility: "EXACT_MATCH",
        usMarketSlug: "slug",
        outcomeSide: null,
        existingStatus: null,
      }),
    ).toBe("NOT_ELIGIBLE");
  });
});

describe("availability message", () => {
  it("states the monitoring fallback when nothing is available", () => {
    expect(availabilityMessage(0)).toContain("continues monitoring automatically");
  });
  it("reports a count otherwise", () => {
    expect(availabilityMessage(3)).toContain("3 potentially relevant");
  });
});
