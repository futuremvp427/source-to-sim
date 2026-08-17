-- Regression coverage for reserve_http_request_slot() in
-- 20260817120000_reserve_http_request_slot.sql.
-- Run via: psql -f supabase/tests/reserve_http_request_slot.sql (after `supabase db reset --local`)
BEGIN;

DO $$
DECLARE
  v_public_has_execute boolean;
  v_oid oid;
  v_host text := 'reserve-slot-test.example';
  v_first timestamptz;
  v_second timestamptz;
  v_third timestamptz;
  v_clamped timestamptz;
  v_before_reserve timestamptz;
BEGIN
  -- 1. PUBLIC, anon, authenticated must not retain catalog-level EXECUTE
  -- (aclexplode/grantee=0 pattern for PUBLIC, matching verify_schema_contract.py
  -- and record_http_rate_limit_privileges.sql -- see those for why
  -- has_function_privilege('PUBLIC', ...) itself is not usable here).
  v_oid := 'public.reserve_http_request_slot(text, integer, integer)'::regprocedure;
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p,
      LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) INTO v_public_has_execute;
  IF v_public_has_execute THEN
    RAISE EXCEPTION 'PUBLIC must not have EXECUTE on reserve_http_request_slot';
  END IF;
  IF has_function_privilege('anon', 'public.reserve_http_request_slot(text, integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not have EXECUTE on reserve_http_request_slot';
  END IF;
  IF has_function_privilege('authenticated', 'public.reserve_http_request_slot(text, integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must not have EXECUTE on reserve_http_request_slot';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.reserve_http_request_slot(text, integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must have EXECUTE on reserve_http_request_slot';
  END IF;

  BEGIN
    SET LOCAL ROLE anon;
    PERFORM public.reserve_http_request_slot(v_host, 500, 4000);
    RAISE EXCEPTION 'anon must not be able to call reserve_http_request_slot';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;

  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.reserve_http_request_slot(v_host, 500, 4000);
    RAISE EXCEPTION 'authenticated must not be able to call reserve_http_request_slot';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;

  -- Defense-in-depth: the function-level auth.role() guard must reject even
  -- an unintended EXECUTE grant, exactly like record_http_rate_limit.
  GRANT EXECUTE ON FUNCTION public.reserve_http_request_slot(text, integer, integer) TO anon;
  BEGIN
    SET LOCAL ROLE anon;
    SET LOCAL request.jwt.claim.role = 'anon';
    PERFORM public.reserve_http_request_slot(v_host, 500, 4000);
    RAISE EXCEPTION 'anon must be rejected by the auth.role() guard even with an unintended EXECUTE grant';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;
  REVOKE ALL ON FUNCTION public.reserve_http_request_slot(text, integer, integer) FROM anon;

  -- 2. First-ever reservation for a fresh host is granted immediately (no
  -- pre-existing next_request_at to wait behind).
  v_before_reserve := clock_timestamp();
  v_first := public.reserve_http_request_slot(v_host, 500, 4000);
  IF v_first > v_before_reserve + interval '50 milliseconds' THEN
    RAISE EXCEPTION 'first reservation for a fresh host must not be pushed into the future, got %', v_first;
  END IF;

  -- 3. A second call immediately after must be serialized at least
  -- p_min_interval_ms later than the first -- this is the atomicity
  -- property the whole migration exists for: two concurrent callers can
  -- never both be told "now."
  v_second := public.reserve_http_request_slot(v_host, 500, 4000);
  IF v_second < v_first + interval '500 milliseconds' THEN
    RAISE EXCEPTION 'second reservation must be paced at least min_interval after the first: first=%, second=%', v_first, v_second;
  END IF;

  -- A third call keeps advancing, proving this is a real queue, not a
  -- one-shot lock.
  v_third := public.reserve_http_request_slot(v_host, 500, 4000);
  IF v_third < v_second + interval '500 milliseconds' THEN
    RAISE EXCEPTION 'third reservation must be paced at least min_interval after the second: second=%, third=%', v_second, v_third;
  END IF;

  -- 4. The max-lookahead clamp bounds how far a pile-up of reservations can
  -- be pushed: many rapid claims on a fresh host never exceed
  -- now() + max_lookahead_ms, however many callers pile up.
  PERFORM public.reserve_http_request_slot('reserve-slot-clamp-test.example', 100, 1000)
  FROM generate_series(1, 50);
  v_clamped := public.reserve_http_request_slot('reserve-slot-clamp-test.example', 100, 1000);
  IF v_clamped > clock_timestamp() + interval '1100 milliseconds' THEN
    RAISE EXCEPTION 'reservation must be clamped to max_lookahead_ms regardless of pile-up depth, got %', v_clamped;
  END IF;

  -- 5. Independent of blocked_until: recording an active 429 cooldown on the
  -- same host must not change reservation pacing -- the two mechanisms are
  -- deliberately decoupled (see the migration's own doc comment).
  PERFORM public.record_http_rate_limit(v_host, now() + interval '10 minutes', 'unrelated-429');
  DECLARE
    v_after_cooldown timestamptz;
  BEGIN
    v_after_cooldown := public.reserve_http_request_slot(v_host, 500, 4000);
    IF v_after_cooldown < v_third + interval '500 milliseconds' THEN
      RAISE EXCEPTION 'reservation pacing must be unaffected by an unrelated blocked_until write, got %', v_after_cooldown;
    END IF;
  END;

  RAISE NOTICE 'reserve_http_request_slot regression passed';
END $$;

ROLLBACK;
