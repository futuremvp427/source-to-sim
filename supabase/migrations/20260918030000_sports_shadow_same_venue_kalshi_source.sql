-- SAME-VENUE (Kalshi -> Kalshi) PAPER copy path: durable, ADDITIVE storage.
-- New tables rather than reuse: sports_shadow_paper_fills has NOT NULL signal_id and
-- UNIQUE (observation_id, notional_tier_usd) -- a same-venue event has no cross-venue
-- signal, no venue match row and no dual-venue observation, so reuse would overload those
-- semantics AND mix same-venue rows into historical cross-venue metrics that must stay
-- untouched. Nothing existing is altered. PAPER/RESEARCH ONLY.

CREATE TABLE public.sports_shadow_kalshi_trader_qualification (
  trader_id text NOT NULL PRIMARY KEY,
  display_handle text,
  approved_for_paper_copy boolean NOT NULL DEFAULT false,
  evidence jsonb,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.sports_shadow_kalshi_trader_qualification TO service_role;
ALTER TABLE public.sports_shadow_kalshi_trader_qualification ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.sports_shadow_kalshi_source_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  route text NOT NULL DEFAULT 'SAME_VENUE_KALSHI' CHECK (route = 'SAME_VENUE_KALSHI'),
  event_key text NOT NULL UNIQUE,
  trader_id text NOT NULL,
  source_trade_id text NOT NULL,
  market_ticker text NOT NULL,
  contract_side text NOT NULL CHECK (contract_side IN ('YES', 'NO')),
  action text NOT NULL CHECK (action IN ('BUY', 'SELL')),
  quantity numeric NOT NULL CHECK (quantity > 0),
  source_price numeric NOT NULL CHECK (source_price > 0 AND source_price <= 1),
  source_price_cents integer NOT NULL CHECK (source_price_cents BETWEEN 1 AND 99),
  source_ts bigint NOT NULL CHECK (source_ts > 0),
  detected_at timestamptz NOT NULL,
  source_name text,
  experiment_epoch_id uuid REFERENCES public.sports_shadow_experiment_epochs(id),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'PAPER_EXECUTED', 'SKIPPED', 'FAILED')),
  status_reason text,
  episode_key text,
  claimed_by text,
  claimed_at timestamptz,
  processed_at timestamptz,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trader_id, source_trade_id)
);
CREATE INDEX sports_shadow_kalshi_source_events_pending_idx
  ON public.sports_shadow_kalshi_source_events (status, source_ts, created_at);
CREATE INDEX sports_shadow_kalshi_source_events_position_idx
  ON public.sports_shadow_kalshi_source_events (trader_id, market_ticker, contract_side, source_ts);
GRANT ALL ON public.sports_shadow_kalshi_source_events TO service_role;
ALTER TABLE public.sports_shadow_kalshi_source_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.sports_shadow_kalshi_paper_fills (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source_event_id uuid NOT NULL REFERENCES public.sports_shadow_kalshi_source_events(id) ON DELETE CASCADE,
  trader_id text NOT NULL,
  market_ticker text NOT NULL,
  contract_side text NOT NULL CHECK (contract_side IN ('YES', 'NO')),
  action text NOT NULL CHECK (action IN ('ENTRY', 'ADD', 'EXIT')),
  notional_tier_usd numeric NOT NULL,
  contracts numeric NOT NULL DEFAULT 0,
  vwap numeric,
  fee_usd numeric,
  fee_model_version text,
  all_in_cost_usd numeric,
  fill_status text NOT NULL CHECK (fill_status IN ('FULL', 'PARTIAL', 'NONE', 'INVALID', 'REJECTED')),
  reject_reason text,
  book_observed_at timestamptz,
  book_stale_reason text,
  episode_key text,
  source_ts bigint NOT NULL,
  detected_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_event_id, notional_tier_usd)
);
CREATE INDEX sports_shadow_kalshi_paper_fills_position_idx
  ON public.sports_shadow_kalshi_paper_fills (trader_id, market_ticker, contract_side, notional_tier_usd);
GRANT ALL ON public.sports_shadow_kalshi_paper_fills TO service_role;
ALTER TABLE public.sports_shadow_kalshi_paper_fills ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.sports_shadow_kalshi_paper_positions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  trader_id text NOT NULL,
  market_ticker text NOT NULL,
  contract_side text NOT NULL CHECK (contract_side IN ('YES', 'NO')),
  notional_tier_usd numeric NOT NULL,
  contracts_open numeric NOT NULL DEFAULT 0 CHECK (contracts_open >= 0),
  avg_entry_price numeric,
  realized_pnl_usd numeric NOT NULL DEFAULT 0,
  fees_usd numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trader_id, market_ticker, contract_side, notional_tier_usd)
);
GRANT ALL ON public.sports_shadow_kalshi_paper_positions TO service_role;
ALTER TABLE public.sports_shadow_kalshi_paper_positions ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.sports_shadow_kalshi_settlements (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  trader_id text NOT NULL,
  market_ticker text NOT NULL,
  contract_side text NOT NULL CHECK (contract_side IN ('YES', 'NO')),
  notional_tier_usd numeric NOT NULL,
  settlement_status text NOT NULL DEFAULT 'PENDING'
    CHECK (settlement_status IN ('PENDING', 'SETTLED_WIN', 'SETTLED_LOSS', 'SETTLED_PUSH', 'VOID', 'CANCELED')),
  settlement_timestamp timestamptz,
  settlement_value numeric,
  settlement_source text,
  gross_pnl_usd numeric,
  total_fees_usd numeric,
  net_pnl_usd numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trader_id, market_ticker, contract_side, notional_tier_usd)
);
GRANT ALL ON public.sports_shadow_kalshi_settlements TO service_role;
ALTER TABLE public.sports_shadow_kalshi_settlements ENABLE ROW LEVEL SECURITY;

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
  ON CONFLICT (event_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('admitted', true, 'duplicate', false, 'id', v_id);
  END IF;

  SELECT id, status INTO v_id, v_status
  FROM public.sports_shadow_kalshi_source_events
  WHERE event_key = p_event_key;

  RETURN jsonb_build_object('admitted', false, 'duplicate', true, 'id', v_id, 'status', v_status);
END;
$$;

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
    ORDER BY source_ts ASC, created_at ASC
    LIMIT GREATEST(1, LEAST(p_limit, 200))
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.sports_shadow_kalshi_source_events e
  SET status = 'PROCESSING', claimed_by = p_worker_id, claimed_at = now()
  WHERE e.id IN (SELECT id FROM claimed)
  RETURNING e.*;
$$;

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
        + (COALESCE(p_vwap, 0) - COALESCE(v_avg, 0)) * v_sell
        - COALESCE(p_fee_usd, 0),
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