-- FINAL BUILD Part 1 (research analytics engine): a single indexed join returning one
-- outcome row per (episode, notional tier) for a given epoch -- the raw material the
-- TypeScript analytics/robustness/bootstrap/baseline/classification engines (all PURE
-- functions) compute from. Never aggregates itself (aggregation logic must stay in
-- testable TS, per this build's own established pattern for stage.ts/independence.ts)
-- -- purely a flat, complete, per-episode join.
--
-- DISTINCT ON (signal_id, notional_tier_usd) ... ORDER BY routing_timestamp ASC: a
-- signal can accumulate more than one paper_fills row per tier over its lifetime (e.g.
-- a later observation re-triggering routing) -- the EARLIEST is taken as the episode's
-- entry fill, matching what a real forward-shadow follower would actually have acted
-- on first. Never blended/averaged across triggers, which would not correspond to any
-- single real execution.
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
  JOIN (
    SELECT DISTINCT ON (pf_inner.signal_id, pf_inner.notional_tier_usd) pf_inner.*
    FROM public.sports_shadow_paper_fills pf_inner
    ORDER BY pf_inner.signal_id, pf_inner.notional_tier_usd, pf_inner.routing_timestamp ASC
  ) pf ON pf.signal_id = s.id
  LEFT JOIN public.sports_quote_observations o ON o.id = pf.observation_id
  LEFT JOIN public.sports_shadow_settlements st
    ON st.signal_id = s.id AND st.venue = pf.chosen_venue AND st.notional_tier_usd = pf.notional_tier_usd
  WHERE s.experiment_epoch_id = p_epoch_id;
$$;

REVOKE ALL ON FUNCTION public.get_sports_shadow_episode_outcomes(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_sports_shadow_episode_outcomes(uuid) TO service_role;
