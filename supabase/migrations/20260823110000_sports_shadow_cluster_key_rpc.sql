-- FINAL BUILD Part 16: threads the independence cluster_key (computed by
-- independence.ts's computeClusterKey at insert time -- see source-poll.server.ts's
-- call site) through insert_sports_shadow_episode so every new episode is durably
-- tagged with its correlation cluster at creation, letting a milestone query
-- COUNT(DISTINCT cluster_key) directly rather than recomputing clustering over the
-- whole table on every read.
--
-- Adding a new trailing parameter changes the function's identity (Postgres resolves
-- overloads by parameter list) -- CREATE OR REPLACE alone would create a SECOND,
-- overloaded 24-arg function rather than replacing the existing 23-arg one, exactly
-- like 20260820230000's find_pending_sports_shadow_signals signature change. The old
-- 23-arg signature is dropped explicitly first, matching that established convention.
DROP FUNCTION IF EXISTS public.insert_sports_shadow_episode(
  uuid, text, text, text, text, text, text, text, text, timestamptz, timestamptz,
  numeric, numeric, numeric, integer, boolean, text, timestamptz, text, text, text, text, numeric
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
  p_cluster_key text DEFAULT NULL
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
    cluster_key, created_at
  ) VALUES (
    p_episode_key, p_source_wallet, p_source_handle, p_source_condition_id, p_source_asset,
    p_source_outcome, p_source_event_slug, p_source_market_slug, p_fill_id,
    p_source_first_fill_at, p_source_last_fill_at, p_source_vwap, p_source_shares,
    p_source_notional, p_source_fill_count, p_source_sell_seen, p_league,
    p_scheduled_start_at, p_away_team, p_home_team, p_bet_type, p_selected_side, p_line,
    p_cluster_key, v_detected_at
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
  numeric, numeric, numeric, integer, boolean, text, timestamptz, text, text, text, text, numeric, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_sports_shadow_episode(
  uuid, text, text, text, text, text, text, text, text, timestamptz, timestamptz,
  numeric, numeric, numeric, integer, boolean, text, timestamptz, text, text, text, text, numeric, text
) TO service_role;
