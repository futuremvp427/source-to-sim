-- CODEX P1-3 (follower lifecycle), part 2: finds lifecycle triggers (ADD/EXIT
-- reactions recorded by source-poll.server.ts) that have not yet had their
-- observation-capture burst scheduled -- an anti-join awkward to express via
-- PostgREST's query builder, so a small dedicated RPC does it in one indexed round
-- trip instead of two application-level queries.
CREATE OR REPLACE FUNCTION public.find_unscheduled_sports_shadow_lifecycle_triggers(p_limit integer)
RETURNS TABLE (id uuid, signal_id uuid, source_fill_id uuid, detected_at timestamptz, source_ts bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.id, t.signal_id, t.source_fill_id, t.detected_at, t.source_ts
  FROM public.sports_shadow_lifecycle_triggers t
  WHERE NOT EXISTS (
    SELECT 1 FROM public.sports_quote_observations o WHERE o.trigger_source_fill_id = t.id
  )
  ORDER BY t.detected_at ASC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.find_unscheduled_sports_shadow_lifecycle_triggers(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_unscheduled_sports_shadow_lifecycle_triggers(integer) TO service_role;
