-- Task 11B + Task 12D/P1-C: find_pending_sports_shadow_signals(p_venue, p_limit)
-- real-SQL semantic + privilege contract, run against the ACTUAL migrated database
-- (never a mocked/fake WorkerRepository). Reproduces the specific starvation defect
-- Task 11B fixed AND the per-venue head-of-line-blocking defect Task 12D/P1-C fixed
-- (supabase/migrations/20260820230000_sports_shadow_pending_signals_rpc.sql) with real
-- rows, not an in-memory reference implementation.
-- Run via: psql -f supabase/tests/sports_shadow_pending_signals_rpc.sql (after
-- `supabase db reset --local`)
BEGIN;

-- Temporary helper (rolled back with the transaction): seeds one fill + one signal at a
-- controlled created_at, returns the signal id. Keeps the scenarios below readable.
CREATE FUNCTION pg_temp.seed_pending_signal(p_key text, p_created_at timestamptz) RETURNS uuid AS $$
DECLARE
  v_fill_id uuid;
  v_signal_id uuid;
BEGIN
  INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, source_ts, identity_basis)
  VALUES ('fill-' || p_key, '0xtestwallet', '0xtestasset-' || p_key, 'BUY', 1, 'source_id')
  RETURNING id INTO v_fill_id;

  INSERT INTO public.sports_shadow_signals (episode_key, source_wallet, source_asset, first_fill_id, source_first_fill_at, source_last_fill_at, bet_type, selected_side, created_at, updated_at)
  VALUES ('episode-' || p_key, '0xtestwallet', '0xtestasset-' || p_key, v_fill_id, p_created_at, p_created_at, 'MONEYLINE', 'TEAM', p_created_at, p_created_at)
  RETURNING id INTO v_signal_id;

  RETURN v_signal_id;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION pg_temp.seed_match(p_signal_id uuid, p_venue text) RETURNS void AS $$
BEGIN
  INSERT INTO public.sports_market_matches (signal_id, venue, match_status, first_match_status)
  VALUES (p_signal_id, p_venue, 'EXACT', 'EXACT');
END;
$$ LANGUAGE plpgsql;

-- Task 12H/P1-M: seeds a non-EXACT match row with an explicit next_recheck_at (NULL means
-- the recheck cutoff has already been reached / exhausted, matching computeRecheckDecision's
-- output when it returns { nextRecheckAt: null }).
CREATE FUNCTION pg_temp.seed_non_exact_match(p_signal_id uuid, p_venue text, p_status text, p_next_recheck_at timestamptz) RETURNS void AS $$
BEGIN
  INSERT INTO public.sports_market_matches (signal_id, venue, match_status, first_match_status, next_recheck_at)
  VALUES (p_signal_id, p_venue, p_status, p_status, p_next_recheck_at);
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  v_base timestamptz := '2026-01-01T00:00:00Z'::timestamptz;
  v_signal_201 uuid;
  v_signal_id uuid;
  v_result record;
  v_count int;
  v_first_id uuid;
  v_ids uuid[];
BEGIN
  ------------------------------------------------------------------
  -- Scenario 1: 220 signals, 1-200 fully resolved for PMUS specifically, 201
  -- unresolved for PMUS. This is the exact reproduction of the confirmed starvation
  -- defect: a fixed ORDER BY created_at ASC LIMIT 200 client-side scan would
  -- return only rows 1-200, all resolved, so signal 201 would never be seen.
  ------------------------------------------------------------------
  FOR i IN 1..220 LOOP
    v_signal_id := pg_temp.seed_pending_signal('s1-' || i, v_base + (i || ' seconds')::interval);
    IF i = 201 THEN
      v_signal_201 := v_signal_id;
    END IF;
    IF i <= 200 THEN
      PERFORM pg_temp.seed_match(v_signal_id, 'PMUS');
    END IF;
  END LOOP;

  SELECT id INTO v_first_id FROM public.find_pending_sports_shadow_signals('PMUS', 20) LIMIT 1;
  IF v_first_id IS NULL OR v_first_id <> v_signal_201 THEN
    RAISE EXCEPTION 'STARVATION REGRESSION: expected signal 201 (id=%) as the first pending row, got %', v_signal_201, v_first_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.find_pending_sports_shadow_signals('PMUS', 220) WHERE id = v_signal_201) THEN
    RAISE EXCEPTION 'STARVATION REGRESSION: signal 201 must be reachable at all -- it was never returned';
  END IF;

  ------------------------------------------------------------------
  -- Scenario 2: unresolved signals scattered above/below index 200 within
  -- the SAME 220-row set -- global oldest-pending wins by (created_at ASC,
  -- id ASC), not by scan position.
  ------------------------------------------------------------------
  DELETE FROM public.sports_market_matches WHERE signal_id = (SELECT id FROM public.sports_shadow_signals WHERE episode_key = 'episode-s1-50');
  SELECT id INTO v_first_id FROM public.find_pending_sports_shadow_signals('PMUS', 20) LIMIT 1;
  IF v_first_id <> (SELECT id FROM public.sports_shadow_signals WHERE episode_key = 'episode-s1-50') THEN
    RAISE EXCEPTION 'expected the newly-scattered older unresolved signal (i=50) to be the new global oldest pending, got %', v_first_id;
  END IF;
  -- Restore full resolution for signal 50 so it does not interfere with later scenarios.
  PERFORM pg_temp.seed_match((SELECT id FROM public.sports_shadow_signals WHERE episode_key = 'episode-s1-50'), 'PMUS');

  -- Clean slate for the remaining focused scenarios.
  DELETE FROM public.sports_shadow_signals;
  DELETE FROM public.sports_shadow_source_fills;

  ------------------------------------------------------------------
  -- Scenario 3: missing PMUS only.
  ------------------------------------------------------------------
  v_signal_id := pg_temp.seed_pending_signal('s3', v_base);
  PERFORM pg_temp.seed_match(v_signal_id, 'KALSHI');
  SELECT missing_pmus, missing_kalshi INTO v_result FROM public.find_pending_sports_shadow_signals('PMUS', 20) WHERE id = v_signal_id;
  IF v_result.missing_pmus IS DISTINCT FROM true OR v_result.missing_kalshi IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'scenario 3: expected missing_pmus=true, missing_kalshi=false, got %/%', v_result.missing_pmus, v_result.missing_kalshi;
  END IF;
  -- Task 12D/P1-C: the KALSHI-scoped query must NOT return this signal (already resolved for KALSHI).
  IF EXISTS (SELECT 1 FROM public.find_pending_sports_shadow_signals('KALSHI', 20) WHERE id = v_signal_id) THEN
    RAISE EXCEPTION 'scenario 3: a signal already resolved for KALSHI must not appear in the KALSHI-scoped pending query';
  END IF;

  ------------------------------------------------------------------
  -- Scenario 4: missing Kalshi only.
  ------------------------------------------------------------------
  v_signal_id := pg_temp.seed_pending_signal('s4', v_base + interval '1 second');
  PERFORM pg_temp.seed_match(v_signal_id, 'PMUS');
  SELECT missing_pmus, missing_kalshi INTO v_result FROM public.find_pending_sports_shadow_signals('KALSHI', 20) WHERE id = v_signal_id;
  IF v_result.missing_pmus IS DISTINCT FROM false OR v_result.missing_kalshi IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'scenario 4: expected missing_pmus=false, missing_kalshi=true, got %/%', v_result.missing_pmus, v_result.missing_kalshi;
  END IF;
  IF EXISTS (SELECT 1 FROM public.find_pending_sports_shadow_signals('PMUS', 20) WHERE id = v_signal_id) THEN
    RAISE EXCEPTION 'scenario 4: a signal already resolved for PMUS must not appear in the PMUS-scoped pending query';
  END IF;

  ------------------------------------------------------------------
  -- Scenario 5: missing both.
  ------------------------------------------------------------------
  v_signal_id := pg_temp.seed_pending_signal('s5', v_base + interval '2 seconds');
  SELECT missing_pmus, missing_kalshi INTO v_result FROM public.find_pending_sports_shadow_signals('PMUS', 20) WHERE id = v_signal_id;
  IF v_result.missing_pmus IS DISTINCT FROM true OR v_result.missing_kalshi IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'scenario 5: expected missing_pmus=true, missing_kalshi=true (via PMUS query), got %/%', v_result.missing_pmus, v_result.missing_kalshi;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.find_pending_sports_shadow_signals('KALSHI', 20) WHERE id = v_signal_id) THEN
    RAISE EXCEPTION 'scenario 5: a signal missing both venues must appear in BOTH venue-scoped queries';
  END IF;

  ------------------------------------------------------------------
  -- Scenario 6: fully resolved -- excluded from BOTH venue-scoped queries.
  ------------------------------------------------------------------
  v_signal_id := pg_temp.seed_pending_signal('s6', v_base + interval '3 seconds');
  PERFORM pg_temp.seed_match(v_signal_id, 'PMUS');
  PERFORM pg_temp.seed_match(v_signal_id, 'KALSHI');
  IF EXISTS (SELECT 1 FROM public.find_pending_sports_shadow_signals('PMUS', 20) WHERE id = v_signal_id) THEN
    RAISE EXCEPTION 'scenario 6: a fully-resolved signal must be excluded from the PMUS-scoped query';
  END IF;
  IF EXISTS (SELECT 1 FROM public.find_pending_sports_shadow_signals('KALSHI', 20) WHERE id = v_signal_id) THEN
    RAISE EXCEPTION 'scenario 6: a fully-resolved signal must be excluded from the KALSHI-scoped query';
  END IF;

  ------------------------------------------------------------------
  -- Scenario 7: more pending than requested limit -- exactly the requested
  -- bounded count, oldest first.
  ------------------------------------------------------------------
  DELETE FROM public.sports_shadow_signals; DELETE FROM public.sports_shadow_source_fills;
  FOR i IN 1..5 LOOP
    PERFORM pg_temp.seed_pending_signal('s7-' || i, v_base + (i || ' seconds')::interval);
  END LOOP;
  SELECT count(*) INTO v_count FROM public.find_pending_sports_shadow_signals('PMUS', 3);
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'scenario 7: expected exactly 3 rows for p_limit=3 with 5 pending, got %', v_count;
  END IF;
  SELECT array_agg(id) INTO v_ids FROM public.find_pending_sports_shadow_signals('PMUS', 3);
  IF v_ids <> ARRAY[
    (SELECT id FROM public.sports_shadow_signals WHERE episode_key = 'episode-s7-1'),
    (SELECT id FROM public.sports_shadow_signals WHERE episode_key = 'episode-s7-2'),
    (SELECT id FROM public.sports_shadow_signals WHERE episode_key = 'episode-s7-3')
  ] THEN
    RAISE EXCEPTION 'scenario 7: expected the oldest 3 signals in order, got %', v_ids;
  END IF;

  ------------------------------------------------------------------
  -- Scenario 8: p_limit > 100 is clamped to 100.
  ------------------------------------------------------------------
  DELETE FROM public.sports_shadow_signals; DELETE FROM public.sports_shadow_source_fills;
  FOR i IN 1..150 LOOP
    PERFORM pg_temp.seed_pending_signal('s8-' || i, v_base + (i || ' seconds')::interval);
  END LOOP;
  SELECT count(*) INTO v_count FROM public.find_pending_sports_shadow_signals('PMUS', 500);
  IF v_count <> 100 THEN
    RAISE EXCEPTION 'scenario 8: p_limit=500 with 150 pending must clamp to exactly 100 rows, got %', v_count;
  END IF;

  ------------------------------------------------------------------
  -- Scenario 9: p_limit NULL must stay bounded (the function's own
  -- COALESCE default), never become LIMIT ALL / unbounded.
  ------------------------------------------------------------------
  SELECT count(*) INTO v_count FROM public.find_pending_sports_shadow_signals('PMUS', NULL);
  IF v_count <> 20 THEN
    RAISE EXCEPTION 'scenario 9: p_limit=NULL with 150 pending must return the NULL-safe default (20), got %', v_count;
  END IF;

  ------------------------------------------------------------------
  -- Scenario 10: a negative p_limit must not become unbounded.
  ------------------------------------------------------------------
  SELECT count(*) INTO v_count FROM public.find_pending_sports_shadow_signals('PMUS', -5);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'scenario 10: p_limit=-5 must return zero rows (clamped, never unbounded), got %', v_count;
  END IF;

  ------------------------------------------------------------------
  -- Scenario 10b: an invalid p_venue value fails closed to zero rows, never
  -- silently falling back to the old combined-OR behavior.
  ------------------------------------------------------------------
  SELECT count(*) INTO v_count FROM public.find_pending_sports_shadow_signals('NOT_A_REAL_VENUE', 20);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'scenario 10b: an invalid p_venue must return zero rows (fail closed), got %', v_count;
  END IF;

  ------------------------------------------------------------------
  -- Scenario 11: resolving the first pending signal's PMUS venue advances the
  -- next PMUS call to the next globally oldest pending signal, without
  -- touching the independent KALSHI queue.
  ------------------------------------------------------------------
  DELETE FROM public.sports_shadow_signals; DELETE FROM public.sports_shadow_source_fills;
  FOR i IN 1..3 LOOP
    PERFORM pg_temp.seed_pending_signal('s11-' || i, v_base + (i || ' seconds')::interval);
  END LOOP;
  SELECT id INTO v_first_id FROM public.find_pending_sports_shadow_signals('PMUS', 20) LIMIT 1;
  IF v_first_id <> (SELECT id FROM public.sports_shadow_signals WHERE episode_key = 'episode-s11-1') THEN
    RAISE EXCEPTION 'scenario 11 setup: expected s11-1 as the first PMUS-pending signal, got %', v_first_id;
  END IF;
  PERFORM pg_temp.seed_match(v_first_id, 'PMUS');
  SELECT id INTO v_first_id FROM public.find_pending_sports_shadow_signals('PMUS', 20) LIMIT 1;
  IF v_first_id <> (SELECT id FROM public.sports_shadow_signals WHERE episode_key = 'episode-s11-2') THEN
    RAISE EXCEPTION 'scenario 11: after resolving s11-1 for PMUS, expected s11-2 to advance to first PMUS-pending, got %', v_first_id;
  END IF;
  -- s11-1 is still missing KALSHI -- resolving PMUS alone must not have advanced it out.
  IF NOT EXISTS (SELECT 1 FROM public.find_pending_sports_shadow_signals('KALSHI', 20) WHERE id = (SELECT id FROM public.sports_shadow_signals WHERE episode_key = 'episode-s11-1')) THEN
    RAISE EXCEPTION 'scenario 11: s11-1 must still appear in the KALSHI-scoped query after only its PMUS venue was resolved';
  END IF;

  ------------------------------------------------------------------
  -- Scenario 12 (Task 12D/P1-C head-of-line-blocking proof): a saturated
  -- PMUS-missing backlog of 20+ old rows does not prevent a newer
  -- Kalshi-only-missing signal from being returned by the independent
  -- KALSHI-scoped query.
  ------------------------------------------------------------------
  DELETE FROM public.sports_shadow_signals; DELETE FROM public.sports_shadow_source_fills;
  FOR i IN 1..25 LOOP
    v_signal_id := pg_temp.seed_pending_signal('s12-old-' || i, v_base + (i || ' seconds')::interval);
    PERFORM pg_temp.seed_match(v_signal_id, 'KALSHI'); -- already resolved for KALSHI, stuck on PMUS only
  END LOOP;
  v_signal_id := pg_temp.seed_pending_signal('s12-newer', v_base + interval '1000 seconds');
  PERFORM pg_temp.seed_match(v_signal_id, 'PMUS'); -- already resolved for PMUS, missing KALSHI only

  SELECT count(*) INTO v_count FROM public.find_pending_sports_shadow_signals('PMUS', 20);
  IF v_count <> 20 THEN
    RAISE EXCEPTION 'scenario 12: expected the PMUS batch to be fully saturated with the 20 oldest old-stuck rows, got %', v_count;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.find_pending_sports_shadow_signals('KALSHI', 20) WHERE id = v_signal_id) THEN
    RAISE EXCEPTION 'scenario 12 HEAD-OF-LINE-BLOCKING REGRESSION: the newer KALSHI-only-missing signal must still be returned by the independent KALSHI query despite the saturated PMUS backlog';
  END IF;

  ------------------------------------------------------------------
  -- Scenario 13 (Task 12H/P1-M): a non-EXACT (NONE) match row with a due
  -- next_recheck_at (in the past) IS returned by the venue-scoped pending
  -- query -- non-EXACT results are retryable, not permanently terminal.
  ------------------------------------------------------------------
  DELETE FROM public.sports_shadow_signals; DELETE FROM public.sports_shadow_source_fills;
  v_signal_id := pg_temp.seed_pending_signal('s13', v_base);
  PERFORM pg_temp.seed_non_exact_match(v_signal_id, 'PMUS', 'NONE', now() - interval '1 minute');
  IF NOT EXISTS (SELECT 1 FROM public.find_pending_sports_shadow_signals('PMUS', 20) WHERE id = v_signal_id) THEN
    RAISE EXCEPTION 'scenario 13 P1-M REGRESSION: a NONE match with a due next_recheck_at must be returned as pending';
  END IF;

  ------------------------------------------------------------------
  -- Scenario 14 (Task 12H/P1-M): a non-EXACT (NEAR) match row with a
  -- next_recheck_at still in the future is NOT yet due -- excluded.
  ------------------------------------------------------------------
  DELETE FROM public.sports_shadow_signals; DELETE FROM public.sports_shadow_source_fills;
  v_signal_id := pg_temp.seed_pending_signal('s14', v_base);
  PERFORM pg_temp.seed_non_exact_match(v_signal_id, 'PMUS', 'NEAR', now() + interval '1 hour');
  IF EXISTS (SELECT 1 FROM public.find_pending_sports_shadow_signals('PMUS', 20) WHERE id = v_signal_id) THEN
    RAISE EXCEPTION 'scenario 14 P1-M REGRESSION: a NEAR match whose next_recheck_at is still in the future must not be returned yet';
  END IF;

  ------------------------------------------------------------------
  -- Scenario 15 (Task 12H/P1-M): a non-EXACT (UNVERIFIED) match row with
  -- next_recheck_at IS NULL (cutoff reached / exhausted) is excluded --
  -- the deterministic cutoff must actually stop retries, not retry forever.
  ------------------------------------------------------------------
  DELETE FROM public.sports_shadow_signals; DELETE FROM public.sports_shadow_source_fills;
  v_signal_id := pg_temp.seed_pending_signal('s15', v_base);
  PERFORM pg_temp.seed_non_exact_match(v_signal_id, 'PMUS', 'UNVERIFIED', NULL);
  IF EXISTS (SELECT 1 FROM public.find_pending_sports_shadow_signals('PMUS', 20) WHERE id = v_signal_id) THEN
    RAISE EXCEPTION 'scenario 15 P1-M REGRESSION: an UNVERIFIED match with next_recheck_at NULL (cutoff reached) must never be returned again';
  END IF;

  ------------------------------------------------------------------
  -- Scenario 16 (Task 12H/P1-M): EXACT is never re-offered as pending, even
  -- if next_recheck_at were somehow non-NULL -- the ratchet (EXACT never
  -- downgraded/rechecked) is enforced by the query itself, not just by the
  -- TypeScript caller that normally always writes next_recheck_at=NULL for EXACT.
  ------------------------------------------------------------------
  DELETE FROM public.sports_shadow_signals; DELETE FROM public.sports_shadow_source_fills;
  v_signal_id := pg_temp.seed_pending_signal('s16', v_base);
  PERFORM pg_temp.seed_non_exact_match(v_signal_id, 'PMUS', 'EXACT', now() - interval '1 minute');
  IF EXISTS (SELECT 1 FROM public.find_pending_sports_shadow_signals('PMUS', 20) WHERE id = v_signal_id) THEN
    RAISE EXCEPTION 'scenario 16 P1-M REGRESSION: an EXACT match must never be returned as pending regardless of next_recheck_at';
  END IF;

  ------------------------------------------------------------------
  -- Scenario 17 (Task 12H/P1-M + P1-C independence): a saturated PMUS
  -- due-for-recheck backlog does not affect the independent KALSHI-scoped
  -- pending query, and vice versa.
  ------------------------------------------------------------------
  DELETE FROM public.sports_shadow_signals; DELETE FROM public.sports_shadow_source_fills;
  FOR i IN 1..5 LOOP
    v_signal_id := pg_temp.seed_pending_signal('s17-pmus-' || i, v_base + (i || ' seconds')::interval);
    PERFORM pg_temp.seed_non_exact_match(v_signal_id, 'PMUS', 'NONE', now() - interval '1 minute');
    PERFORM pg_temp.seed_match(v_signal_id, 'KALSHI'); -- resolved EXACT for KALSHI, so each is genuinely KALSHI-done (not merely "missing"), isolating the KALSHI-scoped assertion below to recheck-due semantics only
  END LOOP;
  v_signal_id := pg_temp.seed_pending_signal('s17-kalshi', v_base + interval '1000 seconds');
  PERFORM pg_temp.seed_match(v_signal_id, 'PMUS'); -- resolved EXACT for PMUS, so this signal is genuinely PMUS-done (not merely "missing"), isolating the assertion below to recheck-due semantics only
  PERFORM pg_temp.seed_non_exact_match(v_signal_id, 'KALSHI', 'NONE', now() - interval '1 minute');

  SELECT count(*) INTO v_count FROM public.find_pending_sports_shadow_signals('PMUS', 20);
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'scenario 17: expected exactly 5 PMUS-due-for-recheck rows, got %', v_count;
  END IF;
  IF EXISTS (SELECT 1 FROM public.find_pending_sports_shadow_signals('PMUS', 20) WHERE id = v_signal_id) THEN
    RAISE EXCEPTION 'scenario 17 P1-C REGRESSION: the KALSHI-only recheck-due signal must not leak into the PMUS-scoped query';
  END IF;
  SELECT count(*) INTO v_count FROM public.find_pending_sports_shadow_signals('KALSHI', 20);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'scenario 17 P1-C REGRESSION: expected exactly 1 KALSHI-due-for-recheck row, unaffected by the saturated PMUS backlog, got %', v_count;
  END IF;

  RAISE NOTICE 'find_pending_sports_shadow_signals semantic scenarios 1-17 passed';
END $$;

------------------------------------------------------------------
-- RPC PRIVILEGE TEST: PUBLIC/anon/authenticated denied, service_role allowed,
-- checked against the REAL running database (never a static text assertion).
------------------------------------------------------------------
DO $$
DECLARE
  v_oid oid;
  v_public_has_execute boolean;
BEGIN
  v_oid := 'public.find_pending_sports_shadow_signals(text, integer)'::regprocedure;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc p,
      LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) INTO v_public_has_execute;
  IF v_public_has_execute THEN
    RAISE EXCEPTION 'PUBLIC must not have EXECUTE on find_pending_sports_shadow_signals';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not have EXECUTE on find_pending_sports_shadow_signals';
  END IF;
  IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must not have EXECUTE on find_pending_sports_shadow_signals';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must have EXECUTE on find_pending_sports_shadow_signals';
  END IF;

  -- Real execution attempt, not just a catalog check: EXECUTE privilege is enforced by
  -- Postgres before the function body ever runs, independent of SECURITY
  -- INVOKER/DEFINER, so the REVOKE ALL above must produce a real insufficient_privilege
  -- error for anon/authenticated even with zero rows in the table.
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM * FROM public.find_pending_sports_shadow_signals('PMUS', 20);
    RAISE EXCEPTION 'anon must not be able to call find_pending_sports_shadow_signals';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;

  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM * FROM public.find_pending_sports_shadow_signals('PMUS', 20);
    RAISE EXCEPTION 'authenticated must not be able to call find_pending_sports_shadow_signals';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;

  -- service_role must succeed (function-level privilege, distinct from row content).
  PERFORM * FROM public.find_pending_sports_shadow_signals('PMUS', 20);

  -- Signature/behavior attributes match the intended contract exactly.
  DECLARE
    v_lang text;
    v_volatile char;
    v_security_definer boolean;
    v_search_path text[];
  BEGIN
    SELECT l.lanname, p.provolatile, p.prosecdef, p.proconfig
    INTO v_lang, v_volatile, v_security_definer, v_search_path
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
    WHERE p.oid = v_oid;
    IF v_lang <> 'sql' THEN RAISE EXCEPTION 'expected LANGUAGE sql, got %', v_lang; END IF;
    IF v_volatile <> 's' THEN RAISE EXCEPTION 'expected STABLE, got volatility %', v_volatile; END IF;
    IF v_security_definer THEN RAISE EXCEPTION 'expected SECURITY INVOKER (prosecdef=false), got SECURITY DEFINER'; END IF;
    IF v_search_path IS NULL OR NOT ('search_path=public' = ANY (v_search_path)) THEN
      RAISE EXCEPTION 'expected SET search_path TO public, got %', v_search_path;
    END IF;
  END;

  RAISE NOTICE 'find_pending_sports_shadow_signals privilege contract passed';
END $$;

ROLLBACK;
