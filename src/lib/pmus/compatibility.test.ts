/**
 * Compatibility matcher tests. Pure classifier + gate invariants:
 * only EXACT_MATCH may reach the authenticated order-preview signer.
 */

import { describe, expect, it, vi } from "vitest";

import {
  classifyCompatibility,
  compareThresholds,
  extractDate,
  extractThreshold,
  resolveCompatibility,
  type SourceMarket,
  type UsMarket,
} from "./compatibility.server";
import { previewOrder, type PmusDeps } from "./capabilities.server";

const openMarket = (market: Partial<UsMarket>): UsMarket => ({
  active: true,
  closed: false,
  archived: false,
  ...market,
});

const nyHigh: SourceMarket = {
  question: "Highest temperature in New York on Aug 8: 90-91°F",
  slug: "highest-temperature-in-nyc-on-august-8-90-91",
  endDate: "2026-08-09T00:00:00Z",
  date: "2026-08-08",
  outcomes: ["Yes", "No"],
};

describe("extractors", () => {
  it("reads ISO and named dates", () => {
    expect(extractDate({ slug: "weather-2026-08-08-ny" })).toBe("2026-08-08");
    expect(extractDate({ question: "High in NY on Aug 8", endDate: "2026-08-09T00:00:00Z" })).toBe(
      "2026-08-08",
    );
  });

  it("reads ranges and inequalities distinctly", () => {
    expect(extractThreshold("Highest temperature: 90-91°F")).toEqual({
      kind: "range",
      low: 90,
      high: 91,
      unit: "F",
    });
    expect(extractThreshold("Will New York exceed 90°F?")).toEqual({
      kind: "above",
      value: 90,
      unit: "F",
    });
    expect(
      compareThresholds(extractThreshold("90-91°F"), extractThreshold("exceed 90°F")),
    ).toBe("KIND_DIFFERS");
    expect(compareThresholds(extractThreshold("90-91°F"), extractThreshold("95-96°F"))).toBe(
      "CONFLICT",
    );
  });
});

describe("classifyCompatibility", () => {
  it("EXACT_MATCH for the same market", () => {
    const result = classifyCompatibility(nyHigh, [
      openMarket({
        slug: "highest-temperature-in-nyc-on-august-8-90-91",
        question: "Highest temperature in New York on Aug 8: 90-91°F",
        endDate: "2026-08-09T00:00:00Z",
      }),
    ]);
    expect(result.compatibility).toBe("EXACT_MATCH");
    expect(result.usMarketSlug).toBe("highest-temperature-in-nyc-on-august-8-90-91");
  });

  it("NO_MATCH for same city and date but a different threshold", () => {
    const result = classifyCompatibility(nyHigh, [
      openMarket({
        slug: "us-ny-high-2026-08-08-95-96",
        question: "Highest temperature in New York on Aug 8: 95-96°F",
      }),
    ]);
    expect(result.compatibility).toBe("NO_MATCH");
    expect(result.usMarketSlug).toBeNull();
  });

  it("NO_MATCH for the same title on a different date", () => {
    const result = classifyCompatibility(nyHigh, [
      openMarket({
        slug: "us-ny-high-2026-08-09-90-91",
        question: "Highest temperature in New York on Aug 9: 90-91°F",
      }),
    ]);
    expect(result.compatibility).toBe("NO_MATCH");
  });

  it("NO_MATCH when only generic YES/NO outcomes overlap", () => {
    const result = classifyCompatibility(
      { question: "Yes or No", slug: "yes-no", outcomes: ["Yes", "No"] },
      [openMarket({ slug: "world-series-champion-2026", question: "Yes / No" })],
    );
    expect(result.compatibility).toBe("NO_MATCH");
  });

  it("never EXACT for partial wording overlap", () => {
    const result = classifyCompatibility(nyHigh, [
      openMarket({
        slug: "us-ny-temperature-season",
        question: "Will New York exceed 90°F this summer?",
      }),
    ]);
    expect(["POSSIBLE_MATCH", "AMBIGUOUS"]).toContain(result.compatibility);
    expect(result.usMarketSlug).toBeNull();
  });

  it("AMBIGUOUS when multiple candidates are equally strong", () => {
    const twin = {
      question: "Highest temperature in New York on Aug 8: 90-91°F",
      endDate: "2026-08-09T00:00:00Z",
    };
    const result = classifyCompatibility(nyHigh, [
      openMarket({ ...twin, slug: "us-ny-high-a-2026-08-08" }),
      openMarket({ ...twin, slug: "us-ny-high-b-2026-08-08" }),
    ]);
    expect(result.compatibility).toBe("AMBIGUOUS");
    expect(result.usMarketSlug).toBeNull();
  });

  it("NO_MATCH with no candidates", () => {
    expect(classifyCompatibility(nyHigh, []).compatibility).toBe("NO_MATCH");
    expect(classifyCompatibility(null, []).compatibility).toBe("NO_MATCH");
  });

  it("POSSIBLE_MATCH when the only slug match is closed", () => {
    const result = classifyCompatibility(nyHigh, [
      openMarket({
        slug: "highest-temperature-in-nyc-on-august-8-90-91",
        question: "Highest temperature in New York on Aug 8: 90-91°F",
        closed: true,
        active: false,
      }),
    ]);
    expect(result.compatibility).not.toBe("EXACT_MATCH");
    expect(result.usMarketSlug).toBeNull();
  });
});

describe("only EXACT_MATCH reaches the authenticated preview", () => {
  function previewHarness() {
    const signer = vi.fn(async () => "ZmFrZS1zaWc=");
    const transport = vi.fn(
      async () => new Response(JSON.stringify({ order: {} }), { status: 200 }),
    );
    const deps: PmusDeps = {
      credentials: { keyId: "fake", secretKey: "ZmFrZQ==" },
      signer,
      transport,
      now: () => 1_700_000_000_000,
    };
    return { deps, signer, transport };
  }

  /** Mirrors the production gate in previews.server.ts. */
  async function gatedPreview(source: SourceMarket, candidates: UsMarket[], deps: PmusDeps) {
    const compat = await resolveCompatibility(source, async () => candidates);
    if (compat.compatibility !== "EXACT_MATCH" || !compat.usMarketSlug) return compat;
    await previewOrder(
      {
        marketSlug: compat.usMarketSlug,
        outcomeSide: "OUTCOME_SIDE_YES",
        action: "ORDER_ACTION_BUY",
        quantity: 1,
        limitPrice: 0.5,
      },
      deps,
    );
    return compat;
  }

  const cases: { name: string; candidates: UsMarket[]; expected: string }[] = [
    {
      name: "POSSIBLE_MATCH",
      candidates: [
        openMarket({
          slug: "us-ny-temperature-season",
          question: "Will New York exceed 90°F this summer?",
        }),
      ],
      expected: "POSSIBLE_MATCH",
    },
    {
      name: "AMBIGUOUS",
      candidates: [
        openMarket({
          slug: "us-ny-high-a-2026-08-08",
          question: "Highest temperature in New York on Aug 8: 90-91°F",
          endDate: "2026-08-09T00:00:00Z",
        }),
        openMarket({
          slug: "us-ny-high-b-2026-08-08",
          question: "Highest temperature in New York on Aug 8: 90-91°F",
          endDate: "2026-08-09T00:00:00Z",
        }),
      ],
      expected: "AMBIGUOUS",
    },
    { name: "NO_MATCH", candidates: [], expected: "NO_MATCH" },
  ];

  for (const testCase of cases) {
    it(`${testCase.name}: signer calls = 0 and transport calls = 0`, async () => {
      const { deps, signer, transport } = previewHarness();
      const compat = await gatedPreview(nyHigh, testCase.candidates, deps);
      expect(compat.compatibility).toBe(testCase.expected);
      expect(signer).toHaveBeenCalledTimes(0);
      expect(transport).toHaveBeenCalledTimes(0);
    });
  }

  it("EXACT_MATCH does reach the signer exactly once", async () => {
    const { deps, signer, transport } = previewHarness();
    const compat = await gatedPreview(
      nyHigh,
      [
        openMarket({
          slug: "highest-temperature-in-nyc-on-august-8-90-91",
          question: "Highest temperature in New York on Aug 8: 90-91°F",
          endDate: "2026-08-09T00:00:00Z",
        }),
      ],
      deps,
    );
    expect(compat.compatibility).toBe("EXACT_MATCH");
    expect(signer).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});