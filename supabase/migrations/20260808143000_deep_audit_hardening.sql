-- Deep-audit hardening: notification delivery state,
-- one-active-experiment-per-wallet guard, and atomic paper settlement.

-- processed_at currently belongs to source_events, so two enabled experiments
-- for the same wallet would compete for the same processing bit. Fail closed at
-- the database boundary until processing state is normalized per experiment.
CREATE UNIQUE INDEX IF NOT EXISTS paper_experiments_one_enabled_per_wallet
  ON public.paper_experiments ((lower(wallet_address)))
  WHERE enabled = true;

-- Notification delivery needs an explicit claim/retry state. notified_at means
-- delivered, never merely attempted.
ALTER TABLE public.alerts
  ADD COLUMN IF NOT EXISTS notification_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS notification_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS notification_error text;
CREATE INDEX IF NOT EXISTS alerts_notification_retry_idx
  ON public.alerts (notification_status, notification_attempted_at, created_at)
  WHERE notified_at IS NULL;

-- Apply a verified settlement as one PostgreSQL transaction. The old sequence
-- inserted the idempotency row and then separately credited cash and closed the
-- position; a crash between those statements could permanently strand a
-- settlement because future passes saw the unique row and skipped it.
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
  v_position public.paper_positions%ROWTYPE;
  v_inserted_id uuid;
  v_payout numeric;
  v_realized numeric;
  v_status text;
BEGIN
  SELECT * INTO v_position
  FROM public.paper_positions
  WHERE experiment_id = p_experiment_id
    AND asset = p_asset
    AND settlement_status = 'open'
    AND shares > 0
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0::numeric, 0::numeric;
    RETURN;
  END IF;

  PERFORM 1
  FROM public.paper_experiments
  WHERE id = p_experiment_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'paper experiment not found';
  END IF;

  v_payout := round(v_position.shares * p_payout_per_share, 6);
  v_realized := round(v_payout - v_position.cost_basis, 6);
  v_status := CASE WHEN p_payout_per_share > 0 THEN 'settled_won' ELSE 'settled_lost' END;

  INSERT INTO public.paper_settlements (
    experiment_id, asset, market_title, outcome, condition_id,
    shares, cost_basis, resolution_outcome, resolution_source, resolution_ts,
    verified, payout, realized_pnl, evidence, settled_at
  ) VALUES (
    p_experiment_id, p_asset, v_position.market_title, v_position.outcome, p_condition_id,
    v_position.shares, v_position.cost_basis, p_resolution_outcome, p_resolution_source,
    p_resolution_ts, true, v_payout, v_realized, COALESCE(p_evidence, '{}'::jsonb), now()
  )
  ON CONFLICT (experiment_id, asset) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NULL THEN
    RETURN QUERY SELECT false, 0::numeric, 0::numeric;
    RETURN;
  END IF;

  UPDATE public.paper_experiments
  SET cash = cash + v_payout,
      realized_pnl = realized_pnl + v_realized,
      updated_at = now()
  WHERE id = p_experiment_id;

  UPDATE public.paper_positions
  SET shares = 0,
      cost_basis = 0,
      avg_price = 0,
      realized_pnl = realized_pnl + v_realized,
      mark = p_payout_per_share,
      mark_source = 'settlement',
      mark_ts = now(),
      settlement_status = v_status,
      updated_at = now()
  WHERE experiment_id = p_experiment_id
    AND asset = p_asset;

  RETURN QUERY SELECT true, v_payout, v_realized;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_verified_paper_settlement(uuid, text, text, text, text, timestamptz, numeric, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_verified_paper_settlement(uuid, text, text, text, text, timestamptz, numeric, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.apply_verified_paper_settlement(uuid, text, text, text, text, timestamptz, numeric, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_verified_paper_settlement(uuid, text, text, text, text, timestamptz, numeric, jsonb) TO service_role;
