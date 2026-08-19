import { describe, expect, it } from "vitest";

import {
  celsiusToFahrenheit,
  convertTemperature,
  deriveBaselineProbability,
  deriveExceedanceProbability,
  deriveRangeProbability,
  fahrenheitToCelsius,
  isForecastEligibleForTrade,
} from "./open-meteo-baseline";
import type { ThresholdSpec } from "./weather-market-parser";

describe("temperature unit conversion", () => {
  it("converts C to F and back losslessly (within floating point tolerance)", () => {
    expect(celsiusToFahrenheit(0)).toBeCloseTo(32, 10);
    expect(celsiusToFahrenheit(100)).toBeCloseTo(212, 10);
    expect(fahrenheitToCelsius(32)).toBeCloseTo(0, 10);
    expect(fahrenheitToCelsius(212)).toBeCloseTo(100, 10);
  });

  it("convertTemperature is a no-op when units already match", () => {
    expect(convertTemperature(25, "C", "C")).toBe(25);
    expect(convertTemperature(77, "F", "F")).toBe(77);
  });

  it("convertTemperature converts when units differ", () => {
    expect(convertTemperature(25, "C", "F")).toBeCloseTo(77, 5);
  });
});

describe("deriveExceedanceProbability", () => {
  it("computes the fraction of ensemble members satisfying >=", () => {
    expect(deriveExceedanceProbability([88, 90, 92, 94], ">=", 90)).toBeCloseTo(0.75, 10);
  });

  it("computes the fraction satisfying <=", () => {
    expect(deriveExceedanceProbability([88, 90, 92, 94], "<=", 90)).toBeCloseTo(0.5, 10);
  });

  it("is 1.0 when every member satisfies, 0.0 when none do", () => {
    expect(deriveExceedanceProbability([95, 96, 97], ">=", 90)).toBe(1);
    expect(deriveExceedanceProbability([80, 81, 82], ">=", 90)).toBe(0);
  });

  it("returns null for an empty ensemble rather than NaN", () => {
    expect(deriveExceedanceProbability([], ">=", 90)).toBeNull();
  });
});

describe("deriveRangeProbability", () => {
  it("computes the fraction of members within [low, high] inclusive", () => {
    expect(deriveRangeProbability([84, 85, 87, 89, 91], 85, 89)).toBeCloseTo(0.6, 10);
  });

  it("includes exact boundary values", () => {
    expect(deriveRangeProbability([85, 89], 85, 89)).toBe(1);
  });

  it("returns null for an empty ensemble", () => {
    expect(deriveRangeProbability([], 85, 89)).toBeNull();
  });
});

describe("deriveBaselineProbability (dispatch by threshold kind)", () => {
  it("dispatches range thresholds to deriveRangeProbability", () => {
    const threshold: ThresholdSpec = { kind: "range", low: 85, high: 89, unit: "F" };
    expect(deriveBaselineProbability([86, 88, 90, 92], threshold)).toBeCloseTo(0.5, 10);
  });

  it("dispatches exceed thresholds to deriveExceedanceProbability", () => {
    const threshold: ThresholdSpec = { kind: "exceed", comparator: ">=", value: 90, unit: "F" };
    expect(deriveBaselineProbability([88, 90, 92, 94], threshold)).toBeCloseTo(0.75, 10);
  });

  it("treats an exact-value threshold as a +/-0.5 rounding band, not literal equality", () => {
    const threshold: ThresholdSpec = { kind: "exact", value: 25, unit: "C" };
    // Members at 24.6, 25.0, 25.4 fall in [24.5, 25.5]; 26.0 does not.
    expect(deriveBaselineProbability([24.6, 25.0, 25.4, 26.0], threshold)).toBeCloseTo(0.75, 10);
  });

  it("an exact threshold with literal-equality-only members (no rounding tolerance) would be near 0, motivating the rounding-band assumption", () => {
    const threshold: ThresholdSpec = { kind: "exact", value: 25, unit: "C" };
    // None of these land in [24.5, 25.5].
    expect(deriveBaselineProbability([20, 22, 30], threshold)).toBe(0);
  });
});

describe("isForecastEligibleForTrade (no-lookahead guard)", () => {
  it("is eligible only when the forecast was issued strictly before the trade", () => {
    expect(isForecastEligibleForTrade(1000, 2000)).toBe(true);
  });

  it("is NOT eligible when the forecast was issued at or after the trade (no lookahead)", () => {
    expect(isForecastEligibleForTrade(2000, 2000)).toBe(false);
    expect(isForecastEligibleForTrade(2001, 2000)).toBe(false);
  });
});
