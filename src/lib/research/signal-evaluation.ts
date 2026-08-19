/**
 * Phase 0B, Part 3: statistical evaluation of prediction quality.
 *
 * Pure math, no DB/network access. Implements Brier score, log loss,
 * calibration bucketing, and cluster-aware bootstrap confidence intervals --
 * clustering (e.g. by city-day) is REQUIRED input, not optional, because
 * repeated trades in the same city on the same day are correlated
 * observations, not independent samples (see the Phase 0B instruction: "Do
 * not count 200 trades in the same city-day as 200 independent
 * observations").
 */

export type Observation = {
  /** Predicted probability of the eventual outcome, in [0, 1]. */
  p: number;
  /** Realized settlement: 1 if the predicted-for outcome occurred, else 0. */
  y: 0 | 1;
  /** Cluster key (e.g. `${city}:${utcDay}` or a market/condition id). */
  clusterKey: string;
};

const EPS = 1e-6;

function clampProb(p: number): number {
  return Math.min(1 - EPS, Math.max(EPS, p));
}

/** Mean squared error between predicted probability and realized outcome. Lower is better; 0 is perfect. */
export function brierScore(obs: readonly Observation[]): number | null {
  if (obs.length === 0) return null;
  const sum = obs.reduce((acc, o) => acc + (o.p - o.y) ** 2, 0);
  return sum / obs.length;
}

/** Mean negative log-likelihood. Lower is better; heavily penalizes confident wrong predictions. */
export function logLoss(obs: readonly Observation[]): number | null {
  if (obs.length === 0) return null;
  const sum = obs.reduce((acc, o) => {
    const p = clampProb(o.p);
    return acc + (o.y === 1 ? -Math.log(p) : -Math.log(1 - p));
  }, 0);
  return sum / obs.length;
}

export type CalibrationBucket = {
  rangeLow: number;
  rangeHigh: number;
  n: number;
  meanPredicted: number | null;
  meanRealized: number | null;
};

/**
 * Buckets observations by predicted probability and compares mean predicted
 * vs. mean realized outcome per bucket -- a well-calibrated predictor has
 * meanPredicted ~= meanRealized in every bucket with enough samples.
 */
export function calibrationBuckets(
  obs: readonly Observation[],
  edges: readonly number[] = [0, 0.2, 0.4, 0.6, 0.8, 1.0],
): CalibrationBucket[] {
  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const low = edges[i]!;
    const high = edges[i + 1]!;
    const inBucket = obs.filter((o) =>
      i === edges.length - 2 ? o.p >= low && o.p <= high : o.p >= low && o.p < high,
    );
    buckets.push({
      rangeLow: low,
      rangeHigh: high,
      n: inBucket.length,
      meanPredicted: inBucket.length > 0 ? mean(inBucket.map((o) => o.p)) : null,
      meanRealized: inBucket.length > 0 ? mean(inBucket.map((o) => o.y)) : null,
    });
  }
  return buckets;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Groups observations by clusterKey, preserving all rows in each group. */
export function groupByCluster(obs: readonly Observation[]): Observation[][] {
  const map = new Map<string, Observation[]>();
  for (const o of obs) {
    const list = map.get(o.clusterKey) ?? [];
    list.push(o);
    map.set(o.clusterKey, list);
  }
  return [...map.values()];
}

export type BootstrapResult = {
  point: number;
  ciLow: number;
  ciHigh: number;
  clusters: number;
  iterations: number;
};

/**
 * Deterministic (seeded), cluster-level bootstrap: each resample draws whole
 * clusters WITH replacement (never individual rows), so correlated
 * within-cluster observations cannot inflate apparent precision. Returns
 * null when there are fewer than 2 clusters (a CI is not meaningful).
 */
export function clusteredBootstrapCi(
  clusters: readonly Observation[][],
  statistic: (obs: readonly Observation[]) => number | null,
  opts: { iterations?: number; seed?: number; alpha?: number } = {},
): BootstrapResult | null {
  const iterations = opts.iterations ?? 1000;
  const alpha = opts.alpha ?? 0.05;
  if (clusters.length < 2) return null;

  const flat = clusters.flat();
  const point = statistic(flat);
  if (point === null) return null;

  const rng = mulberry32(opts.seed ?? 42);
  const samples: number[] = [];
  for (let iter = 0; iter < iterations; iter += 1) {
    const resample: Observation[] = [];
    for (let i = 0; i < clusters.length; i += 1) {
      const idx = Math.floor(rng() * clusters.length);
      resample.push(...clusters[idx]!);
    }
    const stat = statistic(resample);
    if (stat !== null) samples.push(stat);
  }
  samples.sort((a, b) => a - b);
  const lowIdx = Math.floor((alpha / 2) * samples.length);
  const highIdx = Math.min(samples.length - 1, Math.ceil((1 - alpha / 2) * samples.length) - 1);

  return {
    point,
    ciLow: samples[lowIdx] ?? point,
    ciHigh: samples[highIdx] ?? point,
    clusters: clusters.length,
    iterations,
  };
}

/** Deterministic PRNG (mulberry32) so results are reproducible across runs, not just "random". */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type IncrementalValueVerdict =
  "MATERIAL_IMPROVEMENT" | "NO_MATERIAL_IMPROVEMENT" | "INSUFFICIENT_DATA";

export type IncrementalValueResult = {
  baselineOnly: { brier: number | null; logLoss: number | null };
  walletOnly: { brier: number | null; logLoss: number | null };
  combined: { brier: number | null; logLoss: number | null };
  /** Bootstrap CI on (combined Brier - baseline Brier); negative is an improvement (lower Brier = better). */
  brierImprovementCi: BootstrapResult | null;
  verdict: IncrementalValueVerdict;
  clusters: number;
};

/**
 * Part 3's central question: does adding wallet behavior to the public
 * baseline materially improve prediction beyond the baseline alone?
 *
 * `baselinePreds`, `walletPreds`, and `combinedPreds` must be the SAME
 * observations (same outcome y, same clusterKey) with three different `p`
 * columns -- pass them as three parallel Observation arrays built from one
 * underlying dataset. Clustering is enforced: fewer than 2 clusters is
 * INSUFFICIENT_DATA, never a false-confident verdict.
 */
export function compareIncrementalValue(
  baselinePreds: readonly Observation[],
  walletPreds: readonly Observation[],
  combinedPreds: readonly Observation[],
  opts: { iterations?: number; seed?: number; materialityThreshold?: number } = {},
): IncrementalValueResult {
  const materialityThreshold = opts.materialityThreshold ?? 0.01;

  const baseClusters = groupByCluster(baselinePreds);
  const combinedClusters = groupByCluster(combinedPreds);

  if (baseClusters.length < 2 || combinedClusters.length < 2) {
    return {
      baselineOnly: { brier: brierScore(baselinePreds), logLoss: logLoss(baselinePreds) },
      walletOnly: { brier: brierScore(walletPreds), logLoss: logLoss(walletPreds) },
      combined: { brier: brierScore(combinedPreds), logLoss: logLoss(combinedPreds) },
      brierImprovementCi: null,
      verdict: "INSUFFICIENT_DATA",
      clusters: baseClusters.length,
    };
  }

  // Paired difference per cluster-resample: (combined Brier - baseline
  // Brier) computed on the SAME resampled cluster indices for both, via a
  // shared seed and matching cluster order (both arrays are grouped from the
  // same underlying observations, so cluster i in one corresponds to
  // cluster i in the other as long as clusterKey sets match).
  const baseKeyOrder = baseClusters.map((c) => c[0]!.clusterKey);
  const combinedByKey = new Map(combinedClusters.map((c) => [c[0]!.clusterKey, c] as const));
  const pairedCombinedClusters = baseKeyOrder.map((k) => combinedByKey.get(k) ?? []);

  const diffStatistic = (resampleIdx: number[]): number | null => {
    const baseFlat = resampleIdx.flatMap((i) => baseClusters[i] ?? []);
    const combinedFlat = resampleIdx.flatMap((i) => pairedCombinedClusters[i] ?? []);
    const b = brierScore(baseFlat);
    const c = brierScore(combinedFlat);
    if (b === null || c === null) return null;
    return c - b;
  };

  const rng = mulberry32(opts.seed ?? 42);
  const iterations = opts.iterations ?? 1000;
  const samples: number[] = [];
  for (let iter = 0; iter < iterations; iter += 1) {
    const idx: number[] = [];
    for (let i = 0; i < baseClusters.length; i += 1)
      idx.push(Math.floor(rng() * baseClusters.length));
    const stat = diffStatistic(idx);
    if (stat !== null) samples.push(stat);
  }
  samples.sort((a, b) => a - b);
  const pointDiff = diffStatistic(baseClusters.map((_, i) => i));
  const alpha = 0.05;
  const lowIdx = Math.floor((alpha / 2) * samples.length);
  const highIdx = Math.min(samples.length - 1, Math.ceil((1 - alpha / 2) * samples.length) - 1);
  const brierImprovementCi: BootstrapResult | null =
    pointDiff === null
      ? null
      : {
          point: pointDiff,
          ciLow: samples[lowIdx] ?? pointDiff,
          ciHigh: samples[highIdx] ?? pointDiff,
          clusters: baseClusters.length,
          iterations,
        };

  let verdict: IncrementalValueVerdict;
  if (brierImprovementCi === null) {
    verdict = "INSUFFICIENT_DATA";
  } else if (brierImprovementCi.ciHigh < -materialityThreshold) {
    // The entire CI is a material improvement (combined Brier reliably lower).
    verdict = "MATERIAL_IMPROVEMENT";
  } else {
    verdict = "NO_MATERIAL_IMPROVEMENT";
  }

  return {
    baselineOnly: { brier: brierScore(baselinePreds), logLoss: logLoss(baselinePreds) },
    walletOnly: { brier: brierScore(walletPreds), logLoss: logLoss(walletPreds) },
    combined: { brier: brierScore(combinedPreds), logLoss: logLoss(combinedPreds) },
    brierImprovementCi,
    verdict,
    clusters: baseClusters.length,
  };
}
