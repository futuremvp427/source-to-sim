\set ON_ERROR_STOP on

-- Safety contract for the Weather Lab research schema. Runs after a clean
-- migration replay in Audit CI.
--
-- The point of these assertions is that the paper-only guarantee must survive a
-- caller that bypasses the application layer entirely. If a future change makes
-- a live-mode or phantom-trade row insertable, this fails.

DO $$
DECLARE
  experiment_id uuid;
  event_id uuid;
  contract_id uuid;
  order_id uuid;
  signal_id uuid;
  model_run_id uuid;
  rls_disabled_count integer;
  missing_table_count integer;
BEGIN
  -- Every weather lab table must exist and have RLS enabled.
  SELECT count(*) INTO missing_table_count
  FROM (
    VALUES
      ('weather_lab_experiments'), ('weather_lab_market_events'),
      ('weather_lab_market_contracts'), ('weather_lab_quote_snapshots'),
      ('weather_lab_model_runs'), ('weather_lab_bucket_probabilities'),
      ('weather_lab_signals'), ('weather_lab_paper_orders'),
      ('weather_lab_paper_fills'), ('weather_lab_positions'),
      ('weather_lab_settlements'), ('weather_lab_performance_snapshots')
  ) AS expected(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename = expected.name
  );

  IF missing_table_count <> 0 THEN
    RAISE EXCEPTION 'expected every weather_lab table to exist, % missing', missing_table_count;
  END IF;

  SELECT count(*) INTO rls_disabled_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname LIKE 'weather\_lab\_%'
    AND c.relkind = 'r'
    AND c.relrowsecurity = false;

  IF rls_disabled_count <> 0 THEN
    RAISE EXCEPTION 'expected RLS enabled on every weather_lab table, % without it', rls_disabled_count;
  END IF;

  -- A PAPER experiment inserts cleanly.
  INSERT INTO public.weather_lab_experiments (experiment_key, strategy_version, config_hash, config)
  VALUES ('test-exp', 'weather-intraday-v1', 'wlx1-test', '{}'::jsonb)
  RETURNING id INTO experiment_id;

  -- A live-mode experiment must be impossible at the database level.
  BEGIN
    INSERT INTO public.weather_lab_experiments (experiment_key, strategy_version, config_hash, config, mode)
    VALUES ('test-live', 'weather-intraday-v1', 'wlx1-live', '{}'::jsonb, 'LIVE');
    RAISE EXCEPTION 'weather_lab_experiments accepted mode=LIVE; paper-only constraint is missing';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  INSERT INTO public.weather_lab_market_events (
    venue, event_ticker, city, station, weather_date, timezone
  ) VALUES ('KALSHI', 'KXHIGHNY-26AUG27', 'NYC', 'CLINYC', DATE '2026-08-27', 'America/New_York')
  RETURNING id INTO event_id;

  -- Settlement must default to unverified so a contract cannot trade by omission.
  IF (SELECT settlement_status FROM public.weather_lab_market_events WHERE id = event_id)
     <> 'SETTLEMENT_UNVERIFIED' THEN
    RAISE EXCEPTION 'weather_lab_market_events must default to SETTLEMENT_UNVERIFIED';
  END IF;

  IF (SELECT bucket_set_status FROM public.weather_lab_market_events WHERE id = event_id) <> 'UNVALIDATED' THEN
    RAISE EXCEPTION 'weather_lab_market_events must default to UNVALIDATED bucket set';
  END IF;

  INSERT INTO public.weather_lab_market_contracts (event_id, ticker, label, lower_f, upper_f)
  VALUES (event_id, 'KXHIGHNY-26AUG27-B84.5', '84° to 85°', 84, 85)
  RETURNING id INTO contract_id;

  INSERT INTO public.weather_lab_model_runs (experiment_id, config_hash, event_id, decision_at)
  VALUES (experiment_id, 'wlx1-test', event_id, now())
  RETURNING id INTO model_run_id;

  -- A probability outside [0,1] is not a probability.
  BEGIN
    INSERT INTO public.weather_lab_bucket_probabilities (model_run_id, contract_id, probability)
    VALUES (model_run_id, contract_id, 1.5);
    RAISE EXCEPTION 'weather_lab_bucket_probabilities accepted probability 1.5';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  INSERT INTO public.weather_lab_signals (
    experiment_id, config_hash, model_run_id, contract_id, signal_at,
    model_probability, executable_price, raw_edge, fee_per_contract,
    slippage_buffer, net_edge, decision
  ) VALUES (
    experiment_id, 'wlx1-test', model_run_id, contract_id, now(),
    0.23, 0.08, 0.15, 0.0052, 0.01, 0.1348, 'ENTER'
  ) RETURNING id INTO signal_id;

  INSERT INTO public.weather_lab_paper_orders (
    signal_id, experiment_id, config_hash, side, requested_contracts, max_price, observed_ladder
  ) VALUES (signal_id, experiment_id, 'wlx1-test', 'BUY_YES', 100, 0.1, '[]'::jsonb)
  RETURNING id INTO order_id;

  -- A NO_FILL is not a trade: it must never be able to carry size or cost.
  BEGIN
    INSERT INTO public.weather_lab_paper_fills (
      order_id, experiment_id, config_hash, scenario, fill_status,
      filled_contracts, average_price, all_in_cost_usd
    ) VALUES (order_id, experiment_id, 'wlx1-test', 'BASE', 'NO_FILL', 100, 0.08, 8.52);
    RAISE EXCEPTION 'weather_lab_paper_fills accepted a NO_FILL carrying size and cost';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  -- An empty NO_FILL is legitimate and must be recordable.
  INSERT INTO public.weather_lab_paper_fills (
    order_id, experiment_id, config_hash, scenario, fill_status, no_fill_reason
  ) VALUES (order_id, experiment_id, 'wlx1-test', 'PLUS_3C', 'NO_FILL', 'INSUFFICIENT_DEPTH');

  -- An unrecognised adverse scenario must be rejected.
  BEGIN
    INSERT INTO public.weather_lab_paper_fills (
      order_id, experiment_id, config_hash, scenario, fill_status
    ) VALUES (order_id, experiment_id, 'wlx1-test', 'PLUS_9C', 'FILLED');
    RAISE EXCEPTION 'weather_lab_paper_fills accepted an unknown scenario';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  -- Only one fill per order per scenario, so stress results cannot double count.
  INSERT INTO public.weather_lab_paper_fills (
    order_id, experiment_id, config_hash, scenario, fill_status,
    filled_contracts, average_price, notional_usd, fee_usd, all_in_cost_usd
  ) VALUES (order_id, experiment_id, 'wlx1-test', 'BASE', 'FILLED', 100, 0.08, 8.0, 0.52, 8.52);

  BEGIN
    INSERT INTO public.weather_lab_paper_fills (
      order_id, experiment_id, config_hash, scenario, fill_status
    ) VALUES (order_id, experiment_id, 'wlx1-test', 'BASE', 'FILLED');
    RAISE EXCEPTION 'weather_lab_paper_fills accepted a duplicate order/scenario fill';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;

  RAISE NOTICE 'weather_lab schema safety contract OK';
  RAISE EXCEPTION 'rollback test transaction';
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM <> 'rollback test transaction' THEN
      RAISE;
    END IF;
END $$;

-- The weather lab must not have introduced any live-execution surface.
DO $$
DECLARE
  suspicious_count integer;
BEGIN
  SELECT count(*) INTO suspicious_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name LIKE 'weather\_lab\_%'
    AND (
      column_name ILIKE '%api_key%'
      OR column_name ILIKE '%private_key%'
      OR column_name ILIKE '%credential%'
      OR column_name ILIKE '%live_order%'
      OR column_name ILIKE '%enable_live%'
    );

  IF suspicious_count <> 0 THEN
    RAISE EXCEPTION 'weather_lab schema exposes % live-execution/credential column(s)', suspicious_count;
  END IF;
END $$;
