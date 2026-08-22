-- FINAL BUILD Part 6: aggregates sports_shadow_telemetry_events for a single indexed
-- SQL rollup covering the ENTIRE soak window (restart-safe -- telemetry_events is
-- durable, never in-memory) rather than a single-cycle heuristic. soak.ts's pure
-- evaluateSoakHealth consumes exactly this shape.
CREATE OR REPLACE FUNCTION public.get_sports_shadow_soak_telemetry_rollup(p_epoch_id uuid, p_since timestamptz)
RETURNS TABLE (
  actual_cycle_count bigint,
  total_cycle_errors numeric,
  observation_captured_total numeric,
  observation_failed_total numeric,
  observation_backlog_total numeric,
  pmus_discovery_failed_count numeric,
  pmus_discovery_attempted_cycles bigint,
  kalshi_discovery_failed_count numeric,
  kalshi_discovery_attempted_cycles bigint,
  source_lane_acquired_cycles bigint,
  source_starved_cycles bigint,
  lease_lost_count numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT
    count(*) FILTER (WHERE category = 'SYSTEM' AND metric = 'cycle_duration_ms')::bigint,
    COALESCE(sum(value) FILTER (WHERE metric = 'cycle_error_count'), 0),
    COALESCE(sum(value) FILTER (WHERE category = 'OBSERVATION' AND metric = 'captured'), 0),
    COALESCE(sum(value) FILTER (WHERE category = 'OBSERVATION' AND metric = 'failed'), 0),
    COALESCE(sum(value) FILTER (WHERE category = 'OBSERVATION' AND metric = 'skipped'), 0),
    COALESCE(sum(value) FILTER (WHERE category = 'VENUE' AND metric = 'discovery_failed' AND labels->>'venue' = 'PMUS'), 0),
    count(*) FILTER (WHERE category = 'VENUE' AND metric = 'discovery_failed' AND labels->>'venue' = 'PMUS')::bigint,
    COALESCE(sum(value) FILTER (WHERE category = 'VENUE' AND metric = 'discovery_failed' AND labels->>'venue' = 'KALSHI'), 0),
    count(*) FILTER (WHERE category = 'VENUE' AND metric = 'discovery_failed' AND labels->>'venue' = 'KALSHI')::bigint,
    count(*) FILTER (WHERE category = 'SOURCE' AND metric = 'wallets_attempted')::bigint,
    count(*) FILTER (WHERE category = 'SOURCE' AND metric = 'wallets_attempted' AND value = 0)::bigint,
    COALESCE(sum(value) FILTER (WHERE category = 'SOURCE' AND metric = 'lease_lost'), 0)
  FROM public.sports_shadow_telemetry_events
  WHERE experiment_epoch_id = p_epoch_id AND created_at >= p_since;
$$;

REVOKE ALL ON FUNCTION public.get_sports_shadow_soak_telemetry_rollup(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_sports_shadow_soak_telemetry_rollup(uuid, timestamptz) TO service_role;
