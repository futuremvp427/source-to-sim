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
--
-- Codex review (commit fa34d0f) caught a real P1: an INNER join to paper_fills silently
-- dropped every signal that never produced a paper-fill row at all (unmatched signals,
-- or a matched signal whose triggering observation was stale/failed -- paper.server.ts
-- emits no fill row for those cases at all, not even a REJECTED one). That inflated
-- match rate/deflated liquidity-failure rate (e.g. 1 real fill out of 100 detected
-- signals reporting as 100% match), which directly feeds the 70% LIVE_PILOT_REVIEW_READY
-- liquidity gate. Fixed by UNION-ing in a synthetic 'UNROUTED' row, one per canonical
-- notional tier, for every signal missing a real paper-fill row at that tier -- so every
-- tier's execution-metrics denominator sees the FULL set of detected signals, not just
-- the ones that happened to get routed.
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
  WITH dedup_fills AS (
    SELECT DISTINCT ON (pf_inner.signal_id, pf_inner.notional_tier_usd) pf_inner.*
    FROM public.sports_shadow_paper_fills pf_inner
    ORDER BY pf_inner.signal_id, pf_inner.notional_tier_usd, pf_inner.routing_timestamp ASC
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
    JOIN dedup_fills pf ON pf.signal_id = s.id
    LEFT JOIN public.sports_quote_observations o ON o.id = pf.observation_id
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
        WHERE pf2.signal_id = s.id AND pf2.notional_tier_usd = tier.notional_tier_usd
      )
  )
  SELECT * FROM routed
  UNION ALL
  SELECT * FROM unrouted;
$$;

REVOKE ALL ON FUNCTION public.get_sports_shadow_episode_outcomes(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_sports_shadow_episode_outcomes(uuid) TO service_role;
