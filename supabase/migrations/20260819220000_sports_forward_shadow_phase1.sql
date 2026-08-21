-- Sports Forward Shadow Phase 1: additive, isolated schema.
-- Reuses no existing tables (source_events/paper_experiments untouched);
-- reuses the http_rate_limits + worker_status generic mechanisms as-is
-- (new host strings / new worker_status.id, both already parameterized,
-- so no migration is needed for those).

CREATE TABLE public.sports_shadow_source_fills (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  wallet text NOT NULL,
  wallet_handle text,
  condition_id text,
  asset text NOT NULL,
  market_title text NOT NULL DEFAULT 'Unknown market',
  outcome text,
  event_slug text,
  market_slug text,
  side text NOT NULL,
  shares numeric NOT NULL DEFAULT 0,
  price numeric NOT NULL DEFAULT 0,
  source_ts bigint NOT NULL DEFAULT 0,
  identity_basis text NOT NULL,
  identity_degraded boolean NOT NULL DEFAULT false,
  raw jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sports_shadow_source_fills_wallet_ts_idx
  ON public.sports_shadow_source_fills (wallet, source_ts DESC);
GRANT ALL ON public.sports_shadow_source_fills TO service_role;
ALTER TABLE public.sports_shadow_source_fills ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.sports_shadow_signals (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  episode_key text NOT NULL UNIQUE,
  source_wallet text NOT NULL,
  source_handle text,
  source_condition_id text,
  source_asset text NOT NULL,
  source_outcome text,
  source_event_slug text,
  source_market_slug text,
  first_fill_id uuid NOT NULL REFERENCES public.sports_shadow_source_fills(id),
  source_first_fill_at timestamptz NOT NULL,
  source_last_fill_at timestamptz NOT NULL,
  source_vwap numeric NOT NULL DEFAULT 0,
  source_shares numeric NOT NULL DEFAULT 0,
  source_notional numeric NOT NULL DEFAULT 0,
  source_fill_count integer NOT NULL DEFAULT 1,
  source_sell_seen boolean NOT NULL DEFAULT false,
  league text NOT NULL DEFAULT 'MLB',
  scheduled_start_at timestamptz,
  away_team text,
  home_team text,
  bet_type text NOT NULL,
  selected_side text NOT NULL,
  line numeric,
  status text NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sports_shadow_signals_bet_type_check
    CHECK (bet_type IN ('MONEYLINE', 'SPREAD', 'TOTAL')),
  CONSTRAINT sports_shadow_signals_status_check
    CHECK (status IN ('OPEN', 'BURST_COMPLETE', 'SETTLED_WIN', 'SETTLED_LOSS', 'SETTLED_PUSH', 'VOID'))
);
CREATE INDEX sports_shadow_signals_wallet_idx
  ON public.sports_shadow_signals (source_wallet, source_first_fill_at DESC);
CREATE INDEX sports_shadow_signals_status_idx
  ON public.sports_shadow_signals (status, source_first_fill_at);
GRANT ALL ON public.sports_shadow_signals TO service_role;
ALTER TABLE public.sports_shadow_signals ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.sports_market_matches (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  signal_id uuid NOT NULL REFERENCES public.sports_shadow_signals(id) ON DELETE CASCADE,
  venue text NOT NULL,
  match_status text NOT NULL,
  target_event_id text,
  target_market_id text,
  target_identifier text,
  normalized_game_id text,
  line numeric,
  selected_side text,
  settlement_compatibility text NOT NULL DEFAULT 'UNKNOWN',
  reason text,
  metadata jsonb,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (signal_id, venue),
  CONSTRAINT sports_market_matches_venue_check CHECK (venue IN ('PMUS', 'KALSHI')),
  CONSTRAINT sports_market_matches_status_check
    CHECK (match_status IN ('EXACT', 'NEAR', 'NONE', 'UNVERIFIED')),
  CONSTRAINT sports_market_matches_settlement_check
    CHECK (settlement_compatibility IN ('COMPATIBLE', 'INCOMPATIBLE', 'UNKNOWN'))
);
CREATE INDEX sports_market_matches_signal_idx ON public.sports_market_matches (signal_id);
GRANT ALL ON public.sports_market_matches TO service_role;
ALTER TABLE public.sports_market_matches ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.sports_quote_observations (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  signal_id uuid NOT NULL REFERENCES public.sports_shadow_signals(id) ON DELETE CASCADE,
  match_id uuid REFERENCES public.sports_market_matches(id) ON DELETE CASCADE,
  venue text NOT NULL,
  requested_delay_ms integer NOT NULL,
  source_timestamp timestamptz NOT NULL,
  fire_at timestamptz NOT NULL,
  observed_at timestamptz,
  fetch_started_at timestamptz,
  fetch_ended_at timestamptz,
  detection_latency_ms integer,
  best_bid numeric,
  best_ask numeric,
  spread numeric,
  bid_depth jsonb,
  ask_depth jsonb,
  market_status text,
  stale boolean NOT NULL DEFAULT false,
  error_code text,
  reason text,
  raw_metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (signal_id, venue, requested_delay_ms),
  CONSTRAINT sports_quote_observations_venue_check CHECK (venue IN ('PMUS', 'KALSHI')),
  CONSTRAINT sports_quote_observations_delay_check
    CHECK (requested_delay_ms IN (0, 5000, 10000, 30000, 60000))
);
CREATE INDEX sports_quote_observations_due_idx
  ON public.sports_quote_observations (fire_at)
  WHERE observed_at IS NULL;
GRANT ALL ON public.sports_quote_observations TO service_role;
ALTER TABLE public.sports_quote_observations ENABLE ROW LEVEL SECURITY;
