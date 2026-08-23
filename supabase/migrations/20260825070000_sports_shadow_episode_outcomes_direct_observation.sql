-- CODEX remediation follow-up: 20260825040000_sports_shadow_routing_decision_model.sql
-- dropped sports_shadow_paper_fills.observation_id (superseded by
-- pmus_observation_id/kalshi_observation_id) but did not update
-- get_sports_shadow_episode_outcomes, which still joined
-- `sports_quote_observations o ON o.id = pf.observation_id` -- a column that no
-- longer exists. Left as-is, this RPC would fail outright (undefined column) the
-- next time it runs, not merely in a stale SQL test.
--
-- FIX: join directly on whichever venue's observation was actually CHOSEN
-- (pf.chosen_venue), reusing the same direct-provenance principle P1-4 already
-- established for settlement (never re-derive "which observation" via an ambiguous
-- join when the row itself already knows which venue won). Return type is
-- unchanged, so CREATE OR REPLACE is sufficient -- no signature drop needed.
CREATE OR REPLACE FUNCTION public.get_sports_shadow_episode_outcomes(p_epoch_id uuid)
RETURNS TABLE (
  signal_id uuid,
  cluster_key text,
  source_wallet text,
  bet_type text,
  scheduled_start_at timestamptz,
  signal_created_at timestamptz,
  notional_tier_usd numeric,
  chosen_venue text,
  fill_status text,
  contracts numeric,
  vwap numeric,
  fee_usd numeric,
  all_in_cost_usd numeric,
  reject_reason text,
  routing_timestamp timestamptz,
  spread numeric,
  detection_latency_ms integer,
  fire_at timestamptz,
  observed_at timestamptz,
  pmus_result jsonb,
  kalshi_result jsonb,
  settlement_status text,
  gross_pnl_usd numeric,
  total_fees_usd numeric,
  net_pnl_usd numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH entry_fills AS (
    SELECT DISTINCT ON (pf_inner.signal_id, pf_inner.notional_tier_usd) pf_inner.*
    FROM public.sports_shadow_paper_fills pf_inner
    -- Lifecycle trigger_source_fill_id is introduced later in
    -- 20260825120000_sports_shadow_follower_lifecycle.sql. This migration can only
    -- depend on the schema available at this point; the lifecycle migration replaces
    -- this RPC again with the trigger-aware outcome model.
    WHERE pf_inner.side = 'ENTRY'
    ORDER BY pf_inner.signal_id, pf_inner.notional_tier_usd, pf_inner.routing_timestamp ASC, pf_inner.id ASC
  ),
  routed AS (
    SELECT
      s.id AS signal_id,
      s.cluster_key,
      s.source_wallet,
      s.bet_type,
      s.scheduled_start_at,
      s.created_at AS signal_created_at,
      pf.notional_tier_usd,
      pf.chosen_venue,
      pf.fill_status,
      pf.contracts,
      pf.vwap,
      pf.fee_usd,
      pf.all_in_cost_usd,
      pf.reject_reason,
      pf.routing_timestamp,
      o.spread,
      o.detection_latency_ms,
      o.fire_at,
      o.observed_at,
      pf.pmus_result,
      pf.kalshi_result,
      st.settlement_status,
      st.gross_pnl_usd,
      st.total_fees_usd,
      st.net_pnl_usd
    FROM public.sports_shadow_signals s
    JOIN entry_fills pf ON pf.signal_id = s.id
    LEFT JOIN public.sports_quote_observations o ON o.id = (
      CASE pf.chosen_venue
        WHEN 'PMUS' THEN pf.pmus_observation_id
        WHEN 'KALSHI' THEN pf.kalshi_observation_id
        ELSE NULL
      END
    )
    LEFT JOIN public.sports_shadow_settlements st
      ON st.signal_id = s.id AND st.venue = pf.chosen_venue AND st.notional_tier_usd = pf.notional_tier_usd
    WHERE s.experiment_epoch_id = p_epoch_id
  ),
  unrouted AS (
    SELECT
      s.id AS signal_id,
      s.cluster_key,
      s.source_wallet,
      s.bet_type,
      s.scheduled_start_at,
      s.created_at AS signal_created_at,
      tier.notional_tier_usd,
      NULL::text AS chosen_venue,
      'UNROUTED'::text AS fill_status,
      0::numeric AS contracts,
      NULL::numeric AS vwap,
      NULL::numeric AS fee_usd,
      NULL::numeric AS all_in_cost_usd,
      NULL::text AS reject_reason,
      s.created_at AS routing_timestamp,
      NULL::numeric AS spread,
      NULL::integer AS detection_latency_ms,
      NULL::timestamptz AS fire_at,
      NULL::timestamptz AS observed_at,
      NULL::jsonb AS pmus_result,
      NULL::jsonb AS kalshi_result,
      NULL::text AS settlement_status,
      NULL::numeric AS gross_pnl_usd,
      NULL::numeric AS total_fees_usd,
      NULL::numeric AS net_pnl_usd
    FROM public.sports_shadow_signals s
    CROSS JOIN (VALUES (5::numeric), (10::numeric), (25::numeric), (50::numeric), (100::numeric)) AS tier(notional_tier_usd)
    WHERE s.experiment_epoch_id = p_epoch_id
      AND NOT EXISTS (
        SELECT 1 FROM public.sports_shadow_paper_fills pf2
        WHERE pf2.signal_id = s.id
          AND pf2.notional_tier_usd = tier.notional_tier_usd
          AND pf2.side = 'ENTRY'
      )
  )
  SELECT * FROM routed
  UNION ALL
  SELECT * FROM unrouted;
$$;

REVOKE ALL ON FUNCTION public.get_sports_shadow_episode_outcomes(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_sports_shadow_episode_outcomes(uuid) TO service_role;
