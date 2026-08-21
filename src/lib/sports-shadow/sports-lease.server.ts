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
  /**
   * Task 12F / P1-G: atomic renewal via renew_sports_shadow_lease (see
   * supabase/migrations/20260822020000_sports_shadow_lease_renewal.sql) — extends the
   * SAME lease (same id/worker_id/fence) from the database's own `now()`, ONLY while it
   * is still the current, non-expired owner. Returns false (never throws to the caller of
   * `renewSportsLease` below) the moment this worker is no longer provably the owner —
   * expired, or superseded by a newer fence/worker — which is the ordinary "lease lost"
   * outcome, not an exceptional one.
   */
  renew(lease: SportsLease, leaseSeconds: number): Promise<boolean>;
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

  async renew(lease, leaseSeconds) {
    const { data, error } = await supabaseAdmin.rpc("renew_sports_shadow_lease" as never, {
      p_id: lease.lockId,
      p_worker_id: lease.workerId,
      p_fence: lease.fence,
      p_lease_seconds: leaseSeconds,
    } as never);
    if (error) throw new Error(error.message);
    return data === true;
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

/**
 * Fails CLOSED to `false` (lease lost) on any RPC error — a renewal-coordination hiccup
 * must never be silently treated as "still renewed," exactly like acquireSportsLease
 * fails closed to null rather than assuming ownership.
 */
export async function renewSportsLease(
  lease: SportsLease,
  leaseSeconds: number,
  repo: SportsLeaseRepository = supabaseSportsLeaseRepository,
): Promise<boolean> {
  try {
    return await repo.renew(lease, leaseSeconds);
  } catch {
    return false;
  }
}

/**
 * ============================== TASK 12F / P1-G: COOPERATIVE LEASE CHECKPOINTS ==============================
 * A single source/matching cycle can perform far longer sequential work than
 * SOURCE_LEASE_TTL_SECONDS (60s): up to 41 trade-page fetches at up to 12s each, up to
 * 500 Gamma metadata fetches at up to 10s each, then independent PM-US/Kalshi discovery
 * pagination at up to 12s per page. `LeaseCheckpoint` is a zero-timer, work-driven
 * renewal primitive: the bounded work itself calls it between iterations (never a
 * background setInterval/heartbeat), and it renews the underlying lease only often
 * enough to stay safely ahead of expiry.
 *
 * RENEWAL MARGIN MATH: the longest single network operation anywhere in the source lane
 * between two checkpoint calls is 12_000ms (pmus.server.ts/kalshi.server.ts's
 * pacedGetJson REQUEST_TIMEOUT_MS, and source-poll.server.ts's own trade-page
 * REQUEST_TIMEOUT_MS — source-metadata.server.ts's Gamma fetch is smaller, at 10_000ms).
 * LEASE_RENEWAL_MARGIN_MS=20_000 means a checkpoint call is a cheap in-memory freshness
 * check (no DB round trip) until 20s have elapsed since the lease was last (re)newed; the
 * FIRST checkpoint call after that 20s mark performs a real renewal RPC. Worst case: the
 * margin ticks over to "due" the instant a checkpoint call has just decided NOT to renew
 * (because elapsed was still <20s), so one more full 12s await elapses before the NEXT
 * checkpoint call (at the top of the following loop iteration) actually renews — a
 * worst-case unrenewed span of 20_000 + 12_000 = 32_000ms, still comfortably inside the
 * 60_000ms TTL with a ~28s (~47%) safety margin. If that renewal RPC itself then fails
 * (network hiccup, or the lease has genuinely been superseded), the checkpoint returns
 * false immediately — fail closed, never silently continues.
 * ================================================================================
 */
export const LEASE_RENEWAL_MARGIN_MS = 20_000;

/**
 * Returns true while ownership is still (or was just re-)confirmed; false the FIRST time
 * renewal fails, and STICKY false forever after (a superseded/expired lease can never
 * become valid again, so there is no point re-attempting the RPC on every subsequent
 * call — this also keeps renewal calls bounded rather than hammering the DB once lost).
 */
export type LeaseCheckpoint = () => Promise<boolean>;

/** Always reports the lease as valid — the safe default for any deps bag/test that isn't exercising lease-loss behavior. */
export const NO_OP_LEASE_CHECKPOINT: LeaseCheckpoint = async () => true;

export function createLeaseCheckpoint(
  lease: SportsLease,
  leaseSeconds: number,
  repo: SportsLeaseRepository = supabaseSportsLeaseRepository,
  now: () => number = () => Date.now(),
  renewalMarginMs: number = LEASE_RENEWAL_MARGIN_MS,
): LeaseCheckpoint {
  let lastRenewedAtMs = now();
  let lost = false;
  return async () => {
    if (lost) return false;
    if (now() - lastRenewedAtMs < renewalMarginMs) return true;
    const ok = await renewSportsLease(lease, leaseSeconds, repo);
    if (!ok) {
      lost = true;
      return false;
    }
    lastRenewedAtMs = now();
    return true;
  };
}
