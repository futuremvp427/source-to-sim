/**
 * Sports Forward Shadow worker leases — Task-11-local, SERVER only.
 *
 * Reuses the EXISTING generic `acquire_worker_lease` SQL RPC and `worker_status` table
 * (see supabase/migrations/20260807222552_..., .../20260809150500_...) exactly as-is —
 * no migration needed: `worker_status.id` is already a free-text primary key with
 * insert-if-missing-else-CAS-update semantics, so a brand-new lock id is provisioned by
 * the RPC's own `ON CONFLICT ... DO UPDATE` the first time it's ever acquired.
 *
 * Deliberately NOT shadow.server.ts's `acquireLease`/`releaseLease`: that pair hard-codes
 * a single 180s `LEASE_SECONDS` sized for the general ingest cycle, with no way for a
 * caller to choose a different TTL. This module is a thin, independently-testable
 * wrapper around the SAME atomic RPC and CAS-guarded release UPDATE, with caller-chosen
 * lease seconds — sized per lane (see worker.server.ts's OBSERVATION/SOURCE TTL
 * constants), not refactored out of the mature general shadow lease for aesthetics.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type SportsLease = { lockId: string; workerId: string; fence: number };

export type SportsLeaseRepository = {
  /** Atomic acquire via the RPC. Returns the new fence, or null when another still-live worker holds the lease. */
  acquire(lockId: string, workerId: string, leaseSeconds: number): Promise<number | null>;
  /**
   * CAS release guarded by lockId + fence + workerId (mirrors shadow.server.ts's
   * releaseLease exactly): a stale/superseded owner's release is a harmless no-op, never
   * able to clobber a newer fenced owner. Sets lease_expires_at to now() so the lock is
   * immediately available again — no lingering TTL tail after a clean release.
   */
  release(lease: SportsLease, patch: { state: string; lastError: string | null }): Promise<void>;
};

export const supabaseSportsLeaseRepository: SportsLeaseRepository = {
  async acquire(lockId, workerId, leaseSeconds) {
    const { data, error } = await supabaseAdmin.rpc("acquire_worker_lease", {
      p_id: lockId,
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw new Error(error.message);
    return typeof data === "number" ? data : null;
  },

  async release(lease, patch) {
    const nowIso = new Date().toISOString();
    await supabaseAdmin
      .from("worker_status")
      .update({
        state: patch.state,
        last_error: patch.lastError,
        heartbeat_at: nowIso,
        last_poll_at: nowIso,
        lease_expires_at: nowIso,
        updated_at: nowIso,
      } as never)
      .eq("id", lease.lockId)
      .eq("fence", lease.fence)
      .eq("worker_id", lease.workerId);
  },
};

/**
 * Acquires `lockId` for `workerId`, bounded to `leaseSeconds`. Fails CLOSED to null (never
 * throws to the caller) on any RPC error, so a lease-coordination hiccup always reads as
 * "someone else might hold it, skip this lane this cycle" rather than crashing the whole
 * orchestrator cycle.
 */
export async function acquireSportsLease(
  lockId: string,
  workerId: string,
  leaseSeconds: number,
  repo: SportsLeaseRepository = supabaseSportsLeaseRepository,
): Promise<SportsLease | null> {
  try {
    const fence = await repo.acquire(lockId, workerId, leaseSeconds);
    if (fence === null) return null;
    return { lockId, workerId, fence };
  } catch {
    return null;
  }
}

/** Best-effort release — never throws (a release failure just leaves the lease to expire naturally at its TTL). */
export async function releaseSportsLease(
  lease: SportsLease,
  patch: { state: string; lastError: string | null },
  repo: SportsLeaseRepository = supabaseSportsLeaseRepository,
): Promise<void> {
  try {
    await repo.release(lease, patch);
  } catch {
    // Best-effort: the lease's own leaseSeconds TTL is the backstop.
  }
}
