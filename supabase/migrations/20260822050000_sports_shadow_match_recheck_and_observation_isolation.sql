-- Task 12H: two Codex P1 findings from the post-Task-12G re-review.
--
-- ============================== P1-M: NON-EXACT MATCHES MUST BE RECHECKABLE ==============================
-- ROOT CAUSE: find_pending_sports_shadow_signals's anti-join (`match.id IS NULL`) treats
-- the mere EXISTENCE of a sports_market_matches row as "done, never look again" --
-- regardless of whether that row's match_status is EXACT or NONE/NEAR/UNVERIFIED. Once a
-- discovery pass persists a NONE (the target market simply hadn't been listed yet), that
-- signal is invisible to every future pending query for that venue, forever -- even
-- though a later discovery-cache refresh might trivially find the same target.
--
-- FIX: three additive columns on sports_market_matches turn "a row exists" and "this
-- venue is settled, stop looking" into two independently durable facts:
--   first_match_status: set ONCE, at the row's first-ever insert, NEVER updated again --
--     durable audit evidence distinguishing "what did we first observe" from "what is
--     current" (required for experiment match-rate accounting; a single history-free row
--     is sufficient because this ONE additional field is all that distinguishes them --
--     no separate history table needed).
--   next_recheck_at: NULL means "no further recheck" (either a terminal EXACT, or a
--     non-EXACT result whose recheck cutoff has passed); a timestamp means "eligible for
--     recheck at or after this time." Computed application-side (see observation.ts's
--     computeRecheckDecision) from the RECHECK_INTERVAL_MS cooldown (matches PM-US/
--     Kalshi's own 5-minute discovery-cache TTL -- rechecking faster cannot possibly see
--     new discovery data) and a cutoff derived from the signal's OWN scheduled_start_at
--     (this experiment is about PRE-GAME price discovery; once the game has started,
--     discovering the market later no longer serves the measurement) or, when unknown, a
--     bounded fallback window from detection.
--   recheck_count: durable counter, incremented each time a non-terminal row is
--     re-resolved -- diagnostic only, not used for any cutoff decision (the cutoff is
--     time-based, per the mission's explicit "derive from actual Sports Shadow semantics"
--     instruction, not an arbitrary attempt count).
--
-- EXACT is unaffected: an EXACT row's next_recheck_at is always NULL (the existing
-- application-level EXACT-never-downgraded ratchet in persistVenueMatch already refuses
-- to even reach the write path for an EXACT->non-EXACT transition), so EXACT rows can
-- never re-enter the pending query below.
ALTER TABLE public.sports_market_matches
  ADD COLUMN first_match_status text,
  ADD COLUMN next_recheck_at timestamptz,
  ADD COLUMN recheck_count integer NOT NULL DEFAULT 0;

-- Backfill is unnecessary (this table has never been applied to, let alone populated in,
-- any real database), but the column is made NOT NULL here to enforce the invariant that
-- the application ALWAYS supplies it going forward -- matches the existing
-- match_status column's own CHECK-constrained, always-supplied contract.
ALTER TABLE public.sports_market_matches
  ALTER COLUMN first_match_status SET NOT NULL;

ALTER TABLE public.sports_market_matches
  ADD CONSTRAINT sports_market_matches_first_status_check
    CHECK (first_match_status IN ('EXACT', 'NEAR', 'NONE', 'UNVERIFIED'));

-- Bounded per-venue due-recheck lookup: only rows genuinely eligible for a recheck (a
-- durable timestamp, not merely "not yet EXACT") are indexed.
CREATE INDEX sports_market_matches_recheck_idx
  ON public.sports_market_matches (venue, next_recheck_at)
  WHERE next_recheck_at IS NOT NULL;

-- find_pending_sports_shadow_signals: same public signature (text, integer), same
-- privilege/security contract -- only the WHERE clause widens. A signal is pending for a
-- venue when EITHER it has never been attempted at all (match.id IS NULL, unchanged)
-- OR it has a non-EXACT match that is durably due for recheck right now
-- (match_status <> 'EXACT' AND next_recheck_at IS NOT NULL AND next_recheck_at <= now()).
-- Per-venue independence (Task 12D/P1-C) is completely preserved: each venue's OR-branch
-- references only that venue's own joined match row, exactly as before.
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
    (p_venue = 'PMUS' AND (
      pmus_match.id IS NULL
      OR (pmus_match.match_status <> 'EXACT' AND pmus_match.next_recheck_at IS NOT NULL AND pmus_match.next_recheck_at <= now())
    ))
    OR (p_venue = 'KALSHI' AND (
      kalshi_match.id IS NULL
      OR (kalshi_match.match_status <> 'EXACT' AND kalshi_match.next_recheck_at IS NOT NULL AND kalshi_match.next_recheck_at <= now())
    ))
  ORDER BY s.created_at ASC, s.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 0), 100);
$$;

REVOKE ALL ON FUNCTION public.find_pending_sports_shadow_signals(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_pending_sports_shadow_signals(text, integer) TO service_role;

-- ============================== P1-N: PER-VENUE OBSERVATION ISOLATION ==============================
-- ROOT CAUSE: sports_quote_observations' due-observation query (observed_at IS NULL AND
-- fire_at <= now, ORDER BY fire_at, LIMIT N) pools PM-US and Kalshi rows into ONE shared
-- bounded batch. A backlog of old PM-US rows (each up to a 12s fetch timeout) can fill
-- the whole batch and/or consume the whole per-pass deadline, so a healthy, due Kalshi
-- row never gets selected/processed this pass -- inflating its recorded lateness for a
-- reason having nothing to do with Kalshi itself.
--
-- FIX (application-side, see worker.server.ts/observation.server.ts): the due-observation
-- query is now scoped by venue (`WHERE venue = $1 AND ...`), and the two venues run under
-- INDEPENDENT fenced leases with independently bounded row counts/deadlines, invoked
-- concurrently (bounded -- exactly two fixed venue calls, never unbounded Promise.all) so
-- a slow PM-US lane can never delay Kalshi's lane from starting. No new table is needed
-- (physically splitting into two tables was considered but rejected as unnecessary
-- complexity -- the existing `venue` column already lets a single additive index make the
-- per-venue query exactly as efficient as a dedicated table would be, with zero data
-- migration risk).
CREATE INDEX sports_quote_observations_due_venue_idx
  ON public.sports_quote_observations (venue, fire_at)
  WHERE observed_at IS NULL;
