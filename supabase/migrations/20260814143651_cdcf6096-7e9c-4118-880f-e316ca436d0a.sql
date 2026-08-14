CREATE OR REPLACE FUNCTION public.get_pending_experiment_source_events(
  p_experiment_id uuid,
  p_limit integer DEFAULT 300
)
RETURNS TABLE(
  id uuid,
  event_key text,
  asset text,
  market_title text,
  outcome text,
  side text,
  shares numeric,
  price numeric,
  source_ts bigint,
  first_seen_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    pending.id,
    pending.event_key,
    pending.asset,
    pending.market_title,
    pending.outcome,
    pending.side,
    pending.shares,
    pending.price,
    pending.source_ts,
    pending.first_seen_at
  FROM public.paper_experiments pe
  CROSS JOIN LATERAL (
    WITH pending_keys AS MATERIALIZED (
      SELECT
        se.source_ts,
        se.event_key
      FROM public.source_events se
      WHERE se.wallet = lower(pe.wallet_address)
        AND NOT EXISTS (
          SELECT 1
          FROM public.experiment_event_state ees
          WHERE ees.experiment_id = pe.id
            AND ees.event_key = se.event_key
        )
      ORDER BY se.source_ts ASC, se.event_key ASC
      LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 300), 2000))
    )
    SELECT
      se.id,
      se.event_key,
      se.asset,
      se.market_title,
      se.outcome,
      se.side,
      se.shares,
      se.price,
      se.source_ts,
      se.first_seen_at
    FROM pending_keys keys
    JOIN public.source_events se
      ON se.wallet = lower(pe.wallet_address)
     AND se.event_key = keys.event_key
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.experiment_event_state ees
      WHERE ees.experiment_id = pe.id
        AND ees.source_event_id = se.id
    )
    ORDER BY keys.source_ts ASC, keys.event_key ASC
  ) AS pending
  WHERE pe.id = p_experiment_id
  ORDER BY pending.source_ts ASC, pending.event_key ASC;
$function$;

REVOKE ALL ON FUNCTION public.get_pending_experiment_source_events(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_pending_experiment_source_events(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.get_pending_experiment_source_events(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_pending_experiment_source_events(uuid, integer) TO service_role;