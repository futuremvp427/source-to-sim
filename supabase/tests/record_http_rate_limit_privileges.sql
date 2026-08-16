-- Regression coverage for the record_http_rate_limit privilege hardening in
-- 20260816120000_harden_record_http_rate_limit_privileges.sql.
-- Run via: psql -f supabase/tests/record_http_rate_limit_privileges.sql (after `supabase db reset --local`)
BEGIN;

DO $$
DECLARE
  v_blocked_until timestamptz;
  v_reason text;
  v_oid oid;
  v_public_has_execute boolean;
BEGIN
  -- 1. PUBLIC, anon, authenticated must not retain catalog-level EXECUTE.
  -- PUBLIC is an ACL pseudo-grantee, not a real role, so has_function_privilege
  -- rejects it with "role \"public\" does not exist" -- checked via aclexplode
  -- instead (grantee=0 is PostgreSQL's ACL encoding for PUBLIC), the same
  -- pattern scripts/verify_schema_contract.py already uses for this exact case.
  v_oid := 'public.record_http_rate_limit(text, timestamptz, text)'::regprocedure;
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p,
      LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) INTO v_public_has_execute;
  IF v_public_has_execute THEN
    RAISE EXCEPTION 'PUBLIC must not have EXECUTE on record_http_rate_limit';
  END IF;
  IF has_function_privilege('anon', 'public.record_http_rate_limit(text, timestamptz, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not have EXECUTE on record_http_rate_limit';
  END IF;
  IF has_function_privilege('authenticated', 'public.record_http_rate_limit(text, timestamptz, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must not have EXECUTE on record_http_rate_limit';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.record_http_rate_limit(text, timestamptz, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must have EXECUTE on record_http_rate_limit';
  END IF;

  -- 2. Existing server-side cooldown recording still works (direct superuser
  -- call, no PostgREST JWT context -- auth.role() is NULL and must be let
  -- through).
  PERFORM public.record_http_rate_limit('data-api.polymarket.com', now() + interval '30 seconds', 'test-429');
  SELECT blocked_until, reason INTO v_blocked_until, v_reason
  FROM public.http_rate_limits WHERE host = 'data-api.polymarket.com';
  IF v_reason <> 'test-429' THEN
    RAISE EXCEPTION 'expected reason test-429, got %', v_reason;
  END IF;

  -- GREATEST-upsert: a shorter cooldown must not shrink the existing one.
  PERFORM public.record_http_rate_limit('data-api.polymarket.com', now() + interval '5 seconds', 'shorter');
  SELECT blocked_until INTO v_blocked_until FROM public.http_rate_limits WHERE host = 'data-api.polymarket.com';
  IF v_blocked_until < now() + interval '25 seconds' THEN
    RAISE EXCEPTION 'GREATEST-upsert must not shrink an existing cooldown, got blocked_until %', v_blocked_until;
  END IF;

  -- A longer cooldown must extend it.
  PERFORM public.record_http_rate_limit('data-api.polymarket.com', now() + interval '1 hour', 'longer');
  SELECT blocked_until, reason INTO v_blocked_until, v_reason
  FROM public.http_rate_limits WHERE host = 'data-api.polymarket.com';
  IF v_blocked_until < now() + interval '50 minutes' OR v_reason <> 'longer' THEN
    RAISE EXCEPTION 'GREATEST-upsert must extend to the longer cooldown, got blocked_until % reason %', v_blocked_until, v_reason;
  END IF;

  -- 3. DB-level grants: anon/authenticated cannot invoke at all.
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM public.record_http_rate_limit('data-api.polymarket.com', now() + interval '1 day', 'anon-attack');
    RAISE EXCEPTION 'anon must not be able to call record_http_rate_limit';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;

  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.record_http_rate_limit('data-api.polymarket.com', now() + interval '1 day', 'authenticated-attack');
    RAISE EXCEPTION 'authenticated must not be able to call record_http_rate_limit';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;

  -- 4. Defense-in-depth: even if an unintended EXECUTE grant reappears (the
  -- exact production failure mode this migration is hardening against), the
  -- function-level auth.role() guard must still reject an anon/authenticated
  -- PostgREST caller and must not have extended the cooldown.
  GRANT EXECUTE ON FUNCTION public.record_http_rate_limit(text, timestamptz, text) TO anon, authenticated;

  BEGIN
    SET LOCAL ROLE anon;
    SET LOCAL request.jwt.claim.role = 'anon';
    PERFORM public.record_http_rate_limit('data-api.polymarket.com', now() + interval '1 day', 'anon-attack-with-grant');
    RAISE EXCEPTION 'anon must be rejected by the auth.role() guard even with an unintended EXECUTE grant';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;

  BEGIN
    SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claim.role = 'authenticated';
    PERFORM public.record_http_rate_limit('data-api.polymarket.com', now() + interval '1 day', 'authenticated-attack-with-grant');
    RAISE EXCEPTION 'authenticated must be rejected by the auth.role() guard even with an unintended EXECUTE grant';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;

  SELECT blocked_until, reason INTO v_blocked_until, v_reason
  FROM public.http_rate_limits WHERE host = 'data-api.polymarket.com';
  IF v_reason <> 'longer' THEN
    RAISE EXCEPTION 'a rejected call must not have mutated the cooldown row, but reason is now %', v_reason;
  END IF;

  REVOKE ALL ON FUNCTION public.record_http_rate_limit(text, timestamptz, text) FROM anon, authenticated;

  -- 5. service_role, carrying the JWT context PostgREST sets for it, remains
  -- able to invoke and record a cooldown.
  BEGIN
    SET LOCAL ROLE service_role;
    SET LOCAL request.jwt.claim.role = 'service_role';
    PERFORM public.record_http_rate_limit('data-api.polymarket.com', now() + interval '2 hours', 'service-role-ok');
    RESET ROLE;
  END;

  SELECT blocked_until, reason INTO v_blocked_until, v_reason
  FROM public.http_rate_limits WHERE host = 'data-api.polymarket.com';
  IF v_reason <> 'service-role-ok' THEN
    RAISE EXCEPTION 'expected service_role call to succeed and record service-role-ok, got %', v_reason;
  END IF;

  RAISE NOTICE 'record_http_rate_limit_privileges regression passed';
END $$;

ROLLBACK;
