-- Atomic pre-request pacing reservation for data-api.polymarket.com.
--
-- Phase 2 (20260815160000_http_rate_limit_cooldown.sql) gave ingestion a
-- durable, cross-tick cooldown -- but it is purely REACTIVE: every caller
-- reads blocked_until, and if it is not currently in the future, proceeds
-- straight to the real upstream fetch. That read-then-act gap is exactly
-- the race a fresh production incident (2026-08-17) proved is still open:
-- EXPERIMENT_CONCURRENCY (2) runs experiments through Promise.allSettled,
-- so two sibling experiments (and, independently, General Shadow's
-- /activity path, candidate research's own /trades and /positions calls,
-- and the health probe) can call getHostCooldown() within microseconds of
-- each other, both observe blocked=false because no 429 has happened YET,
-- and both then fire real upstream requests at the same instant --
-- reproducing the burst the cooldown exists to prevent, before either
-- request's own outcome has had a chance to teach the cooldown anything.
-- Overlapping scheduler/serverless invocations widen the same window
-- further; an in-process mutex cannot close it because it has no
-- visibility across processes.
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
-- Deliberately uncapped here: next_request_at grows strictly monotonically,
-- one p_min_interval_ms step per call, with NO ceiling clamp in SQL. An
-- earlier version of this function clamped next_request_at to a
-- max-lookahead ceiling directly in this query -- but every caller past
-- the point the clamp saturated then collapsed onto the SAME ceiling
-- timestamp, silently reintroducing simultaneous firing (a pile-up of N
-- callers beyond the clamp all being told the identical "now" once the
-- ceiling was hit) -- exactly the bug this whole mechanism exists to
-- prevent, just moved to a later point in the queue. "Bounded waiting" is
-- instead an application-level decision: the caller compares the returned
-- reserved_at against its own budget and defers (never fetching) rather
-- than waiting, when the wait would be too long -- see
-- MAX_RESERVATION_LOOKAHEAD_MS in http-rate-limit.server.ts. That keeps
-- every granted slot strictly p_min_interval_ms apart from its neighbor,
-- no matter how many callers pile up: excess callers simply don't get used
-- (they defer), they never bunch.
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
ALTER TABLE public.http_rate_limits
  ADD COLUMN IF NOT EXISTS next_request_at timestamptz;

CREATE OR REPLACE FUNCTION public.reserve_http_request_slot(
  p_host text,
  p_min_interval_ms integer
) RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_min_interval interval := make_interval(secs => p_min_interval_ms / 1000.0);
  v_next timestamptz;
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'reserve_http_request_slot: service_role required, got %', auth.role()
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.http_rate_limits AS h (host, next_request_at, updated_at)
  VALUES (p_host, v_now + v_min_interval, v_now)
  ON CONFLICT (host) DO UPDATE SET
    next_request_at = GREATEST(h.next_request_at, v_now) + v_min_interval,
    updated_at = v_now
  RETURNING h.next_request_at INTO v_next;

  RETURN v_next - v_min_interval;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_http_request_slot(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_http_request_slot(text, integer) TO service_role;
