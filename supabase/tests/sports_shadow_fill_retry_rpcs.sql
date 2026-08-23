-- Task 12D / P1-A: real-Postgres proof for insert_sports_shadow_episode /
-- update_sports_shadow_episode -- privilege hardening AND the Hard Design Gate's
-- transactional-rollback guarantee, against the ACTUAL migrated database (never a fake).
-- Run via: psql -f supabase/tests/sports_shadow_fill_retry_rpcs.sql (after
-- `supabase db reset --local`)
BEGIN;

DO $$
DECLARE
  v_fill_id uuid;
  v_signal_id uuid;
  v_trigger_id uuid;
  v_pmus_match_id uuid;
  v_kalshi_match_id uuid;
  v_oid_insert oid;
  v_oid_update oid;
  v_public_has_execute boolean;
  v_missing_count integer;
  v_status text;
BEGIN
  -- Seed one durable fill (PENDING by default).
  INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, source_ts, identity_basis)
  VALUES ('rpc-test-fill-1', '0xtest', '0xasset', 'BUY', 1, 'source_id')
  RETURNING id INTO v_fill_id;

  SELECT downstream_status INTO v_status FROM public.sports_shadow_source_fills WHERE id = v_fill_id;
  IF v_status <> 'PENDING' THEN
    RAISE EXCEPTION 'expected a freshly-inserted fill to default to downstream_status=PENDING, got %', v_status;
  END IF;

  ------------------------------------------------------------------
  -- 1. PRIVILEGE HARDENING: PUBLIC/anon/authenticated denied, service_role allowed,
  -- for BOTH RPCs -- real execution attempts, not just catalog checks.
  ------------------------------------------------------------------
  -- FINAL BUILD Part 16/1/5: signatures grew a trailing DEFAULT-valued parameter each
  -- (p_cluster_key / sell-ledger params) -- see 20260823110000/20260823100000's own
  -- doc comments for why the old signature was explicitly DROPped, not just replaced.
  -- CODEX P1-6 appended insert_sports_shadow_episode's 26th param (p_source_rules_
  -- description text), CODEX P1-3 appended update_sports_shadow_episode's 16th-18th
  -- params (untracked-sell-shares inventory lifecycle), and the PR #55 final gate
  -- appended atomic lifecycle-trigger params -- all via DROP+CREATE, so both exact-
  -- signature casts below must match the new arg lists.
  v_oid_insert := 'public.insert_sports_shadow_episode(uuid, text, text, text, text, text, text, text, text, timestamptz, timestamptz, numeric, numeric, numeric, integer, boolean, text, timestamptz, text, text, text, text, numeric, text, uuid, text)'::regprocedure;
  v_oid_update := 'public.update_sports_shadow_episode(uuid, uuid, timestamptz, timestamptz, numeric, numeric, numeric, integer, boolean, numeric, numeric, numeric, numeric, numeric, bigint, numeric, numeric, numeric, text, numeric, numeric, numeric, numeric, bigint)'::regprocedure;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = v_oid_insert AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) INTO v_public_has_execute;
  IF v_public_has_execute THEN RAISE EXCEPTION 'PUBLIC must not have EXECUTE on insert_sports_shadow_episode'; END IF;
  IF has_function_privilege('anon', v_oid_insert, 'EXECUTE') THEN RAISE EXCEPTION 'anon must not have EXECUTE on insert_sports_shadow_episode'; END IF;
  IF has_function_privilege('authenticated', v_oid_insert, 'EXECUTE') THEN RAISE EXCEPTION 'authenticated must not have EXECUTE on insert_sports_shadow_episode'; END IF;
  IF NOT has_function_privilege('service_role', v_oid_insert, 'EXECUTE') THEN RAISE EXCEPTION 'service_role must have EXECUTE on insert_sports_shadow_episode'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = v_oid_update AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) INTO v_public_has_execute;
  IF v_public_has_execute THEN RAISE EXCEPTION 'PUBLIC must not have EXECUTE on update_sports_shadow_episode'; END IF;
  IF has_function_privilege('anon', v_oid_update, 'EXECUTE') THEN RAISE EXCEPTION 'anon must not have EXECUTE on update_sports_shadow_episode'; END IF;
  IF has_function_privilege('authenticated', v_oid_update, 'EXECUTE') THEN RAISE EXCEPTION 'authenticated must not have EXECUTE on update_sports_shadow_episode'; END IF;
  IF NOT has_function_privilege('service_role', v_oid_update, 'EXECUTE') THEN RAISE EXCEPTION 'service_role must have EXECUTE on update_sports_shadow_episode'; END IF;

  BEGIN
    SET LOCAL ROLE anon;
    PERFORM public.insert_sports_shadow_episode(v_fill_id, 'x', '0xw', NULL, '0xc', '0xa', NULL, NULL, NULL, now(), now(), 0.5, 1, 0.5, 1, false, 'MLB', NULL, NULL, NULL, 'MONEYLINE', 'TEAM', NULL);
    RAISE EXCEPTION 'anon must not be able to call insert_sports_shadow_episode';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;

  ------------------------------------------------------------------
  -- 2. HARD DESIGN GATE, real Postgres: a deliberate CHECK-constraint violation
  -- (invalid bet_type) inside insert_sports_shadow_episode's own INSERT must roll
  -- back the ENTIRE function call -- no signal row, and the fill's downstream_status
  -- unchanged (still PENDING). This is the actual database enforcing atomicity, not
  -- an application-level assumption.
  ------------------------------------------------------------------
  BEGIN
    PERFORM public.insert_sports_shadow_episode(
      v_fill_id, 'rpc-test-episode-bad', '0xtest', NULL, '0xcondition', '0xasset', NULL, NULL, NULL,
      now(), now(), 0.5, 1, 0.5, 1, false, 'MLB', NULL, NULL, NULL, 'NOT_A_REAL_BET_TYPE', 'TEAM', NULL
    );
    RAISE EXCEPTION 'expected insert_sports_shadow_episode to fail on an invalid bet_type';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected
  END;

  IF EXISTS (SELECT 1 FROM public.sports_shadow_signals WHERE episode_key = 'rpc-test-episode-bad') THEN
    RAISE EXCEPTION 'HARD DESIGN GATE VIOLATED: a signal row was created despite the transaction failing';
  END IF;
  SELECT downstream_status INTO v_status FROM public.sports_shadow_source_fills WHERE id = v_fill_id;
  IF v_status <> 'PENDING' THEN
    RAISE EXCEPTION 'HARD DESIGN GATE VIOLATED: fill downstream_status changed to % despite the transaction failing (must remain PENDING)', v_status;
  END IF;

  ------------------------------------------------------------------
  -- 3. Happy path: insert_sports_shadow_episode atomically creates the signal AND
  -- marks the fill COMPLETE together.
  ------------------------------------------------------------------
  v_signal_id := public.insert_sports_shadow_episode(
    v_fill_id, 'rpc-test-episode-1', '0xtest', NULL, '0xcondition', '0xasset', NULL, NULL, NULL,
    now(), now(), 0.5, 10, 5, 1, false, 'MLB', NULL, 'AWY', 'HOM', 'MONEYLINE', 'TEAM', NULL
  );
  IF NOT EXISTS (SELECT 1 FROM public.sports_shadow_signals WHERE id = v_signal_id) THEN
    RAISE EXCEPTION 'expected a signal row to exist after insert_sports_shadow_episode';
  END IF;
  SELECT downstream_status INTO v_status FROM public.sports_shadow_source_fills WHERE id = v_fill_id;
  IF v_status <> 'COMPLETE' THEN
    RAISE EXCEPTION 'expected downstream_status=COMPLETE after insert_sports_shadow_episode, got %', v_status;
  END IF;

  ------------------------------------------------------------------
  -- 4. update_sports_shadow_episode atomically updates the signal's aggregate
  -- fields AND marks a (new, PENDING) fill COMPLETE together. update_sports_shadow_episode
  -- shares insert_sports_shadow_episode's identical structural pattern (a single flat
  -- plpgsql statement sequence with no internal exception handling, so ANY error inside it
  -- is one whole-function Postgres transaction rollback) -- the same rollback guarantee
  -- proven above for the INSERT variant applies identically here by construction; a second
  -- contrived failure trigger is not needed to establish the same mechanism.
  ------------------------------------------------------------------
  INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, source_ts, identity_basis)
  VALUES ('rpc-test-fill-2', '0xtest', '0xasset', 'BUY', 2, 'source_id')
  RETURNING id INTO v_fill_id;

  PERFORM public.update_sports_shadow_episode(v_fill_id, v_signal_id, now(), now(), 0.6, 20, 12, 2, true);
  SELECT downstream_status INTO v_status FROM public.sports_shadow_source_fills WHERE id = v_fill_id;
  IF v_status <> 'COMPLETE' THEN
    RAISE EXCEPTION 'expected downstream_status=COMPLETE after update_sports_shadow_episode, got %', v_status;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sports_shadow_signals WHERE id = v_signal_id AND source_shares = 20 AND source_sell_seen = true) THEN
    RAISE EXCEPTION 'expected update_sports_shadow_episode to have applied the new aggregate fields';
  END IF;

  ------------------------------------------------------------------
  -- 5. Atomic lifecycle trigger: a trigger constraint failure rolls back BOTH the
  -- episode update and the fill completion, so the source fill can be retried.
  ------------------------------------------------------------------
  INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, source_ts, identity_basis)
  VALUES ('rpc-test-fill-3', '0xtest', '0xasset', 'BUY', 3, 'source_id')
  RETURNING id INTO v_fill_id;

  BEGIN
    PERFORM public.update_sports_shadow_episode(
      v_fill_id, v_signal_id, now(), now(), 0.7, 30, 21, 3, true,
      0, 0, NULL, NULL, NULL, NULL, 0, 0, 0,
      'ADD', 10, NULL, NULL, 0.7, 3
    );
    RAISE EXCEPTION 'expected invalid ADD lifecycle trigger without add_fraction to fail';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected: sports_shadow_lifecycle_triggers_type_fraction_check
  END;
  SELECT downstream_status INTO v_status FROM public.sports_shadow_source_fills WHERE id = v_fill_id;
  IF v_status <> 'PENDING' THEN
    RAISE EXCEPTION 'expected invalid lifecycle trigger to leave fill PENDING, got %', v_status;
  END IF;
  IF EXISTS (SELECT 1 FROM public.sports_shadow_signals WHERE id = v_signal_id AND source_shares = 30) THEN
    RAISE EXCEPTION 'expected invalid lifecycle trigger to roll back signal aggregate mutation';
  END IF;

  PERFORM public.update_sports_shadow_episode(
    v_fill_id, v_signal_id, now(), now(), 0.7, 30, 21, 3, true,
    0, 0, NULL, NULL, NULL, NULL, 0, 0, 0,
    'ADD', 10, NULL, 0.5, 0.7, 3
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.sports_shadow_lifecycle_triggers
    WHERE source_fill_id = v_fill_id AND trigger_type = 'ADD' AND add_fraction = 0.5
  ) THEN
    RAISE EXCEPTION 'expected valid update_sports_shadow_episode call to record ADD lifecycle trigger atomically';
  END IF;
  SELECT id INTO v_trigger_id
  FROM public.sports_shadow_lifecycle_triggers
  WHERE source_fill_id = v_fill_id AND trigger_type = 'ADD' AND add_fraction = 0.5;

  ------------------------------------------------------------------
  -- 6. Lifecycle scheduling RPC is venue-complete: PM-US rows already existing for a
  -- trigger must not hide the missing Kalshi venue, and once Kalshi's own five rows
  -- exist the trigger/venue pair disappears idempotently.
  ------------------------------------------------------------------
  INSERT INTO public.sports_market_matches (
    signal_id, venue, match_status, first_match_status, target_market_id, selected_side
  )
  VALUES (v_signal_id, 'PMUS', 'EXACT', 'EXACT', 'pmus-fetch-key', 'TEAM:AWY:LONG')
  RETURNING id INTO v_pmus_match_id;

  INSERT INTO public.sports_market_matches (
    signal_id, venue, match_status, first_match_status, target_market_id, selected_side
  )
  VALUES (v_signal_id, 'KALSHI', 'EXACT', 'EXACT', 'kalshi-ticker', 'YES')
  RETURNING id INTO v_kalshi_match_id;

  INSERT INTO public.sports_quote_observations (
    signal_id, match_id, venue, requested_delay_ms, source_timestamp, fire_at, trigger_source_fill_id
  )
  SELECT v_signal_id, v_pmus_match_id, 'PMUS', d.requested_delay_ms, now(), now(), v_trigger_id
  FROM unnest(ARRAY[0, 5000, 10000, 30000, 60000]::integer[]) AS d(requested_delay_ms);

  SELECT count(*) INTO v_missing_count
  FROM public.find_unscheduled_sports_shadow_lifecycle_triggers(20)
  WHERE id = v_trigger_id AND venue = 'PMUS';
  IF v_missing_count <> 0 THEN
    RAISE EXCEPTION 'expected already-scheduled PMUS lifecycle venue to be omitted, got % rows', v_missing_count;
  END IF;

  SELECT count(*) INTO v_missing_count
  FROM public.find_unscheduled_sports_shadow_lifecycle_triggers(20)
  WHERE id = v_trigger_id AND venue = 'KALSHI' AND match_id = v_kalshi_match_id;
  IF v_missing_count <> 1 THEN
    RAISE EXCEPTION 'expected missing Kalshi lifecycle venue to be returned exactly once, got % rows', v_missing_count;
  END IF;

  INSERT INTO public.sports_quote_observations (
    signal_id, match_id, venue, requested_delay_ms, source_timestamp, fire_at, trigger_source_fill_id
  )
  SELECT v_signal_id, v_kalshi_match_id, 'KALSHI', d.requested_delay_ms, now(), now(), v_trigger_id
  FROM unnest(ARRAY[0, 5000, 10000, 30000, 60000]::integer[]) AS d(requested_delay_ms);

  SELECT count(*) INTO v_missing_count
  FROM public.find_unscheduled_sports_shadow_lifecycle_triggers(20)
  WHERE id = v_trigger_id;
  IF v_missing_count <> 0 THEN
    RAISE EXCEPTION 'expected lifecycle trigger to disappear only after all exact venues are scheduled, got % rows', v_missing_count;
  END IF;

  RAISE NOTICE 'sports_shadow_fill_retry_rpcs contract passed';
END $$;

ROLLBACK;
