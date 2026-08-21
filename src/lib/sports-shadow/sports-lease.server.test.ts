import { describe, expect, it } from "vitest";
import { acquireSportsLease, releaseSportsLease, type SportsLeaseRepository } from "./sports-lease.server";

/**
 * Mirrors the real acquire_worker_lease RPC's own CAS semantics exactly (see
 * supabase/migrations/20260809150500_prevent_same_worker_lease_preemption.sql): a row is
 * claimable when it has no owner yet, OR its lease has expired -- NEVER merely because
 * the caller asks nicely. release() only succeeds (mutates state) when lockId+fence+
 * workerId ALL match the current row, exactly like the real CAS-guarded UPDATE.
 */
function makeFakeLeaseRepo() {
  const rows = new Map<string, { workerId: string; fence: number; leaseExpiresAtMs: number; state: string }>();
  let nowMs = 1_700_000_000_000;
  const setNow = (ms: number) => {
    nowMs = ms;
  };

  const repo: SportsLeaseRepository = {
    async acquire(lockId, workerId, leaseSeconds) {
      const existing = rows.get(lockId);
      const claimable = !existing || existing.leaseExpiresAtMs <= nowMs;
      if (!claimable) return null;
      const fence = (existing?.fence ?? 0) + 1;
      rows.set(lockId, { workerId, fence, leaseExpiresAtMs: nowMs + leaseSeconds * 1000, state: "running" });
      return fence;
    },
    async release(lease, patch) {
      const existing = rows.get(lease.lockId);
      if (!existing) return;
      if (existing.fence !== lease.fence || existing.workerId !== lease.workerId) return; // stale owner: no-op
      rows.set(lease.lockId, { ...existing, leaseExpiresAtMs: nowMs, state: patch.state });
    },
  };

  return { repo, rows, setNow, nowMs: () => nowMs };
}

describe("acquireSportsLease / releaseSportsLease", () => {
  it("first acquire on a brand-new lock id succeeds with fence 1", async () => {
    const { repo } = makeFakeLeaseRepo();
    const lease = await acquireSportsLease("sports_shadow_observations", "worker-a", 90, repo);
    expect(lease).toEqual({ lockId: "sports_shadow_observations", workerId: "worker-a", fence: 1 });
  });

  it("a second overlapping acquire attempt while the first is still live is rejected (returns null)", async () => {
    const { repo } = makeFakeLeaseRepo();
    const first = await acquireSportsLease("sports_shadow_source", "worker-a", 60, repo);
    const second = await acquireSportsLease("sports_shadow_source", "worker-b", 60, repo);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("a released lease is immediately re-acquirable by a different worker", async () => {
    const { repo } = makeFakeLeaseRepo();
    const first = await acquireSportsLease("sports_shadow_source", "worker-a", 60, repo);
    await releaseSportsLease(first!, { state: "idle", lastError: null }, repo);
    const second = await acquireSportsLease("sports_shadow_source", "worker-b", 60, repo);
    expect(second).not.toBeNull();
    expect(second?.fence).toBe(2);
  });

  it("a stale (fenced-out) owner's release cannot clobber a newer owner's lease", async () => {
    const { repo, setNow } = makeFakeLeaseRepo();
    const stale = await acquireSportsLease("sports_shadow_source", "worker-a", 1, repo); // 1s TTL
    setNow(1_700_000_002_000); // 2s later: expired
    const fresh = await acquireSportsLease("sports_shadow_source", "worker-b", 60, repo);
    expect(fresh).not.toBeNull();

    // The stale owner's release call must be a no-op against the now-newer fenced owner.
    await releaseSportsLease(stale!, { state: "idle", lastError: null }, repo);
    const thirdAttempt = await acquireSportsLease("sports_shadow_source", "worker-c", 60, repo);
    expect(thirdAttempt).toBeNull(); // worker-b's lease is still held -- worker-a's stale release did not free it
  });

  it("two independent lock ids never contend with each other", async () => {
    const { repo } = makeFakeLeaseRepo();
    const observationLease = await acquireSportsLease("sports_shadow_observations", "worker-a", 90, repo);
    const sourceLease = await acquireSportsLease("sports_shadow_source", "worker-a", 60, repo);
    expect(observationLease).not.toBeNull();
    expect(sourceLease).not.toBeNull();
  });

  it("acquireSportsLease fails closed to null (never throws) when the repository itself throws", async () => {
    const throwingRepo: SportsLeaseRepository = {
      acquire: async () => {
        throw new Error("rpc unavailable");
      },
      release: async () => {},
    };
    await expect(acquireSportsLease("sports_shadow_source", "worker-a", 60, throwingRepo)).resolves.toBeNull();
  });

  it("releaseSportsLease never throws even when the repository release itself throws", async () => {
    const throwingRepo: SportsLeaseRepository = {
      acquire: async () => 1,
      release: async () => {
        throw new Error("update failed");
      },
    };
    await expect(releaseSportsLease({ lockId: "x", workerId: "w", fence: 1 }, { state: "idle", lastError: null }, throwingRepo)).resolves.toBeUndefined();
  });
});
