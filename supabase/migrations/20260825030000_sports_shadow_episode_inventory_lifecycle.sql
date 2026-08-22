-- CODEX P1-3: source episode does not properly close inventory.
--
-- ROOT CAUSE: decideFill's BUY-aggregation branch matched an existing episode purely by
-- (wallet, conditionId, asset) -- it never checked whether that episode's tracked
-- inventory had already been fully sold. BUY 10 -> SELL 10 -> BUY again inside the
-- 30-minute DCA window folded the second BUY into the ALREADY-CLOSED episode instead of
-- starting a new one. Oversell (SELL 15 against 10 tracked shares) could also imply
-- negative remaining tracked inventory, since sellShares was accumulated without ever
-- being capped against totalShares.
--
-- FIX (episode.ts, application-side): an episode is now "open" only while
-- totalShares - sellShares > 0. A BUY against a same-position episode that is NOT open
-- starts a genuinely NEW episode (even inside the 30-minute window) instead of reopening
-- the closed one. A SELL is capped to consume only the REMAINING tracked inventory at
-- the moment it is applied -- the excess (if any) is recorded as untracked/pre-existing
-- inventory sold, never allowed to make tracked inventory negative, and never silently
-- dropped.
--
-- This migration adds the durable columns/ledger needed to persist and round-trip that
-- untracked-sell evidence -- without it, restarting between BUY/SELL events (a required
-- test scenario) would silently reset the audit trail to zero on every re-hydration of
-- OpenEpisodeState from sports_shadow_signals.
ALTER TABLE public.sports_shadow_signals
  ADD COLUMN IF NOT EXISTS untracked_sell_shares numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS untracked_sell_notional numeric NOT NULL DEFAULT 0;

ALTER TABLE public.sports_shadow_source_sell_events
  ADD COLUMN IF NOT EXISTS untracked_shares numeric NOT NULL DEFAULT 0;

-- Adding new trailing parameters changes the function's identity -- the old 15-arg
-- signature is dropped explicitly first, matching the established convention (see
-- 20260823100000's own identical DROP FUNCTION IF EXISTS for this exact function).
DROP FUNCTION IF EXISTS public.update_sports_shadow_episode(
  uuid, uuid, timestamptz, timestamptz, numeric, numeric, numeric, integer, boolean, numeric, numeric, numeric, numeric, numeric, bigint
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
  p_sell_event_source_ts bigint DEFAULT NULL,
  p_untracked_sell_shares numeric DEFAULT 0,
  p_untracked_sell_notional numeric DEFAULT 0,
  p_sell_event_untracked_shares numeric DEFAULT 0
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
    untracked_sell_shares = p_untracked_sell_shares,
    untracked_sell_notional = p_untracked_sell_notional,
    updated_at = now()
  WHERE id = p_signal_id;

  UPDATE public.sports_shadow_source_fills
  SET downstream_status = 'COMPLETE'
  WHERE id = p_fill_id;

  IF p_sell_event_shares IS NOT NULL THEN
    -- ON CONFLICT DO NOTHING: source_fill_id is UNIQUE -- a retried poll re-processing
    -- the identical raw sell fill never double-counts.
    INSERT INTO public.sports_shadow_source_sell_events (signal_id, source_fill_id, shares, price, notional, source_ts, is_pre_epoch, untracked_shares)
    VALUES (p_signal_id, p_fill_id, p_sell_event_shares, p_sell_event_price, p_sell_event_notional, p_sell_event_source_ts, false, p_sell_event_untracked_shares)
    ON CONFLICT (source_fill_id) DO NOTHING;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.update_sports_shadow_episode(
  uuid, uuid, timestamptz, timestamptz, numeric, numeric, numeric, integer, boolean, numeric, numeric, numeric, numeric, numeric, bigint, numeric, numeric, numeric
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_sports_shadow_episode(
  uuid, uuid, timestamptz, timestamptz, numeric, numeric, numeric, integer, boolean, numeric, numeric, numeric, numeric, numeric, bigint, numeric, numeric, numeric
) TO service_role;
