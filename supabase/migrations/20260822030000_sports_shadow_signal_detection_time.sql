-- Task 12G / P1-L: delayed downstream retry resets the signal's detection anchor.
--
-- ROOT CAUSE (Codex P1 finding): insert_sports_shadow_episode's INSERT INTO
-- sports_shadow_signals never explicitly listed created_at, so it fell through to the
-- column's own DEFAULT now() -- the RPC's OWN EXECUTION time, not the time WE first
-- detected/persisted the underlying source fill. Task 12D's durable per-fill retry
-- deliberately allows a raw fill to stay PENDING across a downstream metadata/DB
-- failure and be processed successfully on a MUCH later poll/restart -- exactly the
-- scenario this durability was built for. But when that later retry finally succeeds,
-- created_at silently became the retry's own timestamp, not the original detection
-- time. Task 11 anchors ALL FIVE +0/+5/+10/+30/+60 fire_at values off the signal's
-- created_at (detectedAtMsFromSignal) -- so the entire outage/retry delay vanished from
-- measured detection latency, a serious measurement bias for exactly the fills this
-- system's crash-safety was designed to protect.
--
-- FIX: sports_shadow_source_fills.first_seen_at already durably records exactly the
-- moment WE first persisted that raw fill (set once, via the column's own DEFAULT now()
-- at INSERT time in Phase 1 of source-poll.server.ts -- never touched again). This
-- CREATE OR REPLACE keeps insert_sports_shadow_episode's public signature and security
-- contract byte-identical (same parameters, same SECURITY DEFINER + auth.role() guard,
-- same REVOKE/GRANT), but now reads that fill's first_seen_at BEFORE inserting the
-- signal and sets sports_shadow_signals.created_at explicitly to it -- so
-- signal.created_at == when WE first detected/persisted the source fill, REGARDLESS of
-- how many polls/restarts/failures separated detection from the eventual successful
-- episode write. A p_fill_id that does not exist in sports_shadow_source_fills now
-- fails explicitly (RAISE EXCEPTION), rather than silently proceeding with a NULL/wrong
-- detection anchor.
--
-- source_first_fill_at/source_last_fill_at remain completely untouched by this fix --
-- they are the SOURCE WALLET's own trade timestamp (event time), a fundamentally
-- different concept from created_at (OUR detection time), and must stay distinct.
-- updated_at is untouched -- it remains the actual row-mutation time.
--
-- Per this task's explicit instruction, the already-committed
-- 20260821040000_sports_shadow_fill_retry.sql migration is left completely unedited;
-- this is a NEW additive migration that CREATE OR REPLACEs the same function.
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
  p_line numeric
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

  -- Task 12G / P1-L: the durable detection anchor is the fill's OWN first_seen_at, read
  -- fresh from the fill row itself -- never the current retry's clock. Fails explicitly
  -- (not silently NULL) if p_fill_id does not reference a real fill.
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
    created_at
  ) VALUES (
    p_episode_key, p_source_wallet, p_source_handle, p_source_condition_id, p_source_asset,
    p_source_outcome, p_source_event_slug, p_source_market_slug, p_fill_id,
    p_source_first_fill_at, p_source_last_fill_at, p_source_vwap, p_source_shares,
    p_source_notional, p_source_fill_count, p_source_sell_seen, p_league,
    p_scheduled_start_at, p_away_team, p_home_team, p_bet_type, p_selected_side, p_line,
    v_detected_at
  )
  RETURNING id INTO v_signal_id;

  UPDATE public.sports_shadow_source_fills
  SET downstream_status = 'COMPLETE'
  WHERE id = p_fill_id;

  RETURN v_signal_id;
END;
$$;

-- Signature is unchanged from 20260821040000 -- REVOKE/GRANT re-asserted defensively
-- (harmless no-op if already correct; CREATE OR REPLACE does not touch privileges).
REVOKE ALL ON FUNCTION public.insert_sports_shadow_episode(
  uuid, text, text, text, text, text, text, text, text, timestamptz, timestamptz,
  numeric, numeric, numeric, integer, boolean, text, timestamptz, text, text, text, text, numeric
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_sports_shadow_episode(
  uuid, text, text, text, text, text, text, text, text, timestamptz, timestamptz,
  numeric, numeric, numeric, integer, boolean, text, timestamptz, text, text, text, text, numeric
) TO service_role;
