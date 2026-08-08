-- 1. Wallet-scoped source event identity
ALTER TABLE public.source_events DROP CONSTRAINT IF EXISTS source_events_event_key_key;
ALTER TABLE public.source_events
  ADD CONSTRAINT source_events_wallet_event_key_key UNIQUE (wallet, event_key);
CREATE INDEX IF NOT EXISTS source_events_wallet_pending_idx
  ON public.source_events (wallet, processed_at, source_ts);

-- 2. Wallet-scoped compatibility checks
ALTER TABLE public.compatibility_checks ADD COLUMN IF NOT EXISTS wallet text NOT NULL DEFAULT '';
UPDATE public.compatibility_checks c
   SET wallet = s.wallet
  FROM public.source_events s
 WHERE c.source_event_id = s.id AND c.wallet = '';
UPDATE public.compatibility_checks c
   SET wallet = s.wallet
  FROM public.source_events s
 WHERE c.wallet = '' AND s.event_key = c.event_key;
ALTER TABLE public.compatibility_checks DROP CONSTRAINT IF EXISTS compatibility_checks_event_key_key;
ALTER TABLE public.compatibility_checks
  ADD CONSTRAINT compatibility_checks_wallet_event_key_key UNIQUE (wallet, event_key);

-- 3. Atomic, lease-fenced processing of ONE source event.
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
BEGIN
  -- Fence check inside the same transaction as every mutation below.
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

  -- Source-side state always advances (history + reconciliation), even on SKIP.
  IF v_src IS NOT NULL THEN
    INSERT INTO public.source_position_state (
      wallet, asset, market_title, outcome, shares, last_event_key, last_event_ts, updated_at
    ) VALUES (
      v_src->>'wallet', v_src->>'asset', v_src->>'market_title', v_src->>'outcome',
      COALESCE(NULLIF(v_src->>'shares','')::numeric, 0),
      v_src->>'last_event_key',
      NULLIF(v_src->>'last_event_ts','')::bigint,
      v_now
    )
    ON CONFLICT (wallet, asset) DO UPDATE SET
      market_title = COALESCE(EXCLUDED.market_title, public.source_position_state.market_title),
      outcome = COALESCE(EXCLUDED.outcome, public.source_position_state.outcome),
      shares = EXCLUDED.shares,
      last_event_key = EXCLUDED.last_event_key,
      last_event_ts = EXCLUDED.last_event_ts,
      updated_at = v_now;
  END IF;

  -- Paper book, bankroll and P&L only move when this event's trade was newly applied.
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
      p_experiment_id, v_audit->>'event_key', v_audit->>'wallet', v_audit->>'market_title',
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

  UPDATE public.source_events
     SET processed_at = v_now,
         backfilled = CASE WHEN (p_event->>'backfilled')::boolean THEN true ELSE backfilled END
   WHERE id = (p_event->>'source_event_id')::uuid;

  RETURN jsonb_build_object('applied', v_applied);
END;
$$;

REVOKE ALL ON FUNCTION public.process_source_event_atomic(text, text, integer, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_source_event_atomic(text, text, integer, uuid, jsonb) TO service_role;