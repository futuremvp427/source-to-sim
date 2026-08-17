-- Regression coverage for get_pending_experiment_source_events after
-- 20260817200000_shadow_v4_compound_pilot.sql's DROP+CREATE (required because
-- PostgreSQL will not let CREATE OR REPLACE add an output column to a
-- RETURNS TABLE function). DROP+CREATE resets a function's ACL to the
-- default, so this proves the recreated function was re-hardened to exactly
-- its prior privilege state, plus every prior signature/behavior attribute,
-- with condition_id as the only addition.
-- Run via: psql -f supabase/tests/pending_experiment_source_events_privileges.sql
-- (after `supabase db reset --local`)
BEGIN;

DO $$
DECLARE
  v_oid oid;
  v_public_has_execute boolean;
  v_lang text;
  v_volatile char;
  v_security_definer boolean;
  v_search_path text[];
  v_default_limit text;
  v_result_cols text;
BEGIN
  v_oid := 'public.get_pending_experiment_source_events(uuid, integer)'::regprocedure;

  -- 1. PUBLIC, anon, authenticated must NOT have EXECUTE; service_role MUST.
  -- PUBLIC is an ACL pseudo-grantee (not a real role), so has_function_privilege
  -- rejects it -- checked via aclexplode (grantee=0 encodes PUBLIC), same
  -- pattern as record_http_rate_limit_privileges.sql.
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p,
      LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) INTO v_public_has_execute;
  IF v_public_has_execute THEN
    RAISE EXCEPTION 'PUBLIC must not have EXECUTE on get_pending_experiment_source_events';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not have EXECUTE on get_pending_experiment_source_events';
  END IF;
  IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must not have EXECUTE on get_pending_experiment_source_events';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must have EXECUTE on get_pending_experiment_source_events';
  END IF;

  -- 2. Signature/behavior attributes unchanged from the prior definition.
  SELECT l.lanname, p.provolatile, p.prosecdef, p.proconfig
  INTO v_lang, v_volatile, v_security_definer, v_search_path
  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
  WHERE p.oid = v_oid;
  IF v_lang <> 'sql' THEN RAISE EXCEPTION 'expected LANGUAGE sql, got %', v_lang; END IF;
  IF v_volatile <> 's' THEN RAISE EXCEPTION 'expected STABLE, got volatility %', v_volatile; END IF;
  IF NOT v_security_definer THEN RAISE EXCEPTION 'expected SECURITY DEFINER'; END IF;
  IF v_search_path IS NULL OR NOT ('search_path=public' = ANY (v_search_path)) THEN
    RAISE EXCEPTION 'expected SET search_path TO public, got %', v_search_path;
  END IF;

  -- p_limit default = 300, same argument names/order as before.
  SELECT pg_get_function_arguments(v_oid) INTO v_default_limit;
  IF v_default_limit <> 'p_experiment_id uuid, p_limit integer DEFAULT 300' THEN
    RAISE EXCEPTION 'expected unchanged (uuid, integer DEFAULT 300) signature, got %', v_default_limit;
  END IF;

  -- Every prior returned field, in the same order, plus condition_id appended.
  SELECT pg_get_function_result(v_oid) INTO v_result_cols;
  IF v_result_cols <> 'TABLE(id uuid, event_key text, asset text, market_title text, outcome text, side text, shares numeric, price numeric, source_ts bigint, first_seen_at timestamp with time zone, condition_id text)' THEN
    RAISE EXCEPTION 'unexpected return row shape: %', v_result_cols;
  END IF;

  RAISE NOTICE 'pending_experiment_source_events_privileges regression passed';
END;
$$;

ROLLBACK;
