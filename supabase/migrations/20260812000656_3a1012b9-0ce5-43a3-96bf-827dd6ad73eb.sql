CREATE TABLE IF NOT EXISTS public.live_safety_state (
  id text PRIMARY KEY DEFAULT 'global',
  kill_switch_engaged boolean NOT NULL DEFAULT true,
  activation_stage text NOT NULL DEFAULT 'locked',
  armed_at timestamptz,
  armed_by uuid,
  activated_at timestamptz,
  activated_by uuid,
  max_live_notional_usd numeric NOT NULL DEFAULT 0,
  max_live_exposure_usd numeric NOT NULL DEFAULT 0,
  last_action text,
  last_action_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT live_safety_stage_check CHECK (activation_stage IN ('locked','armed','activated')),
  CONSTRAINT live_safety_single_row CHECK (id = 'global')
);

GRANT SELECT ON public.live_safety_state TO authenticated;
GRANT ALL ON public.live_safety_state TO service_role;
ALTER TABLE public.live_safety_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read live safety state" ON public.live_safety_state;
CREATE POLICY "Admins can read live safety state"
  ON public.live_safety_state FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

INSERT INTO public.live_safety_state (id) VALUES ('global') ON CONFLICT (id) DO NOTHING;