-- Phase 1: experiment-scoped source-event consumption.
--
-- source_events is the immutable wallet-level event stream. Consumption state
-- must belong to (experiment, source_event), never to the shared source row.
-- Existing experiment history is preserved: rows that were already globally
-- processed before this migration are seeded as legacy-consumed for every
-- existing experiment following that wallet. We do NOT retroactively replay
-- missed historical decisions into contaminated V2/V3 ledgers.

CREATE TABLE public.experiment_event_state (
  experiment_id uuid NOT NULL REFERENCES public.paper_experiments(id) ON DELETE CASCADE,
  source_event_id uuid NOT NULL REFERENCES public.source_events(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  backfilled boolean NOT NULL DEFAULT false,
  legacy_seeded boolean NOT NULL DEFAULT false,
  PRIMARY KEY (experiment_id, source_event_id),
  UNIQUE (experiment_id, event_key)
);

CREATE INDEX experiment_event_state_processed_idx
  ON public.experiment_event_state (experiment_id, processed_at DESC);

GRANT ALL ON public.experiment_event_state TO service_role;
ALTER TABLE public.experiment_event_state ENABLE ROW LEVEL SECURITY;

-- Source-position state used for copy decisions is experiment-scoped as well.
-- A shared wallet-level compact row can be ahead of (or behind) any individual
-- experiment and therefore cannot safely provide sourceSharesBefore once two
-- experiments consume the same immutable event stream independently.
CREATE TABLE public.experiment_source_position_state (
  experiment_id uuid NOT NULL REFERENCES public.paper_experiments(id) ON DELETE CASCADE,
  asset text NOT NULL,
  wallet text NOT NULL,
  market_title text,
  outcome text,
  shares numeric NOT NULL DEFAULT 0,
  last_event_key text,
  last_event_ts bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment_id, asset)
);

CREATE INDEX experiment_source_position_wallet_idx
  ON public.experiment_source_position_state (wallet, experiment_id);

GRANT ALL ON public.experiment_source_position_state TO service_role;
ALTER TABLE public.experiment_source_position_state ENABLE ROW LEVEL SECURITY;

-- The exact pending scan is wallet + chronological source stream anti-joined
-- against the experiment's own consumption state.
CREATE INDEX source_events_wallet_order_idx
  ON public.source_events (wallet, source_ts ASC, event_key ASC);

-- Preserve all historical source state exactly as it stood at migration time.
-- A globally processed source event may have been seen by only one same-wallet
-- experiment; seeding it for every existing experiment is intentional because
-- historical contaminated ledgers must not be silently rewritten after the fix.
INSERT INTO public.experiment_event_state (
  experiment_id, source_event_id, event_key, processed_at, backfilled, legacy_seeded
)
SELECT
  pe.id,
  se.id,
  se.event_key,
  COALESCE(se.processed_at, now()),
  COALESCE(se.backfilled, false),
  true
FROM public.paper_experiments pe
JOIN public.source_events se
  ON se.wallet = lower(pe.wallet_address)
WHERE se.processed_at IS NOT NULL
ON CONFLICT DO NOTHING;

-- Seed each existing experiment's leader/source position from the current
-- reconciled wallet-level compact state. Future events advance these rows only
-- for that experiment.
INSERT INTO public.experiment_source_position_state (
  experiment_id, asset, wallet, market_title, outcome, shares,
  last_event_key, last_event_ts, updated_at
)
SELECT
  pe.id,
  sps.asset,
  lower(pe.wallet_address),
  sps.market_title,
  sps.outcome,
  sps.shares,
  sps.last_event_key,
  sps.last_event_ts,
  now()
FROM public.paper_experiments pe
JOIN public.source_position_state sps
  ON sps.wallet = lower(pe.wallet_address)
ON CONFLICT (experiment_id, asset) DO NOTHING;

-- Returns only events this experiment has not consumed. This is deliberately a
-- database anti-join rather than a client-side fetched-ID set, so coverage stays
-- correct as the event/state tables grow.
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
SET search_path = public
AS $$
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
  FROM public.paper_experiments pe
  JOIN public.source_events se
    ON se.wallet = lower(pe.wallet_address)
  WHERE pe.id = p_experiment_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.experiment_event_state ees
      WHERE ees.experiment_id = pe.id
        AND ees.source_event_id = se.id
    )
  ORDER BY se.source_ts ASC, se.event_key ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 300), 2000));
$$;

REVOKE ALL ON FUNCTION public.get_pending_experiment_source_events(uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pending_experiment_source_events(uuid, integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.get_experiment_source_positions(
  p_experiment_id uuid,
  p_assets text[]
)
RETURNS TABLE(asset text, shares numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT esps.asset, esps.shares
  FROM public.experiment_source_position_state esps
  WHERE esps.experiment_id = p_experiment_id
    AND esps.asset = ANY(COALESCE(p_assets, ARRAY[]::text[]));
$$;

REVOKE ALL ON FUNCTION public.get_experiment_source_positions(uuid, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_experiment_source_positions(uuid, text[])
  TO service_role;

-- Atomic paper processing now gates the whole transaction on the experiment's
-- own event-state row. Retrying the same source event for the same experiment is
-- a no-op; a different experiment may process the same immutable source event.
CREATE OR REPLACE FUNCTION public.process_source_event_atomic(
  p_lock_id text,
  p_worker_id text,
  p_fence integer,
  p_experiment_id uuid,
  p_event jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_held boolean;
  v_trade jsonb := NULLIF(p_event->'trade', 'null'::jsonb);
  v_audit jsonb := NULLIF(p_event->'audit', 'null'::jsonb);
  v_src   jsonb := NULLIF(p_event->'source_state', 'null'::jsonb);
  v_pos   jsonb := NULLIF(p_event->'paper_position', 'null'::jsonb);
  v_exp   jsonb := NULLIF(p_event->'experiment', 'null'::jsonb);
  v_now timestamptz := now();
  v_applied boolean := false;
  v_inserted uuid;
  v_state_inserted uuid;
  v_source_event_id uuid := NULLIF(p_event->>'source_event_id','')::uuid;
  v_event_key text;
  v_wallet text;
BEGIN
  -- Fence check remains inside the same transaction as every mutation.
  SELECT true INTO v_held
    FROM public.worker_status
   WHERE id = p_lock_id
     AND worker_id = p_worker_id
     AND fence = p_fence
     AND lease_expires_at IS NOT NULL
     AND lease_expires_at > v_now
   FOR UPDATE;

  IF v_held IS NOT TRUE THEN
    RAISE EXCEPTION 'stale_fence: lease % is not held by % at fence %', p_lock_id, p_worker_id, p_fence;
  END IF;

  -- Never let a caller attach another wallet's source event to an experiment.
  SELECT se.event_key, se.wallet
    INTO v_event_key, v_wallet
    FROM public.source_events se
    JOIN public.paper_experiments pe
      ON pe.id = p_experiment_id
     AND se.wallet = lower(pe.wallet_address)
   WHERE se.id = v_source_event_id;

  IF v_event_key IS NULL THEN
    RAISE EXCEPTION 'source_event_mismatch: event % does not belong to experiment %',
      v_source_event_id, p_experiment_id;
  END IF;

  INSERT INTO public.experiment_event_state (
    experiment_id, source_event_id, event_key, processed_at, backfilled, legacy_seeded
  ) VALUES (
    p_experiment_id,
    v_source_event_id,
    v_event_key,
    v_now,
    COALESCE((p_event->>'backfilled')::boolean, false),
    false
  )
  ON CONFLICT (experiment_id, source_event_id) DO NOTHING
  RETURNING source_event_id INTO v_state_inserted;

  IF v_state_inserted IS NULL THEN
    RETURN jsonb_build_object('processed', false, 'applied', false);
  END IF;

  IF v_trade IS NOT NULL THEN
    INSERT INTO public.paper_trades (
      experiment_id, source_event_id, event_key, action, side, asset, market_title,
      outcome, price, shares, notional, reason, cash_after, realized_pnl, source_ts
    ) VALUES (
      p_experiment_id,
      NULLIF(v_trade->>'source_event_id','')::uuid,
      v_trade->>'event_key',
      v_trade->>'action',
      v_trade->>'side',
      v_trade->>'asset',
      v_trade->>'market_title',
      v_trade->>'outcome',
      NULLIF(v_trade->>'price','')::numeric,
      COALESCE(NULLIF(v_trade->>'shares','')::numeric, 0),
      COALESCE(NULLIF(v_trade->>'notional','')::numeric, 0),
      v_trade->>'reason',
      NULLIF(v_trade->>'cash_after','')::numeric,
      COALESCE(NULLIF(v_trade->>'realized_pnl','')::numeric, 0),
      NULLIF(v_trade->>'source_ts','')::bigint
    )
    ON CONFLICT (experiment_id, event_key) DO NOTHING
    RETURNING id INTO v_inserted;
    v_applied := v_inserted IS NOT NULL;
  END IF;

  -- Leader/source state is now experiment-scoped. The wallet-level compact
  -- table is maintained only by reconciliation and is never a paper-decision
  -- dependency again.
  IF v_src IS NOT NULL THEN
    INSERT INTO public.experiment_source_position_state (
      experiment_id, asset, wallet, market_title, outcome, shares,
      last_event_key, last_event_ts, updated_at
    ) VALUES (
      p_experiment_id,
      v_src->>'asset',
      v_wallet,
      v_src->>'market_title',
      v_src->>'outcome',
      COALESCE(NULLIF(v_src->>'shares','')::numeric, 0),
      v_src->>'last_event_key',
      NULLIF(v_src->>'last_event_ts','')::bigint,
      v_now
    )
    ON CONFLICT (experiment_id, asset) DO UPDATE SET
      wallet = EXCLUDED.wallet,
      market_title = COALESCE(EXCLUDED.market_title, public.experiment_source_position_state.market_title),
      outcome = COALESCE(EXCLUDED.outcome, public.experiment_source_position_state.outcome),
      shares = EXCLUDED.shares,
      last_event_key = EXCLUDED.last_event_key,
      last_event_ts = EXCLUDED.last_event_ts,
      updated_at = v_now;
  END IF;

  -- Paper book, bankroll and P&L only move when this event's paper_trades row
  -- was newly applied. This preserves legacy idempotency during migration.
  IF v_applied AND v_pos IS NOT NULL THEN
    INSERT INTO public.paper_positions (
      experiment_id, asset, market_title, outcome, shares, cost_basis, avg_price,
      realized_pnl, settlement_status, last_activity_ts, updated_at
    ) VALUES (
      p_experiment_id, v_pos->>'asset', v_pos->>'market_title', v_pos->>'outcome',
      COALESCE(NULLIF(v_pos->>'shares','')::numeric, 0),
      COALESCE(NULLIF(v_pos->>'cost_basis','')::numeric, 0),
      COALESCE(NULLIF(v_pos->>'avg_price','')::numeric, 0),
      COALESCE(NULLIF(v_pos->>'realized_pnl','')::numeric, 0),
      v_pos->>'settlement_status',
      NULLIF(v_pos->>'last_activity_ts','')::bigint,
      v_now
    )
    ON CONFLICT (experiment_id, asset) DO UPDATE SET
      market_title = COALESCE(EXCLUDED.market_title, public.paper_positions.market_title),
      outcome = COALESCE(EXCLUDED.outcome, public.paper_positions.outcome),
      shares = EXCLUDED.shares,
      cost_basis = EXCLUDED.cost_basis,
      avg_price = EXCLUDED.avg_price,
      realized_pnl = EXCLUDED.realized_pnl,
      settlement_status = EXCLUDED.settlement_status,
      last_activity_ts = EXCLUDED.last_activity_ts,
      updated_at = v_now;
  END IF;

  IF v_applied AND v_exp IS NOT NULL THEN
    UPDATE public.paper_experiments
       SET cash = COALESCE(NULLIF(v_exp->>'cash','')::numeric, cash),
           realized_pnl = COALESCE(NULLIF(v_exp->>'realized_pnl','')::numeric, realized_pnl),
           updated_at = v_now
     WHERE id = p_experiment_id;
  END IF;

  IF v_audit IS NOT NULL THEN
    INSERT INTO public.pipeline_audit (
      experiment_id, event_key, wallet, market_title, side, action, source_ts,
      detected_at, event_persisted_at, decision_at, paper_trade_at, position_updated_at,
      detection_latency_seconds, decision_latency_seconds, total_latency_seconds
    ) VALUES (
      p_experiment_id, v_audit->>'event_key', v_wallet, v_audit->>'market_title',
      v_audit->>'side', v_audit->>'action', NULLIF(v_audit->>'source_ts','')::bigint,
      NULLIF(v_audit->>'detected_at','')::timestamptz,
      NULLIF(v_audit->>'event_persisted_at','')::timestamptz,
      NULLIF(v_audit->>'decision_at','')::timestamptz,
      NULLIF(v_audit->>'paper_trade_at','')::timestamptz,
      NULLIF(v_audit->>'position_updated_at','')::timestamptz,
      NULLIF(v_audit->>'detection_latency_seconds','')::numeric,
      NULLIF(v_audit->>'decision_latency_seconds','')::numeric,
      NULLIF(v_audit->>'total_latency_seconds','')::numeric
    )
    ON CONFLICT (experiment_id, event_key) DO NOTHING;
  END IF;

  -- Intentionally DO NOT mutate source_events.processed_at. That column remains
  -- legacy provenance only; current consumption is experiment_event_state.
  RETURN jsonb_build_object('processed', true, 'applied', v_applied);
END;
$$;

REVOKE ALL ON FUNCTION public.process_source_event_atomic(text, text, integer, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_source_event_atomic(text, text, integer, uuid, jsonb)
  TO service_role;

-- The temporary one-enabled-experiment-per-wallet guard is no longer the safety
-- mechanism. Event consumption and source state are both experiment-scoped now.
DROP INDEX IF EXISTS public.paper_experiments_one_enabled_per_wallet;
