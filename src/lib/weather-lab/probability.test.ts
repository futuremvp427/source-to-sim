import { describe, expect, it } from "vitest";
import { parseBucket, type RawKalshiMarket } from "./buckets";
import {
  buildDistribution,
  confidenceScore,
  distributionSum,
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
      const d = buildDistribution({ buckets: BUCKETS, forecasts: [forecast()], observedMaxF: 86 });
      expect(d.buckets.find((b) => b.ticker === "T80")!.probability).toBe(0);
      expect(d.buckets.find((b) => b.ticker === "B80.5")!.probability).toBe(0);
      expect(d.buckets.find((b) => b.ticker === "B84.5")!.probability).toBe(0);
    });

    it("still sums to one after truncation", () => {
      const d = buildDistribution({ buckets: BUCKETS, forecasts: [forecast()], observedMaxF: 86 });
      expect(distributionSum(d)).toBeCloseTo(1, 9);
    });

    it("keeps only the surviving mass of a straddling bucket", () => {
      const d = buildDistribution({ buckets: BUCKETS, forecasts: [forecast({ meanF: 85 })], observedMaxF: 85 });
      const straddling = d.buckets.find((b) => b.ticker === "B84.5")!;
      expect(straddling.probability).toBeGreaterThan(0);
      expect(straddling.probability).toBeLessThan(1);
    });

    it("shifts mass upward relative to the unconstrained forecast", () => {
      const free = buildDistribution({ buckets: BUCKETS, forecasts: [forecast()] });
      const floored = buildDistribution({ buckets: BUCKETS, forecasts: [forecast()], observedMaxF: 86 });
      const freeTail = free.buckets.find((b) => b.ticker === "T87")!.probability;
      const flooredTail = floored.buckets.find((b) => b.ticker === "T87")!.probability;
      expect(flooredTail).toBeGreaterThan(freeTail);
    });

    it("records the floor it applied", () => {
      const d = buildDistribution({ buckets: BUCKETS, forecasts: [forecast()], observedMaxF: 86 });
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
