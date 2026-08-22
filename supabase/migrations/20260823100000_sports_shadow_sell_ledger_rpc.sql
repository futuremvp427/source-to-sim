-- FINAL BUILD Part 1/5/14: threads real sell shares/notional aggregates through
-- update_sports_shadow_episode (insert_sports_shadow_episode needs NO change -- a
-- brand-new episode always starts with sell_shares/sell_notional at their column
-- DEFAULT 0, matching episode.ts's newEpisodeState exactly), and atomically records
-- the individual sell-event row (auditable, one-per-raw-fill) in the SAME transaction
-- as the signal's aggregate update -- never a split-brain "signal updated but the
-- individual sell event was not recorded" state under a partial failure.
--
-- p_sell_event_* parameters are all NULL for a plain BUY-side aggregation update
-- (AGGREGATED_BUY / LATE_RECONCILIATION) -- no sell event is inserted in that case.
-- When populated (a genuine SELL_RECORDED update against a KNOWN open episode), a sell
-- event row is inserted with this signal_id -- the pre-epoch/unknown-position case
-- (no matching episode at all) never reaches this RPC; it is recorded separately by
-- record_pre_epoch_sell below with signal_id NULL.
--
-- Adding new trailing parameters changes the function's identity (Postgres resolves
-- overloads by parameter list) -- CREATE OR REPLACE alone would create a SECOND,
-- overloaded 15-arg function rather than replacing the existing 9-arg one. The old
-- 9-arg signature is dropped explicitly first, matching the established convention
-- (see 20260820230000's find_pending_sports_shadow_signals signature change).
DROP FUNCTION IF EXISTS public.update_sports_shadow_episode(
  uuid, uuid, timestamptz, timestamptz, numeric, numeric, numeric, integer, boolean
);

CREATE OR REPLACE FUNCTION public.update_sports_shadow_episode(
  p_fill_id uuid,
  p_signal_id uuid,
  p_source_first_fill_at timestamptz,
  p_source_last_fill_at timestamptz,
  p_source_vwap numeric,
  p_source_shares numeric,
  p_source_notional numeric,
  p_source_fill_count integer,
  p_source_sell_seen boolean,
  p_source_sell_shares numeric DEFAULT 0,
  p_source_sell_notional numeric DEFAULT 0,
  p_sell_event_shares numeric DEFAULT NULL,
  p_sell_event_price numeric DEFAULT NULL,
  p_sell_event_notional numeric DEFAULT NULL,
  p_sell_event_source_ts bigint DEFAULT NULL
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
    source_sell_shares = p_source_sell_shares,
    source_sell_notional = p_source_sell_notional,
    source_sell_vwap = CASE WHEN p_source_sell_shares > 0 THEN p_source_sell_notional / p_source_sell_shares ELSE NULL END,
    updated_at = now()
  WHERE id = p_signal_id;

  UPDATE public.sports_shadow_source_fills
  SET downstream_status = 'COMPLETE'
  WHERE id = p_fill_id;

  IF p_sell_event_shares IS NOT NULL THEN
    -- ON CONFLICT DO NOTHING: source_fill_id is UNIQUE -- a retried poll re-processing
    -- the identical raw sell fill (e.g. after a crash right after this RPC committed
    -- but before the caller could mark anything else) never double-counts.
    INSERT INTO public.sports_shadow_source_sell_events (signal_id, source_fill_id, shares, price, notional, source_ts, is_pre_epoch)
    VALUES (p_signal_id, p_fill_id, p_sell_event_shares, p_sell_event_price, p_sell_event_notional, p_sell_event_source_ts, false)
    ON CONFLICT (source_fill_id) DO NOTHING;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.update_sports_shadow_episode(
  uuid, uuid, timestamptz, timestamptz, numeric, numeric, numeric, integer, boolean, numeric, numeric, numeric, numeric, numeric, bigint
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_sports_shadow_episode(
  uuid, uuid, timestamptz, timestamptz, numeric, numeric, numeric, integer, boolean, numeric, numeric, numeric, numeric, numeric, bigint
) TO service_role;

-- Records a sell fill with NO known forward open position (Part 5's pre-epoch/
-- untracked case) -- signal_id NULL, is_pre_epoch true, and marks the raw fill
-- COMPLETE in the SAME transaction so a partial failure can never leave the fill
-- durably PENDING forever while the sell event silently exists (or vice versa).
CREATE OR REPLACE FUNCTION public.record_pre_epoch_sell(
  p_fill_id uuid,
  p_shares numeric,
  p_price numeric,
  p_notional numeric,
  p_source_ts bigint
) RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'record_pre_epoch_sell: service_role required, got %', auth.role()
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.sports_shadow_source_sell_events (signal_id, source_fill_id, shares, price, notional, source_ts, is_pre_epoch)
  VALUES (NULL, p_fill_id, p_shares, p_price, p_notional, p_source_ts, true)
  ON CONFLICT (source_fill_id) DO NOTHING;

  UPDATE public.sports_shadow_source_fills
  SET downstream_status = 'COMPLETE'
  WHERE id = p_fill_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_pre_epoch_sell(uuid, numeric, numeric, numeric, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_pre_epoch_sell(uuid, numeric, numeric, numeric, bigint) TO service_role;
