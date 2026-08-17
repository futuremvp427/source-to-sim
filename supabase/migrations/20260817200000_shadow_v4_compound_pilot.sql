-- SHADOW V4 COMPOUND PILOT: HighTempTation.
--
-- Adds condition_id to get_pending_experiment_source_events (a new trailing
-- output column only — every existing column, filter and ordering clause is
-- byte-identical to the prior definition) so compound sizing can group a
-- fill's market by its real condition_id instead of by asset alone. Existing
-- dynamic-v1 experiments never read this column, so this is a no-op for them.
--
-- Then seeds exactly one new, independent PAPER experiment. It does not
-- modify SHADOW V2: HighTempTation, SHADOW V3 CAPACITY: HighTempTation, or
-- any other experiment row.

-- PostgreSQL does not allow CREATE OR REPLACE to add an output column to a
-- RETURNS TABLE function (it errors "cannot change return type of existing
-- function"), so the old shape must be dropped first. Safe here: nothing else
-- in the schema depends on this function's row type, and it is recreated
-- with the identical signature (uuid, integer) plus GRANT/REVOKE immediately
-- after, in this same migration.
DROP FUNCTION IF EXISTS public.get_pending_experiment_source_events(uuid, integer);

CREATE FUNCTION public.get_pending_experiment_source_events(
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
  first_seen_at timestamptz,
  condition_id text
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
    pending.first_seen_at,
    pending.condition_id
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
      se.first_seen_at,
      se.condition_id
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

-- Idempotent, one-time seed. ON CONFLICT (name) DO NOTHING means a later
-- migration replay or app restart can never reset this experiment's money,
-- timestamps, or realized P&L once it exists.
INSERT INTO public.paper_experiments (
  name,
  wallet_address,
  starting_cash,
  cash,
  buy_amount,
  poll_interval_seconds,
  enabled,
  weather_only,
  market_scope,
  realized_pnl,
  simulated,
  sizing_rule,
  follow_from_ts
)
VALUES (
  'SHADOW V4 COMPOUND PILOT: HighTempTation',
  '0x6011655c4afb76f36dd1b08a137a1ba73466b31e',
  433.36108,
  433.36108,
  5,
  60,
  true,
  false,
  'ALL',
  0,
  true,
  'compound-v2-pilot',
  1786996047::bigint
)
ON CONFLICT (name) DO NOTHING;
