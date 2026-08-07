CREATE TABLE public.tracked_wallets (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  address text NOT NULL UNIQUE,
  label text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.tracked_wallets TO service_role;
ALTER TABLE public.tracked_wallets ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.paper_experiments (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL UNIQUE,
  wallet_address text NOT NULL,
  starting_cash numeric NOT NULL DEFAULT 380,
  cash numeric NOT NULL DEFAULT 380,
  buy_amount numeric NOT NULL DEFAULT 10,
  poll_interval_seconds integer NOT NULL DEFAULT 60,
  enabled boolean NOT NULL DEFAULT true,
  weather_only boolean NOT NULL DEFAULT false,
  realized_pnl numeric NOT NULL DEFAULT 0,
  simulated boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.paper_experiments TO service_role;
ALTER TABLE public.paper_experiments ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.source_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  wallet text NOT NULL,
  tx_hash text,
  source_native_id text,
  log_index text,
  condition_id text,
  asset text NOT NULL,
  market_title text NOT NULL DEFAULT 'Unknown market',
  outcome text,
  slug text,
  side text NOT NULL,
  shares numeric NOT NULL DEFAULT 0,
  price numeric NOT NULL DEFAULT 0,
  source_ts bigint NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  identity_basis text NOT NULL,
  identity_degraded boolean NOT NULL DEFAULT false,
  raw jsonb,
  processed_at timestamptz
);
CREATE INDEX source_events_wallet_ts_idx ON public.source_events (wallet, source_ts DESC);
CREATE INDEX source_events_asset_idx ON public.source_events (asset, source_ts);
CREATE INDEX source_events_unprocessed_idx ON public.source_events (processed_at, source_ts);
GRANT ALL ON public.source_events TO service_role;
ALTER TABLE public.source_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.source_position_state (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet text NOT NULL,
  asset text NOT NULL,
  market_title text,
  outcome text,
  shares numeric NOT NULL DEFAULT 0,
  calculation_version integer NOT NULL DEFAULT 1,
  last_event_key text,
  last_event_ts bigint,
  reconciled_at timestamptz,
  reconciliation_status text NOT NULL DEFAULT 'unreconciled',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wallet, asset)
);
GRANT ALL ON public.source_position_state TO service_role;
ALTER TABLE public.source_position_state ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.paper_trades (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  experiment_id uuid NOT NULL REFERENCES public.paper_experiments(id) ON DELETE CASCADE,
  source_event_id uuid REFERENCES public.source_events(id) ON DELETE SET NULL,
  event_key text NOT NULL,
  action text NOT NULL,
  side text,
  asset text NOT NULL,
  market_title text,
  outcome text,
  price numeric,
  shares numeric NOT NULL DEFAULT 0,
  notional numeric NOT NULL DEFAULT 0,
  reason text,
  cash_after numeric,
  realized_pnl numeric NOT NULL DEFAULT 0,
  source_ts bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, event_key)
);
CREATE INDEX paper_trades_experiment_created_idx ON public.paper_trades (experiment_id, created_at DESC);
GRANT ALL ON public.paper_trades TO service_role;
ALTER TABLE public.paper_trades ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.paper_positions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  experiment_id uuid NOT NULL REFERENCES public.paper_experiments(id) ON DELETE CASCADE,
  asset text NOT NULL,
  market_title text,
  outcome text,
  shares numeric NOT NULL DEFAULT 0,
  cost_basis numeric NOT NULL DEFAULT 0,
  avg_price numeric NOT NULL DEFAULT 0,
  realized_pnl numeric NOT NULL DEFAULT 0,
  mark numeric,
  mark_source text,
  mark_ts timestamptz,
  best_bid numeric,
  best_ask numeric,
  midpoint numeric,
  settlement_status text NOT NULL DEFAULT 'open',
  last_activity_ts bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, asset)
);
GRANT ALL ON public.paper_positions TO service_role;
ALTER TABLE public.paper_positions ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.worker_checkpoints (
  id text NOT NULL PRIMARY KEY,
  wallet text NOT NULL,
  last_source_ts bigint NOT NULL DEFAULT 0,
  last_event_key text,
  events_seen integer NOT NULL DEFAULT 0,
  bootstrap_complete boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.worker_checkpoints TO service_role;
ALTER TABLE public.worker_checkpoints ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.worker_status (
  id text NOT NULL PRIMARY KEY,
  worker_id text,
  state text NOT NULL DEFAULT 'stopped',
  fence integer NOT NULL DEFAULT 0,
  heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  last_poll_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  poll_failures integer NOT NULL DEFAULT 0,
  events_ingested integer NOT NULL DEFAULT 0,
  lag_seconds integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.worker_status TO service_role;
ALTER TABLE public.worker_status ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.alerts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  level text NOT NULL DEFAULT 'info',
  kind text NOT NULL,
  message text NOT NULL,
  context jsonb,
  acknowledged boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alerts_created_idx ON public.alerts (created_at DESC);
GRANT ALL ON public.alerts TO service_role;
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;

INSERT INTO public.tracked_wallets (address, label, active)
VALUES ('0x8fbd7cf5f806f563080864694415829f7229a959', 'Target wallet', true)
ON CONFLICT (address) DO NOTHING;

INSERT INTO public.paper_experiments (name, wallet_address, starting_cash, cash, buy_amount, poll_interval_seconds, enabled, weather_only)
VALUES ('SHADOW', '0x8fbd7cf5f806f563080864694415829f7229a959', 380, 380, 10, 60, true, false)
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.worker_status (id, state) VALUES ('ingest', 'stopped')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.worker_checkpoints (id, wallet)
VALUES ('ingest', '0x8fbd7cf5f806f563080864694415829f7229a959')
ON CONFLICT (id) DO NOTHING;