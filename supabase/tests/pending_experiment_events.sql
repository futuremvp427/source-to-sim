-- Regression coverage for get_pending_experiment_source_events after the
-- ordered-scan + correlated-probe optimization. Rolls back all test data.
BEGIN;

DO $$
DECLARE
  v_exp_a uuid := '30000000-0000-0000-0000-000000000001';
  v_exp_b uuid := '30000000-0000-0000-0000-000000000002';
  v_wallet text := '0xpendingscan000000000000000000000000000000000';
  v_id uuid;
  v_count integer;
  v_first text;
  v_ts bigint;
  i integer;
BEGIN
  INSERT INTO public.paper_experiments (
    id, name, wallet_address, starting_cash, cash, enabled, follow_from_ts
  ) VALUES
    (v_exp_a, 'PENDING SCAN A', v_wallet, 100, 100, true, 0),
    (v_exp_b, 'PENDING SCAN B', v_wallet, 100, 100, true, 0);

  -- 1200 events: a long consumed prefix followed by a pending tail.
  FOR i IN 1..1200 LOOP
    INSERT INTO public.source_events (
      event_key, wallet, asset, market_title, side, shares, price,
      source_ts, identity_basis, identity_degraded
    ) VALUES (
      'pending-scan-' || lpad(i::text, 5, '0'), v_wallet, 'asset-1',
      'Pending scan market', 'BUY', 1, 0.5, 1000 + i, 'pending-scan-test', false
    );
  END LOOP;

  -- Experiment A consumes the earliest 1000 events.
  INSERT INTO public.experiment_event_state (
    experiment_id, source_event_id, event_key, processed_at, backfilled, legacy_seeded
  )
  SELECT v_exp_a, se.id, se.event_key, now(), false, false
  FROM public.source_events se
  WHERE se.wallet = v_wallet
  ORDER BY se.source_ts ASC, se.event_key ASC
  LIMIT 1000;

  -- A long consumed prefix must not hide the pending tail.
  SELECT count(*) INTO v_count
  FROM public.get_pending_experiment_source_events(v_exp_a, 2000);
  IF v_count <> 200 THEN
    RAISE EXCEPTION 'expected 200 pending tail events for A, got %', v_count;
  END IF;

  -- Earliest-first ordering.
  SELECT event_key, source_ts INTO v_first, v_ts
  FROM public.get_pending_experiment_source_events(v_exp_a, 300)
  LIMIT 1;
  IF v_first <> 'pending-scan-01001' THEN
    RAISE EXCEPTION 'expected earliest pending event pending-scan-01001, got %', v_first;
  END IF;

  -- Bounded limit: clamps to >= 1 and <= 2000.
  SELECT count(*) INTO v_count
  FROM public.get_pending_experiment_source_events(v_exp_a, 0);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expected p_limit=0 to clamp to 1 row, got %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.get_pending_experiment_source_events(v_exp_a, 50);
  IF v_count <> 50 THEN
    RAISE EXCEPTION 'expected p_limit=50 to return 50 rows, got %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.get_pending_experiment_source_events(v_exp_a, 99999);
  IF v_count <> 200 THEN
    RAISE EXCEPTION 'expected oversized p_limit to stay bounded at available 200, got %', v_count;
  END IF;

  -- Same-wallet sibling B has consumed nothing, so every event is still pending.
  SELECT count(*) INTO v_count
  FROM public.get_pending_experiment_source_events(v_exp_b, 2000);
  IF v_count <> 1200 THEN
    RAISE EXCEPTION 'expected 1200 pending events for sibling B, got %', v_count;
  END IF;

  -- Ordering is strictly (source_ts, event_key) with no duplicates.
  SELECT count(*) INTO v_count FROM (
    SELECT id, source_ts, event_key,
           lag(source_ts) OVER (ORDER BY rn) AS prev_ts,
           lag(event_key) OVER (ORDER BY rn) AS prev_key
    FROM (
      SELECT p.*, row_number() OVER () AS rn
      FROM public.get_pending_experiment_source_events(v_exp_b, 2000) p
    ) ordered
  ) checked
  WHERE prev_ts IS NOT NULL
    AND (source_ts, event_key) <= (prev_ts, prev_key);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'pending events were not returned in (source_ts, event_key) order';
  END IF;

  SELECT count(*) INTO v_count FROM (
    SELECT id FROM public.get_pending_experiment_source_events(v_exp_b, 2000)
    GROUP BY id HAVING count(*) > 1
  ) dupes;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'pending events contained duplicate source_event ids';
  END IF;

  -- Idempotency: repeated calls are stable reads.
  SELECT id INTO v_id
  FROM public.get_pending_experiment_source_events(v_exp_a, 1);
  IF v_id IS DISTINCT FROM (
    SELECT id FROM public.get_pending_experiment_source_events(v_exp_a, 1)
  ) THEN
    RAISE EXCEPTION 'repeated pending reads were not stable';
  END IF;

  RAISE NOTICE 'pending_experiment_events regression passed';
END $$;

ROLLBACK;