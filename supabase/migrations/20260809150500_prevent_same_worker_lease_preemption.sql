-- Prevent overlapping cron invocations from invalidating an in-flight cycle.
--
-- Previous behavior allowed the same worker_id to reacquire an unexpired lease,
-- bumping the fence every minute. When a cycle lasted longer than the cron
-- cadence, the next invocation could self-preempt it and create a livelock:
-- heartbeat_at advanced while last_poll_at/last_success_at never completed.
--
-- An active lease is now exclusive regardless of worker_id. A later invocation
-- may acquire only after the current owner releases the lease or it actually
-- expires. Fence takeover semantics remain unchanged.
CREATE OR REPLACE FUNCTION public.acquire_worker_lease(
  p_id text,
  p_worker_id text,
  p_lease_seconds integer
)
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.worker_status (
    id, worker_id, fence, state, heartbeat_at, lease_expires_at, updated_at
  )
  VALUES (
    p_id, p_worker_id, 1, 'running', now(),
    now() + make_interval(secs => p_lease_seconds), now()
  )
  ON CONFLICT (id) DO UPDATE
  SET
    worker_id = p_worker_id,
    fence = public.worker_status.fence + 1,
    state = 'running',
    heartbeat_at = now(),
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    updated_at = now()
  WHERE
    public.worker_status.worker_id IS NULL
    OR public.worker_status.lease_expires_at IS NULL
    OR public.worker_status.lease_expires_at <= now()
  RETURNING fence;
$$;

REVOKE ALL ON FUNCTION public.acquire_worker_lease(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acquire_worker_lease(text, text, integer) TO service_role;
