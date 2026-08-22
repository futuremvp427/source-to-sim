-- FINAL BUILD: additive schema for the Sports Forward Shadow research platform
-- (experiment epochs, source sell ledger, rule-fingerprint persistence, venue
-- capability state, paper execution/routing ledger, settlements, independence
-- clustering, telemetry, integrity audits, alerts). All isolated, additive tables --
-- existing sports_shadow_* tables/RPCs are extended, never altered destructively.
-- Every new table follows the SAME RLS-enabled-no-policy + service_role-only grant
-- pattern established in 20260819220000_sports_forward_shadow_phase1.sql.

------------------------------------------------------------------
-- 1. EXPERIMENT EPOCHS (Part 17)
------------------------------------------------------------------
CREATE TABLE public.sports_shadow_experiment_epochs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  go_live_at timestamptz NOT NULL,
  wallet_cohort text[] NOT NULL,
  git_sha text NOT NULL,
  config_hash text NOT NULL,
  classifier_version text NOT NULL,
  episode_version text NOT NULL,
  resolver_version text NOT NULL,
  router_version text NOT NULL,
  pmus_fee_model_version text NOT NULL,
  kalshi_fee_model_version text NOT NULL,
  execution_simulator_version text NOT NULL,
  settlement_version text NOT NULL,
  -- Part 18's state machine stages, plus terminal FAILED/PAUSED for operational holds.
  stage text NOT NULL DEFAULT 'PRE_SOAK'
    CHECK (stage IN ('PRE_SOAK', 'OPERATIONAL_SOAK', 'CALIBRATION', 'OUT_OF_SAMPLE', 'LIVE_PILOT_REVIEW_READY', 'FAILED', 'PAUSED')),
  stage_entered_at timestamptz NOT NULL DEFAULT now(),
  soak_started_at timestamptz,
  calibration_started_at timestamptz,
  oos_started_at timestamptz,
  frozen_at timestamptz,
  frozen_config jsonb,
  is_current boolean NOT NULL DEFAULT true,
  notes text
);
-- At most ONE epoch is ever "current" at a time -- the natural target for "which epoch
-- does new work belong to" without a separate settings/singleton table.
CREATE UNIQUE INDEX sports_shadow_experiment_epochs_one_current_idx
  ON public.sports_shadow_experiment_epochs (is_current) WHERE is_current;
CREATE INDEX sports_shadow_experiment_epochs_stage_idx ON public.sports_shadow_experiment_epochs (stage);
GRANT ALL ON public.sports_shadow_experiment_epochs TO service_role;
ALTER TABLE public.sports_shadow_experiment_epochs ENABLE ROW LEVEL SECURITY;

-- Every evaluated signal must be attributable to an epoch (Part 17). Nullable so
-- existing rows (none exist in any live database yet -- this whole feature is
-- unshipped) never need a destructive backfill; new signals are always created with a
-- non-null value by application code from this point on.
ALTER TABLE public.sports_shadow_signals
  ADD COLUMN experiment_epoch_id uuid REFERENCES public.sports_shadow_experiment_epochs(id);
CREATE INDEX sports_shadow_signals_experiment_epoch_idx ON public.sports_shadow_signals (experiment_epoch_id);

------------------------------------------------------------------
-- 2. SOURCE SELL LEDGER (Parts 5, 14) -- replaces the insufficient
-- source_sell_seen-only signal with a real, auditable per-fill sell ledger.
------------------------------------------------------------------
CREATE TABLE public.sports_shadow_source_sell_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- Nullable: a pre-epoch/untracked sell (no known forward open position -- Part 5's
  -- explicit case) has no signal to attach to. NEVER fabricate one; is_pre_epoch below
  -- is true exactly when this is null, enforced by the CHECK constraint.
  signal_id uuid REFERENCES public.sports_shadow_signals(id),
  -- The raw source_fills row this sell event was derived from -- UNIQUE so a retried
  -- poll re-observing the identical raw fill can never double-count a sell (the same
  -- idempotency guarantee sports_shadow_source_fills.event_key already gives BUYs).
  source_fill_id uuid NOT NULL UNIQUE REFERENCES public.sports_shadow_source_fills(id),
  shares numeric NOT NULL,
  price numeric NOT NULL,
  notional numeric NOT NULL,
  source_ts bigint NOT NULL,
  -- True when this sell was recorded with NO known forward (post-go-live) open
  -- position to reduce -- e.g. inventory the wallet held before this experiment's
  -- go-live boundary. Per Part 5's explicit rule: never fabricate a pre-epoch
  -- position; classify clearly instead.
  is_pre_epoch boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sports_shadow_source_sell_events_pre_epoch_consistency
    CHECK (is_pre_epoch = (signal_id IS NULL))
);
CREATE INDEX sports_shadow_source_sell_events_signal_idx
  ON public.sports_shadow_source_sell_events (signal_id, source_ts);
GRANT ALL ON public.sports_shadow_source_sell_events TO service_role;
ALTER TABLE public.sports_shadow_source_sell_events ENABLE ROW LEVEL SECURITY;

-- Sell aggregates on the episode itself -- mirrors the existing source_shares/
-- source_notional/source_vwap BUY-side aggregate columns exactly. Remaining position
-- is deliberately NOT a stored column: it is source_shares - source_sell_shares,
-- computed at read time, so it can never drift out of sync with either aggregate
-- (source_shares can still grow via a later DCA buy AFTER a sell -- Part 5's "source
-- DCA after initial follower entry" -- and a stored remaining-shares column would need
-- a second write path to stay correct through that case; a derived value cannot drift).
ALTER TABLE public.sports_shadow_signals
  ADD COLUMN source_sell_shares numeric NOT NULL DEFAULT 0,
  ADD COLUMN source_sell_notional numeric NOT NULL DEFAULT 0,
  ADD COLUMN source_sell_vwap numeric;

------------------------------------------------------------------
-- 3. RULE-FINGERPRINT PERSISTENCE (Part 6) -- structured, auditable evidence
-- supporting an EXACT match, not just a boolean.
------------------------------------------------------------------
ALTER TABLE public.sports_market_matches
  ADD COLUMN rule_fingerprint jsonb,
  ADD COLUMN rule_fingerprint_version text;

------------------------------------------------------------------
-- 4. VENUE CAPABILITY STATE (Part 8) -- one row per venue, upserted by a periodic
-- capability probe. The rest of the system degrades safely when a venue's row shows
-- reduced capability rather than crashing or fabricating data.
------------------------------------------------------------------
CREATE TABLE public.sports_shadow_venue_capability (
  venue text NOT NULL PRIMARY KEY CHECK (venue IN ('PMUS', 'KALSHI')),
  discovery_available boolean NOT NULL DEFAULT true,
  orderbook_available boolean NOT NULL DEFAULT true,
  checked_at timestamptz NOT NULL DEFAULT now(),
  detail text
);
GRANT ALL ON public.sports_shadow_venue_capability TO service_role;
ALTER TABLE public.sports_shadow_venue_capability ENABLE ROW LEVEL SECURITY;

------------------------------------------------------------------
-- 5. PAPER EXECUTION LEDGER (Parts 9, 10, 12, 13) -- one row per routed (or rejected)
-- notional-tier decision, preserving BOTH venues' full counterfactual results.
------------------------------------------------------------------
CREATE TABLE public.sports_shadow_paper_fills (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  signal_id uuid NOT NULL REFERENCES public.sports_shadow_signals(id),
  experiment_epoch_id uuid REFERENCES public.sports_shadow_experiment_epochs(id),
  -- Provenance: which source fill (BUY or SELL) this simulated follower action
  -- follows, and which live quote observation supplied the executable book.
  source_fill_id uuid REFERENCES public.sports_shadow_source_fills(id),
  observation_id uuid REFERENCES public.sports_quote_observations(id),
  side text NOT NULL CHECK (side IN ('ENTRY', 'ADD', 'EXIT')),
  notional_tier_usd numeric NOT NULL,
  routing_timestamp timestamptz NOT NULL,
  -- Full counterfactual: both venues' depth-walk + fee results, even for the venue
  -- NOT chosen -- Part 12's explicit "preserve venue-specific counterfactuals".
  pmus_result jsonb,
  kalshi_result jsonb,
  chosen_venue text CHECK (chosen_venue IN ('PMUS', 'KALSHI')),
  fill_status text NOT NULL CHECK (fill_status IN ('FULL', 'PARTIAL', 'NONE', 'INVALID', 'REJECTED')),
  contracts numeric NOT NULL DEFAULT 0,
  vwap numeric,
  fee_usd numeric,
  fee_model_version text,
  fee_valid boolean NOT NULL DEFAULT true,
  all_in_cost_usd numeric,
  reject_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Idempotency: each triggering observation event produces AT MOST one routing
  -- decision per notional tier -- a retried/duplicate trigger call for the identical
  -- observation can never create a second, conflicting paper fill for the same tier.
  UNIQUE (observation_id, notional_tier_usd)
);
CREATE INDEX sports_shadow_paper_fills_signal_idx ON public.sports_shadow_paper_fills (signal_id, notional_tier_usd);
CREATE INDEX sports_shadow_paper_fills_epoch_idx ON public.sports_shadow_paper_fills (experiment_epoch_id);
GRANT ALL ON public.sports_shadow_paper_fills TO service_role;
ALTER TABLE public.sports_shadow_paper_fills ENABLE ROW LEVEL SECURITY;

-- Aggregate remaining simulated inventory, PER notional tier (Part 32's capacity
-- analysis needs each tier's own P&L, since a tier that cannot fill at $50 must not be
-- blended with one that fills fine at $5).
CREATE TABLE public.sports_shadow_paper_positions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  signal_id uuid NOT NULL REFERENCES public.sports_shadow_signals(id),
  venue text NOT NULL CHECK (venue IN ('PMUS', 'KALSHI')),
  notional_tier_usd numeric NOT NULL,
  contracts_open numeric NOT NULL DEFAULT 0,
  avg_entry_price numeric,
  realized_pnl_usd numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (signal_id, venue, notional_tier_usd)
);
GRANT ALL ON public.sports_shadow_paper_positions TO service_role;
ALTER TABLE public.sports_shadow_paper_positions ENABLE ROW LEVEL SECURITY;

------------------------------------------------------------------
-- 6. SETTLEMENT (Part 15)
------------------------------------------------------------------
CREATE TABLE public.sports_shadow_settlements (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  signal_id uuid NOT NULL REFERENCES public.sports_shadow_signals(id),
  venue text NOT NULL CHECK (venue IN ('PMUS', 'KALSHI')),
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
  UNIQUE (signal_id, venue, notional_tier_usd)
);
CREATE INDEX sports_shadow_settlements_status_idx ON public.sports_shadow_settlements (settlement_status, created_at);
GRANT ALL ON public.sports_shadow_settlements TO service_role;
ALTER TABLE public.sports_shadow_settlements ENABLE ROW LEVEL SECURITY;

------------------------------------------------------------------
-- 7. INDEPENDENCE / CORRELATION CLUSTERING (Part 16) -- persisted at the signal level
-- so a milestone query can COUNT(DISTINCT cluster_key) directly rather than
-- recomputing clustering over the whole table on every dashboard read.
------------------------------------------------------------------
ALTER TABLE public.sports_shadow_signals ADD COLUMN cluster_key text;
CREATE INDEX sports_shadow_signals_cluster_key_idx ON public.sports_shadow_signals (cluster_key);

------------------------------------------------------------------
-- 8. TELEMETRY (Part 25) -- a single wide metric-event table rather than one bespoke
-- table per subsystem: every category in Part 25's list (SOURCE/VENUE/NETWORK/
-- OBSERVATION/PAPER/SETTLEMENT/SYSTEM) is a distinct `category`, every named metric a
-- `metric` value with a numeric `value` and free-form `labels` for dimensions (venue,
-- wallet, etc). Durable, queryable history -- not "logs only" (Part 25's explicit bar).
------------------------------------------------------------------
CREATE TABLE public.sports_shadow_telemetry_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  category text NOT NULL CHECK (category IN ('SOURCE', 'VENUE', 'NETWORK', 'OBSERVATION', 'PAPER', 'SETTLEMENT', 'SYSTEM')),
  metric text NOT NULL,
  value numeric,
  labels jsonb NOT NULL DEFAULT '{}'::jsonb,
  experiment_epoch_id uuid REFERENCES public.sports_shadow_experiment_epochs(id)
);
CREATE INDEX sports_shadow_telemetry_events_lookup_idx
  ON public.sports_shadow_telemetry_events (category, metric, created_at DESC);
GRANT ALL ON public.sports_shadow_telemetry_events TO service_role;
ALTER TABLE public.sports_shadow_telemetry_events ENABLE ROW LEVEL SECURITY;

------------------------------------------------------------------
-- 9. DAILY INTEGRITY AUDIT (Part 26)
------------------------------------------------------------------
CREATE TABLE public.sports_shadow_integrity_audits (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_at timestamptz NOT NULL DEFAULT now(),
  passed boolean NOT NULL,
  checks_run integer NOT NULL,
  checks_failed integer NOT NULL,
  findings jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX sports_shadow_integrity_audits_run_at_idx ON public.sports_shadow_integrity_audits (run_at DESC);
GRANT ALL ON public.sports_shadow_integrity_audits TO service_role;
ALTER TABLE public.sports_shadow_integrity_audits ENABLE ROW LEVEL SECURITY;

------------------------------------------------------------------
-- 10. ALERTS (Part 27) -- a durable dedup/rate-limit ledger, not the delivery
-- mechanism itself (delivery reuses whatever notification channel the rest of the
-- project already has configured -- see alerts.server.ts, not this migration).
------------------------------------------------------------------
CREATE TABLE public.sports_shadow_alerts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  alert_key text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  message text NOT NULL,
  resolved_at timestamptz
);
-- Only one UNRESOLVED alert per key at a time -- the dedup mechanism that keeps a
-- sustained condition from spamming a new alert every cycle.
CREATE UNIQUE INDEX sports_shadow_alerts_one_unresolved_per_key_idx
  ON public.sports_shadow_alerts (alert_key) WHERE resolved_at IS NULL;
GRANT ALL ON public.sports_shadow_alerts TO service_role;
ALTER TABLE public.sports_shadow_alerts ENABLE ROW LEVEL SECURITY;
