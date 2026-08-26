import { describe, expect, it } from "vitest";
import { parseBucket, type RawKalshiMarket } from "./buckets";
import {
  buildDistribution,
  confidenceScore,
  distributionSum,
  INTRADAY_CONDITIONING_SCHEDULE,
  intradayConditioning,
  MIN_SIGMA_SCALE,
  normalCdf,
  ProbabilityInputError,
  type ModelForecast,
} from "./probability";

const NYC: RawKalshiMarket[] = [
  { ticker: "T80", strike_type: "less", cap_strike: 80, yes_sub_title: "79 or below" },
  { ticker: "B80.5", strike_type: "between", floor_strike: 80, cap_strike: 81, yes_sub_title: "80 to 81" },
  { ticker: "B82.5", strike_type: "between", floor_strike: 82, cap_strike: 83, yes_sub_title: "82 to 83" },
  { ticker: "B84.5", strike_type: "between", floor_strike: 84, cap_strike: 85, yes_sub_title: "84 to 85" },
  { ticker: "B86.5", strike_type: "between", floor_strike: 86, cap_strike: 87, yes_sub_title: "86 to 87" },
  { ticker: "T87", strike_type: "greater", floor_strike: 87, yes_sub_title: "88 or above" },
];
const BUCKETS = NYC.map(parseBucket);

const forecast = (over: Partial<ModelForecast> = {}): ModelForecast => ({
  source: "NBM",
  sourceId: "nbm",
  basis: "STATION",
  meanF: 84,
  sdF: 2,
  weight: 1,
  ...over,
});

describe("normalCdf", () => {
  it("is 0.5 at the mean", () => {
    expect(normalCdf(84, 84, 2)).toBeCloseTo(0.5, 6);
  });
  it("matches the one-sigma value", () => {
    expect(normalCdf(86, 84, 2)).toBeCloseTo(0.8413, 3);
  });
  it("rejects a non-positive sd", () => {
    expect(() => normalCdf(1, 0, 0)).toThrow(ProbabilityInputError);
  });
});

describe("buildDistribution", () => {
  it("returns a normalised distribution over every bucket", () => {
    const d = buildDistribution({ buckets: BUCKETS, forecasts: [forecast()] });
    expect(d.buckets).toHaveLength(6);
    expect(distributionSum(d)).toBeCloseTo(1, 9);
    for (const b of d.buckets) expect(b.probability).toBeGreaterThanOrEqual(0);
  });

  it("puts the most mass on the bucket containing the forecast mean", () => {
    const d = buildDistribution({ buckets: BUCKETS, forecasts: [forecast({ meanF: 84.4 })] });
    expect(d.dominantTicker).toBe("B84.5");
  });

  it("applies the continuity correction rather than using raw integer bounds", () => {
    // With mean exactly 84 and sd 2, the 84-85 bucket spans 83.5..85.5.
    const d = buildDistribution({ buckets: BUCKETS, forecasts: [forecast({ meanF: 84, sdF: 2 })] });
    const p = d.buckets.find((b) => b.ticker === "B84.5")!.probability;
    const expected = normalCdf(85.5, 84, 2) - normalCdf(83.5, 84, 2);
    expect(p).toBeCloseTo(expected, 6);
  });

  it("widens toward the tails as sd grows", () => {
    const tight = buildDistribution({ buckets: BUCKETS, forecasts: [forecast({ sdF: 1 })] });
    const wide = buildDistribution({ buckets: BUCKETS, forecasts: [forecast({ sdF: 6 })] });
    const tightTail = tight.buckets.find((b) => b.ticker === "T87")!.probability;
    const wideTail = wide.buckets.find((b) => b.ticker === "T87")!.probability;
    expect(wideTail).toBeGreaterThan(tightTail);
  });

  it("blends multiple models by weight", () => {
    const cold = forecast({ sourceId: "cold", meanF: 80, weight: 1 });
    const hot = forecast({ sourceId: "hot", meanF: 88, weight: 1 });
    const d = buildDistribution({ buckets: BUCKETS, forecasts: [cold, hot] });
    expect(d.consensusMeanF).toBeCloseTo(84, 6);
    expect(distributionSum(d)).toBeCloseTo(1, 9);
  });

  it("respects unequal weights", () => {
    const cold = forecast({ sourceId: "cold", meanF: 80, weight: 3 });
    const hot = forecast({ sourceId: "hot", meanF: 88, weight: 1 });
    const d = buildDistribution({ buckets: BUCKETS, forecasts: [cold, hot] });
    expect(d.consensusMeanF).toBeCloseTo(82, 6);
  });

  it("reports model disagreement instead of hiding it", () => {
    const agree = buildDistribution({
      buckets: BUCKETS,
      forecasts: [forecast({ sourceId: "a", meanF: 84 }), forecast({ sourceId: "b", meanF: 84 })],
    });
    const disagree = buildDistribution({
      buckets: BUCKETS,
      forecasts: [forecast({ sourceId: "a", meanF: 79 }), forecast({ sourceId: "b", meanF: 89 })],
    });
    expect(agree.modelDispersionF).toBeCloseTo(0, 6);
    expect(disagree.modelDispersionF).toBeGreaterThan(4);
    expect(disagree.confidence).toBeLessThan(agree.confidence);
  });

  it("exposes each model's own probability per bucket", () => {
    const d = buildDistribution({
      buckets: BUCKETS,
      forecasts: [forecast({ sourceId: "nbm", source: "NBM" }), forecast({ sourceId: "hrrr", source: "HRRR", meanF: 87 })],
    });
    const bucket = d.buckets.find((b) => b.ticker === "T87")!;
    expect(bucket.byModel).toHaveLength(2);
    const hrrr = bucket.byModel.find((m) => m.sourceId === "hrrr")!;
    const nbm = bucket.byModel.find((m) => m.sourceId === "nbm")!;
    expect(hrrr.probability).toBeGreaterThan(nbm.probability);
  });

  describe("observation floor", () => {
    it("zeroes every bucket already excluded by the observed maximum", () => {
      const d = buildDistribution({ buckets: BUCKETS, forecasts: [forecast()], observedMaxF: 86, observationBasis: "STATION" });
      expect(d.buckets.find((b) => b.ticker === "T80")!.probability).toBe(0);
      expect(d.buckets.find((b) => b.ticker === "B80.5")!.probability).toBe(0);
      expect(d.buckets.find((b) => b.ticker === "B84.5")!.probability).toBe(0);
    });

    it("still sums to one after truncation", () => {
      const d = buildDistribution({ buckets: BUCKETS, forecasts: [forecast()], observedMaxF: 86, observationBasis: "STATION" });
      expect(distributionSum(d)).toBeCloseTo(1, 9);
    });

    it("keeps only the surviving mass of a straddling bucket", () => {
      const d = buildDistribution({ buckets: BUCKETS, forecasts: [forecast({ meanF: 85 })], observedMaxF: 85, observationBasis: "STATION" });
      const straddling = d.buckets.find((b) => b.ticker === "B84.5")!;
      expect(straddling.probability).toBeGreaterThan(0);
      expect(straddling.probability).toBeLessThan(1);
    });

    it("shifts mass upward relative to the unconstrained forecast", () => {
      const free = buildDistribution({ buckets: BUCKETS, forecasts: [forecast()] });
      const floored = buildDistribution({ buckets: BUCKETS, forecasts: [forecast()], observedMaxF: 86, observationBasis: "STATION" });
      const freeTail = free.buckets.find((b) => b.ticker === "T87")!.probability;
      const flooredTail = floored.buckets.find((b) => b.ticker === "T87")!.probability;
      expect(flooredTail).toBeGreaterThan(freeTail);
    });

    it("records the floor it applied", () => {
      const d = buildDistribution({ buckets: BUCKETS, forecasts: [forecast()], observedMaxF: 86, observationBasis: "STATION" });
      expect(d.observationFloorF).toBe(86);
    });
  });

  describe("input validation", () => {
    it("rejects an empty bucket set", () => {
      expect(() => buildDistribution({ buckets: [], forecasts: [forecast()] })).toThrow(ProbabilityInputError);
    });
    it("rejects an empty forecast set rather than inventing a prior", () => {
      expect(() => buildDistribution({ buckets: BUCKETS, forecasts: [] })).toThrow(ProbabilityInputError);
    });
    it("rejects a non-positive sd", () => {
      expect(() => buildDistribution({ buckets: BUCKETS, forecasts: [forecast({ sdF: 0 })] })).toThrow(
        ProbabilityInputError,
      );
    });
    it("rejects weights that sum to zero", () => {
      expect(() => buildDistribution({ buckets: BUCKETS, forecasts: [forecast({ weight: 0 })] })).toThrow(
        ProbabilityInputError,
      );
    });
    it("rejects a non-finite mean", () => {
      expect(() => buildDistribution({ buckets: BUCKETS, forecasts: [forecast({ meanF: Number.NaN })] })).toThrow(
        ProbabilityInputError,
      );
    });
  });
});

describe("confidenceScore", () => {
  it("stays within 0..1", () => {
    for (const d of [0, 1, 5, 50]) {
      const s = confidenceScore({ modelDispersionF: d, sourceCount: 2, dominantProbability: 0.5 });
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
  it("falls as dispersion rises", () => {
    const a = confidenceScore({ modelDispersionF: 0.5, sourceCount: 4, dominantProbability: 0.6 });
    const b = confidenceScore({ modelDispersionF: 8, sourceCount: 4, dominantProbability: 0.6 });
    expect(b).toBeLessThan(a);
  });
  it("rises with more independent model families", () => {
    const few = confidenceScore({ modelDispersionF: 1, sourceCount: 1, dominantProbability: 0.6 });
    const many = confidenceScore({ modelDispersionF: 1, sourceCount: 4, dominantProbability: 0.6 });
    expect(many).toBeGreaterThan(few);
  });
});

describe("intradayConditioning", () => {
  it("applies no conditioning before the schedule starts", () => {
    const c = intradayConditioning(5);
    expect(c.weight).toBe(0);
    expect(c.sigmaScale).toBe(1);
  });

  it("increases weight monotonically through the day", () => {
    const hours = [8, 10, 12, 13, 14];
    const weights = hours.map((h) => intradayConditioning(h).weight);
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]!).toBeGreaterThan(weights[i - 1]!);
    }
  });

  it("tightens sigma monotonically through the day", () => {
    const scales = [8, 10, 12, 13, 14, 16].map((h) => intradayConditioning(h).sigmaScale);
    for (let i = 1; i < scales.length; i++) {
      expect(scales[i]!).toBeLessThan(scales[i - 1]!);
    }
  });

  it("carries the final row forward past the end of the schedule", () => {
    expect(intradayConditioning(23).weight).toBe(1);
  });

  it("never returns a zero sigma scale, which would be a degenerate distribution", () => {
    for (const h of [18, 20, 23]) {
      expect(intradayConditioning(h).sigmaScale).toBeGreaterThanOrEqual(MIN_SIGMA_SCALE);
    }
  });

  it("uses a frozen schedule so it cannot be tuned at runtime", () => {
    expect(Object.isFrozen(INTRADAY_CONDITIONING_SCHEDULE)).toBe(true);
  });

  it("rejects a non-finite hour", () => {
    expect(() => intradayConditioning(Number.NaN)).toThrow(ProbabilityInputError);
  });
});

describe("buildDistribution with intraday conditioning", () => {
  it("reproduces the live smoke-run defect when conditioning is absent", () => {
    // Consensus 82.4F, observed 75.9F at 13:00: truncation alone leaves far too
    // much mass on 84-85F, which the market priced at ~1c.
    const d = buildDistribution({
      buckets: BUCKETS,
      forecasts: [forecast({ meanF: 82.4, sdF: 1.6 })],
      observedMaxF: 75.92,
      observationBasis: "STATION",
    });
    expect(d.buckets.find((b) => b.ticker === "B84.5")!.probability).toBeGreaterThan(0.1);
  });

  it("collapses that mass once the day is known to be running cold", () => {
    const d = buildDistribution({
      buckets: BUCKETS,
      forecasts: [forecast({ meanF: 82.4, sdF: 1.6 })],
      observedMaxF: 75.92,
      observationBasis: "STATION",
      decisionLocalHour: 13,
    });
    expect(d.buckets.find((b) => b.ticker === "B84.5")!.probability).toBeLessThan(0.01);
  });

  it("shifts the consensus toward the observation by the scheduled weight", () => {
    const d = buildDistribution({
      buckets: BUCKETS,
      forecasts: [forecast({ meanF: 82.4, sdF: 1.6 })],
      observedMaxF: 75.92,
      observationBasis: "STATION",
      decisionLocalHour: 13,
    });
    const w = intradayConditioning(13).weight;
    expect(d.intradayWeight).toBe(w);
    // Floor still applies, so the reported consensus cannot fall below observed.
    expect(d.consensusMeanF).toBeGreaterThanOrEqual(75.92);
  });

  it("does not condition a next-day event that has no observation", () => {
    const d = buildDistribution({
      buckets: BUCKETS,
      forecasts: [forecast({ meanF: 82.4 })],
      decisionLocalHour: 13,
    });
    expect(d.intradayWeight).toBe(0);
    expect(d.intradaySigmaScale).toBe(1);
  });

  it("still sums to one under conditioning", () => {
    const d = buildDistribution({
      buckets: BUCKETS,
      forecasts: [forecast({ meanF: 82.4 }), forecast({ sourceId: "b", meanF: 84 })],
      observedMaxF: 79,
      observationBasis: "STATION",
      decisionLocalHour: 12,
    });
    expect(distributionSum(d)).toBeCloseTo(1, 9);
  });

  it("sharpens the distribution as the day progresses", () => {
    const early = buildDistribution({
      buckets: BUCKETS, forecasts: [forecast({ meanF: 84 })], observedMaxF: 83, observationBasis: "STATION", decisionLocalHour: 9,
    });
    const late = buildDistribution({
      buckets: BUCKETS, forecasts: [forecast({ meanF: 84 })], observedMaxF: 83, observationBasis: "STATION", decisionLocalHour: 15,
    });
    const maxProb = (d: typeof early) => Math.max(...d.buckets.map((b) => b.probability));
    expect(maxProb(late)).toBeGreaterThan(maxProb(early));
  });

  it("reports the conditioning factors it used", () => {
    const d = buildDistribution({
      buckets: BUCKETS, forecasts: [forecast()], observedMaxF: 80, observationBasis: "STATION", decisionLocalHour: 14,
    });
    expect(d.intradayWeight).toBe(1);
    expect(d.intradaySigmaScale).toBeCloseTo(0.37, 6);
  });
});

describe("measurement basis guard", () => {
  it("suppresses conditioning when the observation is on a different basis", () => {
    // This is the 2026-08-26 defect: a STATION observation differenced against a
    // GRID forecast produced a fictitious cold anomaly.
    const d = buildDistribution({
      buckets: BUCKETS,
      forecasts: [forecast({ meanF: 82.4, sdF: 1.6, basis: "GRID" })],
      observedMaxF: 75.92,
      observationBasis: "STATION",
      decisionLocalHour: 13,
    });
    expect(d.basisMismatch).toBe(true);
    expect(d.intradayWeight).toBe(0);
    expect(d.mismatchedBases).toContain("nbm:GRID");
  });

  it("does not let an out-of-basis observation truncate the distribution either", () => {
    const d = buildDistribution({
      buckets: BUCKETS,
      forecasts: [forecast({ meanF: 82.4, basis: "GRID" })],
      observedMaxF: 86,
      observationBasis: "STATION",
    });
    expect(d.observationFloorF).toBeNull();
    // The 79-or-below bucket keeps mass, because an 86F grid-basis reading
    // cannot be trusted to have excluded it on the station basis.
    expect(d.buckets.find((b) => b.ticker === "T80")!.probability).toBeGreaterThan(0);
  });

  it("conditions normally when bases agree", () => {
    const d = buildDistribution({
      buckets: BUCKETS,
      forecasts: [forecast({ meanF: 82.4, basis: "STATION" })],
      observedMaxF: 75.92,
      observationBasis: "STATION",
      decisionLocalHour: 13,
    });
    expect(d.basisMismatch).toBe(false);
    expect(d.intradayWeight).toBeGreaterThan(0);
  });

  it("reports no mismatch when there is no observation to compare", () => {
    const d = buildDistribution({ buckets: BUCKETS, forecasts: [forecast({ basis: "GRID" })] });
    expect(d.basisMismatch).toBe(false);
    expect(d.mismatchedBases).toEqual([]);
  });

  it("flags every offending source, not just the first", () => {
    const d = buildDistribution({
      buckets: BUCKETS,
      forecasts: [
        forecast({ sourceId: "a", basis: "GRID" }),
        forecast({ sourceId: "b", basis: "GRID" }),
        forecast({ sourceId: "c", basis: "STATION" }),
      ],
      observedMaxF: 80,
      observationBasis: "STATION",
    });
    expect(d.mismatchedBases).toHaveLength(2);
  });
});
