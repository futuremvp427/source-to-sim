-- supabase/migrations/20260815120000_poligarch_live_pilot_schema.sql

-- Per-pilot safety state. Deliberately its own table, NOT a reuse of
-- live_safety_state, so arming/activating this pilot can never affect the
-- global live-safety row or any other experiment's display.
CREATE TABLE IF NOT EXISTS public.live_pilot_state (
  pilot_id text PRIMARY KEY,
  kill_switch_engaged boolean NOT NULL DEFAULT true,
  activation_stage text NOT NULL DEFAULT 'locked',
  armed_at timestamptz,
  armed_by uuid,
  activated_at timestamptz,
  activated_by uuid,
  pilot_bankroll_usd numeric NOT NULL DEFAULT 0,
  max_order_notional_usd numeric NOT NULL DEFAULT 0,
  max_total_exposure_usd numeric NOT NULL DEFAULT 0,
  max_daily_realized_loss_usd numeric NOT NULL DEFAULT 0,
  consecutive_failed_orders integer NOT NULL DEFAULT 0,
  last_action text,
  last_action_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT live_pilot_state_stage_check CHECK (activation_stage IN ('locked', 'preview', 'live_pilot'))
);

GRANT SELECT ON public.live_pilot_state TO authenticated;
GRANT ALL ON public.live_pilot_state TO service_role;
ALTER TABLE public.live_pilot_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read live pilot state" ON public.live_pilot_state;
CREATE POLICY "Admins can read live pilot state"
  ON public.live_pilot_state FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Seed locked, kill-switch-engaged, zero-cap row for the Poligarch V2 pilot.
-- No task in this plan ever changes these seeded values.
INSERT INTO public.live_pilot_state (pilot_id)
VALUES ('poligarch_v2_live_pilot')
ON CONFLICT (pilot_id) DO NOTHING;

-- Durable, idempotent record of every live-pilot decision for one source
-- event: preview, skip, or (never reachable yet) a real order attempt.
-- Idempotency key mirrors experiment_event_state's proven pattern:
-- (owning experiment, immutable source event) can only ever produce one row.
CREATE TABLE IF NOT EXISTS public.live_order_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_id text NOT NULL REFERENCES public.live_pilot_state(pilot_id),
  source_experiment_id uuid NOT NULL REFERENCES public.paper_experiments(id),
  source_event_id uuid NOT NULL REFERENCES public.source_events(id),
  source_event_key text NOT NULL,
  source_wallet text NOT NULL,
  source_condition_id text,
  source_asset text,
  source_side text NOT NULL,
  source_price numeric NOT NULL,
  source_ts bigint NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  decision_at timestamptz,
  us_market_slug text,
  market_mapping_status text,
  live_price_snapshot jsonb,
  requested_shares numeric,
  requested_notional_usd numeric,
  status text NOT NULL DEFAULT 'PREVIEWED',
  status_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  fail_reason text,
  submitted_order_id text,
  filled_shares numeric,
  avg_fill_price numeric,
  fees_usd numeric,
  safety_checks jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT live_order_intents_source_unique UNIQUE (source_experiment_id, source_event_id),
  CONSTRAINT live_order_intents_status_check CHECK (
    status IN (
      'PREVIEWED', 'SKIPPED', 'AUTHORIZED', 'SUBMITTING', 'SUBMITTED',
      'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'FAILED'
    )
  )
);

CREATE INDEX IF NOT EXISTS live_order_intents_pilot_created_idx
  ON public.live_order_intents (pilot_id, created_at DESC);

GRANT SELECT ON public.live_order_intents TO authenticated;
GRANT ALL ON public.live_order_intents TO service_role;
ALTER TABLE public.live_order_intents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read live pilot intents" ON public.live_order_intents;
CREATE POLICY "Admins can read live pilot intents"
  ON public.live_order_intents FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
