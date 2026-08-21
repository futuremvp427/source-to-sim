-- Task 11B remediation: fixes a confirmed permanent-starvation defect in the Sports
-- Forward Shadow worker's durable pending-signal recovery.
--
-- The application-side query it replaces was:
--   SELECT ... FROM sports_shadow_signals ORDER BY created_at ASC LIMIT 200
-- (a client-side "scan window" of the globally oldest 200 signals, regardless of
-- resolution status), followed by a second query fetching sports_market_matches for
-- exactly those 200 ids, then filtering in application code for the ones still missing
-- a venue match. Once total signal count exceeds 200 and the oldest 200 happen to all
-- be fully resolved, the scan window is permanently saturated with resolved rows: any
-- signal created after that point (e.g. signal #201) is never even fetched, let alone
-- evaluated for pending work -- not delayed, invisible. This is not a low-volume-phase
-- edge case; it is guaranteed the moment cumulative signal count exceeds 200.
--
-- Fix: push the "missing a match" condition into SQL itself via an explicit anti-join
-- (LEFT JOIN ... WHERE match.id IS NULL) against sports_market_matches. This makes the
-- boundedness apply to genuinely pending rows, not to a fixed-size historical prefix --
-- the invariant the mission requires: return the globally oldest PENDING signals,
-- bounded by the caller's batch size, full stop. No new table: everything needed
-- already lives in sports_shadow_signals + sports_market_matches (see
-- 20260819220000_sports_forward_shadow_phase1.sql).
--
-- ============================== TASK 12D / P1-C: PER-VENUE FAIRNESS ==============================
-- ROOT CAUSE (found by review after this RPC was first written): pooling BOTH venues into
-- one globally-bounded batch (`WHERE pmus_match.id IS NULL OR kalshi_match.id IS NULL`)
-- creates cross-venue head-of-line blocking. If PMUS has a sustained outage, the oldest
-- PMUS-missing signals occupy every one of the batch's slots, cycle after cycle -- even
-- though NEWER signals only missing Kalshi could resolve right now, independently. The
-- symptom is structurally identical to the #201 starvation defect this RPC was built to
-- fix, just recurring one level down: at the per-venue level instead of the whole-signal
-- level.
--
-- FIX: this RPC is now venue-scoped (`p_venue`) rather than venue-combined. A caller
-- queries PMUS-pending and KALSHI-pending as two SEPARATE bounded calls, each independently
-- ordered (created_at ASC, id ASC) and independently limited -- so a stuck/failing venue's
-- backlog can never consume the other venue's batch slots. This migration has never been
-- applied to any database (confirmed throughout this unshipped PR), so the ORIGINAL
-- single-arg venue-combined function is revised in place here rather than layered under a
-- second, conflicting queue model -- see the mission's own explicit instruction to update
-- this contract, not add another one.
--
-- Read-only, single SELECT, LANGUAGE sql (no procedural logic needed) -- deliberately
-- the smallest correct fix, not a new subsystem. SECURITY INVOKER (not DEFINER, unlike
-- this codebase's mutating RPCs such as acquire_worker_lease/reserve_http_request_slot):
-- this function only ever reads, so it runs with the CALLING role's own privileges --
-- defense in depth on top of the REVOKE/GRANT below, not a substitute for it. Both
-- target tables have RLS enabled with no policies at all, so even if EXECUTE were ever
-- mistakenly granted more broadly, a non-service_role caller would see zero rows (RLS
-- default-deny), not a privilege escalation; service_role's BYPASSRLS makes this
-- function behave identically to the application's existing service-role-only access
-- pattern for every other sports_shadow_* table read.
DROP FUNCTION IF EXISTS public.find_pending_sports_shadow_signals(integer);

CREATE OR REPLACE FUNCTION public.find_pending_sports_shadow_signals(
  p_venue text,
  p_limit integer
)
RETURNS TABLE (
  id uuid,
  created_at timestamptz,
  source_first_fill_at timestamptz,
  source_wallet text,
  source_condition_id text,
  source_asset text,
  bet_type text,
  away_team text,
  home_team text,
  scheduled_start_at timestamptz,
  line numeric,
  selected_side text,
  source_event_slug text,
  source_market_slug text,
  missing_pmus boolean,
  missing_kalshi boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    s.id,
    s.created_at,
    s.source_first_fill_at,
    s.source_wallet,
    s.source_condition_id,
    s.source_asset,
    s.bet_type,
    s.away_team,
    s.home_team,
    s.scheduled_start_at,
    s.line,
    s.selected_side,
    s.source_event_slug,
    s.source_market_slug,
    (pmus_match.id IS NULL) AS missing_pmus,
    (kalshi_match.id IS NULL) AS missing_kalshi
  FROM public.sports_shadow_signals s
  LEFT JOIN public.sports_market_matches pmus_match
    ON pmus_match.signal_id = s.id AND pmus_match.venue = 'PMUS'
  LEFT JOIN public.sports_market_matches kalshi_match
    ON kalshi_match.signal_id = s.id AND kalshi_match.venue = 'KALSHI'
  WHERE
    -- Fails closed to zero rows for any p_venue value other than the two legal venues --
    -- never silently falls back to the old combined-OR behavior.
    (p_venue = 'PMUS' AND pmus_match.id IS NULL)
    OR (p_venue = 'KALSHI' AND kalshi_match.id IS NULL)
  ORDER BY s.created_at ASC, s.id ASC
  -- NULL-safe, non-negative, and clamped to a sane ceiling: a bare `LIMIT p_limit`
  -- would silently become UNBOUNDED (Postgres treats LIMIT NULL as "no limit") if a
  -- caller ever passed NULL, and an unclamped caller-supplied value could otherwise
  -- request an arbitrarily large scan. 100 is well above the application's own
  -- PENDING_BATCH_SIZE (20), leaving headroom without removing the ceiling entirely.
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 0), 100);
$$;

REVOKE ALL ON FUNCTION public.find_pending_sports_shadow_signals(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_pending_sports_shadow_signals(text, integer) TO service_role;
