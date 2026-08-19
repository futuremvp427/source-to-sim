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
 * Bounded batch. Candidates with missing or mixed-version persistence
 * (`repairIds`) are selected FIRST so partial historical records get repaired
 * before ordinary refreshes; the remainder is oldest-computed-first.
 * `lastComputedAt` maps candidate id -> ISO time of its most recent metrics
 * computation; missing/unparseable means "never", which sorts first. Ties break
 * on id so the order is fully deterministic.
 */
export function selectResearchBatch<T extends BatchCandidate>(
  candidates: readonly T[],
  lastComputedAt: ReadonlyMap<string, string | null>,
  batchSize: number = RESEARCH_BATCH_SIZE,
  repairIds: ReadonlySet<string> = new Set(),
): T[] {
  const rank = (c: T): number => {
    const raw = lastComputedAt.get(c.id);
    const t = raw ? new Date(raw).getTime() : NaN;
    return Number.isFinite(t) ? t : -1;
  };
  const priority = (c: T): number => (repairIds.has(c.id) ? 0 : 1);
  return [...candidates]
    .sort(
      (a, b) =>
        priority(a) - priority(b) || rank(a) - rank(b) || a.id.localeCompare(b.id),
    )
    .slice(0, Math.max(1, batchSize));
}

/** True once the pass has consumed its wall-clock budget. */
export function budgetExhausted(startedAt: number, now: number, budgetMs = RESEARCH_BUDGET_MS): boolean {
  return now - startedAt >= budgetMs;
}

/** Thrown when the overall research wall-clock budget is consumed. */
export class ResearchBudgetExhaustedError extends Error {
  constructor(message = "research budget exhausted") {
    super(message);
    this.name = "ResearchBudgetExhaustedError";
  }
}

/**
 * One overall deadline for a whole research invocation. Every public HTTP call
 * in the pass takes `signal`, so an exhausted budget aborts in-flight requests
 * instead of leaving them running behind a Promise.race.
 */
export type ResearchDeadline = {
  signal: AbortSignal;
  startedAtMs: number;
  budgetMs: number;
  remainingMs: () => number;
  expired: () => boolean;
  assertLive: () => void;
  dispose: () => void;
};

/**
 * `parentSignal` is the CALLER's deadline (e.g. the ingest scheduler's ~8s
 * budget). It is combined with the pass's own cap so a scheduler abort is a
 * genuine cancellation of in-flight public HTTP, not an abandoned promise.
 */
export function createResearchDeadline(
  budgetMs: number = RESEARCH_BUDGET_MS,
  parentSignal?: AbortSignal,
): ResearchDeadline {
  const controller = new AbortController();
  const startedAtMs = Date.now();
  const timer = setTimeout(() => {
    controller.abort(new ResearchBudgetExhaustedError());
  }, budgetMs);
  const onParentAbort = (): void => controller.abort(new ResearchBudgetExhaustedError());
  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  const expired = (): boolean =>
    controller.signal.aborted ||
    parentSignal?.aborted === true ||
    budgetExhausted(startedAtMs, Date.now(), budgetMs);
  return {
    signal: controller.signal,
    startedAtMs,
    budgetMs,
    remainingMs: () => Math.max(0, budgetMs - (Date.now() - startedAtMs)),
    expired,
    assertLive: () => {
      if (expired()) {
        controller.abort(new ResearchBudgetExhaustedError());
        throw new ResearchBudgetExhaustedError();
      }
    },
    dispose: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

/** At most this many unresolved handles are resolved over the network per run. */
export const UNRESOLVED_RESOLUTIONS_PER_RUN = 1;

/**
 * Catch-up cadence used ONLY while an urgent research backlog remains: resolved
 * candidates that have never completed research, or whose persisted artifacts
 * are missing/mixed-version. Ordinary scored candidates deferred by the normal
 * oldest-first rotation never trigger it, so the steady state stays on the
 * 6-hour cadence. Nothing about request pacing/concurrency changes.
 */
export const URGENT_BACKLOG_CATCHUP_MS = 15 * 60_000;

/** Stable, human-readable marker persisted in the run detail string. */
export function formatUrgentBacklogMarker(remaining: number): string {
  return `Urgent backlog remaining: ${Math.max(0, Math.trunc(remaining))}.`;
}

/** Reads the urgent-backlog count back out of a persisted run detail string. */
export function parseUrgentBacklogRemaining(detail: string | null | undefined): number | null {
  if (!detail) return null;
  const match = /Urgent backlog remaining:\s*(\d+)\./.exec(detail);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Bounded, deterministic selection of unresolved candidates to resolve in one
 * invocation. Oldest-touched first (never-touched first), tie-break on handle,
 * so a failed attempt rotates to the back of the queue and the tail of the
 * unresolved list is never starved.
 */
export function selectUnresolvedForResolution<
  T extends { handle: string; wallet: string | null; updated_at?: string | null },
>(rows: readonly T[], limit: number = UNRESOLVED_RESOLUTIONS_PER_RUN): T[] {
  const rank = (r: T): number => {
    const t = r.updated_at ? new Date(r.updated_at).getTime() : NaN;
    return Number.isFinite(t) ? t : -1;
  };
  return rows
    .filter((r) => !r.wallet)
    .sort((a, b) => rank(a) - rank(b) || a.handle.localeCompare(b.handle))
    .slice(0, Math.max(0, limit));
}
