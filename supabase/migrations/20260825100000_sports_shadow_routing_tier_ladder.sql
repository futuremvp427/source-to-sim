-- CODEX P1-2 (round 2): routing tiers can disappear when the caller's deadline fires.
--
-- ROOT CAUSE: computePaperFillsForObservation's per-tier loop called
-- record_sports_shadow_routing_provenance (creating that ONE tier's durable row) only
-- as the FIRST step INSIDE the same deadline-bounded iteration that then also ran the
-- expensive depth-walk/fee/router evaluation for that tier. If the deadline fired
-- between tiers (e.g. after the $5 evaluation), the loop broke BEFORE ever calling
-- record_sports_shadow_routing_provenance for $10/$25/$50/$100 -- those tiers never got
-- a durable row created AT ALL. maybeDecideExpiredRoutingCutoffs's periodic sweep only
-- ever scans EXISTING rows (WHERE decided_at IS NULL) -- a tier with no row at all is
-- invisible to it, so those larger-capacity tiers were silently, permanently missing
-- from the experiment's results, not merely delayed.
--
-- FIX: record_sports_shadow_routing_provenance_ladder replaces the old per-tier RPC --
-- ONE bounded, idempotent round trip creates/updates the COMPLETE 5-tier ladder
-- (signal_id, requested_delay_ms) for a given venue's observation BEFORE any expensive
-- per-tier evaluation begins. Even if the deadline fires immediately afterward, every
-- tier already has a durable row (this venue's own observation recorded as provenance),
-- so maybeDecideExpiredRoutingCutoffs can still find and eventually terminalize EVERY
-- tier -- a missing DB row can no longer mean a silently missing experiment opportunity.
--
-- Same COALESCE-never-overwrite idempotency as the RPC it replaces; UNIQUE
-- (signal_id, requested_delay_ms, notional_tier_usd) is unchanged, so this is purely an
-- API-shape change, not a data-model change. finalize_sports_shadow_routing_decision
-- (Step 2 of the protocol) is untouched.
DROP FUNCTION IF EXISTS public.record_sports_shadow_routing_provenance(uuid, integer, numeric, text, uuid, timestamptz);

CREATE OR REPLACE FUNCTION public.record_sports_shadow_routing_provenance_ladder(
  p_signal_id uuid,
  p_requested_delay_ms integer,
  p_venue text,
  p_observation_id uuid,
  p_fire_at timestamptz
) RETURNS TABLE (notional_tier_usd numeric, pmus_observation_id uuid, kalshi_observation_id uuid, decided_at timestamptz, fire_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'record_sports_shadow_routing_provenance_ladder: service_role required, got %', auth.role()
      USING ERRCODE = '42501';
  END IF;
  IF p_venue NOT IN ('PMUS', 'KALSHI') THEN
    RAISE EXCEPTION 'record_sports_shadow_routing_provenance_ladder: invalid venue %', p_venue;
  END IF;

  -- ONE statement creates/updates all 5 canonical tiers -- matches
  -- get_sports_shadow_episode_outcomes' own (5, 10, 25, 50, 100) canonical-tier VALUES
  -- list and depth-walk.ts's SPORTS_SHADOW_NOTIONALS_USD, never independently redefined.
  INSERT INTO public.sports_shadow_paper_fills (
    signal_id, requested_delay_ms, notional_tier_usd, fire_at,
    pmus_observation_id, kalshi_observation_id
  )
  SELECT
    p_signal_id, p_requested_delay_ms, tier.notional_tier_usd, p_fire_at,
    CASE WHEN p_venue = 'PMUS' THEN p_observation_id ELSE NULL END,
    CASE WHEN p_venue = 'KALSHI' THEN p_observation_id ELSE NULL END
  FROM (VALUES (5::numeric), (10::numeric), (25::numeric), (50::numeric), (100::numeric)) AS tier(notional_tier_usd)
  ON CONFLICT (signal_id, requested_delay_ms, notional_tier_usd) DO UPDATE SET
    pmus_observation_id = COALESCE(public.sports_shadow_paper_fills.pmus_observation_id, EXCLUDED.pmus_observation_id),
    kalshi_observation_id = COALESCE(public.sports_shadow_paper_fills.kalshi_observation_id, EXCLUDED.kalshi_observation_id);

  RETURN QUERY
    SELECT f.notional_tier_usd, f.pmus_observation_id, f.kalshi_observation_id, f.decided_at, f.fire_at
    FROM public.sports_shadow_paper_fills f
    WHERE f.signal_id = p_signal_id AND f.requested_delay_ms = p_requested_delay_ms
    ORDER BY f.notional_tier_usd ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.record_sports_shadow_routing_provenance_ladder(uuid, integer, text, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_sports_shadow_routing_provenance_ladder(uuid, integer, text, uuid, timestamptz) TO service_role;
