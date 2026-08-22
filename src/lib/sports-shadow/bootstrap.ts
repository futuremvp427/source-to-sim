/**
 * FINAL BUILD Part 3: bootstrap confidence interval — PURE math only.
 *
 * Operates EXCLUSIVELY on independent cluster-level returns (analytics.ts's
 * computeClusterReturns output) -- never on raw, correlated per-signal fills. Resampling
 * raw fills would treat N correlated wallet bets on one game as N independent draws,
 * inflating apparent statistical confidence; resampling clusters is the mission's own
 * explicit requirement.
 *
 * Deterministic and testable: a fixed seed always produces the identical resampled
 * sequence (mulberry32, a small deterministic PRNG -- no crypto, no external
 * dependency, no wall-clock/Math.random anywhere in this module), so a milestone
 * snapshot's bootstrap result is exactly reproducible from its stored seed/iteration
 * count forever, and CI tests never flake.
 */

/** mulberry32: minimal deterministic 32-bit PRNG. Same seed -> identical infinite output sequence, forever, on any runtime. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type BootstrapResult = {
  lowerUsd: number;
  medianUsd: number;
  upperUsd: number;
  meanUsd: number;
  iterations: number;
  seed: number;
  confidenceLevel: number;
  sampleSize: number;
  /** Fraction of resampled means that were > 0 -- the direct input to classification.ts's "~90-95% confidence of positive net expectancy" gate. */
  probabilityPositive: number;
};

/** Sane default for a milestone/promotion-decision report -- stable, precise enough that re-running with a different seed moves the interval by well under a cent at realistic sample sizes. Tests should pass a small override for speed; production snapshot code should never override this. */
export const DEFAULT_BOOTSTRAP_ITERATIONS = 10_000;
export const DEFAULT_CONFIDENCE_LEVEL = 0.9;
export const DEFAULT_BOOTSTRAP_SEED = 20260824;

function percentileOf(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[idx] ?? 0;
}

/**
 * `clusterReturns` -- one net-P&L number PER INDEPENDENT CLUSTER (never per raw fill).
 * Each iteration draws `sampleSize` clusters WITH replacement and computes their mean;
 * the reported interval is the empirical percentile range of those resampled means
 * (the plain nonparametric bootstrap, the standard, most assumption-free choice for an
 * unknown, likely non-normal P&L distribution).
 */
export function bootstrapConfidenceInterval(
  clusterReturns: readonly number[],
  options: { iterations?: number; seed?: number; confidenceLevel?: number } = {},
): BootstrapResult {
  const iterations = options.iterations ?? DEFAULT_BOOTSTRAP_ITERATIONS;
  const seed = options.seed ?? DEFAULT_BOOTSTRAP_SEED;
  const confidenceLevel = options.confidenceLevel ?? DEFAULT_CONFIDENCE_LEVEL;
  const n = clusterReturns.length;

  if (n === 0) {
    return { lowerUsd: 0, medianUsd: 0, upperUsd: 0, meanUsd: 0, iterations, seed, confidenceLevel, sampleSize: 0, probabilityPositive: 0 };
  }

  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(rand() * n);
      total += clusterReturns[idx] ?? 0;
    }
    means.push(total / n);
  }
  means.sort((a, b) => a - b);

  const alpha = (1 - confidenceLevel) / 2;
  const lowerUsd = percentileOf(means, alpha * 100);
  const upperUsd = percentileOf(means, (1 - alpha) * 100);
  const medianUsd = percentileOf(means, 50);
  const meanUsd = means.reduce((a, b) => a + b, 0) / means.length;
  const probabilityPositive = means.filter((m) => m > 0).length / means.length;

  return { lowerUsd, medianUsd, upperUsd, meanUsd, iterations, seed, confidenceLevel, sampleSize: n, probabilityPositive };
}
