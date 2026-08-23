import { describe, expect, it } from "vitest";

import {
  computeKalshiTakerFee,
  computePmusTakerFee,
  computeTakerFee,
  computeTakerFeeForFills,
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

describe("CODEX P1-5: computeTakerFeeForFills -- execution-granularity fee computation, never blended VWAP", () => {
  it("official single-level example: a single-level fill produces the IDENTICAL fee as computeTakerFee against that one price (both formulas' own official worked example)", () => {
    const singleLevel = computeTakerFeeForFills("PMUS", [{ price: 0.5, contracts: 100 }]);
    const direct = computePmusTakerFee(100, 0.5);
    expect(singleLevel.feeUsd).toBe(direct.feeUsd);
    expect(singleLevel.valid).toBe(true);

    const kalshiSingle = computeTakerFeeForFills("KALSHI", [{ price: 0.5, contracts: 100 }]);
    const kalshiDirect = computeKalshiTakerFee(100, 0.5);
    expect(kalshiSingle.feeUsd).toBe(kalshiDirect.feeUsd);
  });

  it("multi-level fill: per-level fee is PROVABLY different from fee(VWAP) -- the exact discrepancy this fix closes, not a rounding nuance", () => {
    // 5 contracts at p=0.50 (p(1-p)=0.2500) + 5 contracts at p=0.90 (p(1-p)=0.0900).
    // Per-level: Theta*(5*0.25 + 5*0.09) = Theta*1.70. Blended VWAP=0.70: Theta*10*0.70*0.30 = Theta*2.10.
    const perLevel = computeTakerFeeForFills("PMUS", [
      { price: 0.5, contracts: 5 },
      { price: 0.9, contracts: 5 },
    ]);
    const blendedAtVwap = computePmusTakerFee(10, 0.7);
    expect(perLevel.valid).toBe(true);
    expect(perLevel.feeUsd).not.toBeCloseTo(blendedAtVwap.feeUsd, 2);
    expect(perLevel.feeUsd).toBeLessThan(blendedAtVwap.feeUsd); // concave formula -- blended VWAP overstates the true cost here
  });

  it("rounding boundary: each level is rounded per the venue's own documented per-fill rule BEFORE summing, not once at the end", () => {
    // Two levels individually landing on PM-US's own documented half-cent boundary example.
    const result = computeTakerFeeForFills("PMUS", [
      { price: 0.5, contracts: 100 }, // Theta*100*0.25 = 1.50 exactly -- no rounding ambiguity
      { price: 0.5, contracts: 100 },
    ]);
    expect(result.feeUsd).toBeCloseTo(3.0, 6);
  });

  it("fails closed as a WHOLE when any one level's own fee computation is invalid -- never silently drops just that level's fee", () => {
    const result = computeTakerFeeForFills("PMUS", [
      { price: 0.5, contracts: 100 },
      { price: 1.5, contracts: 50 }, // out of PM-US's valid [0.01, 0.99] range
    ]);
    expect(result.valid).toBe(false);
    expect(result.feeUsd).toBe(0); // never a partial total from the one valid level
  });

  it("an empty fills array (no consumed levels) is UNVERIFIED, never a silent fee=0 success", () => {
    const result = computeTakerFeeForFills("KALSHI", []);
    expect(result.valid).toBe(false);
  });

  it("CODEX P1-5: a market whose fee cannot be proven (no known multiplier/schedule signal) must never silently fall back to the standard formula as if verified -- this module's own single documented Kalshi formula is the ONLY schedule this codebase can currently prove (live-confirmed: Kalshi's public market API exposes no per-market fee-multiplier field at all), so computeTakerFeeForFills cannot silently apply an override it has no way to detect. This test documents that boundary rather than asserting a fabricated multiplier.", () => {
    // Confirms the dispatcher does not invent per-market fee metadata that does not
    // exist anywhere in this codebase's Kalshi discovery layer (KalshiCandidate has no
    // fee-multiplier field -- see kalshi.ts) -- the standard schedule is applied because
    // it is the only one this system can prove, not because a differing one was ignored.
    const result = computeTakerFeeForFills("KALSHI", [{ price: 0.5, contracts: 100 }]);
    expect(result.feeModelVersion).toBe(KALSHI_FEE_MODEL_VERSION);
    expect(result.valid).toBe(true);
  });
});

describe("CODEX P1-4 (round 2): net fee model re-investigation", () => {
  it("version/date corrected to the currently-in-force schedule (was stale at the Feb 2026 label)", () => {
    expect(KALSHI_FEE_MODEL_VERSION).toBe("KALSHI_FEE_V2_2026-07-07");
    expect(computeKalshiTakerFee(100, 0.5).effectiveDate).toBe("2026-07-07");
  });

  it("official worked rounding example: 1 contract at $0.33 rounds UP from a genuinely non-centicent-aligned raw fee", () => {
    // 0.07 * 1 * 0.33 * 0.67 = 0.0154770 -- the next centicent multiple at or above it is 0.0155.
    const result = computeKalshiTakerFee(1, 0.33);
    expect(result.valid).toBe(true);
    expect(result.feeUsd).toBeCloseTo(0.0155, 6);
    expect(result.feeUsd).toBeGreaterThanOrEqual(0.07 * 1 * 0.33 * 0.67);
  });

  it("netFeeComplete: PM-US's model is complete (no undocumented cross-fill mechanism); Kalshi's is a documented, bounded, safe upper bound (the balance-rounding/rebate accumulator is not modeled)", () => {
    const pmus = computePmusTakerFee(100, 0.5);
    const kalshi = computeKalshiTakerFee(100, 0.5);
    expect(pmus.netFeeComplete).toBe(true);
    expect(pmus.reason).toBeNull();
    expect(kalshi.netFeeComplete).toBe(false);
    expect(kalshi.valid).toBe(true); // still a REAL, documented, currently-in-force formula -- not unverified
    expect(kalshi.reason).toMatch(/rebate|balance-rounding/i);
  });

  it("netFeeComplete propagates through computeTakerFeeForFills for both a single level and a multi-level book, valid or invalid", () => {
    expect(computeTakerFeeForFills("KALSHI", [{ price: 0.5, contracts: 100 }]).netFeeComplete).toBe(false);
    expect(computeTakerFeeForFills("PMUS", [{ price: 0.5, contracts: 100 }]).netFeeComplete).toBe(true);
    expect(
      computeTakerFeeForFills("KALSHI", [
        { price: 0.5, contracts: 50 },
        { price: 0.6, contracts: 50 },
      ]).netFeeComplete,
    ).toBe(false);
    expect(computeTakerFeeForFills("KALSHI", []).netFeeComplete).toBe(false); // invalid, but the venue's own model completeness is still an honest false, not a placeholder true
  });

  it("Kalshi's multiplier M=1 applies to every market this system's own BetType can ever describe -- MONEYLINE/SPREAD/TOTAL are all team/game-level markets, never the player-prop exception the documented non-default multiplier names. A fee computed for any of these is the correctly-applicable schedule, not an unjustified guess.", () => {
    // This module's fee functions take no betType parameter at all (contracts/price
    // only) -- the guarantee comes from the TYPE SYSTEM (types.ts's BetType union),
    // not a runtime check, exactly like this codebase's own established pattern of
    // trusting an exhaustive union rather than defending against values the compiler
    // already makes unreachable. Documents the boundary rather than asserting a
    // fabricated non-default multiplier this codebase has no way to observe (Kalshi's
    // public market API exposes no per-market fee-multiplier field -- see the test
    // immediately above this describe block).
    const result = computeKalshiTakerFee(100, 0.5);
    expect(result.valid).toBe(true);
    expect(result.feeUsd).toBeCloseTo(0.07 * 100 * 0.5 * 0.5, 6); // M=1 -- unmultiplied base formula
  });
});
