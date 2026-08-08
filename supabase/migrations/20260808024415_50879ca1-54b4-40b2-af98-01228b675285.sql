CREATE TABLE public.copyability_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES public.paper_experiments(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  source_event_id uuid REFERENCES public.source_events(id) ON DELETE SET NULL,
  asset text NOT NULL,
  market_title text,
  side text NOT NULL,
  leader_price numeric,
  source_ts bigint,
  detected_at timestamptz,
  sample_delay text NOT NULL,
  delay_seconds integer NOT NULL,
  scheduled_at timestamptz NOT NULL,
  observed_at timestamptz,
  status text NOT NULL DEFAULT 'pending',
  best_bid numeric,
  best_ask numeric,
  midpoint numeric,
  spread numeric,
  follower_price numeric,
  visible_depth numeric,
  required_shares numeric,
  fillable boolean,
  slippage_cents numeric,
  slippage_pct numeric,
  price_direction text,
  improved boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, event_key, sample_delay)
);

CREATE INDEX idx_copyobs_due ON public.copyability_observations (status, scheduled_at);
CREATE INDEX idx_copyobs_experiment ON public.copyability_observations (experiment_id, sample_delay);

GRANT ALL ON public.copyability_observations TO service_role;
ALTER TABLE public.copyability_observations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.alerts ADD COLUMN IF NOT EXISTS dedup_key text;
ALTER TABLE public.alerts ADD COLUMN IF NOT EXISTS notified_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_dedup_key ON public.alerts (dedup_key) WHERE dedup_key IS NOT NULL;