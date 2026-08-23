-- CODEX P1-3 (follower lifecycle), part 2: finds lifecycle trigger/VENUE pairs
-- whose observation-capture burst is not yet fully represented. A trigger is not
-- globally "scheduled" just because one venue has rows: PM-US can be scheduled
-- successfully while Kalshi fails transiently, and the missing Kalshi venue must be
-- retried on the next pass. Returning missing (trigger, venue) pairs makes partial
-- scheduling restart-safe, idempotent, and auditable.
CREATE INDEX IF NOT EXISTS sports_quote_observations_lifecycle_schedule_idx
  ON public.sports_quote_observations (trigger_source_fill_id, venue, requested_delay_ms)
  WHERE trigger_source_fill_id IS NOT NULL;

DROP FUNCTION IF EXISTS public.find_unscheduled_sports_shadow_lifecycle_triggers(integer);

CREATE FUNCTION public.find_unscheduled_sports_shadow_lifecycle_triggers(p_limit integer)
RETURNS TABLE (id uuid, signal_id uuid, source_fill_id uuid, venue text, match_id uuid, detected_at timestamptz, source_ts bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    t.id,
    t.signal_id,
    t.source_fill_id,
    m.venue,
    m.id AS match_id,
    t.detected_at,
    t.source_ts
  FROM public.sports_shadow_lifecycle_triggers t
  JOIN public.sports_market_matches m
    ON m.signal_id = t.signal_id
   AND m.match_status = 'EXACT'
   AND m.target_market_id IS NOT NULL
   AND m.selected_side IS NOT NULL
  WHERE EXISTS (
    SELECT 1
    FROM unnest(ARRAY[0, 5000, 10000, 30000, 60000]::integer[]) AS d(requested_delay_ms)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.sports_quote_observations o
      WHERE o.trigger_source_fill_id = t.id
        AND o.venue = m.venue
        AND o.requested_delay_ms = d.requested_delay_ms
    )
  )
  ORDER BY
    t.detected_at ASC,
    t.id ASC,
    CASE m.venue WHEN 'PMUS' THEN 0 WHEN 'KALSHI' THEN 1 ELSE 2 END,
    m.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 0), 100);
$$;

REVOKE ALL ON FUNCTION public.find_unscheduled_sports_shadow_lifecycle_triggers(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_unscheduled_sports_shadow_lifecycle_triggers(integer) TO service_role;
