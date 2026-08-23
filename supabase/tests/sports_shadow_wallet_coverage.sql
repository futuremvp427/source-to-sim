-- CODEX P1-1 (round 2): real-Postgres proof for sports_shadow_wallet_coverage
-- (20260825010000_sports_shadow_wallet_source_coverage.sql) and its incomplete_reason
-- column (20260825090000_sports_shadow_wallet_coverage_incomplete_reason.sql) -- this
-- table had no schema-contract test at all before this pass. Run via:
-- psql -f supabase/tests/sports_shadow_wallet_coverage.sql (after `supabase db reset --local`)
BEGIN;

DO $$
DECLARE
  v_count integer;
  v_coverage_complete boolean;
  v_incomplete_reason text;
BEGIN
  ------------------------------------------------------------------
  -- A. Table exists, RLS enabled, no anon/authenticated policy, service_role has full DML.
  ------------------------------------------------------------------
  IF to_regclass('public.sports_shadow_wallet_coverage') IS NULL THEN
    RAISE EXCEPTION 'expected table public.sports_shadow_wallet_coverage to exist';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.sports_shadow_wallet_coverage')) THEN
    RAISE EXCEPTION 'RLS must be enabled on public.sports_shadow_wallet_coverage';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sports_shadow_wallet_coverage'
      AND (roles::text[] && ARRAY['anon', 'authenticated', 'public'])
  ) THEN
    RAISE EXCEPTION 'no anon/authenticated/public policy may exist on public.sports_shadow_wallet_coverage';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.sports_shadow_wallet_coverage', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'service_role must have full DML privileges on public.sports_shadow_wallet_coverage';
  END IF;
  IF has_table_privilege('anon', 'public.sports_shadow_wallet_coverage', 'SELECT') THEN
    RAISE EXCEPTION 'anon must not have direct SELECT on public.sports_shadow_wallet_coverage';
  END IF;

  ------------------------------------------------------------------
  -- B. incomplete_reason column exists (CODEX P1-1 round 2).
  ------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sports_shadow_wallet_coverage' AND column_name = 'incomplete_reason'
  ) THEN
    RAISE EXCEPTION 'expected sports_shadow_wallet_coverage.incomplete_reason to exist';
  END IF;

  ------------------------------------------------------------------
  -- C. one row per wallet (PRIMARY KEY), a re-upsert overwrites rather than duplicates,
  -- and the CONTINUOUS invariant round-trips: complete -> incomplete (with reason) ->
  -- complete again (reason cleared).
  ------------------------------------------------------------------
  INSERT INTO public.sports_shadow_wallet_coverage (wallet, covered_through_ts, coverage_complete, incomplete_reason)
  VALUES ('0xcontracttest', 1700000000, true, NULL);

  SELECT count(*) INTO v_count FROM public.sports_shadow_wallet_coverage WHERE wallet = '0xcontracttest';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one row for wallet 0xcontracttest, got %', v_count;
  END IF;

  -- CODEX P1-1 (round 2): downgrade back to incomplete -- the continuous invariant.
  INSERT INTO public.sports_shadow_wallet_coverage (wallet, covered_through_ts, coverage_complete, incomplete_reason)
  VALUES ('0xcontracttest', 1700000000, false, 'steady-state overlap search exhausted the offset ceiling')
  ON CONFLICT (wallet) DO UPDATE SET
    covered_through_ts = EXCLUDED.covered_through_ts,
    coverage_complete = EXCLUDED.coverage_complete,
    incomplete_reason = EXCLUDED.incomplete_reason;

  SELECT coverage_complete, incomplete_reason INTO v_coverage_complete, v_incomplete_reason FROM public.sports_shadow_wallet_coverage WHERE wallet = '0xcontracttest';
  IF v_coverage_complete <> false OR v_incomplete_reason IS NULL THEN
    RAISE EXCEPTION 'expected coverage_complete=false with a non-null incomplete_reason after downgrade, got complete=% reason=%', v_coverage_complete, v_incomplete_reason;
  END IF;

  -- Re-proven complete -- reason is explicitly cleared, never left stale.
  INSERT INTO public.sports_shadow_wallet_coverage (wallet, covered_through_ts, coverage_complete, incomplete_reason)
  VALUES ('0xcontracttest', 1700100000, true, NULL)
  ON CONFLICT (wallet) DO UPDATE SET
    covered_through_ts = EXCLUDED.covered_through_ts,
    coverage_complete = EXCLUDED.coverage_complete,
    incomplete_reason = EXCLUDED.incomplete_reason;

  SELECT coverage_complete, incomplete_reason INTO v_coverage_complete, v_incomplete_reason FROM public.sports_shadow_wallet_coverage WHERE wallet = '0xcontracttest';
  IF v_coverage_complete <> true OR v_incomplete_reason IS NOT NULL THEN
    RAISE EXCEPTION 'expected coverage_complete=true with incomplete_reason cleared to NULL, got complete=% reason=%', v_coverage_complete, v_incomplete_reason;
  END IF;

  RAISE NOTICE 'sports_shadow_wallet_coverage.sql: all assertions passed';
END $$;

ROLLBACK;
