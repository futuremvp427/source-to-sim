-- Task 12I / P1-O: hard pregame recheck cutoff, SELECTION-time (RPC/SQL) layer.
--
-- ROOT CAUSE (Codex P1 finding, on top of Task 12H/P1-M): computeRecheckDecision
-- (observation.ts) only refused to schedule a FUTURE recheck once its own cutoff had
-- already been reached -- it never re-derived the cutoff at the DB layer. Two distinct
-- races follow from relying on a single client-side timestamp written once, at recheck-
-- scheduling time, only:
--   1. (fixed alongside this migration, application-side) the CANDIDATE next recheck
--      time itself could land at/after cutoff, i.e. the row could carry a
--      next_recheck_at that is itself already past the pregame boundary.
--   2. (this migration) a row can be legitimately selected as "due" (next_recheck_at
--      already in the past, correctly, at write time) and then sit un-processed --
--      scheduler outage, worker backlog, a long discovery pass -- until the SIGNAL'S OWN
--      cutoff has since been crossed by real wall-clock time, at which point it is no
--      longer a genuine pregame recheck opportunity at all, no matter what
--      next_recheck_at says.
--
-- FIX: find_pending_sports_shadow_signals's recheck branch now ALSO requires
-- `now() < COALESCE(s.scheduled_start_at, s.created_at + interval '4 hours')` -- the
-- EXACT same cutoff formula as observation.ts's computeCutoffMs (scheduled_start_at when
-- known, else the signal's own immutable created_at -- Task 12G/P1-L's detection anchor,
-- identical to detectedAtMsFromSignal -- plus the same 4-hour fallback window). This is
-- Layer A of the mission's required two-layer defense; Layer B (a final client-side
-- check inside persistVenueMatch, downgrading a would-be-EXACT to UNVERIFIED via
-- observation.ts's new clampPastCutoffResult when the cutoff has been reached by
-- persistence time) is unchanged code, not this migration -- see observation.server.ts.
-- Layer A alone cannot close the execution-time race (SELECT can happen just before
-- cutoff, PROCESS can happen just after), which is exactly why Layer B still exists
-- independently: this migration is defense in depth on the queue itself, not a
-- replacement for the application-side guard.
--
-- No new column: the cutoff is fully derivable from data that is ALREADY durable and
-- immutable (sports_shadow_signals.scheduled_start_at, .created_at), so this migration
-- only revises the RPC body -- same public signature (text, integer), same
-- privilege/security contract, same "missing" (match.id IS NULL) branch untouched (a
-- genuinely-never-attempted signal is not a "recheck" and is not cutoff-gated here; its
-- own first-ever persistVenueMatch call is protected by Layer B, and once that call
-- writes a row, next_recheck_at becomes durably NULL if cutoff has already passed,
-- self-terminating without needing this branch touched at all).
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
      OR (
        pmus_match.match_status <> 'EXACT'
        AND pmus_match.next_recheck_at IS NOT NULL
        AND pmus_match.next_recheck_at <= now()
        -- Task 12I / P1-O, Layer A: never select a recheck once the signal's own durable
        -- pregame cutoff has been reached, regardless of what next_recheck_at says.
        AND now() < COALESCE(s.scheduled_start_at, s.created_at + interval '4 hours')
      )
    ))
    OR (p_venue = 'KALSHI' AND (
      kalshi_match.id IS NULL
      OR (
        kalshi_match.match_status <> 'EXACT'
        AND kalshi_match.next_recheck_at IS NOT NULL
        AND kalshi_match.next_recheck_at <= now()
        AND now() < COALESCE(s.scheduled_start_at, s.created_at + interval '4 hours')
      )
    ))
  ORDER BY s.created_at ASC, s.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 0), 100);
$$;

REVOKE ALL ON FUNCTION public.find_pending_sports_shadow_signals(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_pending_sports_shadow_signals(text, integer) TO service_role;
