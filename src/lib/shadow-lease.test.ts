import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Deterministic lease regression tests.
 *
 * The fake below executes the SAME predicate the SQL statement uses, but the
 * important property under test is that `acquireLease` performs exactly ONE
 * database call (the RPC) and makes no application-side availability decision.
 * `calls` therefore asserts there is no SELECT-before-UPDATE.
 */

type Row = {
  worker_id: string | null;
  fence: number;
  lease_expires_at: number | null;
  last_poll_events_inserted?: number;
};

const state: { row: Row | null; now: number; calls: string[] } = {
  row: null,
  now: 1_000_000,
  calls: [],
};

/** Emulates the atomic INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING fence */
function atomicAcquire(workerId: string, leaseSeconds: number): number | null {
  if (state.row === null) {
    state.row = {
      worker_id: workerId,
      fence: 1,
      lease_expires_at: state.now + leaseSeconds * 1000,
    };
    return 1;
  }
  // An active lease is exclusive even to the same worker_id. This prevents a
  // later cron invocation with the same stable worker name from bumping the
  // fence and invalidating the still-running prior cycle.
  const free =
    state.row.worker_id === null ||
    state.row.lease_expires_at === null ||
    state.row.lease_expires_at <= state.now;
  if (!free) return null;
  state.row.worker_id = workerId;
  state.row.fence += 1;
  state.row.lease_expires_at = state.now + leaseSeconds * 1000;
  return state.row.fence;
}

const updateFilters: Record<string, unknown>[] = [];
const updatePatches: Record<string, unknown>[] = [];

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.calls.push(`rpc:${name}`);
      const fence = atomicAcquire(
        args["p_worker_id"] as string,
        args["p_lease_seconds"] as number,
      );
      return { data: fence, error: null };
    },
    from: (table: string) => {
      state.calls.push(`from:${table}`);
      const filters: Record<string, unknown> = {};
      let patch: Record<string, unknown> = {};
      const chain = {
        update: (p: Record<string, unknown>) => {
          patch = p;
          return chain;
        },
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return chain;
        },
        select: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (v: unknown) => unknown) => {
          updateFilters.push(filters);
          updatePatches.push(patch);
          // Only the true owner (id + fence + worker_id) may write.
          if (
            state.row &&
            filters["fence"] === state.row.fence &&
            filters["worker_id"] === state.row.worker_id
          ) {
            state.row.lease_expires_at = state.now;
            if (typeof patch["last_poll_events_inserted"] === "number") {
              state.row.last_poll_events_inserted = patch["last_poll_events_inserted"] as number;
            }
          }
          return Promise.resolve(resolve({ data: null, error: null }));
        },
      };
      return chain;
    },
  },
}));

const { acquireLease, releaseLeaseForTest, LEASE_SECONDS_FOR_TEST } = await import(
  "./shadow.server"
);

beforeEach(() => {
  state.row = null;
  state.now = 1_000_000;
  state.calls = [];
  updateFilters.length = 0;
  updatePatches.length = 0;
});

describe("atomic lease acquisition", () => {
  it("makes exactly one database call and no read-before-write", async () => {
    await acquireLease("A");
    expect(state.calls).toEqual(["rpc:acquire_worker_lease"]);
  });

  it("only one of two concurrent acquirers wins; the loser gets null", async () => {
    const [a, b] = await Promise.all([acquireLease("A"), acquireLease("B")]);
    const winners = [a, b].filter((l) => l !== null);
    const losers = [a, b].filter((l) => l === null);
    expect(winners).toHaveLength(1);
    expect(losers).toEqual([null]);
    expect(winners[0]!.fence).toBe(1);
  });

  it("a live lease blocks a different worker", async () => {
    expect(await acquireLease("A")).toEqual({ fence: 1, workerId: "A", lockId: "ingest" });
    expect(await acquireLease("B")).toBeNull();
  });

  it("a live lease also blocks the same worker from self-preempting", async () => {
    expect(await acquireLease("A")).toEqual({ fence: 1, workerId: "A", lockId: "ingest" });
    expect(await acquireLease("A")).toBeNull();
    expect(state.row!.fence).toBe(1);
  });

  it("B takes over a stale lease with fence N+1", async () => {
    const a = await acquireLease("A");
    expect(a!.fence).toBe(1);
    state.now += (LEASE_SECONDS_FOR_TEST + 1) * 1000; // A goes stale
    const b = await acquireLease("B");
    expect(b).toEqual({ fence: 2, workerId: "B", lockId: "ingest" });
  });

  it("the same worker can acquire again after the prior lease is released", async () => {
    const a = (await acquireLease("A"))!;
    await releaseLeaseForTest(a, { state: "idle" });
    const next = await acquireLease("A");
    expect(next).toEqual({ fence: 2, workerId: "A", lockId: "ingest" });
  });

  it("a stale owner cannot release or overwrite the new owner's lease", async () => {
    const a = (await acquireLease("A"))!;
    state.now += (LEASE_SECONDS_FOR_TEST + 1) * 1000;
    const b = (await acquireLease("B"))!;

    await releaseLeaseForTest(a, { state: "idle" });
    // B's lease is untouched: fence and owner unchanged.
    expect(state.row!.fence).toBe(b.fence);
    expect(state.row!.worker_id).toBe("B");
    expect(updateFilters.at(-1)).toMatchObject({ fence: a.fence, worker_id: "A" });

    // The real owner can release.
    await releaseLeaseForTest(b, { state: "idle" });
    expect(state.row!.lease_expires_at).toBe(state.now);
  });
});

describe("last_poll_events_inserted telemetry (Finding K)", () => {
  it("a successful cycle that persisted N events records last_poll_events_inserted = N", async () => {
    const a = (await acquireLease("A"))!;
    await releaseLeaseForTest(a, { state: "idle", last_poll_events_inserted: 7 });
    expect(state.row!.last_poll_events_inserted).toBe(7);
  });

  it("a later completed poll that inserted 0 overwrites the previous count, not preserves it", async () => {
    const a = (await acquireLease("A"))!;
    await releaseLeaseForTest(a, { state: "idle", last_poll_events_inserted: 7 });
    expect(state.row!.last_poll_events_inserted).toBe(7);

    const b = (await acquireLease("A"))!;
    await releaseLeaseForTest(b, { state: "idle", last_poll_events_inserted: 0 });
    expect(state.row!.last_poll_events_inserted).toBe(0);
  });

  it("a cycle that persisted N events but failed in a later stage still records N on the error release", async () => {
    const a = (await acquireLease("A"))!;
    await releaseLeaseForTest(a, { state: "error", last_error: "mark refresh failed", last_poll_events_inserted: 7 });
    expect(state.row!.last_poll_events_inserted).toBe(7);
  });

  it("a cycle that failed before a successful persist records 0 on the error release", async () => {
    const a = (await acquireLease("A"))!;
    await releaseLeaseForTest(a, { state: "error", last_error: "source fetch failed", last_poll_events_inserted: 0 });
    expect(state.row!.last_poll_events_inserted).toBe(0);
  });

  it("a stale owner cannot overwrite the new owner's telemetry either", async () => {
    const a = (await acquireLease("A"))!;
    await releaseLeaseForTest(a, { state: "idle", last_poll_events_inserted: 7 });
    // A's lease is now released (lease_expires_at = state.now), so a fresh
    // acquire by B succeeds and bumps the fence without needing staleness.
    const b = (await acquireLease("B"))!;
    await releaseLeaseForTest(b, { state: "idle", last_poll_events_inserted: 3 });
    expect(state.row!.last_poll_events_inserted).toBe(3);

    // A tries to release again with its now-stale fence; must not overwrite B's telemetry.
    await releaseLeaseForTest(a, { state: "idle", last_poll_events_inserted: 999 });
    expect(state.row!.last_poll_events_inserted).toBe(3);
  });
});
