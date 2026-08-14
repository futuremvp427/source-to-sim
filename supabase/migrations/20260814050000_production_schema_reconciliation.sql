-- Production schema reconciliation.
--
-- Production drifted from the migration ledger: several migrations were
-- applied through Lovable's own schema sync without being recorded in
-- supabase_migrations.schema_migrations (confirmed live: acquire_worker_lease
-- already matches 20260809150500's fixed body; apply_verified_paper_settlement
-- already matches 20260809182705's ambiguity-fixed body; worker_status.stage_ms
-- already exists), and several others — starting with Phase 1
-- (20260813134500) — were never applied at all.
--
-- This migration brings the LIVE schema directly to the CURRENT desired final
-- state (matching supabase/schema-contract.json and every migration currently
-- in this repository), without passing through obsolete intermediate states:
--
--  * it does NOT (re)create paper_experiments_one_enabled_per_wallet (the
--    temporary wallet-global-consumption guard from 20260808143000): live
--    production already has multiple concurrently-enabled same-wallet
--    experiments (e.g. "SHADOW V2: badatmath." and "SHADOW V3 CAPACITY:
--    badatmath." both follow 0x8fbd...), so that guard would fail immediately
--    on creation, and Phase 1 drops it again anyway.
--  * it does NOT apply the intermediate 8-arg-plus-lifecycle-row version of
--    apply_verified_paper_settlement from 20260813160000: it goes straight to
--    the final 12-arg signature from 20260813180000, which already includes
--    the settlement lifecycle row and the slippage-basis provenance columns.
--  * it does NOT (re)create the obsolete three-column
--    alerts_notification_retry_idx from 20260808143000: it creates only the
--    two final partial indexes from 20260813170000 directly.
--
-- Every statement is guarded (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF
-- EXISTS) so this migration is a no-op on a database that already ran every
-- migration in this repository in order (this is what GitHub Audit CI's
-- clean-database replay verifies), and brings a drifted database like current
-- production to that identical final state.
--
-- No paper ledger, bankroll, cash, realized P&L, or source/settlement history
-- is modified, deleted, or replayed by this migration. The only rows inserted
-- are Phase 1's own legacy-seeded consumption/source-position state, exactly
-- as 20260813134500 already specifies.

-- ============================================================
-- From 20260808143000 (notification delivery state only — see
-- header note on the guard and settlement RPC that are intentionally
-- NOT replayed).
-- ============================================================
ALTER TABLE public.alerts
  ADD COLUMN IF NOT EXISTS notification_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS notification_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS notification_error text;

-- ============================================================
-- From 20260813134500: Phase 1 experiment-scoped source-event consumption.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.experiment_event_state (
  experiment_id uuid NOT NULL REFERENCES public.paper_experiments(id) ON DELETE CASCADE,
  source_event_id uuid NOT NULL REFERENCES public.source_events(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  backfilled boolean NOT NULL DEFAULT false,
  legacy_seeded boolean NOT NULL DEFAULT false,
  PRIMARY KEY (experiment_id, source_event_id),
  UNIQUE (experiment_id, event_key)
);

CREATE INDEX IF NOT EXISTS experiment_event_state_processed_idx
  ON public.experiment_event_state (experiment_id, processed_at DESC);

GRANT ALL ON public.experiment_event_state TO service_role;
ALTER TABLE public.experiment_event_state ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.experiment_source_position_state (
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

CREATE INDEX IF NOT EXISTS experiment_source_position_wallet_idx
  ON public.experiment_source_position_state (wallet, experiment_id);

GRANT ALL ON public.experiment_source_position_state TO service_role;
ALTER TABLE public.experiment_source_position_state ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS source_events_wallet_order_idx
  ON public.source_events (wallet, source_ts ASC, event_key ASC);

-- Legacy seeding, exactly as 20260813134500 specifies: preserve historical
-- state as it stands today. Never replays a decision into paper_trades, never
-- changes cash/P&L. ON CONFLICT DO NOTHING makes this idempotent regardless
-- of how much history accumulated under the old wallet-global mechanism
-- before this migration ran.
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

  -- Intentionally DO NOT mutate source_events.processed_at. That column
  -- remains legacy provenance only; current consumption is
  -- experiment_event_state.
  RETURN jsonb_build_object('processed', true, 'applied', v_applied);
END;
$$;

REVOKE ALL ON FUNCTION public.process_source_event_atomic(text, text, integer, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_source_event_atomic(text, text, integer, uuid, jsonb)
  TO service_role;

DROP INDEX IF EXISTS public.paper_experiments_one_enabled_per_wallet;

-- ============================================================
-- From 20260813141500: Phase 2 no-lookahead slippage index.
-- ============================================================
CREATE INDEX IF NOT EXISTS copyability_observations_experiment_observed_slippage_idx
  ON public.copyability_observations (experiment_id, observed_at DESC, id DESC)
  INCLUDE (slippage_cents)
  WHERE status = 'observed'
    AND observed_at IS NOT NULL
    AND slippage_cents IS NOT NULL;

-- ============================================================
-- From 20260813150000: Phase 6 copyability scheduling cursor.
-- ============================================================
ALTER TABLE public.paper_experiments
  ADD COLUMN IF NOT EXISTS copyability_cursor_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS copyability_cursor_id uuid;

CREATE INDEX IF NOT EXISTS paper_trades_experiment_created_id_idx
  ON public.paper_trades (experiment_id, created_at, id);

-- ============================================================
-- From 20260813170000: notification claim/retry indexes (final form —
-- the obsolete three-column alerts_notification_retry_idx from
-- 20260808143000 is intentionally never created in this reconciliation).
-- ============================================================
DROP INDEX IF EXISTS public.alerts_notification_retry_idx;

CREATE INDEX IF NOT EXISTS alerts_notification_stale_sending_idx
  ON public.alerts (notification_attempted_at)
  WHERE notified_at IS NULL AND notification_status = 'sending';

CREATE INDEX IF NOT EXISTS alerts_notification_pending_retry_idx
  ON public.alerts (created_at)
  WHERE notified_at IS NULL AND notification_status IN ('pending', 'failed');

-- ============================================================
-- From 20260813180000: settlement lifecycle row + slippage basis
-- provenance (final settlement RPC form — supersedes the intermediate
-- 8-arg-plus-lifecycle-row version from 20260813160000, which is
-- intentionally never applied on its own in this reconciliation).
-- ============================================================
ALTER TABLE public.paper_settlements
  ADD COLUMN IF NOT EXISTS slippage_basis_cents numeric,
  ADD COLUMN IF NOT EXISTS slippage_sample_cutoff_at timestamptz,
  ADD COLUMN IF NOT EXISTS slippage_sample_count integer,
  ADD COLUMN IF NOT EXISTS slippage_method_version text;

-- Drop whichever prior signature is live (the original 8-arg version, if
-- production had never been reconciled before). A no-op if only the 12-arg
-- version already exists.
DROP FUNCTION IF EXISTS public.apply_verified_paper_settlement(
  uuid, text, text, text, text, timestamptz, numeric, jsonb
);

-- CREATE OR REPLACE (not bare CREATE): the 12-arg version may already exist
-- on a database that ran 20260813180000 directly.
CREATE OR REPLACE FUNCTION public.apply_verified_paper_settlement(
  p_experiment_id uuid,
  p_asset text,
  p_condition_id text,
  p_resolution_outcome text,
  p_resolution_source text,
  p_resolution_ts timestamptz,
  p_payout_per_share numeric,
  p_evidence jsonb,
  p_slippage_basis_cents numeric DEFAULT NULL,
  p_slippage_sample_cutoff_at timestamptz DEFAULT NULL,
  p_slippage_sample_count integer DEFAULT NULL,
  p_slippage_method_version text DEFAULT NULL
)
RETURNS TABLE(applied boolean, payout numeric, realized_pnl numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pos public.paper_positions;
  v_payout numeric;
  v_realized numeric;
  v_inserted uuid;
  v_cash_after numeric;
BEGIN
  SELECT * INTO v_pos
    FROM public.paper_positions
   WHERE experiment_id = p_experiment_id
     AND asset = p_asset
     AND settlement_status = 'open'
     AND shares > 0
   FOR UPDATE;

  IF v_pos.id IS NULL THEN
    RETURN QUERY SELECT false, 0::numeric, 0::numeric;
    RETURN;
  END IF;

  v_payout := round(v_pos.shares * COALESCE(p_payout_per_share, 0), 2);
  v_realized := round(v_payout - v_pos.cost_basis, 2);

  INSERT INTO public.paper_settlements (
    experiment_id, asset, market_title, outcome, condition_id, shares, cost_basis,
    resolution_outcome, resolution_source, resolution_ts, verified, payout, realized_pnl, evidence,
    slippage_basis_cents, slippage_sample_cutoff_at, slippage_sample_count, slippage_method_version
  ) VALUES (
    p_experiment_id, p_asset, v_pos.market_title, v_pos.outcome, p_condition_id,
    v_pos.shares, v_pos.cost_basis, p_resolution_outcome, p_resolution_source,
    COALESCE(p_resolution_ts, now()), true, v_payout, v_realized, COALESCE(p_evidence, '{}'::jsonb),
    p_slippage_basis_cents, p_slippage_sample_cutoff_at, p_slippage_sample_count, p_slippage_method_version
  )
  ON CONFLICT (experiment_id, asset) DO NOTHING
  RETURNING id INTO v_inserted;

  IF v_inserted IS NULL THEN
    RETURN QUERY SELECT false, 0::numeric, 0::numeric;
    RETURN;
  END IF;

  UPDATE public.paper_positions AS pp
     SET shares = 0,
         cost_basis = 0,
         realized_pnl = round(pp.realized_pnl + v_realized, 2),
         settlement_status = CASE WHEN v_payout > 0 THEN 'settled_won' ELSE 'settled_lost' END,
         updated_at = now()
   WHERE pp.id = v_pos.id;

  UPDATE public.paper_experiments AS pe
     SET cash = round(pe.cash + v_payout, 2),
         realized_pnl = round(pe.realized_pnl + v_realized, 2),
         updated_at = now()
   WHERE pe.id = p_experiment_id
  RETURNING pe.cash INTO v_cash_after;

  INSERT INTO public.paper_trades (
    experiment_id, source_event_id, event_key, action, side, asset, market_title, outcome,
    price, shares, notional, reason, cash_after, realized_pnl, source_ts
  ) VALUES (
    p_experiment_id, NULL, 'settlement:' || p_asset, 'SETTLEMENT', NULL, p_asset,
    v_pos.market_title, v_pos.outcome, NULL, v_pos.shares, v_payout,
    'Settlement lifecycle evidence: ' || p_resolution_outcome || ' (payout $' || v_payout || ')',
    v_cash_after, 0, extract(epoch FROM COALESCE(p_resolution_ts, now()))::bigint
  )
  ON CONFLICT (experiment_id, event_key) DO NOTHING;

  RETURN QUERY SELECT true, v_payout, v_realized;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_verified_paper_settlement(
  uuid, text, text, text, text, timestamptz, numeric, jsonb, numeric, timestamptz, integer, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_verified_paper_settlement(
  uuid, text, text, text, text, timestamptz, numeric, jsonb, numeric, timestamptz, integer, text
) TO service_role;

-- ============================================================
-- From 20260813190000: Finding K worker telemetry.
-- ============================================================
ALTER TABLE public.worker_status
  ADD COLUMN IF NOT EXISTS last_poll_events_inserted integer NOT NULL DEFAULT 0;
