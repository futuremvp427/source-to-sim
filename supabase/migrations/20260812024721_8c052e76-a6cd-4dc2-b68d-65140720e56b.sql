CREATE TABLE public.general_activity (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet text NOT NULL,
  event_key text NOT NULL,
  activity_type text NOT NULL,
  asset text,
  condition_id text,
  market_title text,
  outcome text,
  slug text,
  category text NOT NULL DEFAULT 'other',
  shares numeric,
  usdc_size numeric,
  price numeric,
  source_ts bigint NOT NULL,
  economics_status text NOT NULL DEFAULT 'UNKNOWN_UNRESOLVED',
  post_go_live boolean NOT NULL DEFAULT false,
  raw jsonb,
  first_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT general_activity_identity UNIQUE (wallet, event_key)
);

CREATE INDEX general_activity_wallet_ts_idx ON public.general_activity (wallet, source_ts DESC);

GRANT ALL ON public.general_activity TO service_role;

ALTER TABLE public.general_activity ENABLE ROW LEVEL SECURITY;

CREATE POLICY "general_activity is backend-only"
  ON public.general_activity FOR SELECT TO authenticated USING (false);

INSERT INTO public.paper_experiments (
  name, wallet_address, starting_cash, cash, buy_amount, poll_interval_seconds,
  enabled, weather_only, realized_pnl, simulated, sizing_rule, follow_from_ts
) VALUES
  ('GENERAL SHADOW: RN1', '0x2005d16a84ceefa912d4e380cd32e7ff827875ea', 500, 500, 5, 60, true, false, 0, true, 'dynamic-v1', 1786503000),
  ('GENERAL SHADOW: swisstony', '0x204f72f35326db932158cba6adff0b9a1da95e14', 500, 500, 5, 60, true, false, 0, true, 'dynamic-v1', 1786503000);