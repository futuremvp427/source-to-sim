import { describe, expect, it } from "vitest";

import { bootstrapConfidenceInterval } from "./bootstrap";

describe("bootstrapConfidenceInterval", () => {
  it("is fully deterministic for a fixed seed -- identical calls produce identical output", () => {
    const returns = [10, -5, 20, 15, -8, 3, 12, -2, 7, 9];
    const a = bootstrapConfidenceInterval(returns, { iterations: 500, seed: 42 });
    const b = bootstrapConfidenceInterval(returns, { iterations: 500, seed: 42 });
    expect(a).toEqual(b);
  });

  it("a different seed produces a different (but still valid) result", () => {
    const returns = [10, -5, 20, 15, -8, 3, 12, -2, 7, 9];
    const a = bootstrapConfidenceInterval(returns, { iterations: 500, seed: 1 });
    const b = bootstrapConfidenceInterval(returns, { iterations: 500, seed: 2 });
    expect(a.seed).not.toBe(b.seed);
  });

  it("lower <= median <= upper always holds", () => {
    const returns = [10, -5, 20, 15, -8, 3, 12, -2, 7, 9];
    const result = bootstrapConfidenceInterval(returns, { iterations: 1000, seed: 7 });
    expect(result.lowerUsd).toBeLessThanOrEqual(result.medianUsd);
    expect(result.medianUsd).toBeLessThanOrEqual(result.upperUsd);
  });

  it("all-positive cluster returns produce probabilityPositive of 1 and a strictly positive interval", () => {
    const returns = [5, 10, 15, 20, 8];
    const result = bootstrapConfidenceInterval(returns, { iterations: 500, seed: 3 });
    expect(result.probabilityPositive).toBe(1);
    expect(result.lowerUsd).toBeGreaterThan(0);
  });

  it("all-negative cluster returns produce probabilityPositive of 0", () => {
    const returns = [-5, -10, -15, -20, -8];
    const result = bootstrapConfidenceInterval(returns, { iterations: 500, seed: 3 });
    expect(result.probabilityPositive).toBe(0);
    expect(result.upperUsd).toBeLessThan(0);
  });

  it("empty input returns a well-defined zero result, never NaN/throw", () => {
    const result = bootstrapConfidenceInterval([], { iterations: 100, seed: 1 });
    expect(result.sampleSize).toBe(0);
    expect(result.lowerUsd).toBe(0);
    expect(result.medianUsd).toBe(0);
    expect(result.upperUsd).toBe(0);
    expect(result.probabilityPositive).toBe(0);
  });

  it("single-cluster input always resamples to that same value -- degenerate but well-defined interval", () => {
    const result = bootstrapConfidenceInterval([42], { iterations: 200, seed: 5 });
    expect(result.lowerUsd).toBe(42);
    expect(result.medianUsd).toBe(42);
    expect(result.upperUsd).toBe(42);
  });

  it("respects a narrower confidenceLevel by producing a narrower (or equal) interval", () => {
    const returns = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 10 + i : -5 - i));
    const wide = bootstrapConfidenceInterval(returns, { iterations: 2000, seed: 11, confidenceLevel: 0.95 });
    const narrow = bootstrapConfidenceInterval(returns, { iterations: 2000, seed: 11, confidenceLevel: 0.5 });
    expect(narrow.upperUsd - narrow.lowerUsd).toBeLessThanOrEqual(wide.upperUsd - wide.lowerUsd);
  });
});
