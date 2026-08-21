import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  acquireSportsLease,
  createLeaseCheckpoint,
  releaseSportsLease,
  renewSportsLease,
  type SportsLeaseRepository,
} from "./sports-lease.server";

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
    /** Mirrors renew_sports_shadow_lease's exact predicate (id + worker_id + fence + not-yet-expired, all via the SAME atomic WHERE clause). */
    async renew(lease, leaseSeconds) {
      const existing = rows.get(lease.lockId);
      if (!existing) return false;
      if (existing.fence !== lease.fence || existing.workerId !== lease.workerId) return false; // superseded by a newer owner/fence
      if (existing.leaseExpiresAtMs <= nowMs) return false; // already expired -- cannot revive
      rows.set(lease.lockId, { ...existing, leaseExpiresAtMs: nowMs + leaseSeconds * 1000 });
      return true;
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
      renew: async () => false,
    };
    await expect(acquireSportsLease("sports_shadow_source", "worker-a", 60, throwingRepo)).resolves.toBeNull();
  });

  it("releaseSportsLease never throws even when the repository release itself throws", async () => {
    const throwingRepo: SportsLeaseRepository = {
      acquire: async () => 1,
      release: async () => {
        throw new Error("update failed");
      },
      renew: async () => false,
    };
    await expect(releaseSportsLease({ lockId: "x", workerId: "w", fence: 1 }, { state: "idle", lastError: null }, throwingRepo)).resolves.toBeUndefined();
  });
});

/**
 * Task 12F / P1-G: renew_sports_shadow_lease semantics, proven against the SAME
 * migration-mirroring fake repo used above -- G2/G3/G4/G5 from the mission's required
 * lease tests.
 */
describe("renewSportsLease — G2/G3/G4/G5", () => {
  it("G2: a renewal with the current id/worker/fence before expiry succeeds and extends the TTL", async () => {
    const { repo, setNow } = makeFakeLeaseRepo();
    const lease = await acquireSportsLease("sports_shadow_source", "worker-a", 60, repo); // expires at +60s
    setNow(1_700_000_030_000); // 30s later, still well before expiry
    const ok = await renewSportsLease(lease!, 60, repo);
    expect(ok).toBe(true);
    // Renewed for another 60s FROM the renewal time (30s in) -- expiry should now be far
    // past the ORIGINAL 60s mark, provable by acquiring again right at the original
    // expiry instant and confirming it's still rejected.
    setNow(1_700_000_061_000); // 1s past the ORIGINAL 60s boundary
    const stillHeld = await acquireSportsLease("sports_shadow_source", "worker-b", 60, repo);
    expect(stillHeld).toBeNull();
  });

  it("G3: a renewal after the lease has already expired fails rather than resurrecting it", async () => {
    const { repo, setNow } = makeFakeLeaseRepo();
    const lease = await acquireSportsLease("sports_shadow_source", "worker-a", 1, repo); // 1s TTL
    setNow(1_700_000_002_000); // 2s later: genuinely expired
    const ok = await renewSportsLease(lease!, 60, repo);
    expect(ok).toBe(false);
    // Confirm the lease is truly available to a new owner -- the failed renewal did not
    // leave it in some half-revived state.
    const fresh = await acquireSportsLease("sports_shadow_source", "worker-b", 60, repo);
    expect(fresh).not.toBeNull();
  });

  it("G4: after another worker acquires a newer fence, the OLD worker's renewal fails", async () => {
    const { repo, setNow } = makeFakeLeaseRepo();
    const stale = await acquireSportsLease("sports_shadow_source", "worker-a", 1, repo);
    setNow(1_700_000_002_000);
    const fresh = await acquireSportsLease("sports_shadow_source", "worker-b", 60, repo);
    expect(fresh).not.toBeNull();
    expect(fresh?.fence).toBeGreaterThan(stale!.fence);

    const staleRenewal = await renewSportsLease(stale!, 60, repo);
    expect(staleRenewal).toBe(false);
  });

  it("G5: a stale owner's renewal after a fence change cannot clobber the new owner's lease", async () => {
    const { repo, setNow } = makeFakeLeaseRepo();
    const stale = await acquireSportsLease("sports_shadow_source", "worker-a", 1, repo);
    setNow(1_700_000_002_000);
    await acquireSportsLease("sports_shadow_source", "worker-b", 60, repo);

    await renewSportsLease(stale!, 60, repo); // no-op, per G4
    const thirdAttempt = await acquireSportsLease("sports_shadow_source", "worker-c", 60, repo);
    expect(thirdAttempt).toBeNull(); // worker-b's lease is still held -- worker-a's stale renewal did not free or extend it
  });

  it("renewSportsLease fails closed to false (never throws) when the repository itself throws", async () => {
    const throwingRepo: SportsLeaseRepository = {
      acquire: async () => 1,
      release: async () => {},
      renew: async () => {
        throw new Error("rpc unavailable");
      },
    };
    await expect(renewSportsLease({ lockId: "x", workerId: "w", fence: 1 }, 60, throwingRepo)).resolves.toBe(false);
  });
});

/**
 * Task 12F / P1-G: createLeaseCheckpoint's cooperative, work-driven, zero-timer renewal
 * primitive -- G1, G6 (via the "sticky lost" property), and the "no daemon" requirement
 * (G10, provable here by construction: nothing in this module ever calls
 * setInterval/setTimeout for renewal -- see the module's own doc comment).
 */
describe("createLeaseCheckpoint", () => {
  it("does not call renew at all before the margin has elapsed (cheap in-memory freshness check)", async () => {
    const { repo, setNow } = makeFakeLeaseRepo();
    const lease = await acquireSportsLease("sports_shadow_source", "worker-a", 60, repo);
    const renewSpy = vi.spyOn(repo, "renew");
    let now = 1_700_000_000_000;
    const checkpoint = createLeaseCheckpoint(lease!, 60, repo, () => now, 20_000);

    setNow(1_700_000_005_000);
    now = 1_700_000_005_000; // 5s elapsed, well under the 20s margin
    const ok = await checkpoint();
    expect(ok).toBe(true);
    expect(renewSpy).not.toHaveBeenCalled();
  });

  it("attempts a real renewal once the margin has elapsed", async () => {
    const { repo, setNow } = makeFakeLeaseRepo();
    const lease = await acquireSportsLease("sports_shadow_source", "worker-a", 60, repo);
    const renewSpy = vi.spyOn(repo, "renew");
    let now = 1_700_000_000_000;
    const checkpoint = createLeaseCheckpoint(lease!, 60, repo, () => now, 20_000);

    setNow(1_700_000_025_000);
    now = 1_700_000_025_000; // 25s elapsed -- past the 20s margin
    const ok = await checkpoint();
    expect(ok).toBe(true);
    expect(renewSpy).toHaveBeenCalledTimes(1);
  });

  it("G1: repeated checkpoints across simulated work lasting well past the original TTL keep the SAME worker's ownership alive, and a second worker cannot acquire meanwhile", async () => {
    const { repo, setNow } = makeFakeLeaseRepo();
    const lease = await acquireSportsLease("sports_shadow_source", "worker-a", 60, repo); // 60s TTL
    let now = 1_700_000_000_000;
    const checkpoint = createLeaseCheckpoint(lease!, 60, repo, () => now, 20_000);

    // Simulate work lasting 150s (well past the original 60s TTL) in 12s steps (matching
    // the real worst-case single network op), checkpointing before each step.
    for (let elapsed = 0; elapsed <= 150_000; elapsed += 12_000) {
      now = 1_700_000_000_000 + elapsed;
      setNow(now);
      const ok = await checkpoint();
      expect(ok).toBe(true);
      // A second worker must never be able to acquire while the first is still being
      // kept alive by successful renewals.
      const contender = await acquireSportsLease("sports_shadow_source", "worker-b", 60, repo);
      expect(contender).toBeNull();
    }
  });

  it("a renewal failure is treated as lease lost -- sticky false forever after, never re-attempting the RPC", async () => {
    let renewCalls = 0;
    const repo: SportsLeaseRepository = {
      acquire: async () => 1,
      release: async () => {},
      renew: async () => {
        renewCalls += 1;
        return false; // superseded/expired
      },
    };
    let now = 1_700_000_000_000;
    const checkpoint = createLeaseCheckpoint({ lockId: "sports_shadow_source", workerId: "worker-a", fence: 1 }, 60, repo, () => now, 20_000);

    now = 1_700_000_025_000;
    const first = await checkpoint();
    expect(first).toBe(false);
    expect(renewCalls).toBe(1);

    // Further checkpoint calls, even well past the margin again, must NOT re-attempt the
    // RPC -- a superseded/expired lease can never become valid again.
    now = 1_700_000_100_000;
    const second = await checkpoint();
    expect(second).toBe(false);
    expect(renewCalls).toBe(1);
  });

  it("does not use setInterval/setTimeout anywhere in its own module source (no daemon/background heartbeat)", () => {
    const source = readFileSync(join(__dirname, "sports-lease.server.ts"), "utf8");
    expect(source).not.toMatch(/setInterval\s*\(/);
    // setTimeout is used elsewhere in this codebase for request pacing, but never inside
    // this module -- it has none at all.
    expect(source).not.toMatch(/setTimeout\s*\(/);
  });
});
