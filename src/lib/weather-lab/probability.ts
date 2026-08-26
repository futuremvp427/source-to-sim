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

/**
 * Measurement basis. Mixing these is a correctness error, not a nuance.
 *
 * A gridded model forecast and a point station observation are different
 * quantities. KNYC (Central Park) was observed running 7-10F cooler than the
 * Open-Meteo grid point for the same hours on 2026-08-26 while the grid sat on
 * its own forecast, so differencing the two produced a fictitious 6.5F cold
 * anomaly and a 90.8% probability on a bucket the market priced at 14c.
 *
 * Contracts settle on the STATION, so STATION is the basis that ultimately
 * matters; a GRID forecast must be bias-corrected to the station before it can
 * be differenced against a station observation.
 */
export type MeasurementBasis = "STATION" | "GRID";

export type ModelForecast = {
  source: SourceKind;
  sourceId: string;
  /** Basis of this forecast. Required so a basis mismatch cannot go unnoticed. */
  basis: MeasurementBasis;
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
  /** Blend weight toward the observation, from the frozen schedule. */
  intradayWeight: number;
  /** Sigma multiplier applied, from the frozen schedule. */
  intradaySigmaScale: number;
  /**
   * True when an observation was supplied on a different basis from at least
   * one forecast. Conditioning is suppressed and the entry gate must reject.
   */
  basisMismatch: boolean;
  /** Bases that disagreed, for the dashboard. Empty when consistent. */
  mismatchedBases: string[];
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
 * Intraday conditioning schedule — PRE-REGISTERED, FROZEN.
 *
 * The first live smoke run exposed a real defect: the model floored its
 * distribution at the observed maximum but did not otherwise react to how the
 * day was actually running. It put 27.6% on an NYC 84-85F bucket the market
 * priced at 1c, on a day sitting at 75.92F at 13:00 local against a consensus
 * mean of 82.4F. The market was right.
 *
 * Diagnostic, on 355 station-days across all five candidate cities
 * (2026-06-15..2026-08-24, Open-Meteo historical *forecast* archive against
 * reanalysis actuals, so no lookahead): the deviation of the observed maximum
 * so far from the forecast strongly predicts the deviation of the final daily
 * maximum from that forecast. Blending toward the observation cuts mean
 * absolute error by 37% at 12:00, 53% at 13:00 and 80% at 14:00 local. The
 * effect is present in every city, not just NYC.
 *
 * So the conditioned mean is `F + w(hour) * (O - F)` and the conditioned sigma
 * is `sigma * sigmaScale(hour)`, with both schedules fitted once on that window
 * and then frozen.
 *
 * TRAIN/OOS DISCIPLINE: 2026-06-15..2026-08-24 is now a CONSUMED training
 * window for this schedule. It must not be re-fitted against forward paper
 * results. Forward collection is the untouched out-of-sample test.
 *
 * CAVEAT: "observed" in the fit is reanalysis, not the settlement station's own
 * observations, so the schedule is a shape, not a precise station calibration.
 *
 * Note what the tail of this schedule implies: by 14:00 local the weight is
 * already 1.0 and residual sigma is a third of the day-ahead value, i.e. the
 * outcome is close to determined. That is the regime the earlier dead-bucket
 * research found the market already prices correctly. The interesting window is
 * the middle of the day, not the end of it.
 */
export const INTRADAY_CONDITIONING_SCHEDULE: ReadonlyArray<{
  localHour: number;
  weight: number;
  sigmaScale: number;
}> = Object.freeze([
  { localHour: 8, weight: 0.12, sigmaScale: 0.94 },
  { localHour: 9, weight: 0.16, sigmaScale: 0.91 },
  { localHour: 10, weight: 0.21, sigmaScale: 0.88 },
  { localHour: 11, weight: 0.3, sigmaScale: 0.82 },
  { localHour: 12, weight: 0.45, sigmaScale: 0.69 },
  { localHour: 13, weight: 0.74, sigmaScale: 0.53 },
  { localHour: 14, weight: 1.0, sigmaScale: 0.37 },
  { localHour: 15, weight: 1.0, sigmaScale: 0.26 },
  { localHour: 16, weight: 1.0, sigmaScale: 0.11 },
  { localHour: 17, weight: 1.0, sigmaScale: 0.06 },
  { localHour: 18, weight: 1.0, sigmaScale: 0.05 },
]);

/** Never collapse sigma to zero; a degenerate distribution is not a confident one. */
export const MIN_SIGMA_SCALE = 0.05;

/**
 * Conditioning factors for a local decision hour. Before the schedule starts,
 * no conditioning is applied; after it ends, the last row is carried forward.
 */
export function intradayConditioning(localHour: number): { weight: number; sigmaScale: number } {
  if (!Number.isFinite(localHour)) throw new ProbabilityInputError("localHour must be finite");
  const first = INTRADAY_CONDITIONING_SCHEDULE[0];
  const last = INTRADAY_CONDITIONING_SCHEDULE[INTRADAY_CONDITIONING_SCHEDULE.length - 1];
  if (!first || !last) return { weight: 0, sigmaScale: 1 };
  if (localHour < first.localHour) return { weight: 0, sigmaScale: 1 };

  let chosen = last;
  for (const row of INTRADAY_CONDITIONING_SCHEDULE) {
    if (row.localHour <= localHour) chosen = row;
  }
  return { weight: chosen.weight, sigmaScale: Math.max(MIN_SIGMA_SCALE, chosen.sigmaScale) };
}

/**
 * Build the bucket distribution.
 *
 * `observedMaxF` is the highest temperature already recorded in the settlement
 * window at decision time. Callers must only pass an observation admitted by
 * the provenance layer.
 *
 * `decisionLocalHour` enables intraday conditioning: the forecast mean is
 * blended toward the observation and sigma is tightened per the frozen
 * schedule. Omit it to get truncation only, which is what the model did before
 * the schedule existed.
 */
export function buildDistribution(params: {
  buckets: readonly TemperatureBucket[];
  forecasts: readonly ModelForecast[];
  observedMaxF?: number | null;
  decisionLocalHour?: number | null;
  /** Basis of `observedMaxF`. Required whenever an observation is supplied. */
  observationBasis?: MeasurementBasis | null;
}): DistributionResult {
  const {
    buckets,
    forecasts,
    observedMaxF = null,
    decisionLocalHour = null,
    observationBasis = null,
  } = params;

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

  // A basis mismatch makes (observed - forecast) meaningless. Fail closed:
  // suppress conditioning entirely and surface the mismatch so the entry gate
  // can reject rather than trading on a fictitious anomaly.
  const mismatched = observedMaxF === null
    ? []
    : [...new Set(forecasts.filter((f) => f.basis !== observationBasis).map((f) => `${f.sourceId}:${f.basis}`))];
  const basisMismatch = mismatched.length > 0;

  // Intraday conditioning: how the day is actually running is far more
  // informative than the day-ahead forecast alone once the afternoon starts.
  const conditioning =
    observedMaxF !== null && decisionLocalHour !== null && !basisMismatch
      ? intradayConditioning(decisionLocalHour)
      : { weight: 0, sigmaScale: 1 };

  const conditioned = forecasts.map((f) => ({
    ...f,
    meanF:
      observedMaxF === null || basisMismatch
        ? f.meanF
        : f.meanF + conditioning.weight * (observedMaxF - f.meanF),
    sdF: Math.max(1e-6, f.sdF * conditioning.sigmaScale),
  }));

  // Under a basis mismatch the observation is not comparable, so it may not
  // truncate the distribution either.
  const usableFloor = basisMismatch ? null : observedMaxF;

  const perModel = conditioned.map((f) => {
    const raw = buckets.map((b) => {
      const p = bucketProbabilityForModel(b, f.meanF, f.sdF);
      return usableFloor === null ? p : applyObservationFloor(b, p, f.meanF, f.sdF, usableFloor);
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

  const consensusMeanF = conditioned.reduce(
    (acc, f, i) => acc + (weights[i] ?? 0) * Math.max(f.meanF, usableFloor ?? Number.NEGATIVE_INFINITY),
    0,
  );
  const variance = conditioned.reduce(
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
    observationFloorF: usableFloor,
    intradayWeight: conditioning.weight,
    intradaySigmaScale: conditioning.sigmaScale,
    basisMismatch,
    mismatchedBases: mismatched,
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
