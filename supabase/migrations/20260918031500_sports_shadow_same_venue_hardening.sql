-- Hardening + settlement runner for SAME_VENUE_KALSHI paper research.
-- Additive only. No live-order state or cross-venue tables are changed.

ALTER TABLE public.sports_shadow_kalshi_settlements
  ADD COLUMN IF NOT EXISTS next_check_at timestamptz,
  ADD COLUMN IF NOT EXISTS check_attempt_count integer NOT NULL DEFAULT 0
    CHECK (check_attempt_count >= 0);

-- Admission is idempotent across BOTH uniqueness invariants. If an event_key and
-- (trader_id, source_trade_id) ever point at different rows, fail closed rather
-- than silently treating an identity collision as a duplicate.
CREATE OR REPLACE FUNCTION public.admit_sports_shadow_kalshi_source_event(
  p_event_key text,
  p_trader_id text,
  p_source_trade_id text,
  p_market_ticker text,
  p_contract_side text,
  p_action text,
  p_quantity numeric,
  p_source_price numeric,
  p_source_price_cents integer,
  p_source_ts bigint,
  p_detected_at timestamptz,
  p_source_name text DEFAULT NULL,
  p_experiment_epoch_id uuid DEFAULT NULL,
  p_raw jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_status text;
  v_event_key text;
  v_trader_id text;
  v_source_trade_id text;
BEGIN
  INSERT INTO public.sports_shadow_kalshi_source_events (
    event_key, trader_id, source_trade_id, market_ticker, contract_side, action,
    quantity, source_price, source_price_cents, source_ts, detected_at,
    source_name, experiment_epoch_id, raw
  ) VALUES (
    p_event_key, p_trader_id, p_source_trade_id, p_market_ticker, p_contract_side, p_action,
    p_quantity, p_source_price, p_source_price_cents, p_source_ts, p_detected_at,
    p_source_name, p_experiment_epoch_id, p_raw
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('admitted', true, 'duplicate', false, 'id', v_id);
  END IF;

  SELECT id, status, event_key, trader_id, source_trade_id
  INTO v_id, v_status, v_event_key, v_trader_id, v_source_trade_id
  FROM public.sports_shadow_kalshi_source_events
  WHERE event_key = p_event_key
     OR (trader_id = p_trader_id AND source_trade_id = p_source_trade_id)
  ORDER BY CASE WHEN event_key = p_event_key THEN 0 ELSE 1 END
  LIMIT 1;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'same-venue source event conflict occurred but no existing row was found';
  END IF;

  IF v_event_key <> p_event_key
     OR v_trader_id <> p_trader_id
     OR v_source_trade_id <> p_source_trade_id THEN
    RAISE EXCEPTION 'same-venue source event identity collision';
  END IF;

  RETURN jsonb_build_object('admitted', false, 'duplicate', true, 'id', v_id, 'status', v_status);
END;
$$;

-- Crash recovery: a worker may die after PENDING -> PROCESSING. Reclaim only rows
-- whose claim is at least 15 minutes old. Per-event/per-tier fill uniqueness still
-- makes a partially completed retry idempotent.
CREATE OR REPLACE FUNCTION public.claim_sports_shadow_kalshi_source_events(
  p_worker_id text,
  p_limit integer DEFAULT 25
)
RETURNS SETOF public.sports_shadow_kalshi_source_events
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH claimed AS (
    SELECT id
    FROM public.sports_shadow_kalshi_source_events
    WHERE status = 'PENDING'
       OR (
         status = 'PROCESSING'
         AND claimed_at IS NOT NULL
         AND claimed_at < now() - interval '15 minutes'
       )
    ORDER BY source_ts ASC, created_at ASC
    LIMIT GREATEST(1, LEAST(p_limit, 200))
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.sports_shadow_kalshi_source_events e
  SET status = 'PROCESSING',
      claimed_by = p_worker_id,
      claimed_at = now(),
      status_reason = NULL
  WHERE e.id IN (SELECT id FROM claimed)
  RETURNING e.*;
$$;

-- Keep realized_pnl_usd GROSS and fees_usd separate. This avoids double-charging
-- exit fees later when settlement computes net P&L = gross P&L - total fees.
CREATE OR REPLACE FUNCTION public.finalize_sports_shadow_kalshi_paper_fill(
  p_source_event_id uuid,
  p_trader_id text,
  p_market_ticker text,
  p_contract_side text,
  p_action text,
  p_notional_tier_usd numeric,
  p_contracts numeric,
  p_vwap numeric,
  p_fee_usd numeric,
  p_fee_model_version text,
  p_all_in_cost_usd numeric,
  p_fill_status text,
  p_reject_reason text,
  p_book_observed_at timestamptz,
  p_book_stale_reason text,
  p_episode_key text,
  p_source_ts bigint,
  p_detected_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fill_id uuid;
  v_open numeric;
  v_avg numeric;
  v_sell numeric;
BEGIN
  INSERT INTO public.sports_shadow_kalshi_paper_fills (
    source_event_id, trader_id, market_ticker, contract_side, action, notional_tier_usd,
    contracts, vwap, fee_usd, fee_model_version, all_in_cost_usd, fill_status,
    reject_reason, book_observed_at, book_stale_reason, episode_key, source_ts, detected_at
  ) VALUES (
    p_source_event_id, p_trader_id, p_market_ticker, p_contract_side, p_action, p_notional_tier_usd,
    COALESCE(p_contracts, 0), p_vwap, p_fee_usd, p_fee_model_version, p_all_in_cost_usd, p_fill_status,
    p_reject_reason, p_book_observed_at, p_book_stale_reason, p_episode_key, p_source_ts, p_detected_at
  )
  ON CONFLICT (source_event_id, notional_tier_usd) DO NOTHING
  RETURNING id INTO v_fill_id;

  IF v_fill_id IS NULL THEN
    RETURN false;
  END IF;

  IF COALESCE(p_contracts, 0) <= 0 THEN
    RETURN true;
  END IF;

  IF p_action IN ('ENTRY', 'ADD') THEN
    INSERT INTO public.sports_shadow_kalshi_paper_positions (
      trader_id, market_ticker, contract_side, notional_tier_usd,
      contracts_open, avg_entry_price, fees_usd, status, updated_at
    ) VALUES (
      p_trader_id, p_market_ticker, p_contract_side, p_notional_tier_usd,
      p_contracts, p_vwap, COALESCE(p_fee_usd, 0), 'OPEN', now()
    )
    ON CONFLICT (trader_id, market_ticker, contract_side, notional_tier_usd) DO UPDATE
    SET contracts_open = public.sports_shadow_kalshi_paper_positions.contracts_open + EXCLUDED.contracts_open,
        avg_entry_price = CASE
          WHEN public.sports_shadow_kalshi_paper_positions.contracts_open + EXCLUDED.contracts_open > 0
          THEN (
            COALESCE(public.sports_shadow_kalshi_paper_positions.avg_entry_price, 0)
              * public.sports_shadow_kalshi_paper_positions.contracts_open
            + COALESCE(EXCLUDED.avg_entry_price, 0) * EXCLUDED.contracts_open
          ) / (public.sports_shadow_kalshi_paper_positions.contracts_open + EXCLUDED.contracts_open)
          ELSE public.sports_shadow_kalshi_paper_positions.avg_entry_price
        END,
        fees_usd = public.sports_shadow_kalshi_paper_positions.fees_usd + EXCLUDED.fees_usd,
        status = 'OPEN',
        updated_at = now();
    RETURN true;
  END IF;

  SELECT contracts_open, avg_entry_price
  INTO v_open, v_avg
  FROM public.sports_shadow_kalshi_paper_positions
  WHERE trader_id = p_trader_id
    AND market_ticker = p_market_ticker
    AND contract_side = p_contract_side
    AND notional_tier_usd = p_notional_tier_usd
  FOR UPDATE;

  IF v_open IS NULL OR v_open <= 0 THEN
    RETURN true;
  END IF;

  v_sell := LEAST(p_contracts, v_open);

  UPDATE public.sports_shadow_kalshi_paper_positions
  SET contracts_open = v_open - v_sell,
      realized_pnl_usd = realized_pnl_usd
        + (COALESCE(p_vwap, 0) - COALESCE(v_avg, 0)) * v_sell,
      fees_usd = fees_usd + COALESCE(p_fee_usd, 0),
      status = CASE WHEN v_open - v_sell <= 0 THEN 'CLOSED' ELSE 'OPEN' END,
      updated_at = now()
  WHERE trader_id = p_trader_id
    AND market_ticker = p_market_ticker
    AND contract_side = p_contract_side
    AND notional_tier_usd = p_notional_tier_usd;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.find_open_sports_shadow_kalshi_positions(
  p_limit integer DEFAULT 50
)
RETURNS TABLE (
  trader_id text,
  market_ticker text,
  contract_side text,
  notional_tier_usd numeric,
  contracts_open numeric,
  avg_entry_price numeric,
  realized_pnl_usd numeric,
  fees_usd numeric,
  check_attempt_count integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.trader_id,
    p.market_ticker,
    p.contract_side,
    p.notional_tier_usd,
    p.contracts_open,
    p.avg_entry_price,
    p.realized_pnl_usd,
    p.fees_usd,
    COALESCE(s.check_attempt_count, 0)
  FROM public.sports_shadow_kalshi_paper_positions p
  LEFT JOIN public.sports_shadow_kalshi_settlements s
    ON s.trader_id = p.trader_id
   AND s.market_ticker = p.market_ticker
   AND s.contract_side = p.contract_side
   AND s.notional_tier_usd = p.notional_tier_usd
  WHERE p.status = 'OPEN'
    AND p.contracts_open > 0
    AND (
      s.id IS NULL
      OR (
        s.settlement_status = 'PENDING'
        AND (s.next_check_at IS NULL OR s.next_check_at <= now())
      )
    )
  ORDER BY p.updated_at ASC
  LIMIT GREATEST(1, LEAST(p_limit, 200));
$$;

CREATE OR REPLACE FUNCTION public.finalize_sports_shadow_kalshi_settlement(
  p_trader_id text,
  p_market_ticker text,
  p_contract_side text,
  p_notional_tier_usd numeric,
  p_settlement_status text,
  p_settlement_timestamp timestamptz,
  p_settlement_value numeric,
  p_settlement_source text,
  p_gross_pnl_usd numeric,
  p_total_fees_usd numeric,
  p_net_pnl_usd numeric,
  p_next_check_at timestamptz,
  p_check_attempt_count integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.sports_shadow_kalshi_settlements (
    trader_id, market_ticker, contract_side, notional_tier_usd,
    settlement_status, settlement_timestamp, settlement_value, settlement_source,
    gross_pnl_usd, total_fees_usd, net_pnl_usd,
    next_check_at, check_attempt_count, updated_at
  ) VALUES (
    p_trader_id, p_market_ticker, p_contract_side, p_notional_tier_usd,
    p_settlement_status, p_settlement_timestamp, p_settlement_value, p_settlement_source,
    p_gross_pnl_usd, COALESCE(p_total_fees_usd, 0), p_net_pnl_usd,
    p_next_check_at, GREATEST(0, p_check_attempt_count), now()
  )
  ON CONFLICT (trader_id, market_ticker, contract_side, notional_tier_usd) DO UPDATE
  SET settlement_status = EXCLUDED.settlement_status,
      settlement_timestamp = EXCLUDED.settlement_timestamp,
      settlement_value = EXCLUDED.settlement_value,
      settlement_source = EXCLUDED.settlement_source,
      gross_pnl_usd = EXCLUDED.gross_pnl_usd,
      total_fees_usd = EXCLUDED.total_fees_usd,
      net_pnl_usd = EXCLUDED.net_pnl_usd,
      next_check_at = EXCLUDED.next_check_at,
      check_attempt_count = EXCLUDED.check_attempt_count,
      updated_at = now();

  IF p_settlement_status <> 'PENDING' THEN
    UPDATE public.sports_shadow_kalshi_paper_positions
    SET contracts_open = 0,
        realized_pnl_usd = COALESCE(p_gross_pnl_usd, realized_pnl_usd),
        status = 'CLOSED',
        updated_at = now()
    WHERE trader_id = p_trader_id
      AND market_ticker = p_market_ticker
      AND contract_side = p_contract_side
      AND notional_tier_usd = p_notional_tier_usd;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.admit_sports_shadow_kalshi_source_event(text,text,text,text,text,text,numeric,numeric,integer,bigint,timestamptz,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admit_sports_shadow_kalshi_source_event(text,text,text,text,text,text,numeric,numeric,integer,bigint,timestamptz,text,uuid,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.claim_sports_shadow_kalshi_source_events(text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_sports_shadow_kalshi_source_events(text,integer) TO service_role;
REVOKE ALL ON FUNCTION public.finalize_sports_shadow_kalshi_paper_fill(uuid,text,text,text,text,numeric,numeric,numeric,numeric,text,numeric,text,text,timestamptz,text,text,bigint,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_sports_shadow_kalshi_paper_fill(uuid,text,text,text,text,numeric,numeric,numeric,numeric,text,numeric,text,text,timestamptz,text,text,bigint,timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.find_open_sports_shadow_kalshi_positions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.find_open_sports_shadow_kalshi_positions(integer) TO service_role;
REVOKE ALL ON FUNCTION public.finalize_sports_shadow_kalshi_settlement(text,text,text,numeric,text,timestamptz,numeric,text,numeric,numeric,numeric,timestamptz,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_sports_shadow_kalshi_settlement(text,text,text,numeric,text,timestamptz,numeric,text,numeric,numeric,numeric,timestamptz,integer) TO service_role;
