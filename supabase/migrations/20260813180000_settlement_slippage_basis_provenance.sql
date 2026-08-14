-- Settlement basis provenance.
--
-- paper_settlements previously had no record of what slippage basis (if any)
-- was in effect at the moment a position settled. This adds four columns
-- persisted once, at settlement time, using the same prior-utc-day-v1
-- no-lookahead methodology as the Phase 2 observation panel (see
-- src/lib/observation/slippage-asof.ts): only observations strictly before
-- 00:00:00 UTC on the settlement's own day are eligible, capped at the same
-- sample limit. Legacy settlements applied before this migration keep these
-- columns NULL forever — their original basis cannot be proven and is never
-- retroactively invented or reconstructed from current data.
ALTER TABLE public.paper_settlements
  ADD COLUMN IF NOT EXISTS slippage_basis_cents numeric,
  ADD COLUMN IF NOT EXISTS slippage_sample_cutoff_at timestamptz,
  ADD COLUMN IF NOT EXISTS slippage_sample_count integer,
  ADD COLUMN IF NOT EXISTS slippage_method_version text;

-- The parameter list is changing, so CREATE OR REPLACE (same identity) would
-- create a second overload instead of replacing this function; drop the old
-- signature explicitly first.
DROP FUNCTION IF EXISTS public.apply_verified_paper_settlement(
  uuid, text, text, text, text, timestamptz, numeric, jsonb
);

CREATE FUNCTION public.apply_verified_paper_settlement(
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

  -- Lifecycle evidence only: realized_pnl is hardcoded to 0 so this row can
  -- never be mistaken for (or double-count) the real realization above.
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
