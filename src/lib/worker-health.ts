/**
 * Pure operational-health rules for the scheduled shadow workers.
 *
 * Two properties matter and are asserted by tests:
 *  1. A cycle that is abandoned (platform timeout / process kill) leaves
 *     state='running' with last_poll_at frozen. That MUST read as stale, never
 *     as healthy, even though lease acquisition keeps refreshing heartbeat_at.
 *  2. Work must be ordered oldest-completion-first, so a starved worker is the
 *     first one served on the next cycle instead of being cut off forever.
 */

export type WorkerRow = {
  id: string;
  state: string;
  heartbeat_at: string | null;
  last_poll_at: string | null;
  last_success_at: string | null;
  lease_expires_at: string | null;
  poll_failures: number;
};

/** A required worker must complete a cycle at least this often. */
export const WORKER_SUCCESS_WARN_SECONDS = 600;
export const WORKER_SUCCESS_FAIL_SECONDS = 1_800;

export function ageSecondsFrom(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((nowMs - ms) / 1000));
}

export type WorkerVerdict = {
  id: string;
  status: "PASS" | "WARN" | "FAIL";
  /** True when the row claims to be running but its lease has already lapsed. */
  abandoned: boolean;
  successAgeSeconds: number | null;
  reason: string;
};

/**
 * Freshness is judged on last_success_at / last_poll_at — the timestamps only a
 * COMPLETED cycle writes — not on heartbeat_at, which lease acquisition alone
 * refreshes and therefore cannot prove progress.
 */
export function classifyWorker(row: WorkerRow | undefined, nowMs: number): WorkerVerdict {
  if (!row) {
    return {
      id: "missing",
      status: "FAIL",
      abandoned: false,
      successAgeSeconds: null,
      reason: "No worker row recorded",
    };
  }
  const completed = row.last_success_at ?? row.last_poll_at;
  const age = ageSecondsFrom(completed, nowMs);
  const leaseLapsed =
    row.lease_expires_at === null || new Date(row.lease_expires_at).getTime() <= nowMs;
  const abandoned = row.state === "running" && leaseLapsed;

  if (age === null) {
    return {
      id: row.id,
      status: "FAIL",
      abandoned,
      successAgeSeconds: null,
      reason: "Never completed a cycle",
    };
  }
  const status =
    age > WORKER_SUCCESS_FAIL_SECONDS ? "FAIL" : age > WORKER_SUCCESS_WARN_SECONDS ? "WARN" : "PASS";
  const reason =
    status === "PASS"
      ? `Completed a cycle ${age}s ago`
      : `${abandoned ? "Abandoned cycle — " : ""}last completed cycle ${age}s ago`;
  return { id: row.id, status, abandoned, successAgeSeconds: age, reason };
}

/** Heartbeat age beyond which a worker's dashboard badge reads stale/unhealthy. */
export const WORKER_HEARTBEAT_STALE_SECONDS = 300;

/**
 * Dashboard badge health: judged on the CURRENT state and a fresh heartbeat,
 * never on last_error/poll_failures. Those two fields are diagnostic history
 * (surfaced separately in the dashboard's "Poll failures" row) and are
 * deliberately NOT cleared by a benign rate-limit cooldown deferral --
 * runExperimentCycle's host-cooldown skip releases the lease with
 * state:"idle" but leaves last_error/poll_failures untouched, since deferring
 * for an active cooldown is not itself a failure and no operation was
 * attempted or failed that cycle. Gating on a non-null last_error instead of
 * state made a fully idle, normally-heartbeating worker read as unhealthy for
 * as long as an old, already-resolved error string remained on the row.
 *
 * "error" (an unhandled cycle exception) and "stale" (an abandoned cycle
 * reclaimed by reclaimAbandonedWorkers) are the only states that represent a
 * current, unresolved failure; a genuine current error must still render
 * unhealthy.
 */
export function isWorkerHealthy(worker: {
  state: string | null;
  heartbeatAgeSeconds: number | null;
} | null | undefined): boolean {
  if (!worker) return false;
  const age = worker.heartbeatAgeSeconds ?? Number.POSITIVE_INFINITY;
  return age < WORKER_HEARTBEAT_STALE_SECONDS && worker.state !== "error" && worker.state !== "stale";
}

/** Worker rows that claim to be running while holding no live lease. */
export function findAbandonedWorkers(rows: WorkerRow[], nowMs: number): WorkerRow[] {
  return rows.filter((row) => classifyWorker(row, nowMs).abandoned);
}

/**
 * Deterministic starvation-free ordering: least-recently-completed first, with a
 * stable name tiebreak so equal-age workers keep a fixed order.
 */
export function orderByStaleness<T extends { name: string }>(
  items: T[],
  lastCompletedMsFor: (item: T) => number | null,
): T[] {
  return [...items].sort((a, b) => {
    const av = lastCompletedMsFor(a);
    const bv = lastCompletedMsFor(b);
    if (av === bv) return a.name.localeCompare(b.name);
    if (av === null) return -1;
    if (bv === null) return 1;
    return av - bv;
  });
}
