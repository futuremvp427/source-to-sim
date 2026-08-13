-- Real-database regression for Finding C.
-- Runs after a clean migration replay and rolls back all test data.
BEGIN;

DO $$
DECLARE
  v_exp_a uuid := '10000000-0000-0000-0000-000000000001';
  v_exp_b uuid := '10000000-0000-0000-0000-000000000002';
  v_event_1 uuid := '20000000-0000-0000-0000-000000000001';
  v_event_2 uuid := '20000000-0000-0000-0000-000000000002';
  v_wallet text := '0xphase1isolation0000000000000000000000000000';
  v_count integer;
  v_result jsonb;
  v_shares numeric;
BEGIN
  -- The old partial unique guard is intentionally gone: two enabled experiments
  -- may follow the same immutable wallet stream.
  INSERT INTO public.paper_experiments (
    id, name, wallet_address, starting_cash, cash, enabled, follow_from_ts
  ) VALUES
    (v_exp_a, 'PHASE1 ISOLATION A', v_wallet, 100, 100, true, 0),
    (v_exp_b, 'PHASE1 ISOLATION B', v_wallet, 100, 100, true, 0);

  INSERT INTO public.worker_status (
    id, worker_id, state, fence, heartbeat_at, lease_expires_at, updated_at
  ) VALUES
    ('phase1:isolation:a', 'worker-a', 'running', 1, now(), now() + interval '1 hour', now()),
    ('phase1:isolation:b', 'worker-b', 'running', 1, now(), now() + interval '1 hour', now());

  INSERT INTO public.source_events (
    id, event_key, wallet, asset, market_title, side, shares, price,
    source_ts, identity_basis, identity_degraded
  ) VALUES
    (v_event_1, 'phase1-event-1', v_wallet, 'asset-1', 'Phase 1 test market', 'BUY', 10, 0.40, 1000, 'phase1-test', false),
    (v_event_2, 'phase1-event-2', v_wallet, 'asset-1', 'Phase 1 test market', 'SELL', 4, 0.60, 1001, 'phase1-test', false);

  SELECT count(*) INTO v_count
  FROM public.get_pending_experiment_source_events(v_exp_a, 10);
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'expected experiment A to see 2 pending events, got %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.get_pending_experiment_source_events(v_exp_b, 10);
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'expected experiment B to see 2 pending events, got %', v_count;
  END IF;

  v_result := public.process_source_event_atomic(
    'phase1:isolation:a', 'worker-a', 1, v_exp_a,
    jsonb_build_object(
      'source_event_id', v_event_1,
      'backfilled', false,
      'source_state', jsonb_build_object(
        'wallet', v_wallet, 'asset', 'asset-1', 'market_title', 'Phase 1 test market',
        'outcome', null, 'shares', 10, 'last_event_key', 'phase1-event-1', 'last_event_ts', 1000
      ),
      'trade', jsonb_build_object(
        'source_event_id', v_event_1, 'event_key', 'phase1-event-1', 'action', 'SKIP',
        'side', 'BUY', 'asset', 'asset-1', 'market_title', 'Phase 1 test market',
        'outcome', null, 'price', 0.40, 'shares', 0, 'notional', 0,
        'reason', 'phase1 test', 'cash_after', 100, 'realized_pnl', 0, 'source_ts', 1000
      ),
      'paper_position', null,
      'experiment', jsonb_build_object('cash', 100, 'realized_pnl', 0),
      'audit', null
    )
  );

  IF COALESCE((v_result->>'processed')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'experiment A first event was not recorded as processed: %', v_result;
  END IF;

  -- Processing A must not hide the immutable event from B.
  SELECT count(*) INTO v_count
  FROM public.get_pending_experiment_source_events(v_exp_b, 10)
  WHERE id = v_event_1;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'experiment A consumed event 1 globally; B no longer sees it';
  END IF;

  -- A retry is a complete no-op at the experiment-event transaction boundary.
  v_result := public.process_source_event_atomic(
    'phase1:isolation:a', 'worker-a', 1, v_exp_a,
    jsonb_build_object(
      'source_event_id', v_event_1,
      'backfilled', false,
      'source_state', jsonb_build_object(
        'wallet', v_wallet, 'asset', 'asset-1', 'market_title', 'Phase 1 test market',
        'outcome', null, 'shares', 999, 'last_event_key', 'phase1-event-1', 'last_event_ts', 1000
      ),
      'trade', null, 'paper_position', null, 'experiment', null, 'audit', null
    )
  );
  IF COALESCE((v_result->>'processed')::boolean, true) IS NOT FALSE THEN
    RAISE EXCEPTION 'retry unexpectedly reprocessed experiment A event 1: %', v_result;
  END IF;
  SELECT shares INTO v_shares
  FROM public.experiment_source_position_state
  WHERE experiment_id = v_exp_a AND asset = 'asset-1';
  IF v_shares <> 10 THEN
    RAISE EXCEPTION 'retry mutated A source state; expected 10, got %', v_shares;
  END IF;

  -- B independently consumes the same source event.
  v_result := public.process_source_event_atomic(
    'phase1:isolation:b', 'worker-b', 1, v_exp_b,
    jsonb_build_object(
      'source_event_id', v_event_1,
      'backfilled', false,
      'source_state', jsonb_build_object(
        'wallet', v_wallet, 'asset', 'asset-1', 'market_title', 'Phase 1 test market',
        'outcome', null, 'shares', 10, 'last_event_key', 'phase1-event-1', 'last_event_ts', 1000
      ),
      'trade', jsonb_build_object(
        'source_event_id', v_event_1, 'event_key', 'phase1-event-1', 'action', 'SKIP',
        'side', 'BUY', 'asset', 'asset-1', 'market_title', 'Phase 1 test market',
        'outcome', null, 'price', 0.40, 'shares', 0, 'notional', 0,
        'reason', 'phase1 test', 'cash_after', 100, 'realized_pnl', 0, 'source_ts', 1000
      ),
      'paper_position', null,
      'experiment', jsonb_build_object('cash', 100, 'realized_pnl', 0),
      'audit', null
    )
  );
  IF COALESCE((v_result->>'processed')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'experiment B could not independently process event 1: %', v_result;
  END IF;

  -- Advance only A through event 2. B's leader/source state must remain at 10.
  PERFORM public.process_source_event_atomic(
    'phase1:isolation:a', 'worker-a', 1, v_exp_a,
    jsonb_build_object(
      'source_event_id', v_event_2,
      'backfilled', false,
      'source_state', jsonb_build_object(
        'wallet', v_wallet, 'asset', 'asset-1', 'market_title', 'Phase 1 test market',
        'outcome', null, 'shares', 6, 'last_event_key', 'phase1-event-2', 'last_event_ts', 1001
      ),
      'trade', jsonb_build_object(
        'source_event_id', v_event_2, 'event_key', 'phase1-event-2', 'action', 'SKIP',
        'side', 'SELL', 'asset', 'asset-1', 'market_title', 'Phase 1 test market',
        'outcome', null, 'price', 0.60, 'shares', 0, 'notional', 0,
        'reason', 'phase1 test', 'cash_after', 100, 'realized_pnl', 0, 'source_ts', 1001
      ),
      'paper_position', null,
      'experiment', jsonb_build_object('cash', 100, 'realized_pnl', 0),
      'audit', null
    )
  );

  SELECT shares INTO v_shares
  FROM public.experiment_source_position_state
  WHERE experiment_id = v_exp_b AND asset = 'asset-1';
  IF v_shares <> 10 THEN
    RAISE EXCEPTION 'A advanced B source state; expected B=10, got %', v_shares;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.get_pending_experiment_source_events(v_exp_b, 10)
  WHERE id = v_event_2;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'experiment B lost event 2 after A processed it';
  END IF;

  PERFORM public.process_source_event_atomic(
    'phase1:isolation:b', 'worker-b', 1, v_exp_b,
    jsonb_build_object(
      'source_event_id', v_event_2,
      'backfilled', false,
      'source_state', jsonb_build_object(
        'wallet', v_wallet, 'asset', 'asset-1', 'market_title', 'Phase 1 test market',
        'outcome', null, 'shares', 6, 'last_event_key', 'phase1-event-2', 'last_event_ts', 1001
      ),
      'trade', jsonb_build_object(
        'source_event_id', v_event_2, 'event_key', 'phase1-event-2', 'action', 'SKIP',
        'side', 'SELL', 'asset', 'asset-1', 'market_title', 'Phase 1 test market',
        'outcome', null, 'price', 0.60, 'shares', 0, 'notional', 0,
        'reason', 'phase1 test', 'cash_after', 100, 'realized_pnl', 0, 'source_ts', 1001
      ),
      'paper_position', null,
      'experiment', jsonb_build_object('cash', 100, 'realized_pnl', 0),
      'audit', null
    )
  );

  SELECT count(*) INTO v_count
  FROM public.experiment_event_state
  WHERE experiment_id IN (v_exp_a, v_exp_b)
    AND source_event_id IN (v_event_1, v_event_2);
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'expected four independent experiment-event states, got %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.paper_trades
  WHERE experiment_id IN (v_exp_a, v_exp_b)
    AND event_key IN ('phase1-event-1', 'phase1-event-2');
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'expected four idempotent per-experiment decision rows, got %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.source_events
  WHERE id IN (v_event_1, v_event_2)
    AND processed_at IS NOT NULL;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'experiment processing still mutates shared source_events.processed_at';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.get_pending_experiment_source_events(v_exp_a, 10);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'experiment A still has pending rows after both events';
  END IF;
  SELECT count(*) INTO v_count
  FROM public.get_pending_experiment_source_events(v_exp_b, 10);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'experiment B still has pending rows after both events';
  END IF;
END $$;

ROLLBACK;
