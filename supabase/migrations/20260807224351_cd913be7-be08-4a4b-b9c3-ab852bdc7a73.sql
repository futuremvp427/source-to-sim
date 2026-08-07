CREATE TABLE public.order_previews (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  experiment_id uuid NOT NULL REFERENCES public.paper_experiments(id) ON DELETE CASCADE,
  source_event_id uuid REFERENCES public.source_events(id) ON DELETE SET NULL,
  event_key text NOT NULL,
  asset text NOT NULL,
  market_title text,
  outcome text,
  source_slug text,
  source_side text NOT NULL,
  source_price numeric,
  candidate_shares numeric NOT NULL DEFAULT 0,
  candidate_notional numeric NOT NULL DEFAULT 0,
  us_market_slug text,
  compatibility text NOT NULL DEFAULT 'NO_MATCH',
  compatibility_reason text,
  status text NOT NULL DEFAULT 'NOT_ELIGIBLE',
  preview_side text,
  preview_price numeric,
  preview_quantity numeric,
  preview_estimated_cost numeric,
  available_balance numeric,
  balance_currency text,
  error text,
  source_ts bigint,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  decided_at timestamp with time zone,
  UNIQUE (experiment_id, event_key)
);

GRANT ALL ON public.order_previews TO service_role;
ALTER TABLE public.order_previews ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.integration_status (
  id text NOT NULL PRIMARY KEY,
  configured boolean NOT NULL DEFAULT false,
  connected boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'unverified',
  detail text,
  account_summary jsonb,
  last_verified_at timestamp with time zone,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT ALL ON public.integration_status TO service_role;
ALTER TABLE public.integration_status ENABLE ROW LEVEL SECURITY;

CREATE INDEX order_previews_status_idx ON public.order_previews (status, created_at DESC);