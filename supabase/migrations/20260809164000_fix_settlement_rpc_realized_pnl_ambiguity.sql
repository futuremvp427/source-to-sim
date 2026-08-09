-- Fix a runtime-only PL/pgSQL name collision in apply_verified_paper_settlement.
--
-- The function RETURNS TABLE(... realized_pnl numeric), which creates a PL/pgSQL
-- output variable named realized_pnl. The previous UPDATE expressions used the
-- unqualified name `realized_pnl` on the RHS, making it ambiguous with the
-- target table column. PostgreSQL can create the function successfully and then
-- raise the ambiguity only when the UPDATE path executes, rolling back the
-- settlement transaction. Qualifying the target-table columns removes that
-- ambiguity without changing any accounting semantics.

CREATE OR REPLACE FUNCTION public.apply_verified_paper_settlement(
  p_experiment_id uuid,
  p_asset text,
  p_condition_id text,
  p_resolution_outcome text,
  p_resolution_source text,
  p_resolution_ts timestamptz,
  p_payout_per_share numeric,
  p_evidence jsonb
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
    resolution_outcome, resolution_source, resolution_ts, verified, payout, realized_pnl, evidence
  ) VALUES (
    p_experiment_id, p_asset, v_pos.market_title, v_pos.outcome, p_condition_id,
    v_pos.shares, v_pos.cost_basis, p_resolution_outcome, p_resolution_source,
    COALESCE(p_resolution_ts, now()), true, v_payout, v_realized, COALESCE(p_evidence, '{}'::jsonb)
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
   WHERE pe.id = p_experiment_id;

  RETURN QUERY SELECT true, v_payout, v_realized;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_verified_paper_settlement(uuid, text, text, text, text, timestamptz, numeric, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_verified_paper_settlement(uuid, text, text, text, text, timestamptz, numeric, jsonb) TO service_role;
