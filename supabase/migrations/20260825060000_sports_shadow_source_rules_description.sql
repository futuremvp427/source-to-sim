-- CODEX P1-6: EXACT does not prove source economic equivalence.
--
-- ROOT CAUSE: resolver.ts's settlement-rule compatibility check (buildSettlementProfile/
-- overallCompatibility) already existed and correctly parsed the TARGET venue's own
-- rulesDescription for extra-innings/postponement/push-risk language -- but it never
-- incorporated the SOURCE (Polymarket) market's own resolution rules at all. Same game +
-- same team + same line does NOT imply the same contract: a postponement, a shortened/
-- called game, or an extra-innings rule difference between the source and target venues
-- can make two structurally-identical-looking bets settle differently.
--
-- Confirmed (not invented) that gamma-api.polymarket.com's own market `description` field
-- carries this exact same class of resolution-rules text, e.g. a real live MLB moneyline
-- market's description: "If the game is postponed, this market will remain open until the
-- game has been completed. If the game is canceled entirely, with no make-up game, or ends
-- in a tie, this market will resolve 50-50." -- the SAME structural role as
-- PmusCandidate/KalshiCandidate's own rulesDescription field.
--
-- FIX: source_rules_description is captured from Gamma at signal-creation time
-- (source-metadata.server.ts) and persisted durably so resolver.ts's matching lane
-- (potentially a separate cycle, long after the signal was created) has it available
-- without re-fetching Gamma. resolver.ts now combines the source's OWN per-dimension
-- rule status with the target's (see resolver.ts's combineDimension) -- EXACT now
-- requires BOTH sides to positively agree, not merely that the target's text alone looks
-- safe. A genuine cross-venue rule MISMATCH (source says extra innings included, target
-- says excluded) now correctly downgrades to NEAR rather than a false EXACT; missing
-- rules text on either side stays UNVERIFIED rather than assumed compatible.
ALTER TABLE public.sports_shadow_signals
  ADD COLUMN IF NOT EXISTS source_rules_description text;

-- Signature-change hazard (established convention -- see 20260823110000/20260824000000's
-- own identical comments for this exact function): DROP the old 25-arg signature first.
DROP FUNCTION IF EXISTS public.insert_sports_shadow_episode(
  uuid, text, text, text, text, text, text, text, text, timestamptz, timestamptz,
  numeric, numeric, numeric, integer, boolean, text, timestamptz, text, text, text, text, numeric, text, uuid
);

CREATE OR REPLACE FUNCTION public.insert_sports_shadow_episode(
  p_fill_id uuid,
  p_episode_key text,
  p_source_wallet text,
  p_source_handle text,
  p_source_condition_id text,
  p_source_asset text,
  p_source_outcome text,
  p_source_event_slug text,
  p_source_market_slug text,
  p_source_first_fill_at timestamptz,
  p_source_last_fill_at timestamptz,
  p_source_vwap numeric,
  p_source_shares numeric,
  p_source_notional numeric,
  p_source_fill_count integer,
  p_source_sell_seen boolean,
  p_league text,
  p_scheduled_start_at timestamptz,
  p_away_team text,
  p_home_team text,
  p_bet_type text,
  p_selected_side text,
  p_line numeric,
  p_cluster_key text DEFAULT NULL,
  p_experiment_epoch_id uuid DEFAULT NULL,
  p_source_rules_description text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_signal_id uuid;
  v_detected_at timestamptz;
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'insert_sports_shadow_episode: service_role required, got %', auth.role()
      USING ERRCODE = '42501';
  END IF;

  SELECT first_seen_at INTO v_detected_at
  FROM public.sports_shadow_source_fills
  WHERE id = p_fill_id;

  IF v_detected_at IS NULL THEN
    RAISE EXCEPTION 'insert_sports_shadow_episode: no sports_shadow_source_fills row found for p_fill_id %', p_fill_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO public.sports_shadow_signals (
    episode_key, source_wallet, source_handle, source_condition_id, source_asset,
    source_outcome, source_event_slug, source_market_slug, first_fill_id,
    source_first_fill_at, source_last_fill_at, source_vwap, source_shares,
    source_notional, source_fill_count, source_sell_seen, league,
    scheduled_start_at, away_team, home_team, bet_type, selected_side, line,
    cluster_key, experiment_epoch_id, source_rules_description, created_at
  ) VALUES (
    p_episode_key, p_source_wallet, p_source_handle, p_source_condition_id, p_source_asset,
    p_source_outcome, p_source_event_slug, p_source_market_slug, p_fill_id,
    p_source_first_fill_at, p_source_last_fill_at, p_source_vwap, p_source_shares,
    p_source_notional, p_source_fill_count, p_source_sell_seen, p_league,
    p_scheduled_start_at, p_away_team, p_home_team, p_bet_type, p_selected_side, p_line,
    p_cluster_key, p_experiment_epoch_id, p_source_rules_description, v_detected_at
  )
  RETURNING id INTO v_signal_id;

  UPDATE public.sports_shadow_source_fills
  SET downstream_status = 'COMPLETE'
  WHERE id = p_fill_id;

  RETURN v_signal_id;
END;
$$;

REVOKE ALL ON FUNCTION public.insert_sports_shadow_episode(
  uuid, text, text, text, text, text, text, text, text, timestamptz, timestamptz,
  numeric, numeric, numeric, integer, boolean, text, timestamptz, text, text, text, text, numeric, text, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_sports_shadow_episode(
  uuid, text, text, text, text, text, text, text, text, timestamptz, timestamptz,
  numeric, numeric, numeric, integer, boolean, text, timestamptz, text, text, text, text, numeric, text, uuid, text
) TO service_role;

-- find_pending_sports_shadow_signals: same (p_venue text, p_limit integer) signature, but
-- RETURNS TABLE gains source_rules_description -- Postgres cannot CREATE OR REPLACE a
-- change to the return type, so the old 15-column-return version is dropped first.
DROP FUNCTION IF EXISTS public.find_pending_sports_shadow_signals(text, integer);

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
  missing_kalshi boolean,
  source_rules_description text
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
    (kalshi_match.id IS NULL) AS missing_kalshi,
    s.source_rules_description
  FROM public.sports_shadow_signals s
  LEFT JOIN public.sports_market_matches pmus_match
    ON pmus_match.signal_id = s.id AND pmus_match.venue = 'PMUS'
  LEFT JOIN public.sports_market_matches kalshi_match
    ON kalshi_match.signal_id = s.id AND kalshi_match.venue = 'KALSHI'
  WHERE
    (p_venue = 'PMUS' AND (
      pmus_match.id IS NULL
      OR (
        pmus_match.match_status <> 'EXACT'
        AND pmus_match.next_recheck_at IS NOT NULL
        AND pmus_match.next_recheck_at <= now()
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
