import { describe, expect, it } from "vitest";
import {
  cheapTailFeeProfile,
  FEE_MODEL_VERSION,
  feeInProbabilityPoints,
  quoteFee,
  roundUpToCenticent,
  UnsupportedFeeScheduleError,
  type FeeSchedule,
} from "./fees";

/** Verbatim shape observed on Kalshi series KXHIGHNY. */
const WEATHER_SCHEDULE: FeeSchedule = { feeType: "quadratic", feeMultiplier: 1 };

describe("roundUpToCenticent", () => {
  it("rounds up to the next centicent, not the next cent", () => {
    // 0.07 * 0.05 * 0.95 = 0.003325 -> 0.0034, NOT 0.01.
    expect(roundUpToCenticent(0.003325)).toBe(0.0034);
  });

  it("leaves exact centicents untouched", () => {
    expect(roundUpToCenticent(0.0034)).toBe(0.0034);
    expect(roundUpToCenticent(0.01)).toBe(0.01);
  });

  it("returns zero for zero and negative input", () => {
    expect(roundUpToCenticent(0)).toBe(0);
    expect(roundUpToCenticent(-1)).toBe(0);
  });

  it("rejects non-finite input", () => {
    expect(() => roundUpToCenticent(Number.NaN)).toThrow(RangeError);
  });
});

describe("quoteFee", () => {
  it("prices the quadratic taker fee at the maximum-fee midpoint", () => {
    // 0.07 * 100 * 0.5 * 0.5 = 1.75
    const q = quoteFee({ price: 0.5, contracts: 100, schedule: WEATHER_SCHEDULE });
    expect(q.feeUsd).toBeCloseTo(1.75, 4);
    expect(q.feeModelVersion).toBe(FEE_MODEL_VERSION);
    expect(q.isLowerBound).toBe(false);
  });

  it("is symmetric about 0.5", () => {
    const low = quoteFee({ price: 0.2, contracts: 100, schedule: WEATHER_SCHEDULE });
    const high = quoteFee({ price: 0.8, contracts: 100, schedule: WEATHER_SCHEDULE });
    expect(low.feeUsd).toBeCloseTo(high.feeUsd, 6);
  });

  it("applies the venue fee multiplier", () => {
    const base = quoteFee({ price: 0.5, contracts: 100, schedule: WEATHER_SCHEDULE });
    const halved = quoteFee({
      price: 0.5,
      contracts: 100,
      schedule: { feeType: "quadratic", feeMultiplier: 0.5 },
    });
    expect(halved.feeUsd).toBeCloseTo(base.feeUsd / 2, 4);
  });

  it("charges no taker fee to a resting maker order but marks it a lower bound", () => {
    const q = quoteFee({ price: 0.5, contracts: 100, schedule: WEATHER_SCHEDULE, role: "maker" });
    expect(q.feeUsd).toBe(0);
    expect(q.isLowerBound).toBe(true);
  });

  it("reports fee as a fraction of premium, which is what hurts cheap contracts", () => {
    const q = quoteFee({ price: 0.05, contracts: 100, schedule: WEATHER_SCHEDULE });
    // premium = $5.00; fee = 0.07*100*0.05*0.95 = 0.3325 -> 0.3325
    expect(q.feeUsd).toBeCloseTo(0.3325, 4);
    expect(q.effectiveFeeFractionOfPremium).toBeCloseTo(0.0665, 4);
  });

  it("costs proportionally far more premium at 1c than at 20c", () => {
    const cheap = quoteFee({ price: 0.01, contracts: 100, schedule: WEATHER_SCHEDULE });
    const rich = quoteFee({ price: 0.2, contracts: 100, schedule: WEATHER_SCHEDULE });
    expect(cheap.effectiveFeeFractionOfPremium!).toBeGreaterThan(
      rich.effectiveFeeFractionOfPremium!,
    );
  });

  it("returns a null premium fraction for a zero-contract quote", () => {
    const q = quoteFee({ price: 0.5, contracts: 0, schedule: WEATHER_SCHEDULE });
    expect(q.feeUsd).toBe(0);
    expect(q.effectiveFeeFractionOfPremium).toBeNull();
  });

  it("fails closed on an unrecognised fee type", () => {
    expect(() =>
      quoteFee({ price: 0.5, contracts: 1, schedule: { feeType: "linear", feeMultiplier: 1 } }),
    ).toThrow(UnsupportedFeeScheduleError);
  });

  it("fails closed on a non-positive fee multiplier", () => {
    expect(() =>
      quoteFee({ price: 0.5, contracts: 1, schedule: { feeType: "quadratic", feeMultiplier: 0 } }),
    ).toThrow(UnsupportedFeeScheduleError);
  });

  it("rejects prices outside [0,1]", () => {
    expect(() => quoteFee({ price: 1.2, contracts: 1, schedule: WEATHER_SCHEDULE })).toThrow(RangeError);
    expect(() => quoteFee({ price: -0.1, contracts: 1, schedule: WEATHER_SCHEDULE })).toThrow(RangeError);
  });

  it("rejects negative contract counts", () => {
    expect(() => quoteFee({ price: 0.5, contracts: -1, schedule: WEATHER_SCHEDULE })).toThrow(RangeError);
  });
});

describe("feeInProbabilityPoints", () => {
  it("converts fee into a per-contract probability shift", () => {
    const pts = feeInProbabilityPoints({ price: 0.5, contracts: 100, schedule: WEATHER_SCHEDULE });
    expect(pts).toBeCloseTo(0.0175, 4);
  });

  it("stays finite and small for deep-tail prices", () => {
    const pts = feeInProbabilityPoints({ price: 0.02, contracts: 100, schedule: WEATHER_SCHEDULE });
    expect(pts).toBeGreaterThan(0);
    expect(pts).toBeLessThan(0.01);
  });
});

describe("cheapTailFeeProfile", () => {
  it("produces a monotonically decreasing premium burden as price rises", () => {
    const rows = cheapTailFeeProfile(WEATHER_SCHEDULE);
    const fractions = rows.map((r) => r.fractionOfPremium ?? 0);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i] ?? 0).toBeLessThan(fractions[i - 1] ?? 0);
    }
  });

  it("keeps the 1c premium burden well below the whole premium", () => {
    const [penny] = cheapTailFeeProfile(WEATHER_SCHEDULE, [0.01]);
    expect(penny?.fractionOfPremium ?? 0).toBeLessThan(0.1);
    expect(penny?.fractionOfPremium ?? 0).toBeGreaterThan(0.05);
  });
});
