-- Task 12F / P1-G: the source lease can expire while a wallet poll is still running.
--
-- ROOT CAUSE: acquire_worker_lease's fixed SOURCE_LEASE_TTL_SECONDS (60s) is acquired
-- ONCE at the start of a source/matching cycle and never renewed. A single cycle can
-- perform far longer sequential work than that: up to MAX_PAGES_PER_WALLET (41) trade
-- page fetches at up to 12s each, up to MAX_PENDING_FILLS_PER_POLL (500) Gamma metadata
-- fetches at up to 10s each, then independent PM-US/Kalshi discovery pagination (up to
-- 12s per page). If the lease expires while the original worker is still running,
-- acquire_worker_lease lets a LATER invocation take over with a newer fence -- and Task
-- 12D's crash-safety argument for insert_sports_shadow_episode/update_sports_shadow_episode
-- explicitly depends on wallet polling being serialized by this exact lease. Two workers
-- concurrently reading the same stale episode snapshot and both writing could
-- double-aggregate a fill's contribution.
--
-- Note that acquire_worker_lease itself CANNOT be reused for renewal:
-- 20260809150500_prevent_same_worker_lease_preemption.sql deliberately made its WHERE
-- clause exclude an still-active lease (lease_expires_at <= now() required to match) for
-- the SAME worker_id, specifically to stop a worker self-preempting its own in-flight
-- cycle by re-acquiring (which would bump the fence and desynchronize any caller still
-- holding the OLD fence value). Renewal needs the opposite: extend the CURRENT owner's
-- CURRENT fence in place, without bumping it, and ONLY while it is still the current,
-- non-expired owner.
--
-- renew_sports_shadow_lease is intentionally the smallest possible addition: one atomic
-- UPDATE, guarded by id + worker_id + fence + "not yet expired" (all in one WHERE clause,
-- using the database's own `now()` for the expiry check, never a client-supplied
-- timestamp), extending lease_expires_at from that same `now()`. It returns a plain
-- boolean (true = renewed, false = lease already lost -- expired, or a newer fence/worker
-- has since taken over) rather than throwing, so a caller's cooperative checkpoint (see
-- sports-lease.server.ts's createLeaseCheckpoint) can treat "false" as an ordinary,
-- expected outcome to check on every call, not an exceptional one to catch.
--
-- Cannot revive an already-expired lease (lease_expires_at > now() is a hard predicate --
-- once true, the row simply does not match and 0 rows are updated) and cannot renew after
-- a newer owner/fence has acquired (fence must match exactly; fence only ever increases,
-- via acquire_worker_lease, never decreases or resets here).
--
-- acquire_worker_lease itself is intentionally left completely unmodified.
CREATE OR REPLACE FUNCTION public.renew_sports_shadow_lease(
  p_id text,
  p_worker_id text,
  p_fence integer,
  p_lease_seconds integer
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH renewed AS (
    UPDATE public.worker_status
    SET
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      updated_at = now()
    WHERE
      id = p_id
      AND worker_id = p_worker_id
      AND fence = p_fence
      AND lease_expires_at > now()
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM renewed);
$$;

REVOKE ALL ON FUNCTION public.renew_sports_shadow_lease(text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_sports_shadow_lease(text, text, integer, integer) TO service_role;
