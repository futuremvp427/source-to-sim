CREATE TABLE public.paper_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES public.paper_experiments(id) ON DELETE CASCADE,
  asset text NOT NULL,
  market_title text,
  outcome text,
  condition_id text,
  shares numeric NOT NULL DEFAULT 0,
  cost_basis numeric NOT NULL DEFAULT 0,
  resolution_outcome text NOT NULL,
  resolution_source text NOT NULL,
  resolution_ts timestamp with time zone,
  verified boolean NOT NULL DEFAULT false,
  payout numeric NOT NULL DEFAULT 0,
  realized_pnl numeric NOT NULL DEFAULT 0,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  settled_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, asset)
);
GRANT SELECT ON public.paper_settlements TO authenticated;
GRANT ALL ON public.paper_settlements TO service_role;
ALTER TABLE public.paper_settlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "settlements are service managed" ON public.paper_settlements FOR SELECT TO authenticated USING (false);

CREATE TABLE public.pipeline_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES public.paper_experiments(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  wallet text NOT NULL,
  market_title text,
  side text,
  action text,
  source_ts bigint,
  detected_at timestamp with time zone,
  event_persisted_at timestamp with time zone,
  decision_at timestamp with time zone,
  paper_trade_at timestamp with time zone,
  position_updated_at timestamp with time zone,
  compatibility_checked_at timestamp with time zone,
  preview_created_at timestamp with time zone,
  alert_created_at timestamp with time zone,
  detection_latency_seconds numeric,
  decision_latency_seconds numeric,
  total_latency_seconds numeric,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, event_key)
);
GRANT SELECT ON public.pipeline_audit TO authenticated;
GRANT ALL ON public.pipeline_audit TO service_role;
ALTER TABLE public.pipeline_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit is service managed" ON public.pipeline_audit FOR SELECT TO authenticated USING (false);

CREATE INDEX idx_pipeline_audit_experiment_created ON public.pipeline_audit (experiment_id, created_at DESC);
CREATE INDEX idx_source_events_wallet_processed ON public.source_events (wallet, processed_at);