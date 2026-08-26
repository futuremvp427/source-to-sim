/**
 * Bucket probability engine.
 *
 * Produces a probability distribution over every bucket in a station-day event,
 * which is the only object that can be compared like-for-like against the
 * market's own implied distribution.
 *
 * Design decisions that matter for correctness:
 *
 * - **Continuity correction.** Contracts settle on a whole-degree reported
 *   maximum, so bucket [lo, hi] is P(lo - 0.5 < X < hi + 0.5) under a continuous
 *   forecast distribution. Omitting this systematically misprices narrow buckets.
 *
 * - **Observation floor.** A daily maximum cannot end below the maximum already
 *   observed. Once an intraday observation exists it truncates the distribution
 *   from below and the remainder is renormalised. This is the mechanism the
 *   research phase identified in BeefSlayer's behaviour (68.6% of its first
 *   entries land 12-24h after 00Z of the target date), so it is modelled
 *   explicitly rather than left to the forecast means.
 *
 * - **Dispersion is reported, never hidden.** Model disagreement is a first
 *   class output. A tight consensus and a wide disagreement can produce the
 *   same blended mean while deserving completely different position sizing.
 */

import type { TemperatureBucket } from "./buckets";
import type { SourceKind } from "./provenance";

export type ModelForecast = {
  source: SourceKind;
  sourceId: string;
  /** Forecast daily maximum, degrees F. */
  meanF: number;
  /** Forecast standard deviation, degrees F. Must be > 0. */
  sdF: number;
  /** Relative blend weight. Normalised internally. */
  weight: number;
};

export type BucketProbability = {
  ticker: string;
  label: string;
  probability: number;
  /** Per-model probability for this bucket, before blending. */
  byModel: Array<{ sourceId: string; source: SourceKind; probability: number }>;
};

export type DistributionResult = {
  buckets: BucketProbability[];
  /** Weighted-mean forecast maximum after any observation truncation. */
  consensusMeanF: number;
  /** Weighted SD of model means: pure between-model disagreement. */
  modelDispersionF: number;
  /** Distinct model families that contributed. */
  contributingSources: SourceKind[];
  /** Highest-probability bucket. */
  dominantTicker: string;
  /** 0..1. Rises with agreement and source count, falls with dispersion. */
  confidence: number;
  /** Observed maximum applied as a floor, when one was supplied. */
  observationFloorF: number | null;
};

export class ProbabilityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbabilityInputError";
  }
}

/** Abramowitz & Stegun 7.1.26 error function; |error| < 1.5e-7. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF. */
export function normalCdf(x: number, mean: number, sd: number): number {
  if (sd <= 0) throw new ProbabilityInputError(`sd must be positive, got ${sd}`);
  return 0.5 * (1 + erf((x - mean) / (sd * Math.SQRT2)));
}

/** P(lo-0.5 < X < hi+0.5) for one model, with unbounded tails supported. */
function bucketProbabilityForModel(bucket: TemperatureBucket, mean: number, sd: number): number {
  const lower = bucket.lowerF === null ? 0 : normalCdf(bucket.lowerF - 0.5, mean, sd);
  const upper = bucket.upperF === null ? 1 : normalCdf(bucket.upperF + 0.5, mean, sd);
  return Math.max(0, upper - lower);
}

function normaliseWeights(forecasts: readonly ModelForecast[]): number[] {
  const total = forecasts.reduce((a, f) => a + f.weight, 0);
  if (total <= 0) throw new ProbabilityInputError("forecast weights must sum to a positive number");
  return forecasts.map((f) => f.weight / total);
}

/**
 * Renormalise a distribution after truncating below an observed maximum.
 * Buckets entirely below the floor go to zero; a straddling bucket keeps only
 * the mass at or above the floor.
 */
function applyObservationFloor(
  bucket: TemperatureBucket,
  raw: number,
  mean: number,
  sd: number,
  floorF: number,
): number {
  if (bucket.upperF !== null && bucket.upperF < floorF) return 0;
  if (bucket.lowerF !== null && bucket.lowerF >= floorF) return raw;
  // Straddling bucket: keep mass from the floor upward.
  const lower = normalCdf(floorF - 0.5, mean, sd);
  const upper = bucket.upperF === null ? 1 : normalCdf(bucket.upperF + 0.5, mean, sd);
  return Math.max(0, upper - lower);
}

/**
 * Build the bucket distribution.
 *
 * `observedMaxF` is the highest temperature already recorded in the settlement
 * window at decision time. Callers must only pass an observation admitted by
 * the provenance layer.
 */
export function buildDistribution(params: {
  buckets: readonly TemperatureBucket[];
  forecasts: readonly ModelForecast[];
  observedMaxF?: number | null;
}): DistributionResult {
  const { buckets, forecasts, observedMaxF = null } = params;

  if (buckets.length === 0) throw new ProbabilityInputError("no buckets supplied");
  if (forecasts.length === 0) throw new ProbabilityInputError("no forecasts supplied");
  for (const f of forecasts) {
    if (!Number.isFinite(f.meanF)) throw new ProbabilityInputError(`${f.sourceId} has a non-finite mean`);
    if (!Number.isFinite(f.sdF) || f.sdF <= 0) {
      throw new ProbabilityInputError(`${f.sourceId} must have a positive finite sd, got ${f.sdF}`);
    }
    if (!Number.isFinite(f.weight) || f.weight < 0) {
      throw new ProbabilityInputError(`${f.sourceId} must have a non-negative finite weight`);
    }
  }
  if (observedMaxF !== null && !Number.isFinite(observedMaxF)) {
    throw new ProbabilityInputError("observedMaxF must be finite when supplied");
  }

  const weights = normaliseWeights(forecasts);

  const perModel = forecasts.map((f) => {
    const raw = buckets.map((b) => {
      const p = bucketProbabilityForModel(b, f.meanF, f.sdF);
      return observedMaxF === null ? p : applyObservationFloor(b, p, f.meanF, f.sdF, observedMaxF);
    });
    const total = raw.reduce((a, b) => a + b, 0);
    // Truncation removes mass; renormalise so each model still sums to 1.
    const normalised = total > 0 ? raw.map((p) => p / total) : raw.map(() => 1 / buckets.length);
    return { forecast: f, probabilities: normalised };
  });

  const blended = buckets.map((_, i) =>
    perModel.reduce((acc, m, mi) => acc + (weights[mi] ?? 0) * (m.probabilities[i] ?? 0), 0),
  );
  const blendTotal = blended.reduce((a, b) => a + b, 0);
  const finalProbs = blended.map((p) => p / blendTotal);

  const consensusMeanF = forecasts.reduce(
    (acc, f, i) => acc + (weights[i] ?? 0) * Math.max(f.meanF, observedMaxF ?? Number.NEGATIVE_INFINITY),
    0,
  );
  const variance = forecasts.reduce(
    (acc, f, i) => acc + (weights[i] ?? 0) * (f.meanF - consensusMeanF) ** 2,
    0,
  );
  const modelDispersionF = Math.sqrt(Math.max(0, variance));

  const bucketResults: BucketProbability[] = buckets.map((b, i) => ({
    ticker: b.ticker,
    label: b.label,
    probability: finalProbs[i] ?? 0,
    byModel: perModel.map((m) => ({
      sourceId: m.forecast.sourceId,
      source: m.forecast.source,
      probability: m.probabilities[i] ?? 0,
    })),
  }));

  const dominant = bucketResults.reduce((a, b) => (b.probability > a.probability ? b : a));
  const contributingSources = [...new Set(forecasts.map((f) => f.source))].sort();

  return {
    buckets: bucketResults,
    consensusMeanF,
    modelDispersionF,
    contributingSources,
    dominantTicker: dominant.ticker,
    confidence: confidenceScore({
      modelDispersionF,
      sourceCount: contributingSources.length,
      dominantProbability: dominant.probability,
    }),
    observationFloorF: observedMaxF,
  };
}

/**
 * Confidence in 0..1. Deliberately simple and monotone so it cannot be tuned
 * into a result: more independent model families and tighter agreement raise it,
 * dispersion lowers it, and a diffuse distribution caps it.
 */
export function confidenceScore(params: {
  modelDispersionF: number;
  sourceCount: number;
  dominantProbability: number;
}): number {
  const { modelDispersionF, sourceCount, dominantProbability } = params;
  const agreement = 1 / (1 + Math.max(0, modelDispersionF) / 2);
  const breadth = Math.min(1, sourceCount / 4);
  const sharpness = Math.min(1, Math.max(0, dominantProbability));
  const score = agreement * (0.5 + 0.5 * breadth) * (0.5 + 0.5 * sharpness);
  return Math.min(1, Math.max(0, score));
}

/** Probabilities must sum to ~1. Used as an invariant check by callers and tests. */
export function distributionSum(result: DistributionResult): number {
  return result.buckets.reduce((a, b) => a + b.probability, 0);
}
