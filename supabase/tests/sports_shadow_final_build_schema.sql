-- FINAL BUILD: real-Postgres proof for the new experiment-epoch/sell-ledger/rule-
-- fingerprint/capability/paper-execution/settlement/independence/telemetry/integrity/
-- alerts schema (20260823090000_sports_shadow_final_build_schema.sql) against the
-- ACTUAL migrated database. Run via: psql -f
-- supabase/tests/sports_shadow_final_build_schema.sql (after `supabase db reset --local`)
BEGIN;

DO $$
DECLARE
  v_table text;
  v_wallet text := '0xfinalbuild';
  v_fill_id uuid;
  v_signal_id uuid;
  v_epoch_id uuid;
  v_epoch_id_2 uuid;
  v_count integer;
BEGIN
  ------------------------------------------------------------------
  -- A. EVERY NEW TABLE EXISTS, RLS ENABLED, NO anon/authenticated POLICY, service_role
  -- has full DML, anon/authenticated have none.
  ------------------------------------------------------------------
  FOREACH v_table IN ARRAY ARRAY[
    'sports_shadow_experiment_epochs',
    'sports_shadow_source_sell_events',
    'sports_shadow_venue_capability',
    'sports_shadow_paper_fills',
    'sports_shadow_paper_positions',
    'sports_shadow_settlements',
    'sports_shadow_telemetry_events',
    'sports_shadow_integrity_audits',
    'sports_shadow_alerts'
  ]
  LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      RAISE EXCEPTION 'expected table public.% to exist', v_table;
    END IF;
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
    IF NOT has_table_privilege('service_role', 'public.' || v_table, 'SELECT, INSERT, UPDATE, DELETE') THEN
      RAISE EXCEPTION 'service_role must have full DML privileges on public.%', v_table;
    END IF;
    IF has_table_privilege('anon', 'public.' || v_table, 'SELECT') THEN
      RAISE EXCEPTION 'anon must not have direct SELECT on public.%', v_table;
    END IF;
    IF has_table_privilege('authenticated', 'public.' || v_table, 'SELECT') THEN
      RAISE EXCEPTION 'authenticated must not have direct SELECT on public.%', v_table;
    END IF;
  END LOOP;

  ------------------------------------------------------------------
  -- B. Existing tables' new columns exist.
  ------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sports_shadow_signals' AND column_name = 'experiment_epoch_id') THEN
    RAISE EXCEPTION 'expected sports_shadow_signals.experiment_epoch_id to exist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sports_shadow_signals' AND column_name = 'cluster_key') THEN
    RAISE EXCEPTION 'expected sports_shadow_signals.cluster_key to exist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sports_shadow_signals' AND column_name = 'source_sell_shares') THEN
    RAISE EXCEPTION 'expected sports_shadow_signals.source_sell_shares to exist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sports_market_matches' AND column_name = 'rule_fingerprint') THEN
    RAISE EXCEPTION 'expected sports_market_matches.rule_fingerprint to exist';
  END IF;

  ------------------------------------------------------------------
  -- C. Only ONE epoch can be is_current=true at a time.
  ------------------------------------------------------------------
  INSERT INTO public.sports_shadow_experiment_epochs (
    go_live_at, wallet_cohort, git_sha, config_hash, classifier_version, episode_version,
    resolver_version, router_version, pmus_fee_model_version, kalshi_fee_model_version,
    execution_simulator_version, settlement_version
  ) VALUES (
    now(), ARRAY['0xa'], 'sha1', 'hash1', 'c1', 'e1', 'r1', 'rt1', 'pf1', 'kf1', 'x1', 's1'
  ) RETURNING id INTO v_epoch_id;

  BEGIN
    INSERT INTO public.sports_shadow_experiment_epochs (
      go_live_at, wallet_cohort, git_sha, config_hash, classifier_version, episode_version,
      resolver_version, router_version, pmus_fee_model_version, kalshi_fee_model_version,
      execution_simulator_version, settlement_version, is_current
    ) VALUES (
      now(), ARRAY['0xb'], 'sha2', 'hash2', 'c1', 'e1', 'r1', 'rt1', 'pf1', 'kf1', 'x1', 's1', true
    );
    RAISE EXCEPTION 'expected a second is_current=true epoch to violate the one-current partial unique index';
  EXCEPTION
    WHEN unique_violation THEN NULL; -- expected
  END;

  -- Flipping the old epoch to non-current THEN inserting a new current one succeeds
  -- (the correct, real application sequence for starting a new epoch).
  UPDATE public.sports_shadow_experiment_epochs SET is_current = false WHERE id = v_epoch_id;
  INSERT INTO public.sports_shadow_experiment_epochs (
    go_live_at, wallet_cohort, git_sha, config_hash, classifier_version, episode_version,
    resolver_version, router_version, pmus_fee_model_version, kalshi_fee_model_version,
    execution_simulator_version, settlement_version
  ) VALUES (
    now(), ARRAY['0xb'], 'sha2', 'hash2', 'c1', 'e1', 'r1', 'rt1', 'pf1', 'kf1', 'x1', 's1'
  ) RETURNING id INTO v_epoch_id_2;

  ------------------------------------------------------------------
  -- D. Sell ledger idempotency: UNIQUE(source_fill_id) prevents double-counting a
  -- retried poll's re-observation of the identical raw fill as two sell events.
  ------------------------------------------------------------------
  INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, source_ts, identity_basis)
  VALUES ('fb-buy-1', v_wallet, '0xasset', 'BUY', 1, 'source_id')
  RETURNING id INTO v_fill_id;

  INSERT INTO public.sports_shadow_signals (
    episode_key, source_wallet, source_asset, first_fill_id, source_first_fill_at, source_last_fill_at,
    bet_type, selected_side, experiment_epoch_id
  ) VALUES (
    'fb-episode-1', v_wallet, '0xasset', v_fill_id, now(), now(), 'MONEYLINE', 'AWAY', v_epoch_id_2
  ) RETURNING id INTO v_signal_id;

  INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, source_ts, identity_basis)
  VALUES ('fb-sell-1', v_wallet, '0xasset', 'SELL', 2, 'source_id')
  RETURNING id INTO v_fill_id;

  INSERT INTO public.sports_shadow_source_sell_events (signal_id, source_fill_id, shares, price, notional, source_ts)
  VALUES (v_signal_id, v_fill_id, 10, 0.5, 5, 2);

  BEGIN
    INSERT INTO public.sports_shadow_source_sell_events (signal_id, source_fill_id, shares, price, notional, source_ts)
    VALUES (v_signal_id, v_fill_id, 10, 0.5, 5, 2);
    RAISE EXCEPTION 'expected a duplicate source_fill_id sell event to violate the UNIQUE constraint';
  EXCEPTION
    WHEN unique_violation THEN NULL; -- expected
  END;

  ------------------------------------------------------------------
  -- E1. Paper fills idempotency: UNIQUE(signal_id, requested_delay_ms,
  -- notional_tier_usd) prevents two routing decisions for the SAME logical routing
  -- opportunity (CODEX P1-2 fix -- previously keyed by the PHYSICAL observation_id,
  -- which let PM-US's and Kalshi's independently-completing observations each create
  -- their own duplicate row for what should be exactly one decision). Also proves the
  -- decide-once provenance protocol: record_sports_shadow_routing_provenance never
  -- overwrites an already-known observation id, and finalize_sports_shadow_routing_
  -- decision's WHERE decided_at IS NULL guard lets exactly one caller win.
  ------------------------------------------------------------------
  INSERT INTO public.sports_shadow_paper_fills (signal_id, requested_delay_ms, notional_tier_usd, fill_status)
  VALUES (v_signal_id, 0, 10, 'FULL');
  BEGIN
    INSERT INTO public.sports_shadow_paper_fills (signal_id, requested_delay_ms, notional_tier_usd, fill_status)
    VALUES (v_signal_id, 0, 10, 'FULL');
    RAISE EXCEPTION 'expected a duplicate (signal_id, requested_delay_ms, notional_tier_usd) paper fill to violate UNIQUE';
  EXCEPTION
    WHEN unique_violation THEN NULL; -- expected
  END;

  DECLARE
    v_match_id uuid;
    v_obs_pmus uuid;
    v_obs_kalshi uuid;
    v_won boolean;
  BEGIN
    INSERT INTO public.sports_market_matches (signal_id, venue, match_status, first_match_status)
    VALUES (v_signal_id, 'PMUS', 'EXACT', 'EXACT')
    RETURNING id INTO v_match_id;
    INSERT INTO public.sports_quote_observations (signal_id, match_id, venue, requested_delay_ms, source_timestamp, fire_at)
    VALUES (v_signal_id, v_match_id, 'PMUS', 30000, now(), now())
    RETURNING id INTO v_obs_pmus;

    INSERT INTO public.sports_market_matches (signal_id, venue, match_status, first_match_status)
    VALUES (v_signal_id, 'KALSHI', 'EXACT', 'EXACT')
    RETURNING id INTO v_match_id;
    INSERT INTO public.sports_quote_observations (signal_id, match_id, venue, requested_delay_ms, source_timestamp, fire_at)
    VALUES (v_signal_id, v_match_id, 'KALSHI', 30000, now(), now())
    RETURNING id INTO v_obs_kalshi;

    PERFORM public.record_sports_shadow_routing_provenance(v_signal_id, 30000, 25, 'PMUS', v_obs_pmus, now());
    PERFORM public.record_sports_shadow_routing_provenance(v_signal_id, 30000, 25, 'KALSHI', v_obs_kalshi, now());

    -- Re-recording PMUS's provenance with a bogus id must NOT clobber the already-known
    -- one (COALESCE guard) -- a retried/duplicate call is always safe.
    PERFORM public.record_sports_shadow_routing_provenance(v_signal_id, 30000, 25, 'PMUS', gen_random_uuid(), now());
    IF NOT EXISTS (
      SELECT 1 FROM public.sports_shadow_paper_fills
      WHERE signal_id = v_signal_id AND requested_delay_ms = 30000 AND notional_tier_usd = 25
        AND pmus_observation_id = v_obs_pmus AND kalshi_observation_id = v_obs_kalshi
    ) THEN
      RAISE EXCEPTION 'expected record_sports_shadow_routing_provenance to preserve already-known observation ids via COALESCE';
    END IF;

    SELECT public.finalize_sports_shadow_routing_decision(
      v_signal_id, 30000, 25, now(), 'BOTH_COMPLETE', 'PMUS', 'FULL', 20, 0.5, 0.1, 'v1', true, 10.1, NULL,
      '{}'::jsonb, '{}'::jsonb, 'mkt-1', 'YES', 'ENTRY', NULL, v_epoch_id_2
    ) INTO v_won;
    IF NOT v_won THEN
      RAISE EXCEPTION 'expected the first finalize_sports_shadow_routing_decision call to win (decided_at was NULL)';
    END IF;

    -- "No later quote can alter a +0 decision" is a DB-enforced invariant: a second
    -- finalize call for the same logical row must lose, not silently overwrite.
    SELECT public.finalize_sports_shadow_routing_decision(
      v_signal_id, 30000, 25, now(), 'BOTH_COMPLETE', 'KALSHI', 'FULL', 20, 0.5, 0.1, 'v1', true, 10.1, NULL,
      '{}'::jsonb, '{}'::jsonb, 'mkt-2', 'NO', 'ENTRY', NULL, v_epoch_id_2
    ) INTO v_won;
    IF v_won THEN
      RAISE EXCEPTION 'expected the second finalize_sports_shadow_routing_decision call for an already-decided row to lose';
    END IF;

    -- CODEX P1-7 foundation: a winning ENTRY/FULL finalize atomically opens the
    -- corresponding sports_shadow_paper_positions row in the SAME transaction.
    IF NOT EXISTS (
      SELECT 1 FROM public.sports_shadow_paper_positions
      WHERE signal_id = v_signal_id AND venue = 'PMUS' AND notional_tier_usd = 25 AND contracts_open = 20
    ) THEN
      RAISE EXCEPTION 'expected finalize_sports_shadow_routing_decision to atomically open a paper position on ENTRY/FULL';
    END IF;
  END;

  ------------------------------------------------------------------
  -- E2. Paper positions + settlements: UNIQUE(signal_id, venue, notional_tier_usd)
  -- enforces exactly one aggregate row per signal/venue/tier -- never a silent
  -- duplicate accumulator.
  ------------------------------------------------------------------
  INSERT INTO public.sports_shadow_paper_positions (signal_id, venue, notional_tier_usd, contracts_open)
  VALUES (v_signal_id, 'PMUS', 10, 20);
  BEGIN
    INSERT INTO public.sports_shadow_paper_positions (signal_id, venue, notional_tier_usd, contracts_open)
    VALUES (v_signal_id, 'PMUS', 10, 5);
    RAISE EXCEPTION 'expected a duplicate (signal_id, venue, notional_tier_usd) paper position to violate UNIQUE';
  EXCEPTION
    WHEN unique_violation THEN NULL; -- expected
  END;

  INSERT INTO public.sports_shadow_settlements (signal_id, venue, notional_tier_usd)
  VALUES (v_signal_id, 'PMUS', 10);
  BEGIN
    INSERT INTO public.sports_shadow_settlements (signal_id, venue, notional_tier_usd)
    VALUES (v_signal_id, 'PMUS', 10);
    RAISE EXCEPTION 'expected a duplicate (signal_id, venue, notional_tier_usd) settlement to violate UNIQUE';
  EXCEPTION
    WHEN unique_violation THEN NULL; -- expected
  END;

  ------------------------------------------------------------------
  -- F. Alerts: only one UNRESOLVED alert per alert_key at a time; a resolved one does
  -- not block a fresh alert under the same key.
  ------------------------------------------------------------------
  INSERT INTO public.sports_shadow_alerts (alert_key, severity, message) VALUES ('venue_starvation:KALSHI', 'WARNING', 'first');
  BEGIN
    INSERT INTO public.sports_shadow_alerts (alert_key, severity, message) VALUES ('venue_starvation:KALSHI', 'WARNING', 'second');
    RAISE EXCEPTION 'expected a second UNRESOLVED alert under the same key to violate the partial unique index';
  EXCEPTION
    WHEN unique_violation THEN NULL; -- expected
  END;
  UPDATE public.sports_shadow_alerts SET resolved_at = now() WHERE alert_key = 'venue_starvation:KALSHI';
  INSERT INTO public.sports_shadow_alerts (alert_key, severity, message) VALUES ('venue_starvation:KALSHI', 'WARNING', 'third, after resolution');
  SELECT count(*) INTO v_count FROM public.sports_shadow_alerts WHERE alert_key = 'venue_starvation:KALSHI';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'expected exactly 2 total alert rows under this key (1 resolved + 1 fresh unresolved), got %', v_count;
  END IF;

  ------------------------------------------------------------------
  -- G. Venue capability: single row per venue, PMUS/KALSHI only.
  ------------------------------------------------------------------
  INSERT INTO public.sports_shadow_venue_capability (venue, discovery_available, orderbook_available)
  VALUES ('KALSHI', true, false)
  ON CONFLICT (venue) DO UPDATE SET orderbook_available = EXCLUDED.orderbook_available, checked_at = now();
  BEGIN
    INSERT INTO public.sports_shadow_venue_capability (venue) VALUES ('ESPN');
    RAISE EXCEPTION 'expected an invalid venue value to violate the CHECK constraint';
  EXCEPTION
    WHEN check_violation THEN NULL; -- expected
  END;

  RAISE NOTICE 'sports_shadow_final_build_schema.sql: all assertions passed';
END $$;

ROLLBACK;
