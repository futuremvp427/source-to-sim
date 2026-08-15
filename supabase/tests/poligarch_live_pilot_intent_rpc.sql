-- supabase/tests/poligarch_live_pilot_intent_rpc.sql
-- Run via: psql -f supabase/tests/poligarch_live_pilot_intent_rpc.sql (after `supabase db reset --local`)
BEGIN;

DO $$
DECLARE
  v_exp_id uuid;
  v_event_id uuid;
  v_first jsonb;
  v_second jsonb;
  v_count int;
BEGIN
  INSERT INTO public.paper_experiments (name, wallet_address)
  VALUES ('SHADOW V2: Poligarch', '0xb40e89677d59665d5188541ad860450a6e2a7cc9')
  RETURNING id INTO v_exp_id;

  INSERT INTO public.source_events (event_key, wallet, asset, side, price, source_ts, identity_basis)
  VALUES ('test-event-1', '0xb40e89677d59665d5188541ad860450a6e2a7cc9', 'tok-a', 'BUY', 0.42, 1000, 'tx_hash')
  RETURNING id INTO v_event_id;

  v_first := public.create_or_get_live_pilot_intent_atomic(
    'poligarch_v2_live_pilot', v_exp_id, v_event_id,
    jsonb_build_object('source_event_key', 'test-event-1', 'source_wallet', '0xb40e89677d59665d5188541ad860450a6e2a7cc9', 'source_side', 'BUY', 'source_price', 0.42, 'source_ts', 1000)
  );
  IF (v_first->>'created')::boolean IS NOT true THEN
    RAISE EXCEPTION 'first call must create a new intent';
  END IF;

  -- Replay: same experiment + same source event must NOT create a second row.
  v_second := public.create_or_get_live_pilot_intent_atomic(
    'poligarch_v2_live_pilot', v_exp_id, v_event_id,
    jsonb_build_object('source_event_key', 'test-event-1', 'source_wallet', '0xb40e89677d59665d5188541ad860450a6e2a7cc9', 'source_side', 'BUY', 'source_price', 0.42, 'source_ts', 1000)
  );
  IF (v_second->>'created')::boolean IS NOT false THEN
    RAISE EXCEPTION 'replay must not create a second intent';
  END IF;
  IF v_first->>'intent_id' <> v_second->>'intent_id' THEN
    RAISE EXCEPTION 'replay must return the same intent id';
  END IF;

  SELECT count(*) INTO v_count FROM public.live_order_intents WHERE source_experiment_id = v_exp_id;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 intent row, got %', v_count;
  END IF;

  -- Status transition appends to history, does not overwrite it.
  PERFORM public.update_live_pilot_intent_status_atomic(
    (v_first->>'intent_id')::uuid, 'SKIPPED', jsonb_build_object('fail_reason', 'LIVE_MARKET_MAPPING_UNVERIFIED')
  );
  SELECT jsonb_array_length(status_history) INTO v_count FROM public.live_order_intents WHERE id = (v_first->>'intent_id')::uuid;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'expected 2 status_history entries after one transition, got %', v_count;
  END IF;

  -- Invalid status must be rejected.
  BEGIN
    PERFORM public.update_live_pilot_intent_status_atomic((v_first->>'intent_id')::uuid, 'BOGUS', '{}'::jsonb);
    RAISE EXCEPTION 'invalid status must have raised';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'invalid status%' THEN
      RAISE;
    END IF;
  END;

  -- anon/authenticated must not be able to call either RPC directly.
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.create_or_get_live_pilot_intent_atomic('poligarch_v2_live_pilot', v_exp_id, v_event_id, '{}'::jsonb);
    RAISE EXCEPTION 'authenticated must not be able to call create_or_get_live_pilot_intent_atomic';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;

  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.update_live_pilot_intent_status_atomic((v_first->>'intent_id')::uuid, 'AUTHORIZED', '{}'::jsonb);
    RAISE EXCEPTION 'authenticated must not be able to call update_live_pilot_intent_status_atomic';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;
END $$;

ROLLBACK;
