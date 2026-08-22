import { describe, expect, it } from "vitest";

import {
  computeKalshiTakerFee,
  computePmusTakerFee,
  computeTakerFee,
  KALSHI_FEE_MODEL_VERSION,
  PMUS_FEE_MODEL_VERSION,
} from "./fees";

describe("FINAL BUILD Part 11: PM-US taker fee (Fee = 0.06 * C * p * (1-p), banker's rounding)", () => {
  it("computes the documented formula at p=0.50 (worst case, $1.50/100 contracts)", () => {
    const result = computePmusTakerFee(100, 0.5);
    expect(result.valid).toBe(true);
    // 0.06 * 100 * 0.5 * 0.5 = 1.5 exactly
    expect(result.feeUsd).toBeCloseTo(1.5, 6);
    expect(result.feeModelVersion).toBe(PMUS_FEE_MODEL_VERSION);
  });

  it("fees fall toward the extremes (lower near p=0.01/0.99 than at p=0.50)", () => {
    const mid = computePmusTakerFee(100, 0.5);
    const extreme = computePmusTakerFee(100, 0.05);
    expect(extreme.feeUsd).toBeLessThan(mid.feeUsd);
  });

  it("banker's rounding: a raw fee landing exactly on a half-cent boundary rounds to the NEAREST EVEN cent, not always up", () => {
    // Construct contracts/price such that the raw fee is exactly X.XX5.
    // 0.06 * C * p * (1-p) = 0.025 -> pick p=0.5, C such that 0.06*C*0.25=0.025 -> C = 0.025/0.015 = 1.6667 (not clean)
    // Simpler: directly verify the rounding helper's documented examples via price/contracts
    // chosen to land on a known boundary is fragile across float precision -- instead
    // verify the DOCUMENTED asymmetry holds using a known input pair that PM-US's own
    // docs use as an example: $0.025 -> $0.02, $0.035 -> $0.04.
    // 0.06 * C * p * (1-p) = 0.025: choose p=0.5 => 0.015*C=0.025 => C=5/3 (not integer,
    // but contracts need not be integer in this pure math layer -- fractional share
    // counts are legitimate intermediate values in depth-walk's own contractsFilled).
    const down = computePmusTakerFee(5 / 3, 0.5); // raw fee = 0.025 exactly
    expect(down.feeUsd).toBeCloseTo(0.02, 6); // 2 is even -> rounds down
    const up = computePmusTakerFee(7 / 3, 0.5); // raw fee = 0.06 * 7/3 * 0.25 = 0.035 exactly
    expect(up.feeUsd).toBeCloseTo(0.04, 6); // 4 is even, 3 is odd -> rounds up to 4
  });

  it("rejects an out-of-range price as UNVERIFIED (never silently fee=0 while claiming success)", () => {
    const result = computePmusTakerFee(10, 1.5);
    expect(result.valid).toBe(false);
    expect(result.reason).not.toBeNull();
    expect(result.feeUsd).toBe(0);
  });

  it("rejects non-positive contracts as UNVERIFIED", () => {
    expect(computePmusTakerFee(0, 0.5).valid).toBe(false);
    expect(computePmusTakerFee(-1, 0.5).valid).toBe(false);
    expect(computePmusTakerFee(Number.NaN, 0.5).valid).toBe(false);
  });
});

describe("FINAL BUILD Part 11: Kalshi taker fee (fees = round_up(0.07 * C * P * (1-P)) to the nearest $0.0001)", () => {
  it("computes the documented formula and rounds UP to the nearest centicent, never down", () => {
    // 0.07 * 100 * 0.5 * 0.5 = 1.75 exactly (already a whole centicent multiple)
    const exact = computeKalshiTakerFee(100, 0.5);
    expect(exact.valid).toBe(true);
    expect(exact.feeUsd).toBeCloseTo(1.75, 6);
    expect(exact.feeModelVersion).toBe(KALSHI_FEE_MODEL_VERSION);
  });

  it("rounds UP even when the raw fee is only fractionally above a centicent boundary", () => {
    // 0.07 * 3 * 0.5 * 0.5 = 0.0525 -> rounds up to 0.0525 exactly already a centicent
    // multiple; use a price that produces a non-centicent-aligned raw value instead.
    const result = computeKalshiTakerFee(1, 0.13); // 0.07*1*0.13*0.87 = 0.0079170...
    expect(result.valid).toBe(true);
    // Raw = 0.00791700..., next centicent multiple at or above it is 0.0080.
    expect(result.feeUsd).toBeCloseTo(0.008, 6);
    expect(result.feeUsd).toBeGreaterThanOrEqual(0.07 * 1 * 0.13 * 0.87);
  });

  it("fees peak near p=0.50 and fall toward the extremes, same shape as PM-US", () => {
    const mid = computeKalshiTakerFee(100, 0.5);
    const extreme = computeKalshiTakerFee(100, 0.05);
    expect(extreme.feeUsd).toBeLessThan(mid.feeUsd);
  });

  it("rejects an out-of-range price or non-positive contracts as UNVERIFIED", () => {
    expect(computeKalshiTakerFee(10, 0).valid).toBe(false);
    expect(computeKalshiTakerFee(10, 1).valid).toBe(false);
    expect(computeKalshiTakerFee(0, 0.5).valid).toBe(false);
  });
});

describe("computeTakerFee: venue dispatch", () => {
  it("routes PMUS to the PM-US formula and KALSHI to the Kalshi formula", () => {
    const pmus = computeTakerFee("PMUS", 100, 0.5);
    const kalshi = computeTakerFee("KALSHI", 100, 0.5);
    expect(pmus.feeModelVersion).toBe(PMUS_FEE_MODEL_VERSION);
    expect(kalshi.feeModelVersion).toBe(KALSHI_FEE_MODEL_VERSION);
    // Different coefficients (0.06 vs 0.07) -> different fee at the identical input.
    expect(pmus.feeUsd).not.toBeCloseTo(kalshi.feeUsd, 6);
  });
});
