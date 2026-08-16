/**
 * Pure, deterministic batching for the autonomous candidate research pass.
 *
 * The full pass used to research every watchlist candidate in a single
 * invocation, which repeatedly outlived the fixed 300s research lease and left
 * the lease effectively abandoned with no progress recorded. Work is now
 * bounded per invocation and RESUMABLE: candidates are ordered oldest-computed
 * first (never-computed first), so repeated scheduled runs walk the whole
 * universe over time instead of restarting it and starving the tail.
 *
 * Scoring and promotion rules are untouched — this only decides WHICH
 * candidates a given invocation refreshes.
 */

/** Candidates researched per scheduled invocation. */
export const RESEARCH_BATCH_SIZE = 3;

/**
 * Wall-clock budget for one pass. Well inside the 300s lease, so the lease can
 * never be left abandoned by an overrunning pass.
 */
export const RESEARCH_BUDGET_MS = 120_000;

export type BatchCandidate = { id: string; handle: string };

/**
 * Oldest-first bounded batch. `lastComputedAt` maps candidate id -> ISO time of
 * its most recent metrics computation; missing/unparseable means "never", which
 * sorts first. Ties break on id so the order is fully deterministic.
 */
export function selectResearchBatch<T extends BatchCandidate>(
  candidates: readonly T[],
  lastComputedAt: ReadonlyMap<string, string | null>,
  batchSize: number = RESEARCH_BATCH_SIZE,
): T[] {
  const rank = (c: T): number => {
    const raw = lastComputedAt.get(c.id);
    const t = raw ? new Date(raw).getTime() : NaN;
    return Number.isFinite(t) ? t : -1;
  };
  return [...candidates]
    .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, batchSize));
}

/** True once the pass has consumed its wall-clock budget. */
export function budgetExhausted(startedAt: number, now: number, budgetMs = RESEARCH_BUDGET_MS): boolean {
  return now - startedAt >= budgetMs;
}
