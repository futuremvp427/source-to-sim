import { describe, expect, it } from "vitest";

import { parseWeatherMarket } from "./weather-market-parser";

describe("parseWeatherMarket", () => {
  it("parses a real captured market shape: 'Will the highest temperature in Tokyo be 25°C on June 5?'", () => {
    const result = parseWeatherMarket({
      question: "Will the highest temperature in Tokyo be 25°C on June 5?",
      slug: "highest-temperature-in-tokyo-on-june-5-2026-25c",
      referenceYear: 2026,
    });
    expect(result).not.toBeNull();
    expect(result!.city).toBe("tokyo");
    expect(result!.date).toBe("2026-06-05");
    expect(result!.threshold).toEqual({ kind: "exact", value: 25, unit: "C" });
  });

  it("parses a generic-question NYC market with an explicit range in the slug", () => {
    const result = parseWeatherMarket({
      question: "Highest temperature in NYC on Aug 8?",
      slug: "nyc-high-temp-aug-8-85-89f",
      referenceYear: 2026,
    });
    expect(result).not.toBeNull();
    expect(result!.city).toBe("nyc");
    expect(result!.date).toBe("2026-08-08");
    expect(result!.threshold).toEqual({ kind: "range", low: 85, high: 89, unit: "F" });
  });

  it("parses an exceedance-style threshold ('above 90')", () => {
    const result = parseWeatherMarket({
      question: "Will the temperature exceed 90 degrees in Miami on July 4?",
      slug: null,
      referenceYear: 2026,
    });
    expect(result).not.toBeNull();
    expect(result!.city).toBe("miami");
    expect(result!.threshold).toEqual({ kind: "exceed", comparator: ">=", value: 90, unit: "F" });
  });

  it("parses a below-threshold market ('below 32')", () => {
    const result = parseWeatherMarket({
      question: "Will the low temperature in Denver be below 32 on Jan 15?",
      slug: null,
      referenceYear: 2026,
    });
    expect(result).not.toBeNull();
    expect(result!.threshold).toEqual({ kind: "exceed", comparator: "<=", value: 32, unit: "F" });
  });

  it("prefers a longer, more specific city match ('new york city' over a bare substring)", () => {
    const result = parseWeatherMarket({
      question: "Will it be 70 degrees in New York City on Sep 1?",
      slug: null,
      referenceYear: 2026,
    });
    expect(result?.city).toBe("new york city");
  });

  it("returns null (fails closed) for an unrecognized city, rather than guessing", () => {
    const result = parseWeatherMarket({
      question: "Will it be 70 degrees in Reykjavik on Sep 1?",
      slug: null,
      referenceYear: 2026,
    });
    expect(result).toBeNull();
  });

  it("returns null when no date can be found", () => {
    const result = parseWeatherMarket({
      question: "Will it be 70 degrees in NYC?",
      slug: null,
      referenceYear: 2026,
    });
    expect(result).toBeNull();
  });

  it("returns null when no threshold can be found", () => {
    const result = parseWeatherMarket({
      question: "Will it rain in NYC on Aug 8?",
      slug: null,
      referenceYear: 2026,
    });
    expect(result).toBeNull();
  });

  it("returns null for a completely unrelated (non-weather) market", () => {
    const result = parseWeatherMarket({
      question: "Will the Lakers win the NBA finals?",
      slug: "nba-finals-2026-lakers",
      referenceYear: 2026,
    });
    expect(result).toBeNull();
  });

  it("returns null for empty/missing question and slug", () => {
    expect(parseWeatherMarket({ question: null, slug: null, referenceYear: 2026 })).toBeNull();
    expect(parseWeatherMarket({ question: "", slug: "", referenceYear: 2026 })).toBeNull();
  });

  it("infers unit from city default (Celsius for Tokyo) when no explicit unit is stated", () => {
    const result = parseWeatherMarket({
      question: "Will Tokyo be 30 on August 1?",
      slug: null,
      referenceYear: 2026,
    });
    expect(result?.threshold.unit).toBe("C");
  });

  it("infers unit from city default (Fahrenheit for NYC) when no explicit unit is stated", () => {
    const result = parseWeatherMarket({
      question: "Will NYC be 90 on August 1?",
      slug: null,
      referenceYear: 2026,
    });
    expect(result?.threshold.unit).toBe("F");
  });

  it("uses the explicit year in the slug/question when present, not just referenceYear", () => {
    const result = parseWeatherMarket({
      question: null,
      slug: "highest-temperature-in-tokyo-on-june-5-2026-25c",
      referenceYear: 2027,
    });
    expect(result?.date).toBe("2026-06-05");
  });
});
