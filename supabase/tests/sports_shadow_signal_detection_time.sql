-- Task 12G / P1-L: real-Postgres proof that insert_sports_shadow_episode anchors
-- sports_shadow_signals.created_at to the fill's OWN first_seen_at (T0 -- when we first
-- detected/persisted the raw fill), never to the RPC's own execution time (T1 -- a much
-- later retry/restart), while leaving source_first_fill_at/source_last_fill_at (the
-- SOURCE WALLET's trade time) and updated_at (actual mutation time) untouched. Also
-- re-verifies the privilege contract is unchanged from 20260821040000.
-- Run via: psql -f supabase/tests/sports_shadow_signal_detection_time.sql (after
-- `supabase db reset --local`)
BEGIN;

DO $$
DECLARE
  v_t0 timestamptz := now() - interval '2 hours'; -- T0: original detection, simulated as 2h in the past
  v_fill_id uuid;
  v_signal_id uuid;
  v_created_at timestamptz;
  v_source_first_fill_at timestamptz;
  v_source_last_fill_at timestamptz;
  v_updated_at timestamptz;
  v_oid oid;
  v_public_has_execute boolean;
BEGIN
  ------------------------------------------------------------------
  -- 1. PRIVILEGE HARDENING unchanged from 20260821040000: PUBLIC/anon/authenticated
  -- denied, service_role allowed -- real execution attempt, not just catalog inspection.
  ------------------------------------------------------------------
  -- FINAL BUILD Part 16: signature grew a trailing DEFAULT-valued p_cluster_key param.
  v_oid := 'public.insert_sports_shadow_episode(uuid, text, text, text, text, text, text, text, text, timestamptz, timestamptz, numeric, numeric, numeric, integer, boolean, text, timestamptz, text, text, text, text, numeric, text)'::regprocedure;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) INTO v_public_has_execute;
  IF v_public_has_execute THEN RAISE EXCEPTION 'PUBLIC must not have EXECUTE on insert_sports_shadow_episode'; END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'anon must not have EXECUTE on insert_sports_shadow_episode'; END IF;
  IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'authenticated must not have EXECUTE on insert_sports_shadow_episode'; END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'service_role must have EXECUTE on insert_sports_shadow_episode'; END IF;

  BEGIN
    SET LOCAL ROLE anon;
    PERFORM public.insert_sports_shadow_episode(gen_random_uuid(), 'x', '0xw', NULL, '0xc', '0xa', NULL, NULL, NULL, now(), now(), 0.5, 1, 0.5, 1, false, 'MLB', NULL, NULL, NULL, 'MONEYLINE', 'TEAM', NULL);
    RAISE EXCEPTION 'anon must not be able to call insert_sports_shadow_episode';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;

  ------------------------------------------------------------------
  -- 2. L1/L2: seed a raw fill whose first_seen_at (T0) is explicitly 2 hours in the
  -- past (simulating: fill detected at T0, downstream processing failed/stayed
  -- PENDING, and only NOW -- T1, "now()" -- does a retry finally succeed). The source
  -- trade timestamps (p_source_first_fill_at/p_source_last_fill_at) are deliberately
  -- set to a THIRD, different value again, to prove all three timestamps
  -- (first_seen_at/created_at vs source_first_fill_at vs "now") stay independently
  -- distinct rather than any of them collapsing into another.
  ------------------------------------------------------------------
  INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, source_ts, identity_basis, first_seen_at)
  VALUES ('detection-time-test-1', '0xtest', '0xasset', 'BUY', 1, 'source_id', v_t0)
  RETURNING id INTO v_fill_id;

  -- L2: the fix -- call the RPC "now" (T1, long after T0) and assert created_at == T0.
  v_signal_id := public.insert_sports_shadow_episode(
    v_fill_id, 'detection-time-episode-1', '0xtest', NULL, '0xcondition', '0xasset', NULL, NULL, NULL,
    '2026-01-01T00:00:00Z'::timestamptz, '2026-01-01T00:05:00Z'::timestamptz, -- source trade time: a THIRD distinct value
    0.5, 10, 5, 1, false, 'MLB', NULL, 'AWY', 'HOM', 'MONEYLINE', 'TEAM', NULL
  );

  SELECT created_at, source_first_fill_at, source_last_fill_at, updated_at
  INTO v_created_at, v_source_first_fill_at, v_source_last_fill_at, v_updated_at
  FROM public.sports_shadow_signals WHERE id = v_signal_id;

  -- L2/L25: created_at must equal T0 (the fill's first_seen_at), NOT "now" (T1).
  IF v_created_at <> v_t0 THEN
    RAISE EXCEPTION 'HARD GATE VIOLATED: expected signal.created_at = T0 (%), got %', v_t0, v_created_at;
  END IF;
  IF v_created_at >= now() - interval '1 hour' THEN
    RAISE EXCEPTION 'HARD GATE VIOLATED: signal.created_at (%) looks like it was set to the RPC execution time (now=%), not the original T0 detection time', v_created_at, now();
  END IF;

  -- L4/L26: source_first_fill_at/source_last_fill_at remain the SOURCE TRADE time --
  -- completely distinct from created_at (T0) and from each other's own concept.
  IF v_source_first_fill_at <> '2026-01-01T00:00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'HARD GATE VIOLATED: source_first_fill_at was overwritten with the detection time -- expected the source trade time';
  END IF;
  IF v_source_last_fill_at <> '2026-01-01T00:05:00Z'::timestamptz THEN
    RAISE EXCEPTION 'HARD GATE VIOLATED: source_last_fill_at was overwritten with the detection time -- expected the source trade time';
  END IF;
  IF v_source_first_fill_at = v_created_at THEN
    RAISE EXCEPTION 'HARD GATE VIOLATED: source_first_fill_at must never equal created_at in this test (they are deliberately different clocks)';
  END IF;

  -- updated_at remains the actual row-mutation time (i.e. "now", not T0) -- unaffected by this fix.
  IF v_updated_at < now() - interval '1 minute' THEN
    RAISE EXCEPTION 'updated_at should reflect the actual INSERT time (now), not T0 -- got %', v_updated_at;
  END IF;

  -- L9/L10 (part 1): a fresh fill can still be inserted correctly (the fix does not
  -- break the ordinary immediate no-failure path -- L3) -- fill detected and processed
  -- in the SAME instant, created_at should still equal first_seen_at exactly (T0 == T1
  -- in this case, trivially).
  DECLARE
    v_immediate_fill_id uuid;
    v_immediate_signal_id uuid;
    v_immediate_created_at timestamptz;
    v_immediate_first_seen_at timestamptz;
  BEGIN
    INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, source_ts, identity_basis)
    VALUES ('detection-time-test-2', '0xtest', '0xasset', 'BUY', 2, 'source_id')
    RETURNING id, first_seen_at INTO v_immediate_fill_id, v_immediate_first_seen_at;

    v_immediate_signal_id := public.insert_sports_shadow_episode(
      v_immediate_fill_id, 'detection-time-episode-2', '0xtest', NULL, '0xcondition2', '0xasset', NULL, NULL, NULL,
      now(), now(), 0.5, 10, 5, 1, false, 'MLB', NULL, 'AWY', 'HOM', 'MONEYLINE', 'TEAM', NULL
    );
    SELECT created_at INTO v_immediate_created_at FROM public.sports_shadow_signals WHERE id = v_immediate_signal_id;
    IF v_immediate_created_at <> v_immediate_first_seen_at THEN
      RAISE EXCEPTION 'L3 VIOLATED: immediate no-failure path must still anchor created_at to first_seen_at, got % vs %', v_immediate_created_at, v_immediate_first_seen_at;
    END IF;
  END;

  ------------------------------------------------------------------
  -- 3. L9: a fill_id that does not exist in sports_shadow_source_fills fails
  -- explicitly, rather than silently proceeding with a NULL/wrong detection anchor.
  ------------------------------------------------------------------
  BEGIN
    PERFORM public.insert_sports_shadow_episode(
      gen_random_uuid(), 'detection-time-episode-orphan', '0xtest', NULL, '0xcondition3', '0xasset', NULL, NULL, NULL,
      now(), now(), 0.5, 10, 5, 1, false, 'MLB', NULL, 'AWY', 'HOM', 'MONEYLINE', 'TEAM', NULL
    );
    RAISE EXCEPTION 'expected insert_sports_shadow_episode to fail explicitly for a nonexistent p_fill_id';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL; -- expected
  END;

  -- L9: that failed attempt must not have created a signal or mutated anything.
  IF EXISTS (SELECT 1 FROM public.sports_shadow_signals WHERE episode_key = 'detection-time-episode-orphan') THEN
    RAISE EXCEPTION 'HARD GATE VIOLATED: a signal was created despite the nonexistent-fill_id failure';
  END IF;

  RAISE NOTICE 'sports_shadow_signal_detection_time contract passed';
END $$;

ROLLBACK;
