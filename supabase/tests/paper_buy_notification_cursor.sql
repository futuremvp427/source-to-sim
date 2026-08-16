\set ON_ERROR_STOP on

-- Durable paper-BUY notification cursor regression.
-- Runs inside a transaction and leaves the clean-replay database unchanged.
BEGIN;

DO $$
DECLARE
  v_cursor_at timestamptz;
  v_count integer;
BEGIN
  IF has_function_privilege(
    'anon',
    'public.get_pending_paper_buy_notification_trades(integer)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'anon must not execute get_pending_paper_buy_notification_trades';
  END IF;
  IF has_function_privilege(
    'authenticated',
    'public.get_pending_paper_buy_notification_trades(integer)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated must not execute get_pending_paper_buy_notification_trades';
  END IF;
  IF NOT has_function_privilege(
    'service_role',
    'public.get_pending_paper_buy_notification_trades(integer)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'service_role must execute get_pending_paper_buy_notification_trades';
  END IF;
  IF has_function_privilege(
    'anon',
    'public.advance_paper_buy_notification_cursor(timestamp with time zone,uuid)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.advance_paper_buy_notification_cursor(timestamp with time zone,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'untrusted roles must not execute advance_paper_buy_notification_cursor';
  END IF;

  SELECT last_created_at INTO v_cursor_at
  FROM public.paper_buy_notification_cursor
  WHERE cursor_name = 'telegram-paper-buy';
  IF v_cursor_at IS NULL THEN
    RAISE EXCEPTION 'telegram-paper-buy cursor row is missing';
  END IF;

  INSERT INTO public.paper_experiments (
    id, name, wallet_address, starting_cash, cash, buy_amount,
    poll_interval_seconds, enabled, weather_only, realized_pnl, simulated
  ) VALUES (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
    'TEST: durable paper buy notification cursor',
    '0x00000000000000000000000000000000000000aa',
    380, 380, 5, 60, true, false, 0, true
  );

  -- Historical BUY before the feature cursor: must never be retro-notified.
  INSERT INTO public.paper_trades (
    id, experiment_id, event_key, action, side, asset, market_title,
    outcome, price, shares, notional, cash_after, source_ts, created_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000001'::uuid,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
    'cursor-before', 'BUY', 'BUY', 'asset-before', 'Before cursor',
    'Yes', 0.40, 10, 4, 376, 1, v_cursor_at - interval '1 second'
  );

  -- Two BUYs share an identical timestamp to prove the UUID tie-breaker.
  INSERT INTO public.paper_trades (
    id, experiment_id, event_key, action, side, asset, market_title,
    outcome, price, shares, notional, cash_after, source_ts, created_at
  ) VALUES
  (
    '00000000-0000-0000-0000-000000000002'::uuid,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
    'cursor-after-1', 'BUY', 'BUY', 'asset-after-1', 'After cursor one',
    'Yes', 0.50, 10, 5, 375, 2, v_cursor_at + interval '1 second'
  ),
  (
    '00000000-0000-0000-0000-000000000003'::uuid,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
    'cursor-after-2', 'BUY', 'BUY', 'asset-after-2', 'After cursor two',
    'No', 0.60, 10, 6, 369, 3, v_cursor_at + interval '1 second'
  );

  -- A SELL after the cursor is not a paper-BUY notification candidate.
  INSERT INTO public.paper_trades (
    id, experiment_id, event_key, action, side, asset, market_title,
    outcome, price, shares, notional, cash_after, source_ts, created_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000004'::uuid,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
    'cursor-sell', 'SELL', 'SELL', 'asset-after-1', 'After cursor sell',
    'Yes', 0.55, 5, 2.75, 371.75, 4, v_cursor_at + interval '2 seconds'
  );

  SELECT count(*) INTO v_count
  FROM public.get_pending_paper_buy_notification_trades(120)
  WHERE experiment_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'expected exactly 2 post-cursor BUYs, got %', v_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.get_pending_paper_buy_notification_trades(120)
    WHERE event_key = 'cursor-before'
  ) THEN
    RAISE EXCEPTION 'pre-cursor historical BUY must not be returned';
  END IF;

  PERFORM public.advance_paper_buy_notification_cursor(
    v_cursor_at + interval '1 second',
    '00000000-0000-0000-0000-000000000002'::uuid
  );

  -- Same timestamp, greater UUID must still remain pending.
  SELECT count(*) INTO v_count
  FROM public.get_pending_paper_buy_notification_trades(120)
  WHERE event_key = 'cursor-after-2';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'UUID tie-breaker lost the second BUY at the same timestamp';
  END IF;

  PERFORM public.advance_paper_buy_notification_cursor(
    v_cursor_at + interval '1 second',
    '00000000-0000-0000-0000-000000000003'::uuid
  );

  SELECT count(*) INTO v_count
  FROM public.get_pending_paper_buy_notification_trades(120)
  WHERE experiment_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'cursor advance must remove already-queued BUYs from the pending scan';
  END IF;

  RAISE NOTICE 'paper_buy_notification_cursor regression passed';
END $$;

ROLLBACK;
