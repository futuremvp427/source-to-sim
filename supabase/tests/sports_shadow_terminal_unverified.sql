-- Task 12F / P1-H: real-Postgres schema proof that TERMINAL_UNVERIFIED is a valid
-- downstream_status and downstream_unverified_reason durably retains the exact
-- classifier reason code -- against the ACTUAL migrated database.
-- Run via: psql -f supabase/tests/sports_shadow_terminal_unverified.sql (after
-- `supabase db reset --local`)
BEGIN;

DO $$
DECLARE
  v_fill_id uuid;
  v_status text;
  v_reason text;
  v_check_def text;
BEGIN
  ------------------------------------------------------------------
  -- 1. The CHECK constraint on downstream_status includes TERMINAL_UNVERIFIED
  -- alongside the original four Task 12D values -- an additive widening, not a
  -- replacement, of 20260821040000_sports_shadow_fill_retry.sql's original constraint.
  ------------------------------------------------------------------
  SELECT pg_get_constraintdef(oid) INTO v_check_def
  FROM pg_constraint
  WHERE conrelid = 'public.sports_shadow_source_fills'::regclass
    AND conname = 'sports_shadow_source_fills_downstream_status_check';

  IF v_check_def IS NULL THEN
    RAISE EXCEPTION 'sports_shadow_source_fills_downstream_status_check constraint is missing';
  END IF;
  IF v_check_def NOT LIKE '%TERMINAL_UNVERIFIED%' THEN
    RAISE EXCEPTION 'downstream_status CHECK constraint does not include TERMINAL_UNVERIFIED: %', v_check_def;
  END IF;
  IF v_check_def NOT LIKE '%PENDING%' OR v_check_def NOT LIKE '%COMPLETE%'
     OR v_check_def NOT LIKE '%TERMINAL_INELIGIBLE%' OR v_check_def NOT LIKE '%TERMINAL_INVALID%' THEN
    RAISE EXCEPTION 'downstream_status CHECK constraint lost one of the original Task 12D values: %', v_check_def;
  END IF;

  ------------------------------------------------------------------
  -- 2. downstream_unverified_reason exists, is nullable (a PENDING/COMPLETE/other-
  -- terminal fill has no unverified reason), and text-typed.
  ------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sports_shadow_source_fills'
      AND column_name = 'downstream_unverified_reason' AND is_nullable = 'YES' AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'sports_shadow_source_fills.downstream_unverified_reason is missing or not a nullable text column';
  END IF;

  ------------------------------------------------------------------
  -- 3. A real INSERT with downstream_status = 'TERMINAL_UNVERIFIED' and a reason code
  -- succeeds and durably round-trips both fields (H12: reason code retained for audit).
  ------------------------------------------------------------------
  INSERT INTO public.sports_shadow_source_fills (
    event_key, wallet, asset, side, source_ts, identity_basis, downstream_status, downstream_unverified_reason
  ) VALUES (
    'terminal-unverified-test-1', '0xtest', '0xasset', 'BUY', 1, 'source_id', 'TERMINAL_UNVERIFIED', 'UNVERIFIED_UNKNOWN_TEAM'
  )
  RETURNING id INTO v_fill_id;

  SELECT downstream_status, downstream_unverified_reason INTO v_status, v_reason
  FROM public.sports_shadow_source_fills WHERE id = v_fill_id;
  IF v_status <> 'TERMINAL_UNVERIFIED' THEN
    RAISE EXCEPTION 'expected downstream_status=TERMINAL_UNVERIFIED, got %', v_status;
  END IF;
  IF v_reason <> 'UNVERIFIED_UNKNOWN_TEAM' THEN
    RAISE EXCEPTION 'expected downstream_unverified_reason to durably retain the reason code, got %', v_reason;
  END IF;

  ------------------------------------------------------------------
  -- 4. An invalid downstream_status value is still rejected by the CHECK constraint --
  -- the widening did not accidentally open the column up to arbitrary text.
  ------------------------------------------------------------------
  BEGIN
    INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, source_ts, identity_basis, downstream_status)
    VALUES ('terminal-unverified-test-2', '0xtest', '0xasset', 'BUY', 2, 'source_id', 'NOT_A_REAL_STATUS');
    RAISE EXCEPTION 'expected an invalid downstream_status to violate the CHECK constraint';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected
  END;

  ------------------------------------------------------------------
  -- 5. A normal PENDING fill still has a NULL downstream_unverified_reason (the
  -- additive column does not force every row to carry a reason).
  ------------------------------------------------------------------
  INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, source_ts, identity_basis)
  VALUES ('terminal-unverified-test-3', '0xtest', '0xasset', 'BUY', 3, 'source_id');

  IF EXISTS (
    SELECT 1 FROM public.sports_shadow_source_fills
    WHERE event_key = 'terminal-unverified-test-3' AND downstream_unverified_reason IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'expected a default-PENDING fill to have a NULL downstream_unverified_reason';
  END IF;

  RAISE NOTICE 'sports_shadow_terminal_unverified contract passed';
END $$;

ROLLBACK;
