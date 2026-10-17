-- Run against a real freshly migrated local Supabase database. Every data read
-- and role switch is rolled back; this test never targets production.
BEGIN;

DO $$
DECLARE
  v_table text;
  v_role text;
  v_privilege text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'sports_shadow_source_fills',
    'sports_shadow_signals',
    'sports_market_matches',
    'sports_quote_observations',
    'sports_shadow_wallet_cursor',
    'sports_shadow_experiment_epochs',
    'sports_shadow_source_sell_events',
    'sports_shadow_venue_capability',
    'sports_shadow_paper_fills',
    'sports_shadow_paper_positions',
    'sports_shadow_settlements',
    'sports_shadow_telemetry_events',
    'sports_shadow_integrity_audits',
    'sports_shadow_alerts',
    'sports_shadow_milestone_snapshots',
    'sports_shadow_wallet_coverage',
    'sports_shadow_lifecycle_triggers'
  ] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class
            WHERE oid = to_regclass('public.' || v_table)) THEN
      RAISE EXCEPTION 'RLS must remain enabled on public.%', v_table;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) a
      WHERE c.oid = to_regclass('public.' || v_table) AND a.grantee = 0
    ) THEN
      RAISE EXCEPTION 'PUBLIC must have no table privileges on public.%', v_table;
    END IF;

    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ] LOOP
        IF has_table_privilege(v_role, 'public.' || v_table, v_privilege) THEN
          RAISE EXCEPTION '% must not have % on public.%', v_role, v_privilege, v_table;
        END IF;
      END LOOP;

      -- An actual role-level SELECT must fail at the privilege layer; an empty
      -- result caused only by RLS is not sufficient proof of revoked access.
      EXECUTE format('SET LOCAL ROLE %I', v_role);
      BEGIN
        EXECUTE format('SELECT 1 FROM public.%I LIMIT 1', v_table);
        RAISE EXCEPTION '% unexpectedly queried public.%', v_role, v_table;
      EXCEPTION WHEN insufficient_privilege THEN
        NULL;
      END;
      RESET ROLE;
    END LOOP;

    FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', 'public.' || v_table, v_privilege) THEN
        RAISE EXCEPTION 'service_role must retain % on public.%', v_privilege, v_table;
      END IF;
    END LOOP;
    SET LOCAL ROLE service_role;
    EXECUTE format('SELECT 1 FROM public.%I LIMIT 1', v_table);
    RESET ROLE;
  END LOOP;
  RAISE NOTICE 'Sports Shadow server-only grants: all seventeen tables passed';
END;
$$;

ROLLBACK;
