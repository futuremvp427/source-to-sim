import { describe, expect, it } from "vitest";

import { decidePreviewAction } from "./automation";
import type { SourceMarket, UsMarket } from "./compatibility.server";
import {
  assessWeatherTranslation,
  findWeatherTranslationCandidates,
  WEATHER_TRANSLATION_CORRIDORS,
} from "./weather-translation";

const openMarket = (market: Partial<UsMarket>): UsMarket => ({
  active: true,
  closed: false,
  archived: false,
  ...market,
});

function source(question: string, slug: string, date = "2026-08-26"): SourceMarket {
  return {
    question,
    slug,
    date,
    endDate: "2026-08-27T00:00:00Z",
    outcomes: ["Yes", "No"],
  };
}

describe("audited weather translation corridors", () => {
  it("admits only LA, San Francisco, and Miami", () => {
    expect(WEATHER_TRANSLATION_CORRIDORS).toEqual([
      { location: "los angeles", station: "KLAX" },
      { location: "san francisco", station: "KSFO" },
      { location: "miami", station: "KMIA" },
    ]);
  });

  const cases = [
    {
      city: "Los Angeles",
      station: "KLAX",
      sourceSlug: "highest-temperature-in-los-angeles-on-2026-08-26-79-80f",
      usSlug: "us-los-angeles-high-2026-08-26-79-80f",
    },
    {
      city: "San Francisco",
      station: "KSFO",
      sourceSlug: "highest-temperature-in-san-francisco-on-2026-08-26-70-71f",
      usSlug: "us-san-francisco-high-2026-08-26-70-71f",
    },
    {
      city: "Miami",
      station: "KMIA",
      sourceSlug: "highest-temperature-in-miami-on-2026-08-26-92-93f",
      usSlug: "us-miami-high-2026-08-26-92-93f",
    },
  ] as const;

  for (const testCase of cases) {
    it(`${testCase.city}: same date and exact bucket becomes research candidate at ${testCase.station}`, () => {
      const result = assessWeatherTranslation(
        source(
          `Highest temperature in ${testCase.city} on Aug 26: ${
            testCase.city === "Los Angeles" ? "79-80" : testCase.city === "San Francisco" ? "70-71" : "92-93"
          }°F`,
          testCase.sourceSlug,
        ),
        openMarket({
          slug: testCase.usSlug,
          question: `Highest temperature in ${testCase.city} on Aug 26: ${
            testCase.city === "Los Angeles" ? "79-80" : testCase.city === "San Francisco" ? "70-71" : "92-93"
          }°F`,
          endDate: "2026-08-27T00:00:00Z",
        }),
      );

      expect(result.status).toBe("TRANSLATION_CANDIDATE");
      expect(result.station).toBe(testCase.station);
      expect(result.previewEligible).toBe(false);
      expect(result.settlementEquivalence).toBe("UNPROVEN");
    });
  }
});

describe("weather translation fails closed", () => {
  it("rejects NYC even when date and bucket match", () => {
    const result = assessWeatherTranslation(
      source(
        "Highest temperature in New York on Aug 26: 84-85°F",
        "highest-temperature-in-nyc-on-2026-08-26-84-85f",
      ),
      openMarket({
        slug: "us-new-york-high-2026-08-26-84-85f",
        question: "Highest temperature in New York on Aug 26: 84-85°F",
        endDate: "2026-08-27T00:00:00Z",
      }),
    );

    expect(result.status).toBe("NOT_TRANSLATABLE");
    expect(result.previewEligible).toBe(false);
  });

  it("rejects Chicago even when date and bucket match", () => {
    const result = assessWeatherTranslation(
      source(
        "Highest temperature in Chicago on Aug 26: 81-82°F",
        "highest-temperature-in-chicago-on-2026-08-26-81-82f",
      ),
      openMarket({
        slug: "us-chicago-high-2026-08-26-81-82f",
        question: "Highest temperature in Chicago on Aug 26: 81-82°F",
        endDate: "2026-08-27T00:00:00Z",
      }),
    );

    expect(result.status).toBe("NOT_TRANSLATABLE");
  });

  it("rejects an unverified city", () => {
    const result = assessWeatherTranslation(
      source(
        "Highest temperature in Dallas on Aug 26: 99-100°F",
        "highest-temperature-in-dallas-on-2026-08-26-99-100f",
      ),
      openMarket({
        slug: "us-dallas-high-2026-08-26-99-100f",
        question: "Highest temperature in Dallas on Aug 26: 99-100°F",
        endDate: "2026-08-27T00:00:00Z",
      }),
    );

    expect(result.status).toBe("NOT_TRANSLATABLE");
  });

  it("rejects the same city on a different date", () => {
    const result = assessWeatherTranslation(
      source(
        "Highest temperature in Los Angeles on Aug 26: 79-80°F",
        "highest-temperature-in-los-angeles-on-2026-08-26-79-80f",
      ),
      openMarket({
        slug: "us-los-angeles-high-2026-08-27-79-80f",
        question: "Highest temperature in Los Angeles on Aug 27: 79-80°F",
        endDate: "2026-08-28T00:00:00Z",
      }),
    );

    expect(result.status).toBe("NOT_TRANSLATABLE");
  });

  it("rejects a different temperature bucket", () => {
    const result = assessWeatherTranslation(
      source(
        "Highest temperature in Miami on Aug 26: 92-93°F",
        "highest-temperature-in-miami-on-2026-08-26-92-93f",
      ),
      openMarket({
        slug: "us-miami-high-2026-08-26-94-95f",
        question: "Highest temperature in Miami on Aug 26: 94-95°F",
        endDate: "2026-08-27T00:00:00Z",
      }),
    );

    expect(result.status).toBe("NOT_TRANSLATABLE");
  });

  it("rejects Fahrenheit/Celsius unit mismatch", () => {
    const result = assessWeatherTranslation(
      source(
        "Highest temperature in San Francisco on Aug 26: 70-71°F",
        "highest-temperature-in-san-francisco-on-2026-08-26-70-71f",
      ),
      openMarket({
        slug: "us-san-francisco-high-2026-08-26-70-71c",
        question: "Highest temperature in San Francisco on Aug 26: 70-71°C",
        endDate: "2026-08-27T00:00:00Z",
      }),
    );

    expect(result.status).toBe("NOT_TRANSLATABLE");
  });

  it("returns UNVERIFIED rather than guessing when threshold evidence is absent", () => {
    const result = assessWeatherTranslation(
      source(
        "Highest temperature in Miami on Aug 26",
        "highest-temperature-in-miami-on-2026-08-26",
      ),
      openMarket({
        slug: "us-miami-high-2026-08-26",
        question: "Highest temperature in Miami on Aug 26",
        endDate: "2026-08-27T00:00:00Z",
      }),
    );

    expect(result.status).toBe("UNVERIFIED");
  });

  it("does not misread an ISO date as a temperature range", () => {
    const result = assessWeatherTranslation(
      source(
        "Highest temperature in Miami on 2026-08-26",
        "highest-temperature-in-miami-on-2026-08-26",
      ),
      openMarket({
        slug: "us-miami-high-2026-08-26",
        question: "Highest temperature in Miami on 2026-08-26",
        endDate: "2026-08-27T00:00:00Z",
      }),
    );

    expect(result.status).toBe("UNVERIFIED");
  });

  it("does not return closed US markets as candidates", () => {
    const result = assessWeatherTranslation(
      source(
        "Highest temperature in Los Angeles on Aug 26: 79-80°F",
        "highest-temperature-in-los-angeles-on-2026-08-26-79-80f",
      ),
      openMarket({
        slug: "us-los-angeles-high-2026-08-26-79-80f",
        question: "Highest temperature in Los Angeles on Aug 26: 79-80°F",
        endDate: "2026-08-27T00:00:00Z",
        active: false,
        closed: true,
      }),
    );

    expect(result.status).toBe("NOT_TRANSLATABLE");
  });
});

describe("translation candidates cannot unlock execution", () => {
  it("existing authenticated-preview gate rejects TRANSLATION_CANDIDATE", () => {
    const action = decidePreviewAction({
      compatibility: "TRANSLATION_CANDIDATE",
      usMarketSlug: "us-miami-high-2026-08-26-92-93f",
      outcomeSide: "OUTCOME_SIDE_YES",
      existingStatus: null,
    });

    expect(action).toBe("NOT_ELIGIBLE");
  });

  it("candidate finder preserves ambiguity instead of picking a US market", () => {
    const src = source(
      "Highest temperature in Los Angeles on Aug 26: 79-80°F",
      "highest-temperature-in-los-angeles-on-2026-08-26-79-80f",
    );
    const candidates = findWeatherTranslationCandidates(src, [
      openMarket({
        slug: "us-la-a-2026-08-26-79-80f",
        question: "Highest temperature in Los Angeles on Aug 26: 79-80°F",
        endDate: "2026-08-27T00:00:00Z",
      }),
      openMarket({
        slug: "us-la-b-2026-08-26-79-80f",
        question: "Highest temperature in Los Angeles on Aug 26: 79-80°F",
        endDate: "2026-08-27T00:00:00Z",
      }),
    ]);

    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.previewEligible === false)).toBe(true);
  });
});
