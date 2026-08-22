-- FINAL BUILD (repository-completion pass): real-Postgres proof for the analytics/
-- soak-health/milestone-snapshot schema and RPCs added by 20260824000000-20260824040000
-- against the ACTUAL migrated database. Run via: psql -f
-- supabase/tests/sports_shadow_final_build_analytics.sql (after `supabase db reset --local`)
BEGIN;

DO $$
DECLARE
  v_wallet text := '0xanalyticsbuild';
  v_epoch_id uuid;
  v_cal_start timestamptz := now() - interval '10 days';
  v_oos_start timestamptz := v_cal_start + interval '1.5 days';
  v_fill_a uuid;
  v_fill_b uuid;
  v_fill_c uuid;
  v_signal_a uuid;
  v_signal_b uuid;
  v_signal_c uuid;
  v_match_id uuid;
  v_obs_early uuid;
  v_obs_late uuid;
  v_row record;
  v_oid oid;
BEGIN
  ------------------------------------------------------------------
  -- A. sports_shadow_milestone_snapshots: exists, RLS enabled, no anon/authenticated
  -- policy, service_role has full DML, and the UNIQUE(epoch, kind, version) constraint
  -- enforces insert-only-once-per-version (the mission's own explicit rule).
  ------------------------------------------------------------------
  IF to_regclass('public.sports_shadow_milestone_snapshots') IS NULL THEN
    RAISE EXCEPTION 'expected table public.sports_shadow_milestone_snapshots to exist';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.sports_shadow_milestone_snapshots')) THEN
    RAISE EXCEPTION 'RLS must be enabled on public.sports_shadow_milestone_snapshots';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sports_shadow_milestone_snapshots'
      AND (roles::text[] && ARRAY['anon', 'authenticated', 'public'])
  ) THEN
    RAISE EXCEPTION 'no anon/authenticated/public policy may exist on public.sports_shadow_milestone_snapshots';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.sports_shadow_milestone_snapshots', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'service_role must have full DML privileges on public.sports_shadow_milestone_snapshots';
  END IF;

  INSERT INTO public.sports_shadow_experiment_epochs (
    go_live_at, wallet_cohort, git_sha, config_hash, classifier_version, episode_version,
    resolver_version, router_version, pmus_fee_model_version, kalshi_fee_model_version,
    execution_simulator_version, settlement_version, calibration_started_at, oos_started_at
  ) VALUES (
    v_cal_start, ARRAY[v_wallet], 'sha1', 'hash1', 'c1', 'e1', 'r1', 'rt1', 'pf1', 'kf1', 'x1', 's1',
    v_cal_start, v_oos_start
  ) RETURNING id INTO v_epoch_id;

  INSERT INTO public.sports_shadow_milestone_snapshots (experiment_epoch_id, milestone_kind, snapshot_version, frozen_config, report, classification)
  VALUES (v_epoch_id, 'CALIBRATION', 'SNAPSHOT_V1', '{}'::jsonb, '{}'::jsonb, 'INTERESTING');
  BEGIN
    INSERT INTO public.sports_shadow_milestone_snapshots (experiment_epoch_id, milestone_kind, snapshot_version, frozen_config, report, classification)
    VALUES (v_epoch_id, 'CALIBRATION', 'SNAPSHOT_V1', '{}'::jsonb, '{}'::jsonb, 'INTERESTING');
    RAISE EXCEPTION 'expected a duplicate (epoch, kind, version) snapshot to violate UNIQUE';
  EXCEPTION
    WHEN unique_violation THEN NULL; -- expected
  END;
  -- A NEW version for the SAME (epoch, kind) is allowed -- never blocked, only ever ADDS a row.
  INSERT INTO public.sports_shadow_milestone_snapshots (experiment_epoch_id, milestone_kind, snapshot_version, frozen_config, report, classification)
  VALUES (v_epoch_id, 'CALIBRATION', 'SNAPSHOT_V2', '{}'::jsonb, '{}'::jsonb, 'CANDIDATE_FOR_OOS');

  ------------------------------------------------------------------
  -- B. insert_sports_shadow_episode's new p_experiment_epoch_id parameter actually
  -- persists onto sports_shadow_signals.experiment_epoch_id (the bug this pass fixed --
  -- previously always NULL regardless of what was passed).
  ------------------------------------------------------------------
  v_oid := 'public.insert_sports_shadow_episode(uuid, text, text, text, text, text, text, text, text, timestamptz, timestamptz, numeric, numeric, numeric, integer, boolean, text, timestamptz, text, text, text, text, numeric, text, uuid)'::regprocedure;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must have EXECUTE on insert_sports_shadow_episode(...25 args)';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not have EXECUTE on insert_sports_shadow_episode(...25 args)';
  END IF;

  INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, source_ts, identity_basis)
  VALUES ('ab-fill-a', v_wallet, '0xasset', 'BUY', 1, 'source_id') RETURNING id INTO v_fill_a;

  v_signal_a := public.insert_sports_shadow_episode(
    v_fill_a, 'ab-episode-a', v_wallet, NULL, '0xcondition', '0xasset', 'AWY', NULL, NULL,
    v_cal_start + interval '1 day', v_cal_start + interval '1 day', 0.5, 10, 5, 1, false,
    'MLB', NULL, 'AwayTeam', 'HomeTeam', 'MONEYLINE', 'AWY', NULL, 'game-1', v_epoch_id
  );
  IF (SELECT experiment_epoch_id FROM public.sports_shadow_signals WHERE id = v_signal_a) IS DISTINCT FROM v_epoch_id THEN
    RAISE EXCEPTION 'expected insert_sports_shadow_episode to persist p_experiment_epoch_id onto sports_shadow_signals.experiment_epoch_id';
  END IF;

  UPDATE public.sports_shadow_signals SET created_at = v_cal_start + interval '1 day' WHERE id = v_signal_a;
  -- Codex-caught P1: "settled" must come from sports_shadow_settlements, NEVER from
  -- sports_shadow_signals.status (which the real settlement pipeline never writes) --
  -- inserted at tier=5 specifically so it does not collide with section D's own
  -- tier=25 settlement inserts for signal_a below.
  INSERT INTO public.sports_shadow_settlements (signal_id, venue, notional_tier_usd, settlement_status, net_pnl_usd)
  VALUES (v_signal_a, 'PMUS', 5, 'SETTLED_WIN', 10);

  INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, source_ts, identity_basis)
  VALUES ('ab-fill-b', v_wallet, '0xasset2', 'BUY', 2, 'source_id') RETURNING id INTO v_fill_b;
  v_signal_b := public.insert_sports_shadow_episode(
    v_fill_b, 'ab-episode-b', v_wallet, NULL, '0xcondition2', '0xasset2', 'HOM', NULL, NULL,
    v_cal_start + interval '2 days', v_cal_start + interval '2 days', 0.5, 10, 5, 1, false,
    'MLB', NULL, 'AwayTeam', 'HomeTeam', 'MONEYLINE', 'HOM', NULL, 'game-1', v_epoch_id
  );
  UPDATE public.sports_shadow_signals SET created_at = v_cal_start + interval '2 days' WHERE id = v_signal_b;
  INSERT INTO public.sports_shadow_settlements (signal_id, venue, notional_tier_usd, settlement_status, net_pnl_usd)
  VALUES (v_signal_b, 'PMUS', 5, 'SETTLED_LOSS', -5);

  INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, source_ts, identity_basis)
  VALUES ('ab-fill-c', v_wallet, '0xasset3', 'BUY', 3, 'source_id') RETURNING id INTO v_fill_c;
  v_signal_c := public.insert_sports_shadow_episode(
    v_fill_c, 'ab-episode-c', v_wallet, NULL, '0xcondition3', '0xasset3', 'AWY', NULL, NULL,
    v_cal_start + interval '1 day', v_cal_start + interval '1 day', 0.5, 10, 5, 1, false,
    'MLB', NULL, 'OtherAway', 'OtherHome', 'MONEYLINE', 'AWY', NULL, NULL, v_epoch_id
  ); -- cluster_key NULL -- its own singleton cluster; no settlement row at all -- stays unsettled

  ------------------------------------------------------------------
  -- C. get_sports_shadow_epoch_counters: raw/independent/settled counts, and the
  -- calibration/OOS windows correctly split game-1's two correlated signals by their
  -- OWN created_at against the epoch's calibration_started_at/oos_started_at boundary.
  ------------------------------------------------------------------
  v_oid := 'public.get_sports_shadow_epoch_counters(uuid)'::regprocedure;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must have EXECUTE on get_sports_shadow_epoch_counters';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not have EXECUTE on get_sports_shadow_epoch_counters';
  END IF;

  SELECT * INTO v_row FROM public.get_sports_shadow_epoch_counters(v_epoch_id);
  IF v_row.raw_episode_count <> 3 THEN
    RAISE EXCEPTION 'expected raw_episode_count = 3, got %', v_row.raw_episode_count;
  END IF;
  IF v_row.independent_episode_count <> 2 THEN
    RAISE EXCEPTION 'expected independent_episode_count = 2 (game-1 cluster once + signal-c singleton), got %', v_row.independent_episode_count;
  END IF;
  IF v_row.settled_count <> 2 THEN
    RAISE EXCEPTION 'expected settled_count = 2, got %', v_row.settled_count;
  END IF;
  IF v_row.settled_independent_count <> 1 THEN
    RAISE EXCEPTION 'expected settled_independent_count = 1 (game-1 cluster, signal-c not settled), got %', v_row.settled_independent_count;
  END IF;
  -- signal_a (day+1) falls BEFORE oos_start (day+1.5) -- counted in calibration window.
  -- signal_b (day+2) falls AFTER oos_start -- excluded from calibration, counted in OOS.
  IF v_row.calibration_independent_settled_count <> 1 THEN
    RAISE EXCEPTION 'expected calibration_independent_settled_count = 1 (only signal_a''s window), got %', v_row.calibration_independent_settled_count;
  END IF;
  IF v_row.oos_independent_settled_count <> 1 THEN
    RAISE EXCEPTION 'expected oos_independent_settled_count = 1 (only signal_b''s window), got %', v_row.oos_independent_settled_count;
  END IF;

  ------------------------------------------------------------------
  -- D. get_sports_shadow_episode_outcomes: DISTINCT ON picks the EARLIEST paper_fill
  -- per (signal, tier), and the settlement join matches ONLY the chosen venue/tier.
  ------------------------------------------------------------------
  v_oid := 'public.get_sports_shadow_episode_outcomes(uuid)'::regprocedure;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must have EXECUTE on get_sports_shadow_episode_outcomes';
  END IF;
  IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must not have EXECUTE on get_sports_shadow_episode_outcomes';
  END IF;

  INSERT INTO public.sports_market_matches (signal_id, venue, match_status, first_match_status)
  VALUES (v_signal_a, 'PMUS', 'EXACT', 'EXACT') RETURNING id INTO v_match_id;

  INSERT INTO public.sports_quote_observations (signal_id, match_id, venue, requested_delay_ms, source_timestamp, fire_at, observed_at, spread)
  VALUES (v_signal_a, v_match_id, 'PMUS', 0, v_cal_start, v_cal_start, v_cal_start, 0.03)
  RETURNING id INTO v_obs_early;
  INSERT INTO public.sports_quote_observations (signal_id, match_id, venue, requested_delay_ms, source_timestamp, fire_at, observed_at, spread)
  VALUES (v_signal_a, v_match_id, 'PMUS', 60000, v_cal_start, v_cal_start, v_cal_start, 0.05)
  RETURNING id INTO v_obs_late;

  -- Earlier routing_timestamp, contracts = 7 -- this is the one that must win.
  INSERT INTO public.sports_shadow_paper_fills (signal_id, experiment_epoch_id, observation_id, side, notional_tier_usd, routing_timestamp, chosen_venue, fill_status, contracts)
  VALUES (v_signal_a, v_epoch_id, v_obs_early, 'ENTRY', 25, v_cal_start + interval '1 day', 'PMUS', 'FULL', 7);
  -- Later routing_timestamp, contracts = 99 -- must be excluded by DISTINCT ON.
  INSERT INTO public.sports_shadow_paper_fills (signal_id, experiment_epoch_id, observation_id, side, notional_tier_usd, routing_timestamp, chosen_venue, fill_status, contracts)
  VALUES (v_signal_a, v_epoch_id, v_obs_late, 'ENTRY', 25, v_cal_start + interval '1 day 1 hour', 'PMUS', 'FULL', 99);

  -- Settlement for the WRONG venue at the same tier -- must NOT join.
  INSERT INTO public.sports_shadow_settlements (signal_id, venue, notional_tier_usd, settlement_status, net_pnl_usd)
  VALUES (v_signal_a, 'KALSHI', 25, 'SETTLED_WIN', 999);
  -- Settlement for the CHOSEN venue/tier -- must join.
  INSERT INTO public.sports_shadow_settlements (signal_id, venue, notional_tier_usd, settlement_status, net_pnl_usd)
  VALUES (v_signal_a, 'PMUS', 25, 'SETTLED_WIN', 12.34);

  SELECT * INTO v_row FROM public.get_sports_shadow_episode_outcomes(v_epoch_id) WHERE signal_id = v_signal_a AND notional_tier_usd = 25;
  IF v_row.contracts <> 7 THEN
    RAISE EXCEPTION 'expected DISTINCT ON to pick the EARLIEST paper fill (contracts=7), got %', v_row.contracts;
  END IF;
  IF v_row.net_pnl_usd <> 12.34 THEN
    RAISE EXCEPTION 'expected the settlement join to match ONLY the chosen venue (PMUS, net_pnl=12.34), got %', v_row.net_pnl_usd;
  END IF;
  IF v_row.spread <> 0.03 THEN
    RAISE EXCEPTION 'expected the observation join to follow the EARLIEST paper fill''s own observation_id (spread=0.03), got %', v_row.spread;
  END IF;

  ------------------------------------------------------------------
  -- D2. Codex-caught P1 regression: signal_c has NO paper_fills row at all (never
  -- matched/routed) -- it must still appear, as a synthetic 'UNROUTED' row, once per
  -- canonical notional tier, so match-rate/liquidity-failure-rate denominators see the
  -- FULL set of detected signals, not only the ones that happened to get routed.
  ------------------------------------------------------------------
  IF (SELECT count(*) FROM public.get_sports_shadow_episode_outcomes(v_epoch_id) WHERE signal_id = v_signal_c) <> 5 THEN
    RAISE EXCEPTION 'expected signal_c (never routed) to appear exactly 5 times (once per canonical tier), got %',
      (SELECT count(*) FROM public.get_sports_shadow_episode_outcomes(v_epoch_id) WHERE signal_id = v_signal_c);
  END IF;
  IF (SELECT count(*) FROM public.get_sports_shadow_episode_outcomes(v_epoch_id) WHERE signal_id = v_signal_c AND fill_status = 'UNROUTED') <> 5 THEN
    RAISE EXCEPTION 'expected all 5 of signal_c''s synthetic rows to have fill_status = UNROUTED';
  END IF;
  SELECT * INTO v_row FROM public.get_sports_shadow_episode_outcomes(v_epoch_id) WHERE signal_id = v_signal_c AND notional_tier_usd = 25;
  IF v_row.settlement_status IS NOT NULL OR v_row.chosen_venue IS NOT NULL OR v_row.contracts <> 0 THEN
    RAISE EXCEPTION 'expected an UNROUTED row to have no settlement/venue and zero contracts, got venue=% contracts=% settlement=%', v_row.chosen_venue, v_row.contracts, v_row.settlement_status;
  END IF;

  ------------------------------------------------------------------
  -- E. get_sports_shadow_soak_telemetry_rollup: sums are correctly scoped by epoch AND
  -- by the p_since cutoff (an event before the cutoff must be excluded).
  ------------------------------------------------------------------
  v_oid := 'public.get_sports_shadow_soak_telemetry_rollup(uuid, timestamptz)'::regprocedure;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must have EXECUTE on get_sports_shadow_soak_telemetry_rollup';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not have EXECUTE on get_sports_shadow_soak_telemetry_rollup';
  END IF;

  INSERT INTO public.sports_shadow_telemetry_events (created_at, category, metric, value, labels, experiment_epoch_id)
  VALUES
    (now() - interval '1 hour', 'SYSTEM', 'cycle_duration_ms', 1000, '{}'::jsonb, v_epoch_id),
    (now() - interval '1 hour', 'SYSTEM', 'cycle_error_count', 0, '{}'::jsonb, v_epoch_id),
    (now() - interval '1 hour', 'OBSERVATION', 'skipped', 5, '{"venue":"PMUS"}'::jsonb, v_epoch_id),
    (now() - interval '1 hour', 'VENUE', 'discovery_failed', 1, '{"venue":"KALSHI"}'::jsonb, v_epoch_id),
    (now() - interval '1 hour', 'SOURCE', 'wallets_attempted', 0, '{}'::jsonb, v_epoch_id),
    (now() - interval '1 hour', 'SOURCE', 'lease_lost', 1, '{}'::jsonb, v_epoch_id),
    -- BEFORE the cutoff below -- must be excluded entirely.
    (now() - interval '10 hours', 'SYSTEM', 'cycle_duration_ms', 1000, '{}'::jsonb, v_epoch_id);

  SELECT * INTO v_row FROM public.get_sports_shadow_soak_telemetry_rollup(v_epoch_id, now() - interval '2 hours');
  IF v_row.actual_cycle_count <> 1 THEN
    RAISE EXCEPTION 'expected actual_cycle_count = 1 (the pre-cutoff event must be excluded), got %', v_row.actual_cycle_count;
  END IF;
  IF v_row.observation_backlog_total <> 5 THEN
    RAISE EXCEPTION 'expected observation_backlog_total = 5, got %', v_row.observation_backlog_total;
  END IF;
  IF v_row.kalshi_discovery_failed_count <> 1 OR v_row.kalshi_discovery_attempted_cycles <> 1 THEN
    RAISE EXCEPTION 'expected kalshi discovery failed=1/attempted=1, got failed=% attempted=%', v_row.kalshi_discovery_failed_count, v_row.kalshi_discovery_attempted_cycles;
  END IF;
  IF v_row.pmus_discovery_attempted_cycles <> 0 THEN
    RAISE EXCEPTION 'expected pmus_discovery_attempted_cycles = 0 (no PMUS discovery_failed event was recorded), got %', v_row.pmus_discovery_attempted_cycles;
  END IF;
  IF v_row.source_lane_acquired_cycles <> 1 OR v_row.source_starved_cycles <> 1 THEN
    RAISE EXCEPTION 'expected source_lane_acquired_cycles=1/source_starved_cycles=1 (wallets_attempted=0), got acquired=% starved=%', v_row.source_lane_acquired_cycles, v_row.source_starved_cycles;
  END IF;
  IF v_row.lease_lost_count <> 1 THEN
    RAISE EXCEPTION 'expected lease_lost_count = 1, got %', v_row.lease_lost_count;
  END IF;

  RAISE NOTICE 'sports_shadow_final_build_analytics.sql: all assertions passed';
END $$;

ROLLBACK;
