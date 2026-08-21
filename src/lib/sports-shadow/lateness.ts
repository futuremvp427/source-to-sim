/**
 * Task 12, section 11: observation-lateness measurement definition — PURE logic only.
 *
 * Defines, once shadow collection is activated, how forward-shadow observation quality
 * will be measured. Does NOT alter observed_at/fire_at semantics (Task 8 owns those
 * unchanged), does not fabricate timing evidence before the collector has actually run,
 * and does NOT claim +5s precision until real observations exist to measure.
 *
 * lateness_ms = observed_at - fire_at, for every COMPLETED (observed_at IS NOT NULL)
 * observation row. A row with error_code set is still measurable for lateness (it was
 * attempted at a real wall-clock time — the timing question and the success/failure
 * question are independent), so `failed` is reported separately, never folded into or
 * excluded from the lateness distribution silently.
 */

export type LatenessSample = {
  venue: "PMUS" | "KALSHI";
  requestedDelayMs: number;
  latenessMs: number;
  failed: boolean;
};

export type LatenessBucketStats = {
  count: number;
  medianMs: number | null;
  p90Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  failedCount: number;
  failedRate: number;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const rank = p * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const lowerVal = sorted[lower]!;
  const upperVal = sorted[upper]!;
  return lowerVal + (upperVal - lowerVal) * (rank - lower);
}

function summarize(samples: LatenessSample[]): LatenessBucketStats {
  const latenesses = samples.map((s) => s.latenessMs).sort((a, b) => a - b);
  const failedCount = samples.filter((s) => s.failed).length;
  return {
    count: samples.length,
    medianMs: latenesses.length > 0 ? percentile(latenesses, 0.5) : null,
    p90Ms: latenesses.length > 0 ? percentile(latenesses, 0.9) : null,
    p95Ms: latenesses.length > 0 ? percentile(latenesses, 0.95) : null,
    maxMs: latenesses.length > 0 ? Math.max(...latenesses) : null,
    failedCount,
    failedRate: samples.length > 0 ? failedCount / samples.length : 0,
  };
}

export type LatenessReport = {
  overall: LatenessBucketStats;
  byRequestedDelayMs: Record<number, LatenessBucketStats>;
  byVenue: Record<string, LatenessBucketStats>;
};

/**
 * Groups already-fetched samples (see the read-only reporting query below for how to
 * fetch them) into overall / per-requested-delay / per-venue stats. Pure — no I/O, no
 * database access, no dashboard. A caller (a future reporting task, once real
 * observations exist) fetches rows and passes them here.
 */
export function buildLatenessReport(samples: LatenessSample[]): LatenessReport {
  const byRequestedDelayMs: Record<number, LatenessBucketStats> = {};
  for (const delay of [0, 5000, 10000, 30000, 60000]) {
    byRequestedDelayMs[delay] = summarize(samples.filter((s) => s.requestedDelayMs === delay));
  }
  const byVenue: Record<string, LatenessBucketStats> = {};
  for (const venue of ["PMUS", "KALSHI"] as const) {
    byVenue[venue] = summarize(samples.filter((s) => s.venue === venue));
  }
  return { overall: summarize(samples), byRequestedDelayMs, byVenue };
}

/**
 * The read-only SQL this report is meant to consume, once real observations exist.
 * Documented here (not executed by this module — no I/O) so the eventual reporting
 * task has a single, already-reviewed starting query rather than reinventing one:
 *
 *   SELECT
 *     venue,
 *     requested_delay_ms,
 *     EXTRACT(EPOCH FROM (observed_at - fire_at)) * 1000 AS lateness_ms,
 *     (error_code IS NOT NULL) AS failed
 *   FROM public.sports_quote_observations
 *   WHERE observed_at IS NOT NULL
 *   ORDER BY observed_at ASC;
 *
 * Never claims sub-5-second precision from this query alone -- that claim can only be
 * made after enough real rows exist to compute the LatenessReport above and inspect it.
 */
export const LATENESS_REPORTING_QUERY_SQL = `
SELECT
  venue,
  requested_delay_ms,
  EXTRACT(EPOCH FROM (observed_at - fire_at)) * 1000 AS lateness_ms,
  (error_code IS NOT NULL) AS failed
FROM public.sports_quote_observations
WHERE observed_at IS NOT NULL
ORDER BY observed_at ASC;
`.trim();
