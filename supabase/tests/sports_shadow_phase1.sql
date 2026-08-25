-- Task 12A: Sports Forward Shadow Phase 1 real-schema contract.
-- Verifies supabase/migrations/20260819220000_sports_forward_shadow_phase1.sql and
-- supabase/migrations/20260820230000_sports_shadow_pending_signals_rpc.sql against a
-- REAL, freshly-migrated local Postgres instance (never a fake/in-memory assumption).
-- Run via: psql -f supabase/tests/sports_shadow_phase1.sql (after `supabase db reset --local`)
BEGIN;

DO $$
DECLARE
  v_table text;
  v_oid oid;
  v_public_has_execute boolean;
  v_epoch_id uuid;
BEGIN
  -- A. TABLES EXIST
  FOREACH v_table IN ARRAY ARRAY[
    'sports_shadow_source_fills',
    'sports_shadow_signals',
    'sports_market_matches',
    'sports_quote_observations'
  ]
  LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      RAISE EXCEPTION 'expected table public.% to exist', v_table;
    END IF;
  END LOOP;

  -- B. RLS enabled on all four, and no permissive anon/authenticated policy exists.
  FOREACH v_table IN ARRAY ARRAY[
    'sports_shadow_source_fills',
    'sports_shadow_signals',
    'sports_market_matches',
    'sports_quote_observations'
  ]
  LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.' || v_table)) THEN
      RAISE EXCEPTION 'RLS must be enabled on public.%', v_table;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = v_table
        AND (roles::text[] && ARRAY['anon', 'authenticated', 'public'])
    ) THEN
      RAISE EXCEPTION 'no anon/authenticated/public policy may exist on public.%', v_table;
    END IF;
  END LOOP;

  -- C. SERVICE ROLE ACCESS: service_role has full table privileges; anon/authenticated
  -- have none directly on the table (their only path, if any, is a hardened RPC).
  FOREACH v_table IN ARRAY ARRAY[
    'sports_shadow_source_fills',
    'sports_shadow_signals',
    'sports_market_matches',
    'sports_quote_observations'
  ]
  LOOP
    IF NOT has_table_privilege('service_role', 'public.' || v_table, 'SELECT, INSERT, UPDATE, DELETE') THEN
      RAISE EXCEPTION 'service_role must have full DML privileges on public.%', v_table;
    END IF;
    IF has_table_privilege('anon', 'public.' || v_table, 'SELECT') THEN
      RAISE EXCEPTION 'anon must not have direct SELECT on public.%', v_table;
    END IF;
    IF has_table_privilege('authenticated', 'public.' || v_table, 'SELECT') THEN
      RAISE EXCEPTION 'authenticated must not have direct SELECT on public.%', v_table;
    END IF;
    -- Real execution attempt, not just a catalog check: with no table-level GRANT to
    -- anon, a real anon-role SELECT must be rejected at the privilege-check layer
    -- (insufficient_privilege) before RLS is even evaluated -- matching every other
    -- Sports Shadow table's established GRANT ALL TO service_role-only pattern.
    BEGIN
      EXECUTE format('SET LOCAL ROLE anon');
      EXECUTE format('SELECT 1 FROM public.%I LIMIT 1', v_table);
      RAISE EXCEPTION 'anon must not be able to SELECT from public.% at all (no GRANT expected)', v_table;
    EXCEPTION WHEN insufficient_privilege THEN
      RESET ROLE;
    END;
  END LOOP;

  -- D. CHECK CONSTRAINTS
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sports_shadow_signals'::regclass
      AND conname = 'sports_shadow_signals_bet_type_check'
      AND pg_get_constraintdef(oid) LIKE '%MONEYLINE%SPREAD%TOTAL%'
  ) THEN
    RAISE EXCEPTION 'sports_shadow_signals.bet_type CHECK constraint missing or unexpected';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sports_market_matches'::regclass
      AND conname = 'sports_market_matches_venue_check'
      AND pg_get_constraintdef(oid) LIKE '%PMUS%KALSHI%'
  ) THEN
    RAISE EXCEPTION 'sports_market_matches.venue CHECK constraint missing or unexpected';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sports_market_matches'::regclass
      AND conname = 'sports_market_matches_status_check'
      AND pg_get_constraintdef(oid) LIKE '%EXACT%NEAR%NONE%UNVERIFIED%'
  ) THEN
    RAISE EXCEPTION 'sports_market_matches.match_status CHECK constraint missing or unexpected';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sports_market_matches'::regclass
      AND conname = 'sports_market_matches_settlement_check'
      AND pg_get_constraintdef(oid) LIKE '%COMPATIBLE%INCOMPATIBLE%UNKNOWN%'
  ) THEN
    RAISE EXCEPTION 'sports_market_matches.settlement_compatibility CHECK constraint missing or unexpected';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sports_quote_observations'::regclass
      AND conname = 'sports_quote_observations_delay_check'
      AND pg_get_constraintdef(oid) = 'CHECK ((requested_delay_ms = ANY (ARRAY[0, 5000, 10000, 30000, 60000])))'
  ) THEN
    RAISE EXCEPTION 'sports_quote_observations.requested_delay_ms CHECK constraint missing or does not match the exact five legal delays';
  END IF;

  -- Seed real rows OUTSIDE any exception-catching sub-block, so the deliberately-invalid
  -- insert below (and its implicit-savepoint rollback) cannot also undo these -- section
  -- F reuses this exact signal/match pair afterward.
  INSERT INTO public.sports_shadow_experiment_epochs (
    go_live_at, wallet_cohort, git_sha, config_hash, classifier_version, episode_version,
    resolver_version, router_version, pmus_fee_model_version, kalshi_fee_model_version,
    execution_simulator_version, settlement_version, is_current
  ) VALUES (
    now(), ARRAY['0xtest'], '1111111111111111111111111111111111111111', 'phase1-test-epoch',
    'c1', 'e1', 'r1', 'rt1', 'pf1', 'kf1', 'x1', 's1', false
  ) RETURNING id INTO v_epoch_id;

  INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, source_ts, identity_basis)
  VALUES ('contract-test-fill-1', '0xtest', '0xasset', 'BUY', 1, 'source_id');
  INSERT INTO public.sports_shadow_signals (episode_key, source_wallet, source_asset, first_fill_id, source_first_fill_at, source_last_fill_at, bet_type, selected_side, experiment_epoch_id)
  VALUES ('contract-test-episode-1', '0xtest', '0xasset', (SELECT id FROM public.sports_shadow_source_fills WHERE event_key = 'contract-test-fill-1'), now(), now(), 'MONEYLINE', 'TEAM', v_epoch_id);
  INSERT INTO public.sports_market_matches (signal_id, venue, match_status, first_match_status)
  VALUES ((SELECT id FROM public.sports_shadow_signals WHERE episode_key = 'contract-test-episode-1'), 'PMUS', 'EXACT', 'EXACT');

  -- Functional proof, not just catalog inspection, that an out-of-set delay is
  -- rejected. Isolated in its own exception-catching sub-block (an implicit savepoint)
  -- so only THIS insert's failure is rolled back, nothing seeded above.
  BEGIN
    INSERT INTO public.sports_quote_observations (signal_id, match_id, venue, requested_delay_ms, source_timestamp, fire_at)
    VALUES (
      (SELECT id FROM public.sports_shadow_signals WHERE episode_key = 'contract-test-episode-1'),
      (SELECT id FROM public.sports_market_matches WHERE signal_id = (SELECT id FROM public.sports_shadow_signals WHERE episode_key = 'contract-test-episode-1')),
      'PMUS', 45000, now(), now()
    );
    RAISE EXCEPTION 'an out-of-set requested_delay_ms (45000) must have been rejected by the CHECK constraint';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected
  END;

  -- E. UNIQUENESS
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sports_shadow_source_fills'::regclass AND contype = 'u' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.sports_shadow_source_fills'::regclass AND attname = 'event_key')]) THEN
    RAISE EXCEPTION 'sports_shadow_source_fills.event_key must be UNIQUE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sports_shadow_signals'::regclass AND contype = 'u' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.sports_shadow_signals'::regclass AND attname = 'episode_key')]) THEN
    RAISE EXCEPTION 'sports_shadow_signals.episode_key must be UNIQUE';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sports_market_matches'::regclass AND contype = 'u'
      AND conkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.sports_market_matches'::regclass AND attname = 'signal_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.sports_market_matches'::regclass AND attname = 'venue')
      ]
  ) THEN
    RAISE EXCEPTION 'sports_market_matches must have UNIQUE (signal_id, venue)';
  END IF;
  -- CODEX P1-3 (follower lifecycle): the ORIGINAL 3-column UNIQUE (signal_id, venue,
  -- requested_delay_ms) was replaced by a 4-column `UNIQUE NULLS NOT DISTINCT
  -- (signal_id, venue, requested_delay_ms, trigger_source_fill_id)` constraint
  -- (sports_quote_observations_logical_key -- see migration
  -- 20260825120000_sports_shadow_follower_lifecycle.sql's own doc comment) so an ENTRY
  -- observation row (trigger_source_fill_id NULL) and a lifecycle ADD/EXIT observation
  -- row for the SAME (signal, venue, delay) but a DIFFERENT trigger can coexist, while
  -- still enforcing exactly one row per logical key. This assertion was updated to match
  -- that intentional, already-Codex-reviewed schema change rather than the stale
  -- 3-column shape.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sports_quote_observations'::regclass AND contype = 'u'
      AND conkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.sports_quote_observations'::regclass AND attname = 'signal_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.sports_quote_observations'::regclass AND attname = 'venue'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.sports_quote_observations'::regclass AND attname = 'requested_delay_ms'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.sports_quote_observations'::regclass AND attname = 'trigger_source_fill_id')
      ]
  ) THEN
    RAISE EXCEPTION 'sports_quote_observations must have UNIQUE NULLS NOT DISTINCT (signal_id, venue, requested_delay_ms, trigger_source_fill_id)';
  END IF;

  -- F. FK / CASCADE CONTRACTS — validated as-is from Task 1 (documented, not "fixed"):
  -- sports_shadow_signals.first_fill_id -> sports_shadow_source_fills: NO ACTION.
  -- sports_market_matches.signal_id -> sports_shadow_signals: ON DELETE CASCADE.
  -- sports_quote_observations.signal_id -> sports_shadow_signals: ON DELETE CASCADE.
  -- sports_quote_observations.match_id -> sports_market_matches: ON DELETE CASCADE.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sports_shadow_signals'::regclass
      AND confrelid = 'public.sports_shadow_source_fills'::regclass
      AND confdeltype <> 'a' -- 'a' = NO ACTION
  ) THEN
    RAISE EXCEPTION 'sports_shadow_signals.first_fill_id FK must remain ON DELETE NO ACTION (Task 1 as-built contract)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sports_market_matches'::regclass
      AND confrelid = 'public.sports_shadow_signals'::regclass
      AND confdeltype = 'c' -- CASCADE
  ) THEN
    RAISE EXCEPTION 'sports_market_matches.signal_id FK must remain ON DELETE CASCADE (Task 1 as-built contract)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sports_quote_observations'::regclass
      AND confrelid = 'public.sports_shadow_signals'::regclass
      AND confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'sports_quote_observations.signal_id FK must remain ON DELETE CASCADE (Task 1 as-built contract)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sports_quote_observations'::regclass
      AND confrelid = 'public.sports_market_matches'::regclass
      AND confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'sports_quote_observations.match_id FK must remain ON DELETE CASCADE (Task 1 as-built contract)';
  END IF;

  -- Functional CASCADE proof: deleting the signal created above must remove its match
  -- and observation rows too (the observation insert above failed/rolled back its own
  -- statement due to the CHECK violation, so re-seed a schedulable row here).
  DELETE FROM public.sports_quote_observations WHERE signal_id = (SELECT id FROM public.sports_shadow_signals WHERE episode_key = 'contract-test-episode-1');
  INSERT INTO public.sports_quote_observations (signal_id, match_id, venue, requested_delay_ms, source_timestamp, fire_at)
  VALUES (
    (SELECT id FROM public.sports_shadow_signals WHERE episode_key = 'contract-test-episode-1'),
    (SELECT id FROM public.sports_market_matches WHERE signal_id = (SELECT id FROM public.sports_shadow_signals WHERE episode_key = 'contract-test-episode-1')),
    'PMUS', 0, now(), now()
  );
  DELETE FROM public.sports_shadow_signals WHERE episode_key = 'contract-test-episode-1';
  IF EXISTS (SELECT 1 FROM public.sports_market_matches WHERE signal_id NOT IN (SELECT id FROM public.sports_shadow_signals)) THEN
    RAISE EXCEPTION 'deleting a signal must cascade-delete its sports_market_matches rows';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sports_quote_observations WHERE signal_id NOT IN (SELECT id FROM public.sports_shadow_signals)) THEN
    RAISE EXCEPTION 'deleting a signal must cascade-delete its sports_quote_observations rows';
  END IF;

  -- G. DUE INDEX: partial index on (fire_at) WHERE observed_at IS NULL.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'sports_quote_observations'
      AND indexname = 'sports_quote_observations_due_idx'
      AND indexdef LIKE '%WHERE (observed_at IS NULL)%'
  ) THEN
    RAISE EXCEPTION 'sports_quote_observations_due_idx partial index (fire_at) WHERE observed_at IS NULL is missing';
  END IF;

  -- H. TASK 12D SCHEMA: downstream_status (P1-A) and the wallet rotation cursor (P1-B).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sports_shadow_source_fills' AND column_name = 'downstream_status'
  ) THEN
    RAISE EXCEPTION 'sports_shadow_source_fills.downstream_status column is missing (Task 12D/P1-A)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sports_shadow_source_fills'::regclass
      AND conname = 'sports_shadow_source_fills_downstream_status_check'
      AND pg_get_constraintdef(oid) LIKE '%PENDING%COMPLETE%TERMINAL_INELIGIBLE%TERMINAL_INVALID%'
  ) THEN
    RAISE EXCEPTION 'sports_shadow_source_fills.downstream_status CHECK constraint missing or unexpected';
  END IF;
  -- Loose on exact paren/cast rendering (Postgres renders a single-predicate partial
  -- index WHERE clause as e.g. "WHERE (downstream_status = 'PENDING'::text)", not the
  -- "((...))" double-paren shape used elsewhere in this file for a compound predicate)
  -- -- still strict enough to prove the index targets the right column and value.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'sports_shadow_source_fills'
      AND indexname = 'sports_shadow_source_fills_pending_idx'
      AND indexdef LIKE '%WHERE%downstream_status%PENDING%'
  ) THEN
    RAISE EXCEPTION 'sports_shadow_source_fills_pending_idx partial index is missing';
  END IF;
  IF to_regclass('public.sports_shadow_wallet_cursor') IS NULL THEN
    RAISE EXCEPTION 'sports_shadow_wallet_cursor table is missing (Task 12D/P1-B)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sports_shadow_wallet_cursor WHERE id = 'source_wallet_rotation') THEN
    RAISE EXCEPTION 'sports_shadow_wallet_cursor seed row (source_wallet_rotation) is missing';
  END IF;
  IF has_table_privilege('anon', 'public.sports_shadow_wallet_cursor', 'SELECT') THEN
    RAISE EXCEPTION 'anon must not have direct SELECT on public.sports_shadow_wallet_cursor';
  END IF;

  RAISE NOTICE 'sports_shadow_phase1 schema contract passed';
END $$;

ROLLBACK;
