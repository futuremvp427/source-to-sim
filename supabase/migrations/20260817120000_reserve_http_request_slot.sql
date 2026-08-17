-- Atomic pre-request pacing reservation for data-api.polymarket.com.
--
-- Phase 2 (20260815160000_http_rate_limit_cooldown.sql) gave ingestion a
-- durable, cross-tick cooldown -- but it is purely REACTIVE: every caller
-- reads blocked_until, and if it is not currently in the future, proceeds
-- straight to the real upstream fetch. That read-then-act gap is exactly
-- the race a fresh production incident (2026-08-17) proved is still open:
-- EXPERIMENT_CONCURRENCY (2) runs experiments through Promise.allSettled,
-- so two sibling experiments (and, independently, General Shadow's
-- /activity path and candidate research's own /trades path) can call
-- getHostCooldown() within microseconds of each other, both observe
-- blocked=false because no 429 has happened YET, and both then fire real
-- upstream requests at the same instant -- reproducing the burst the
-- cooldown exists to prevent, before either request's own outcome has had
-- a chance to teach the cooldown anything. Overlapping scheduler/serverless
-- invocations widen the same window further; an in-process mutex cannot
-- close it because it has no visibility across processes.
--
-- This migration adds a second, complementary mechanism: an atomic
-- reservation queue, keyed by the same one-row-per-host table, that every
-- caller must claim immediately before (and only before) issuing an actual
-- upstream network request -- never for a cache hit, and never at cycle
-- start where the existing blocked_until fast-path check still lives
-- unchanged. reserve_http_request_slot() hands back the timestamp the
-- caller is allowed to proceed at; concurrent callers racing the same
-- statement are serialized by Postgres's own row-level locking (the same
-- GREATEST-upsert shape already used by record_http_rate_limit and
-- acquire_worker_lease), so two callers can never both be told "now."
--
-- Never touches blocked_until, paper accounting, checkpoints, bankrolls,
-- settlements, or live-trading state -- this purely paces outbound HTTP.
ALTER TABLE public.http_rate_limits
  ADD COLUMN IF NOT EXISTS next_request_at timestamptz;

-- Atomically claims the next available pacing slot for a host and returns
-- when the caller may actually issue its request. Every call (whether it
-- inserts the host's first-ever row or updates an existing one) advances
-- next_request_at by p_min_interval_ms for the NEXT caller and returns this
-- caller's own claimed slot -- GREATEST(next_request_at, now()) -- as
-- reserved_at. The p_max_lookahead_ms clamp bounds how far into the future
-- a pile-up of concurrent callers can push reservations, so a burst of many
-- overlapping callers degrades to a bounded wait instead of an
-- ever-growing queue; callers are expected to treat that clamp as a hard
-- ceiling on their own wait, not to loop or retry the reservation itself.
--
-- Deliberately independent of blocked_until: this function does not read
-- or write it, and does not decide whether the host is in an active 429
-- cooldown -- that remains getHostCooldown()'s job, unchanged, called
-- before this at cycle start. The two mechanisms are complementary: this
-- one prevents concurrent callers from ever firing simultaneously in the
-- first place; blocked_until still backstops the case where the paced
-- rate itself still draws a 429 from upstream.
--
-- Hardened identically to record_http_rate_limit from the start (see that
-- function's own migration for why a bare REVOKE FROM PUBLIC alone proved
-- insufficient in production): plpgsql with an explicit auth.role() runtime
-- guard, plus REVOKE FROM PUBLIC, anon, authenticated by name.
CREATE OR REPLACE FUNCTION public.reserve_http_request_slot(
  p_host text,
  p_min_interval_ms integer,
  p_max_lookahead_ms integer
) RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_min_interval interval := make_interval(secs => p_min_interval_ms / 1000.0);
  v_ceiling timestamptz := v_now + make_interval(secs => p_max_lookahead_ms / 1000.0) + v_min_interval;
  v_next timestamptz;
  v_reserved_at timestamptz;
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'reserve_http_request_slot: service_role required, got %', auth.role()
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.http_rate_limits AS h (host, next_request_at, updated_at)
  VALUES (p_host, v_now + v_min_interval, v_now)
  ON CONFLICT (host) DO UPDATE SET
    next_request_at = LEAST(
      GREATEST(h.next_request_at, v_now) + v_min_interval,
      v_ceiling
    ),
    updated_at = v_now
  RETURNING h.next_request_at INTO v_next;

  v_reserved_at := v_next - v_min_interval;
  RETURN v_reserved_at;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_http_request_slot(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_http_request_slot(text, integer, integer) TO service_role;
