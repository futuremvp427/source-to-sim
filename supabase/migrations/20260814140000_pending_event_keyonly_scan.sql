-- Production reliability: keep get_pending_experiment_source_events exact while
-- avoiding heap reads across a long already-consumed prefix.
--
-- source_events has a unique (wallet, event_key) identity and
-- experiment_event_state has a unique (experiment_id, event_key) identity.
-- The first pass therefore needs only keys already present in the existing
-- source_events_wallet_order_idx and the experiment/event-key unique index.
-- Full source-event payloads are fetched only for the bounded pending result.
--
-- The MATERIALIZED boundary is intentional: it prevents the planner from
-- pulling the wide source_events payload back into the prefix scan.  The final
-- source_event_id check is a cheap defensive re-check over <= p_limit rows and
-- preserves source-event identity as the authoritative consumption invariant.

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
  WITH experiment AS MATERIALIZED (
    SELECT pe.id, lower(pe.wallet_address) AS wallet
    FROM public.paper_experiments pe
    WHERE pe.id = p_experiment_id
  ),
  pending_keys AS MATERIALIZED (
    SELECT
      exp.wallet,
      se.source_ts,
      se.event_key
    FROM experiment exp
    JOIN public.source_events se
      ON se.wallet = exp.wallet
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.experiment_event_state ees
      WHERE ees.experiment_id = exp.id
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
  FROM pending_keys pending
  JOIN public.source_events se
    ON se.wallet = pending.wallet
   AND se.event_key = pending.event_key
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.experiment_event_state ees
    WHERE ees.experiment_id = p_experiment_id
      AND ees.source_event_id = se.id
  )
  ORDER BY pending.source_ts ASC, pending.event_key ASC;
$function$;

REVOKE ALL ON FUNCTION public.get_pending_experiment_source_events(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_pending_experiment_source_events(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.get_pending_experiment_source_events(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_pending_experiment_source_events(uuid, integer) TO service_role;
