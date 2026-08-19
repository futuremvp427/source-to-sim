/**
 * Phase 0B, Part 2 infrastructure: pure probability derivation from a
 * historical forecast ensemble, plus the no-lookahead eligibility guard.
 *
 * No DB/network access in this file. See open-meteo-baseline.server.ts for
 * the actual fetch wrapper (which this environment could not execute or
 * validate against a live endpoint -- see that file's doc comment).
 */

import type { ThresholdSpec } from "./weather-market-parser";

export function celsiusToFahrenheit(c: number): number {
  return c * (9 / 5) + 32;
}

export function fahrenheitToCelsius(f: number): number {
  return (f - 32) * (5 / 9);
}

/** Converts a value already in `fromUnit` into `toUnit`. No-op if units match. */
export function convertTemperature(value: number, fromUnit: "C" | "F", toUnit: "C" | "F"): number {
  if (fromUnit === toUnit) return value;
  return fromUnit === "C" ? celsiusToFahrenheit(value) : fahrenheitToCelsius(value);
}

/**
 * Fraction of ensemble members satisfying the comparator against threshold.
 * This IS the "public baseline probability" for an exceedance-style market.
 */
export function deriveExceedanceProbability(
  memberValues: readonly number[],
  comparator: ">=" | ">" | "<=" | "<",
  threshold: number,
): number | null {
  if (memberValues.length === 0) return null;
  const satisfies = (v: number): boolean => {
    if (comparator === ">=") return v >= threshold;
    if (comparator === ">") return v > threshold;
    if (comparator === "<=") return v <= threshold;
    return v < threshold;
  };
  return memberValues.filter(satisfies).length / memberValues.length;
}

/** Fraction of ensemble members falling within [low, high] inclusive. */
export function deriveRangeProbability(
  memberValues: readonly number[],
  low: number,
  high: number,
): number | null {
  if (memberValues.length === 0) return null;
  return memberValues.filter((v) => v >= low && v <= high).length / memberValues.length;
}

/**
 * A Polymarket "exact value" weather market (e.g. "will the high be 25C?")
 * settles on a specific reported daily value, which for a continuous
 * forecast ensemble has near-zero literal-equality probability. Modeling
 * assumption (documented, not hidden): treat "exact N" as the range
 * [N - 0.5, N + 0.5] -- the plausible rounding band a reported integer
 * reading would fall into. This is an approximation, not a guarantee of
 * matching Polymarket's own settlement rounding convention, which is not
 * independently knowable without a live market catalog pull.
 */
export const EXACT_VALUE_ROUNDING_BAND = 0.5;

/**
 * Dispatches to the right probability derivation for a parsed threshold
 * spec. `memberValuesInThresholdUnit` must already be converted to the same
 * unit as `threshold.unit` by the caller (see open-meteo-baseline.server.ts).
 */
export function deriveBaselineProbability(
  memberValuesInThresholdUnit: readonly number[],
  threshold: ThresholdSpec,
): number | null {
  if (threshold.kind === "range") {
    return deriveRangeProbability(memberValuesInThresholdUnit, threshold.low, threshold.high);
  }
  if (threshold.kind === "exact") {
    return deriveRangeProbability(
      memberValuesInThresholdUnit,
      threshold.value - EXACT_VALUE_ROUNDING_BAND,
      threshold.value + EXACT_VALUE_ROUNDING_BAND,
    );
  }
  return deriveExceedanceProbability(
    memberValuesInThresholdUnit,
    threshold.comparator,
    threshold.value,
  );
}

/**
 * THE no-lookahead guard. `forecastIssuedAtSourceTs` is when the forecast
 * model RUN that produced these values was actually issued/available
 * (unix seconds); `tradeSourceTs` is the wallet's trade timestamp. A
 * forecast is eligible for comparison against a trade ONLY if it was
 * issued strictly before the trade -- this is enforced here, in one place,
 * as a hard runtime check independent of whatever the upstream API claims
 * to serve, precisely because the API's point-in-time correctness could not
 * be verified live in this environment (see open-meteo-baseline.server.ts).
 */
export function isForecastEligibleForTrade(
  forecastIssuedAtSourceTs: number,
  tradeSourceTs: number,
): boolean {
  return forecastIssuedAtSourceTs < tradeSourceTs;
}
