import { median } from "../copyability/core";

export const SLIPPAGE_SAMPLE_LIMIT = 2000;
export const SLIPPAGE_METHODOLOGY_VERSION = "prior-utc-day-v1";

export type SlippageObservationSample = {
  observedAt: string;
  slippageCents: number | null;
};

export type SlippageDayBasis = {
  cutoffAt: string;
  medianCents: number | null;
  sampleCount: number;
  methodologyVersion: typeof SLIPPAGE_METHODOLOGY_VERSION;
};

/**
 * Historical settlement day D may only use observations available before
 * 00:00:00 UTC on D. This is the committed no-lookahead boundary.
 */
export function priorUtcDayCutoff(settlementDay: string): string {
  return `${settlementDay}T00:00:00.000Z`;
}

/**
 * Pure reference implementation used by regression tests and offline checks.
 * Production queries apply the same cutoff in PostgreSQL before limiting to the
 * most recent sample window.
 */
export function buildPriorDaySlippageBasis(
  settlementDay: string,
  samples: SlippageObservationSample[],
  limit = SLIPPAGE_SAMPLE_LIMIT,
): SlippageDayBasis {
  const cutoffAt = priorUtcDayCutoff(settlementDay);
  const cutoffMs = new Date(cutoffAt).getTime();
  const cappedLimit = Math.max(1, Math.min(Math.trunc(limit), SLIPPAGE_SAMPLE_LIMIT));

  const eligible = samples
    .map((sample) => ({
      ...sample,
      observedMs: new Date(sample.observedAt).getTime(),
    }))
    .filter(
      (sample) =>
        Number.isFinite(sample.observedMs) &&
        sample.observedMs < cutoffMs &&
        sample.slippageCents !== null &&
        Number.isFinite(sample.slippageCents) &&
        sample.slippageCents >= 0,
    )
    .sort((a, b) => b.observedMs - a.observedMs)
    .slice(0, cappedLimit)
    .map((sample) => sample.slippageCents as number);

  return {
    cutoffAt,
    medianCents: median(eligible),
    sampleCount: eligible.length,
    methodologyVersion: SLIPPAGE_METHODOLOGY_VERSION,
  };
}
