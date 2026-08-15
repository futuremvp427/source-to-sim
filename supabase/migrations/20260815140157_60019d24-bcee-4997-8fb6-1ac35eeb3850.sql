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

-- supabase/migrations/20260815121000_poligarch_live_pilot_intent_rpc.sql

-- Guarantees a source event can never create two live-pilot intents.
-- Mirrors process_source_event_atomic's ON CONFLICT DO NOTHING idempotency
-- pattern from supabase/migrations/20260813134500_experiment_scoped_event_consumption.sql.
CREATE OR REPLACE FUNCTION public.create_or_get_live_pilot_intent_atomic(
  p_pilot_id text,
  p_source_experiment_id uuid,
  p_source_event_id uuid,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_status text;
  v_created boolean := false;
BEGIN
  INSERT INTO public.live_order_intents (
    id, pilot_id, source_experiment_id, source_event_id, source_event_key,
    source_wallet, source_condition_id, source_asset, source_side,
    source_price, source_ts, status, status_history
  )
  VALUES (
    gen_random_uuid(), p_pilot_id, p_source_experiment_id, p_source_event_id,
    p_payload->>'source_event_key', p_payload->>'source_wallet',
    p_payload->>'source_condition_id', p_payload->>'source_asset',
    p_payload->>'source_side', (p_payload->>'source_price')::numeric,
    (p_payload->>'source_ts')::bigint, 'PREVIEWED',
    jsonb_build_array(jsonb_build_object('status', 'PREVIEWED', 'at', now()))
  )
  ON CONFLICT (source_experiment_id, source_event_id) DO NOTHING
  RETURNING id, status INTO v_id, v_status;

  IF v_id IS NOT NULL THEN
    v_created := true;
  ELSE
    SELECT id, status INTO v_id, v_status
    FROM public.live_order_intents
    WHERE source_experiment_id = p_source_experiment_id AND source_event_id = p_source_event_id;
  END IF;

  RETURN jsonb_build_object('intent_id', v_id, 'created', v_created, 'status', v_status);
END;
$$;

REVOKE ALL ON FUNCTION public.create_or_get_live_pilot_intent_atomic(text, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_or_get_live_pilot_intent_atomic(text, uuid, uuid, jsonb) TO service_role;

-- Explicit state-machine transition with a full audit trail. Every call
-- appends to status_history rather than overwriting it.
CREATE OR REPLACE FUNCTION public.update_live_pilot_intent_status_atomic(
  p_intent_id uuid,
  p_new_status text,
  p_fields jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.live_order_intents%ROWTYPE;
BEGIN
  IF p_new_status NOT IN (
    'PREVIEWED', 'SKIPPED', 'AUTHORIZED', 'SUBMITTING', 'SUBMITTED',
    'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'FAILED'
  ) THEN
    RAISE EXCEPTION 'invalid status %', p_new_status;
  END IF;

  SELECT * INTO v_row FROM public.live_order_intents WHERE id = p_intent_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'intent % not found', p_intent_id;
  END IF;

  UPDATE public.live_order_intents
  SET
    status = p_new_status,
    status_history = status_history || jsonb_build_object('status', p_new_status, 'at', now(), 'fields', p_fields),
    decision_at = COALESCE(decision_at, CASE WHEN p_new_status <> 'PREVIEWED' THEN now() ELSE NULL END),
    fail_reason = COALESCE(p_fields->>'fail_reason', fail_reason),
    market_mapping_status = COALESCE(p_fields->>'market_mapping_status', market_mapping_status),
    us_market_slug = COALESCE(p_fields->>'us_market_slug', us_market_slug),
    live_price_snapshot = COALESCE(p_fields->'live_price_snapshot', live_price_snapshot),
    requested_shares = COALESCE((p_fields->>'requested_shares')::numeric, requested_shares),
    requested_notional_usd = COALESCE((p_fields->>'requested_notional_usd')::numeric, requested_notional_usd),
    submitted_order_id = COALESCE(p_fields->>'submitted_order_id', submitted_order_id),
    filled_shares = COALESCE((p_fields->>'filled_shares')::numeric, filled_shares),
    avg_fill_price = COALESCE((p_fields->>'avg_fill_price')::numeric, avg_fill_price),
    fees_usd = COALESCE((p_fields->>'fees_usd')::numeric, fees_usd),
    safety_checks = COALESCE(p_fields->'safety_checks', safety_checks),
    updated_at = now()
  WHERE id = p_intent_id
  RETURNING * INTO v_row;

  RETURN to_jsonb(v_row);
END;
$$;

REVOKE ALL ON FUNCTION public.update_live_pilot_intent_status_atomic(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_live_pilot_intent_status_atomic(uuid, text, jsonb) TO service_role;