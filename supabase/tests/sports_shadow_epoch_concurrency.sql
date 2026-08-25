-- CANARY-1: real-Postgres concurrency proof for atomic Sports Shadow epoch
-- resolution. This intentionally uses dblink async queries so multiple database
-- sessions call ensure_sports_shadow_current_epoch at the same time.

CREATE EXTENSION IF NOT EXISTS dblink;

CREATE OR REPLACE FUNCTION pg_temp.call_epoch_concurrently(
  p_calls integer,
  p_go_live_at timestamptz,
  p_wallet_cohort text[],
  p_git_sha text,
  p_config_hash text,
  p_classifier_version text,
  p_episode_version text,
  p_resolver_version text,
  p_router_version text,
  p_pmus_fee_model_version text,
  p_kalshi_fee_model_version text,
  p_execution_simulator_version text,
  p_settlement_version text
) RETURNS uuid[]
LANGUAGE plpgsql
AS $$
DECLARE
  v_conn text;
  v_conns text[] := '{}';
  v_sql text;
  v_busy boolean;
  v_epoch_id uuid;
  v_ids uuid[] := '{}';
BEGIN
  IF p_calls < 1 THEN
    RAISE EXCEPTION 'p_calls must be positive';
  END IF;

  v_sql := format(
    'SELECT (public.ensure_sports_shadow_current_epoch(%L::timestamptz, %L::text[], %L, %L, %L, %L, %L, %L, %L, %L, %L, %L)).id::uuid AS epoch_id',
    p_go_live_at,
    p_wallet_cohort,
    p_git_sha,
    p_config_hash,
    p_classifier_version,
    p_episode_version,
    p_resolver_version,
    p_router_version,
    p_pmus_fee_model_version,
    p_kalshi_fee_model_version,
    p_execution_simulator_version,
    p_settlement_version
  );

  FOR i IN 1..p_calls LOOP
    v_conn := 'sports_epoch_concurrency_' || txid_current()::text || '_' || i::text;
    PERFORM dblink_connect(v_conn, format('dbname=%I', current_database()));
    PERFORM dblink_send_query(v_conn, v_sql);
    v_conns := array_append(v_conns, v_conn);
  END LOOP;

  LOOP
    v_busy := false;
    FOREACH v_conn IN ARRAY v_conns LOOP
      IF dblink_is_busy(v_conn) = 1 THEN
        v_busy := true;
      END IF;
    END LOOP;
    EXIT WHEN NOT v_busy;
    PERFORM pg_sleep(0.01);
  END LOOP;

  FOREACH v_conn IN ARRAY v_conns LOOP
    SELECT epoch_id INTO v_epoch_id
    FROM dblink_get_result(v_conn) AS t(epoch_id uuid);
    IF v_epoch_id IS NULL THEN
      RAISE EXCEPTION 'ensure_sports_shadow_current_epoch returned NULL through %', v_conn;
    END IF;
    v_ids := array_append(v_ids, v_epoch_id);
    PERFORM dblink_disconnect(v_conn);
  END LOOP;

  RETURN v_ids;
EXCEPTION
  WHEN OTHERS THEN
    FOREACH v_conn IN ARRAY v_conns LOOP
      BEGIN
        PERFORM dblink_disconnect(v_conn);
      EXCEPTION
        WHEN OTHERS THEN NULL;
      END;
    END LOOP;
    RAISE;
END;
$$;

DO $$
DECLARE
  v_original_current_id uuid;
  v_ids uuid[];
  v_id uuid;
  v_current_count integer;
  v_distinct_count integer;
  v_b_id uuid;
  v_after_count integer;
  v_fill_id uuid;
  v_oid oid;
BEGIN
  SELECT id INTO v_original_current_id
  FROM public.sports_shadow_experiment_epochs
  WHERE is_current
  LIMIT 1;

  UPDATE public.sports_shadow_experiment_epochs
  SET is_current = false
  WHERE config_hash LIKE 'canary-epoch-concurrency-%';
  DELETE FROM public.sports_shadow_experiment_epochs
  WHERE config_hash LIKE 'canary-epoch-concurrency-%';

  v_oid := 'public.ensure_sports_shadow_current_epoch(timestamp with time zone, text[], text, text, text, text, text, text, text, text, text, text)'::regprocedure;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must have EXECUTE on ensure_sports_shadow_current_epoch';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not have EXECUTE on ensure_sports_shadow_current_epoch';
  END IF;
  IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must not have EXECUTE on ensure_sports_shadow_current_epoch';
  END IF;

  -- Same identity: 10 concurrent callers converge on one current epoch and one id.
  v_ids := pg_temp.call_epoch_concurrently(
    10,
    '2026-08-25T00:00:00Z',
    ARRAY['0x1111111111111111111111111111111111111111'],
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'canary-epoch-concurrency-a',
    'classifier-a',
    'episode-a',
    'resolver-a',
    'router-a',
    'pmus-fee-a',
    'kalshi-fee-a',
    'sim-a',
    'settlement-a'
  );
  SELECT count(DISTINCT x) INTO v_distinct_count FROM unnest(v_ids) AS x;
  IF v_distinct_count <> 1 THEN
    RAISE EXCEPTION 'same-identity concurrent calls returned % distinct epoch ids: %', v_distinct_count, v_ids;
  END IF;
  SELECT count(*) INTO v_current_count FROM public.sports_shadow_experiment_epochs WHERE is_current;
  IF v_current_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one current epoch after same-identity calls, got %', v_current_count;
  END IF;

  -- New identity B over current A: concurrent callers create exactly one B current.
  v_ids := pg_temp.call_epoch_concurrently(
    10,
    '2026-08-25T00:00:00Z',
    ARRAY['0x1111111111111111111111111111111111111111'],
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'canary-epoch-concurrency-b',
    'classifier-a',
    'episode-a',
    'resolver-a',
    'router-a',
    'pmus-fee-a',
    'kalshi-fee-a',
    'sim-a',
    'settlement-a'
  );
  SELECT count(DISTINCT x) INTO v_distinct_count FROM unnest(v_ids) AS x;
  IF v_distinct_count <> 1 THEN
    RAISE EXCEPTION 'new-identity concurrent calls returned % distinct epoch ids: %', v_distinct_count, v_ids;
  END IF;
  v_b_id := v_ids[1];
  IF (SELECT config_hash FROM public.sports_shadow_experiment_epochs WHERE is_current) <> 'canary-epoch-concurrency-b' THEN
    RAISE EXCEPTION 'expected B to be current after concurrent rollover';
  END IF;

  -- Subsequent same B call: no extra B row is created.
  SELECT count(*) INTO v_after_count FROM public.sports_shadow_experiment_epochs WHERE config_hash = 'canary-epoch-concurrency-b';
  v_ids := pg_temp.call_epoch_concurrently(
    10,
    '2026-08-25T00:00:00Z',
    ARRAY['0x1111111111111111111111111111111111111111'],
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'canary-epoch-concurrency-b',
    'classifier-a',
    'episode-a',
    'resolver-a',
    'router-a',
    'pmus-fee-a',
    'kalshi-fee-a',
    'sim-a',
    'settlement-a'
  );
  IF v_ids[1] <> v_b_id THEN
    RAISE EXCEPTION 'subsequent same-B calls returned %, expected %', v_ids[1], v_b_id;
  END IF;
  IF (SELECT count(*) FROM public.sports_shadow_experiment_epochs WHERE config_hash = 'canary-epoch-concurrency-b') <> v_after_count THEN
    RAISE EXCEPTION 'subsequent same-B calls created an additional B epoch';
  END IF;

  -- Different deployment SHA: creates one new current epoch.
  v_ids := pg_temp.call_epoch_concurrently(
    10,
    '2026-08-25T00:00:00Z',
    ARRAY['0x1111111111111111111111111111111111111111'],
    'cccccccccccccccccccccccccccccccccccccccc',
    'canary-epoch-concurrency-b',
    'classifier-a',
    'episode-a',
    'resolver-a',
    'router-a',
    'pmus-fee-a',
    'kalshi-fee-a',
    'sim-a',
    'settlement-a'
  );
  SELECT count(DISTINCT x) INTO v_distinct_count FROM unnest(v_ids) AS x;
  IF v_distinct_count <> 1 THEN
    RAISE EXCEPTION 'different-SHA concurrent calls returned % distinct epoch ids: %', v_distinct_count, v_ids;
  END IF;
  IF (SELECT git_sha FROM public.sports_shadow_experiment_epochs WHERE is_current) <> 'cccccccccccccccccccccccccccccccccccccccc' THEN
    RAISE EXCEPTION 'expected different deployment SHA to become current once';
  END IF;

  -- Different go-live boundary: creates one new current epoch.
  v_ids := pg_temp.call_epoch_concurrently(
    10,
    '2026-08-26T00:00:00Z',
    ARRAY['0x1111111111111111111111111111111111111111'],
    'cccccccccccccccccccccccccccccccccccccccc',
    'canary-epoch-concurrency-b',
    'classifier-a',
    'episode-a',
    'resolver-a',
    'router-a',
    'pmus-fee-a',
    'kalshi-fee-a',
    'sim-a',
    'settlement-a'
  );
  SELECT count(DISTINCT x) INTO v_distinct_count FROM unnest(v_ids) AS x;
  IF v_distinct_count <> 1 THEN
    RAISE EXCEPTION 'different-go-live concurrent calls returned % distinct epoch ids: %', v_distinct_count, v_ids;
  END IF;
  IF (SELECT go_live_at FROM public.sports_shadow_experiment_epochs WHERE is_current) <> '2026-08-26T00:00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'expected different go-live boundary to become current once';
  END IF;

  -- DB guardrails must reject future NULL epoch-bearing research rows while allowing
  -- existing failed-canary evidence to remain unvalidated.
  BEGIN
    INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, source_ts, identity_basis)
    VALUES ('canary-null-epoch-fill', '0x1111111111111111111111111111111111111111', 'asset', 'BUY', 1, 'source_id')
    RETURNING id INTO v_fill_id;
    INSERT INTO public.sports_shadow_signals (
      episode_key, source_wallet, source_asset, first_fill_id, source_first_fill_at, source_last_fill_at,
      bet_type, selected_side, experiment_epoch_id
    ) VALUES (
      'canary-null-epoch-signal', '0x1111111111111111111111111111111111111111', 'asset',
      v_fill_id, now(), now(), 'MONEYLINE', 'TEAM', NULL
    );
    RAISE EXCEPTION 'expected future sports_shadow_signals NULL experiment_epoch_id insert to fail';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  -- Cleanup dblink-created rows before later SQL tests run.
  UPDATE public.sports_shadow_experiment_epochs
  SET is_current = false
  WHERE is_current AND config_hash LIKE 'canary-epoch-concurrency-%';
  IF v_original_current_id IS NOT NULL THEN
    UPDATE public.sports_shadow_experiment_epochs
    SET is_current = true
    WHERE id = v_original_current_id;
  END IF;
  DELETE FROM public.sports_shadow_experiment_epochs
  WHERE config_hash LIKE 'canary-epoch-concurrency-%';
  DELETE FROM public.sports_shadow_source_fills
  WHERE event_key = 'canary-null-epoch-fill';
END;
$$;
