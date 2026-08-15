-- supabase/tests/poligarch_live_pilot_schema.sql
-- Run via: psql -f supabase/tests/poligarch_live_pilot_schema.sql (after `supabase db reset --local`)
BEGIN;

-- The seed row must exist locked, kill-switch-engaged, zero caps.
DO $$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.live_pilot_state WHERE pilot_id = 'poligarch_v2_live_pilot';
  IF r IS NULL THEN
    RAISE EXCEPTION 'seed row missing';
  END IF;
  IF r.kill_switch_engaged IS NOT true THEN
    RAISE EXCEPTION 'kill switch must default engaged, got %', r.kill_switch_engaged;
  END IF;
  IF r.activation_stage <> 'locked' THEN
    RAISE EXCEPTION 'activation stage must default locked, got %', r.activation_stage;
  END IF;
  IF r.max_order_notional_usd <> 0 OR r.max_total_exposure_usd <> 0 OR r.max_daily_realized_loss_usd <> 0 THEN
    RAISE EXCEPTION 'caps must default to zero';
  END IF;
END $$;

-- anon/authenticated must never be able to write to either table.
DO $$
BEGIN
  BEGIN
    EXECUTE format('SET LOCAL ROLE authenticated');
    UPDATE public.live_pilot_state SET kill_switch_engaged = false WHERE pilot_id = 'poligarch_v2_live_pilot';
    RAISE EXCEPTION 'authenticated role must not be able to update live_pilot_state';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected
  END;
END $$;

ROLLBACK;
