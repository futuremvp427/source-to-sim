-- Weather Lab: research/paper-only schema for the independent US intraday
-- weather value experiment.
--
-- ISOLATION: every object here is prefixed `weather_lab_` and is entirely
-- separate from Sports Shadow. No Sports Shadow table, function, trigger, cron
-- job or policy is read or written by this migration. The two systems share a
-- database and nothing else.
--
-- SAFETY: this schema has no concept of a live order. There is no venue
-- credential column, no order id, no submission status, and no enable-live
-- flag. `weather_lab_experiments.mode` is constrained to the single value
-- 'PAPER' at the database level, so a live row cannot be inserted even by a
-- caller that bypasses the application.
--
-- ACCESS: tables are granted to service_role and have RLS enabled with no
-- policies, matching the existing convention. anon/authenticated therefore read
-- nothing directly; the dashboard reads through server functions that use the
-- service-role client.

-- ---------------------------------------------------------------------------
-- Experiments. A strategy change is a NEW experiment, never an edit.
-- ---------------------------------------------------------------------------
CREATE TABLE public.weather_lab_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_key text NOT NULL UNIQUE,
  strategy_version text NOT NULL,
  -- Hash of the frozen config. Rows collected under a different hash may never
  -- be blended with these.
  config_hash text NOT NULL,
  config jsonb NOT NULL,
  mode text NOT NULL DEFAULT 'PAPER',
  status text NOT NULL DEFAULT 'COLLECTING',
  frozen_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  stopped_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weather_lab_experiments_paper_only CHECK (mode = 'PAPER'),
  CONSTRAINT weather_lab_experiments_status_valid
    CHECK (status IN ('COLLECTING', 'FROZEN', 'CLOSED', 'ABANDONED'))
);
CREATE UNIQUE INDEX weather_lab_experiments_key_hash_idx
  ON public.weather_lab_experiments (experiment_key, config_hash);
GRANT ALL ON public.weather_lab_experiments TO service_role;
ALTER TABLE public.weather_lab_experiments ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Market events (one station-day) and their contracts (buckets).
-- ---------------------------------------------------------------------------
CREATE TABLE public.weather_lab_market_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue text NOT NULL,
  event_ticker text NOT NULL,
  city text NOT NULL,
  station text NOT NULL,
  -- The settlement calendar date in the station's local timezone.
  weather_date date NOT NULL,
  timezone text NOT NULL,
  settlement_provider text,
  settlement_provider_url text,
  settlement_measurement text,
  settlement_unit text,
  settlement_rounding_note text,
  settlement_revision_note text,
  -- 'SETTLEMENT_VERIFIED' or 'SETTLEMENT_UNVERIFIED'. Unverified may not trade.
  settlement_status text NOT NULL DEFAULT 'SETTLEMENT_UNVERIFIED',
  settlement_fingerprint text NOT NULL DEFAULT 'sfp1-unknown',
  mutually_exclusive boolean,
  collateral_return_type text,
  -- Whether the parsed bucket set tiles the temperature line exactly once.
  bucket_set_status text NOT NULL DEFAULT 'UNVALIDATED',
  bucket_set_problem text,
  market_status text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weather_lab_market_events_settlement_status_valid
    CHECK (settlement_status IN ('SETTLEMENT_VERIFIED', 'SETTLEMENT_UNVERIFIED')),
  CONSTRAINT weather_lab_market_events_bucket_status_valid
    CHECK (bucket_set_status IN ('UNVALIDATED', 'VALID', 'INVALID'))
);
CREATE UNIQUE INDEX weather_lab_market_events_identity_idx
  ON public.weather_lab_market_events (venue, event_ticker);
CREATE INDEX weather_lab_market_events_station_day_idx
  ON public.weather_lab_market_events (station, weather_date);
GRANT ALL ON public.weather_lab_market_events TO service_role;
ALTER TABLE public.weather_lab_market_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.weather_lab_market_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.weather_lab_market_events (id) ON DELETE CASCADE,
  ticker text NOT NULL,
  label text NOT NULL,
  strike_type text,
  -- Inclusive whole-degree bounds; NULL means unbounded on that side.
  lower_f integer,
  upper_f integer,
  fee_type text,
  fee_multiplier numeric,
  market_status text,
  -- Populated only after the event settles.
  settled_result text,
  settled_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weather_lab_market_contracts_settled_result_valid
    CHECK (settled_result IS NULL OR settled_result IN ('YES', 'NO', 'VOID'))
);
CREATE UNIQUE INDEX weather_lab_market_contracts_ticker_idx
  ON public.weather_lab_market_contracts (event_id, ticker);
GRANT ALL ON public.weather_lab_market_contracts TO service_role;
ALTER TABLE public.weather_lab_market_contracts ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Quote snapshots. Append-only time series; we never overwrite the latest
-- value, because historical replay needs the whole path.
-- ---------------------------------------------------------------------------
CREATE TABLE public.weather_lab_quote_snapshots (
  id bigserial PRIMARY KEY,
  contract_id uuid NOT NULL REFERENCES public.weather_lab_market_contracts (id) ON DELETE CASCADE,
  yes_bid numeric,
  yes_ask numeric,
  no_bid numeric,
  no_ask numeric,
  -- Full depth ladders as returned by the venue, for depth-aware replay.
  yes_bid_ladder jsonb,
  no_bid_ladder jsonb,
  volume numeric,
  open_interest numeric,
  market_status text,
  -- Provenance: when the venue says the quote is from, when we asked, and how
  -- long it took. Required so no-lookahead can be proven, not just intended.
  quote_at timestamptz,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  latency_ms integer,
  rate_limited boolean NOT NULL DEFAULT false
);
CREATE INDEX weather_lab_quote_snapshots_contract_time_idx
  ON public.weather_lab_quote_snapshots (contract_id, retrieved_at DESC);
GRANT ALL ON public.weather_lab_quote_snapshots TO service_role;
ALTER TABLE public.weather_lab_quote_snapshots ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Weather model runs and the bucket distribution they produced.
-- ---------------------------------------------------------------------------
CREATE TABLE public.weather_lab_model_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES public.weather_lab_experiments (id) ON DELETE CASCADE,
  config_hash text NOT NULL,
  event_id uuid NOT NULL REFERENCES public.weather_lab_market_events (id) ON DELETE CASCADE,
  -- The instant the model was asked to decide. Every input must predate this.
  decision_at timestamptz NOT NULL,
  consensus_mean_f numeric,
  model_dispersion_f numeric,
  confidence numeric,
  dominant_ticker text,
  observation_floor_f numeric,
  -- One row per contributing feed, each carrying issued/valid/retrieved times.
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Feeds that were fetched but refused, with the reason. Kept so a thin model
  -- run is visibly thin rather than silently confident.
  rejected_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX weather_lab_model_runs_experiment_idx
  ON public.weather_lab_model_runs (experiment_id, decision_at DESC);
GRANT ALL ON public.weather_lab_model_runs TO service_role;
ALTER TABLE public.weather_lab_model_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.weather_lab_bucket_probabilities (
  id bigserial PRIMARY KEY,
  model_run_id uuid NOT NULL REFERENCES public.weather_lab_model_runs (id) ON DELETE CASCADE,
  contract_id uuid NOT NULL REFERENCES public.weather_lab_market_contracts (id) ON DELETE CASCADE,
  probability numeric NOT NULL,
  -- Per-model probabilities before blending, so disagreement stays inspectable.
  by_model jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT weather_lab_bucket_probabilities_range CHECK (probability >= 0 AND probability <= 1)
);
CREATE UNIQUE INDEX weather_lab_bucket_probabilities_run_contract_idx
  ON public.weather_lab_bucket_probabilities (model_run_id, contract_id);
GRANT ALL ON public.weather_lab_bucket_probabilities TO service_role;
ALTER TABLE public.weather_lab_bucket_probabilities ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Signals: a priced candidate, whether or not it was entered.
-- ---------------------------------------------------------------------------
CREATE TABLE public.weather_lab_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES public.weather_lab_experiments (id) ON DELETE CASCADE,
  config_hash text NOT NULL,
  model_run_id uuid NOT NULL REFERENCES public.weather_lab_model_runs (id) ON DELETE CASCADE,
  contract_id uuid NOT NULL REFERENCES public.weather_lab_market_contracts (id) ON DELETE CASCADE,
  quote_snapshot_id bigint REFERENCES public.weather_lab_quote_snapshots (id) ON DELETE SET NULL,
  signal_at timestamptz NOT NULL,
  entry_local_hour integer,
  model_probability numeric NOT NULL,
  executable_price numeric NOT NULL,
  raw_edge numeric NOT NULL,
  fee_per_contract numeric NOT NULL,
  slippage_buffer numeric NOT NULL,
  net_edge numeric NOT NULL,
  spread numeric,
  strategy_class text,
  decision text NOT NULL,
  -- Every failing gate reason, so the dashboard can explain a rejection.
  reject_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weather_lab_signals_decision_valid CHECK (decision IN ('ENTER', 'REJECT')),
  CONSTRAINT weather_lab_signals_strategy_class_valid CHECK (
    strategy_class IS NULL OR strategy_class IN (
      'CHEAP_TAIL_VALUE', 'MID_PRICE_VALUE', 'HIGH_CONFIDENCE_VALUE',
      'INTRADAY_OBSERVATION_EDGE', 'MODEL_DISAGREEMENT', 'FORECAST_REVISION'
    )
  )
);
CREATE INDEX weather_lab_signals_experiment_time_idx
  ON public.weather_lab_signals (experiment_id, signal_at DESC);
GRANT ALL ON public.weather_lab_signals TO service_role;
ALTER TABLE public.weather_lab_signals ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Paper orders and fills. Every adverse scenario is stored, not just the base
-- case, so the stress panel reads real recorded results rather than estimates.
-- ---------------------------------------------------------------------------
CREATE TABLE public.weather_lab_paper_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id uuid NOT NULL REFERENCES public.weather_lab_signals (id) ON DELETE CASCADE,
  experiment_id uuid NOT NULL REFERENCES public.weather_lab_experiments (id) ON DELETE CASCADE,
  config_hash text NOT NULL,
  side text NOT NULL,
  requested_contracts numeric NOT NULL,
  max_price numeric NOT NULL,
  -- Snapshot of the ladder the simulator walked, so a fill is re-derivable.
  observed_ladder jsonb NOT NULL,
  placed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weather_lab_paper_orders_side_valid CHECK (side IN ('BUY_YES', 'BUY_NO'))
);
CREATE INDEX weather_lab_paper_orders_signal_idx ON public.weather_lab_paper_orders (signal_id);
GRANT ALL ON public.weather_lab_paper_orders TO service_role;
ALTER TABLE public.weather_lab_paper_orders ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.weather_lab_paper_fills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.weather_lab_paper_orders (id) ON DELETE CASCADE,
  experiment_id uuid NOT NULL REFERENCES public.weather_lab_experiments (id) ON DELETE CASCADE,
  config_hash text NOT NULL,
  scenario text NOT NULL,
  fill_status text NOT NULL,
  no_fill_reason text,
  filled_contracts numeric NOT NULL DEFAULT 0,
  average_price numeric,
  notional_usd numeric NOT NULL DEFAULT 0,
  fee_usd numeric NOT NULL DEFAULT 0,
  all_in_cost_usd numeric NOT NULL DEFAULT 0,
  levels_consumed integer NOT NULL DEFAULT 0,
  filled_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weather_lab_paper_fills_scenario_valid
    CHECK (scenario IN ('BASE', 'PLUS_1C', 'PLUS_2C', 'PLUS_3C')),
  CONSTRAINT weather_lab_paper_fills_status_valid
    CHECK (fill_status IN ('FILLED', 'PARTIAL', 'NO_FILL')),
  -- A NO_FILL is not a trade and must never carry size or cost.
  CONSTRAINT weather_lab_paper_fills_no_fill_is_empty CHECK (
    fill_status <> 'NO_FILL'
    OR (filled_contracts = 0 AND all_in_cost_usd = 0 AND average_price IS NULL)
  )
);
CREATE UNIQUE INDEX weather_lab_paper_fills_order_scenario_idx
  ON public.weather_lab_paper_fills (order_id, scenario);
GRANT ALL ON public.weather_lab_paper_fills TO service_role;
ALTER TABLE public.weather_lab_paper_fills ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Positions and settlements.
-- ---------------------------------------------------------------------------
CREATE TABLE public.weather_lab_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES public.weather_lab_experiments (id) ON DELETE CASCADE,
  config_hash text NOT NULL,
  fill_id uuid NOT NULL REFERENCES public.weather_lab_paper_fills (id) ON DELETE CASCADE,
  contract_id uuid NOT NULL REFERENCES public.weather_lab_market_contracts (id) ON DELETE CASCADE,
  -- Denormalised so performance aggregation can group without re-joining.
  station_day text NOT NULL,
  city text NOT NULL,
  scenario text NOT NULL,
  contracts_open numeric NOT NULL,
  cost_basis_usd numeric NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT weather_lab_positions_status_valid CHECK (status IN ('OPEN', 'SETTLED')),
  CONSTRAINT weather_lab_positions_scenario_valid
    CHECK (scenario IN ('BASE', 'PLUS_1C', 'PLUS_2C', 'PLUS_3C'))
);
CREATE UNIQUE INDEX weather_lab_positions_fill_idx ON public.weather_lab_positions (fill_id);
CREATE INDEX weather_lab_positions_station_day_idx
  ON public.weather_lab_positions (experiment_id, station_day);
GRANT ALL ON public.weather_lab_positions TO service_role;
ALTER TABLE public.weather_lab_positions ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.weather_lab_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id uuid NOT NULL REFERENCES public.weather_lab_positions (id) ON DELETE CASCADE,
  experiment_id uuid NOT NULL REFERENCES public.weather_lab_experiments (id) ON DELETE CASCADE,
  config_hash text NOT NULL,
  -- The settled whole-degree maximum and where it came from.
  settled_temperature_f numeric,
  settlement_source text,
  settlement_fingerprint_at_entry text NOT NULL,
  settlement_fingerprint_at_settlement text,
  -- True when the rule changed mid-experiment; such rows are excluded, not blended.
  settlement_rule_changed boolean NOT NULL DEFAULT false,
  outcome text NOT NULL,
  gross_payout_usd numeric NOT NULL DEFAULT 0,
  net_pnl_usd numeric NOT NULL DEFAULT 0,
  settled_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weather_lab_settlements_outcome_valid CHECK (outcome IN ('WIN', 'LOSS', 'VOID'))
);
CREATE UNIQUE INDEX weather_lab_settlements_position_idx ON public.weather_lab_settlements (position_id);
GRANT ALL ON public.weather_lab_settlements TO service_role;
ALTER TABLE public.weather_lab_settlements ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Performance snapshots. Materialised so the dashboard is cheap to render and
-- so a historical view of the verdict is retained.
-- ---------------------------------------------------------------------------
CREATE TABLE public.weather_lab_performance_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES public.weather_lab_experiments (id) ON DELETE CASCADE,
  config_hash text NOT NULL,
  scenario text NOT NULL,
  independent_station_days integer NOT NULL,
  signals integer NOT NULL DEFAULT 0,
  paper_fills integer NOT NULL DEFAULT 0,
  settled_trades integer NOT NULL DEFAULT 0,
  net_pnl_usd numeric,
  cost_usd numeric,
  roi numeric,
  win_rate numeric,
  profit_factor numeric,
  max_drawdown_usd numeric,
  sample_strength text,
  acceptance_verdict text,
  acceptance_failures jsonb NOT NULL DEFAULT '[]'::jsonb,
  bootstrap jsonb,
  trimmed_top_1pct jsonb,
  trimmed_top_5pct jsonb,
  breakdowns jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weather_lab_performance_snapshots_verdict_valid CHECK (
    acceptance_verdict IS NULL
    OR acceptance_verdict IN ('PASS', 'FAIL', 'INSUFFICIENT_SAMPLE')
  )
);
CREATE INDEX weather_lab_performance_snapshots_experiment_idx
  ON public.weather_lab_performance_snapshots (experiment_id, computed_at DESC);
GRANT ALL ON public.weather_lab_performance_snapshots TO service_role;
ALTER TABLE public.weather_lab_performance_snapshots ENABLE ROW LEVEL SECURITY;
