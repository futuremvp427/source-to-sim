-- Task 12D / P1-A: persisted fills lost after a downstream failure.
--
-- ROOT CAUSE: source-poll.server.ts treated "raw fill row exists" and "downstream episode
-- processing complete" as the SAME state (insertRawFill returning inserted:false was the
-- only signal used to skip a fill on a later poll). A fill whose raw row was persisted but
-- whose LATER step (metadata fetch, findLatestEpisode, updateEpisode/insertNewEpisode)
-- failed or was left UNVERIFIED was silently treated as fully handled forever after.
--
-- FIX: `downstream_status` makes the two states explicit and independently durable.
-- PENDING (default) means "not yet safely applied" and is retried on every subsequent poll
-- via a bounded (wallet, source_ts) query -- this is the exact same "re-derive pending work
-- fresh from durable state every cycle" pattern Task 11B already established for signals,
-- applied here at the fill level. COMPLETE and the two TERMINAL_* values are reached only
-- through the atomic RPCs below, never through a bare UPDATE from application code, so a
-- fill can never be marked done without its corresponding episode mutation (if any) having
-- actually committed in the SAME transaction.
--
-- HARD DESIGN GATE PROOF (crash after episode aggregation, before completion marker):
-- insert_sports_shadow_episode / update_sports_shadow_episode below perform the episode
-- INSERT-or-UPDATE and the fill's downstream_status write in ONE function invocation, which
-- Postgres executes as a single transaction. There is no intermediate state where the
-- episode mutation has committed but the fill is still PENDING: either the whole function
-- commits (episode mutated AND fill COMPLETE together) or a crash/error rolls back the
-- ENTIRE transaction (episode UNCHANGED, fill still PENDING, safe to retry from scratch).
-- A retry after such a crash therefore always recomputes decideFill against the SAME
-- (correctly still-unmutated) prior episode state and applies the identical aggregation
-- exactly once when it finally commits. This relies on wallet polling itself being
-- serialized by Task 11's SOURCE_LOCK_ID lease (only one worker ever calls
-- pollSportsShadowWallet for a given wallet at a time) -- true concurrent double-processing
-- of the same wallet is out of scope here exactly as it already was for the rest of Task 10.
--
-- Fields that are set ONCE at episode creation and never change on a later aggregation
-- (wallet/condition/asset/league/teams/bet_type/selected_side/line/slugs/first_fill_id) are
-- only ever written by insert_sports_shadow_episode; update_sports_shadow_episode writes
-- only the aggregate fields decideFill's AGGREGATED_BUY/LATE_RECONCILIATION/SELL_RECORDED
-- outcomes actually mutate -- the same field set source-poll.server.ts's existing
-- updateEpisode already writes today, just made atomic with the fill's completion.
ALTER TABLE public.sports_shadow_source_fills
  ADD COLUMN downstream_status text NOT NULL DEFAULT 'PENDING',
  ADD CONSTRAINT sports_shadow_source_fills_downstream_status_check
    CHECK (downstream_status IN ('PENDING', 'COMPLETE', 'TERMINAL_INELIGIBLE', 'TERMINAL_INVALID'));

-- Bounded retry-pending query index: one wallet's oldest-first PENDING fills.
CREATE INDEX sports_shadow_source_fills_pending_idx
  ON public.sports_shadow_source_fills (wallet, source_ts)
  WHERE downstream_status = 'PENDING';

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
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'insert_sports_shadow_episode: service_role required, got %', auth.role()
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.sports_shadow_signals (
    episode_key, source_wallet, source_handle, source_condition_id, source_asset,
    source_outcome, source_event_slug, source_market_slug, first_fill_id,
    source_first_fill_at, source_last_fill_at, source_vwap, source_shares,
    source_notional, source_fill_count, source_sell_seen, league,
    scheduled_start_at, away_team, home_team, bet_type, selected_side, line
  ) VALUES (
    p_episode_key, p_source_wallet, p_source_handle, p_source_condition_id, p_source_asset,
    p_source_outcome, p_source_event_slug, p_source_market_slug, p_fill_id,
    p_source_first_fill_at, p_source_last_fill_at, p_source_vwap, p_source_shares,
    p_source_notional, p_source_fill_count, p_source_sell_seen, p_league,
    p_scheduled_start_at, p_away_team, p_home_team, p_bet_type, p_selected_side, p_line
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
  numeric, numeric, numeric, integer, boolean, text, timestamptz, text, text, text, text, numeric
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_sports_shadow_episode(
  uuid, text, text, text, text, text, text, text, text, timestamptz, timestamptz,
  numeric, numeric, numeric, integer, boolean, text, timestamptz, text, text, text, text, numeric
) TO service_role;

CREATE OR REPLACE FUNCTION public.update_sports_shadow_episode(
  p_fill_id uuid,
  p_signal_id uuid,
  p_source_first_fill_at timestamptz,
  p_source_last_fill_at timestamptz,
  p_source_vwap numeric,
  p_source_shares numeric,
  p_source_notional numeric,
  p_source_fill_count integer,
  p_source_sell_seen boolean
) RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'update_sports_shadow_episode: service_role required, got %', auth.role()
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.sports_shadow_signals
  SET
    source_first_fill_at = p_source_first_fill_at,
    source_last_fill_at = p_source_last_fill_at,
    source_vwap = p_source_vwap,
    source_shares = p_source_shares,
    source_notional = p_source_notional,
    source_fill_count = p_source_fill_count,
    source_sell_seen = p_source_sell_seen,
    updated_at = now()
  WHERE id = p_signal_id;

  UPDATE public.sports_shadow_source_fills
  SET downstream_status = 'COMPLETE'
  WHERE id = p_fill_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_sports_shadow_episode(
  uuid, uuid, timestamptz, timestamptz, numeric, numeric, numeric, integer, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_sports_shadow_episode(
  uuid, uuid, timestamptz, timestamptz, numeric, numeric, numeric, integer, boolean
) TO service_role;
