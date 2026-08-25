-- CODEX P1-4 regression: find_open_sports_shadow_paper_positions must (a) exclude a
-- position whose settlement is already TERMINAL, so a bounded batch cannot be starved by
-- already-settled rows forever, and (b) return the target_market_id/selected_side
-- persisted DIRECTLY on the paper_fill row (chosen-venue-specific), never a value
-- ambiguously joined from sports_market_matches, which can hold TWO rows (one per venue)
-- for the same signal. Rolls back all test data.
BEGIN;

DO $$
DECLARE
  v_fill_id uuid;
  v_signal_terminal uuid;
  v_signal_open uuid;
  v_signal_dual_match uuid;
  v_epoch_id uuid;
  v_count integer;
BEGIN
  INSERT INTO public.sports_shadow_experiment_epochs (
    go_live_at, wallet_cohort, git_sha, config_hash, classifier_version, episode_version,
    resolver_version, router_version, pmus_fee_model_version, kalshi_fee_model_version,
    execution_simulator_version, settlement_version, is_current
  ) VALUES (
    now(), ARRAY['0xwallet'], '1111111111111111111111111111111111111111', 'open-positions-test-epoch',
    'c1', 'e1', 'r1', 'rt1', 'pf1', 'kf1', 'x1', 's1', false
  ) RETURNING id INTO v_epoch_id;

  -- ---------- Fixture 1: a TERMINAL-settled position and an OPEN one ----------
  INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, identity_basis)
  VALUES ('p14-fill-terminal', '0xwallet', '0xasset', 'BUY', 'source_id')
  RETURNING id INTO v_fill_id;

  INSERT INTO public.sports_shadow_signals (
    episode_key, source_wallet, source_asset, first_fill_id, source_first_fill_at, source_last_fill_at,
    bet_type, selected_side, experiment_epoch_id
  ) VALUES (
    'p14-episode-terminal', '0xwallet', '0xasset', v_fill_id, now(), now(), 'MONEYLINE', 'TEAM:NYY:LONG', v_epoch_id
  ) RETURNING id INTO v_signal_terminal;

  INSERT INTO public.sports_shadow_paper_fills (
    signal_id, requested_delay_ms, notional_tier_usd, decided_at, side, fill_status,
    contracts, all_in_cost_usd, chosen_venue, target_market_id, selected_side, experiment_epoch_id
  ) VALUES (
    v_signal_terminal, 0, 5, now(), 'ENTRY', 'FULL', 10, 5.10, 'PMUS', 'pmus-market-terminal', 'TEAM:NYY:LONG', v_epoch_id
  );
  -- CODEX P1-3: find_open_sports_shadow_paper_positions now sources contracts/cost-basis
  -- from sports_shadow_paper_positions (the CURRENT remaining inventory), not the frozen
  -- ENTRY fill row -- every fixture from here on needs its own position row too.
  INSERT INTO public.sports_shadow_paper_positions (signal_id, venue, notional_tier_usd, contracts_open, avg_entry_price, remaining_cost_basis_usd, status)
  VALUES (v_signal_terminal, 'PMUS', 5, 10, 0.5, 5.10, 'OPEN');

  INSERT INTO public.sports_shadow_settlements (signal_id, venue, notional_tier_usd, settlement_status)
  VALUES (v_signal_terminal, 'PMUS', 5, 'SETTLED_WIN');

  INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, identity_basis)
  VALUES ('p14-fill-open', '0xwallet', '0xasset', 'BUY', 'source_id')
  RETURNING id INTO v_fill_id;

  INSERT INTO public.sports_shadow_signals (
    episode_key, source_wallet, source_asset, first_fill_id, source_first_fill_at, source_last_fill_at,
    bet_type, selected_side, experiment_epoch_id
  ) VALUES (
    'p14-episode-open', '0xwallet', '0xasset', v_fill_id, now(), now(), 'MONEYLINE', 'TEAM:BOS:SHORT', v_epoch_id
  ) RETURNING id INTO v_signal_open;

  INSERT INTO public.sports_shadow_paper_fills (
    signal_id, requested_delay_ms, notional_tier_usd, decided_at, side, fill_status,
    contracts, all_in_cost_usd, chosen_venue, target_market_id, selected_side, experiment_epoch_id
  ) VALUES (
    v_signal_open, 0, 5, now(), 'ENTRY', 'FULL', 10, 5.10, 'KALSHI', 'kalshi-market-open', 'YES', v_epoch_id
  );
  INSERT INTO public.sports_shadow_paper_positions (signal_id, venue, notional_tier_usd, contracts_open, avg_entry_price, remaining_cost_basis_usd, status)
  VALUES (v_signal_open, 'KALSHI', 5, 10, 0.5, 5.10, 'OPEN');

  -- A batch limited to 1 must return the OPEN position, never the terminal-settled one.
  SELECT count(*) INTO v_count
  FROM public.find_open_sports_shadow_paper_positions(1)
  WHERE signal_id = v_signal_open;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expected the OPEN position to be selectable even with limit=1, got %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.find_open_sports_shadow_paper_positions(100)
  WHERE signal_id = v_signal_terminal;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'expected the TERMINAL-settled position to be excluded entirely, got %', v_count;
  END IF;

  -- ---------- Fixture 2: a signal EXACT-matched on BOTH venues, with DIFFERENT target ----------
  -- markets per venue -- proves the RPC returns the CHOSEN venue's own stored provenance,
  -- never a value that could have been ambiguously joined from the OTHER venue's match row.
  INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, identity_basis)
  VALUES ('p14-fill-dual', '0xwallet', '0xasset', 'BUY', 'source_id')
  RETURNING id INTO v_fill_id;

  INSERT INTO public.sports_shadow_signals (
    episode_key, source_wallet, source_asset, first_fill_id, source_first_fill_at, source_last_fill_at,
    bet_type, selected_side, experiment_epoch_id
  ) VALUES (
    'p14-episode-dual', '0xwallet', '0xasset', v_fill_id, now(), now(), 'MONEYLINE', 'TEAM:NYY:LONG', v_epoch_id
  ) RETURNING id INTO v_signal_dual_match;

  INSERT INTO public.sports_market_matches (signal_id, venue, match_status, first_match_status, target_market_id, selected_side)
  VALUES
    (v_signal_dual_match, 'PMUS', 'EXACT', 'EXACT', 'pmus-dual-market', 'TEAM:NYY:LONG'),
    (v_signal_dual_match, 'KALSHI', 'EXACT', 'EXACT', 'kalshi-dual-market', 'YES');

  -- The routing decision chose KALSHI -- the paper_fill's OWN stored provenance must be
  -- Kalshi's market/side, never PM-US's (which is what an unfiltered signal_id-only join
  -- against sports_market_matches could have returned instead).
  INSERT INTO public.sports_shadow_paper_fills (
    signal_id, requested_delay_ms, notional_tier_usd, decided_at, side, fill_status,
    contracts, all_in_cost_usd, chosen_venue, target_market_id, selected_side, experiment_epoch_id
  ) VALUES (
    v_signal_dual_match, 0, 5, now(), 'ENTRY', 'FULL', 10, 5.10, 'KALSHI', 'kalshi-dual-market', 'YES', v_epoch_id
  );
  INSERT INTO public.sports_shadow_paper_positions (signal_id, venue, notional_tier_usd, contracts_open, avg_entry_price, remaining_cost_basis_usd, status)
  VALUES (v_signal_dual_match, 'KALSHI', 5, 10, 0.5, 5.10, 'OPEN');

  IF NOT EXISTS (
    SELECT 1 FROM public.find_open_sports_shadow_paper_positions(100)
    WHERE signal_id = v_signal_dual_match
      AND chosen_venue = 'KALSHI'
      AND target_market_id = 'kalshi-dual-market'
      AND selected_side = 'YES'
  ) THEN
    RAISE EXCEPTION 'expected the dual-matched signal to settle against its ACTUAL chosen (Kalshi) target, not an ambiguous join result';
  END IF;

  ------------------------------------------------------------------
  -- CODEX P2-3 REQUIRED TEST: pending settlement rows can starve ready positions.
  -- Seed 50 recently-checked PENDING positions (next_check_at far in the future, not yet
  -- due) plus 1 later-created position that IS ready to settle (no settlement row at
  -- all, i.e. never checked -- always due). The ready position must be selectable even
  -- with a batch LIMIT far smaller than 51, and the 50 not-yet-due rows must be
  -- EXCLUDED entirely (not merely lower priority) until their own next_check_at arrives.
  ------------------------------------------------------------------
  DECLARE
    v_signal_ready uuid;
    v_not_due_count integer;
    v_ready_found boolean;
    v_persisted_attempt_count integer;
    v_persisted_next_check_at timestamptz;
  BEGIN
    FOR i IN 1..50 LOOP
      DECLARE
        v_fill_not_due uuid;
        v_signal_not_due uuid;
      BEGIN
        INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, identity_basis)
        VALUES ('p23-fill-notdue-' || i, '0xwallet', '0xasset', 'BUY', 'source_id')
        RETURNING id INTO v_fill_not_due;

        INSERT INTO public.sports_shadow_signals (
          episode_key, source_wallet, source_asset, first_fill_id, source_first_fill_at, source_last_fill_at,
          bet_type, selected_side, created_at, experiment_epoch_id
        ) VALUES (
          'p23-episode-notdue-' || i, '0xwallet', '0xasset', v_fill_not_due, now(), now(), 'MONEYLINE', 'TEAM:NYY:LONG',
          now() - interval '1 day', -- OLDER than the ready position below -- would win a pure oldest-decided-first ordering
          v_epoch_id
        ) RETURNING id INTO v_signal_not_due;

        INSERT INTO public.sports_shadow_paper_fills (
          signal_id, requested_delay_ms, notional_tier_usd, decided_at, side, fill_status,
          contracts, all_in_cost_usd, chosen_venue, target_market_id, selected_side, experiment_epoch_id
        ) VALUES (
          v_signal_not_due, 0, 5, now() - interval '1 day', 'ENTRY', 'FULL', 10, 5.10, 'PMUS', 'pmus-market-notdue-' || i, 'TEAM:NYY:LONG', v_epoch_id
        );
        INSERT INTO public.sports_shadow_paper_positions (signal_id, venue, notional_tier_usd, contracts_open, avg_entry_price, remaining_cost_basis_usd, status)
        VALUES (v_signal_not_due, 'PMUS', 5, 10, 0.5, 5.10, 'OPEN');

        -- Recently checked, still PENDING, next check far in the future -- NOT due.
        INSERT INTO public.sports_shadow_settlements (signal_id, venue, notional_tier_usd, settlement_status, next_check_at, check_attempt_count)
        VALUES (v_signal_not_due, 'PMUS', 5, 'PENDING', now() + interval '1 hour', 3);
      END;
    END LOOP;

    -- The ready position: created AFTER all 50 not-due rows, but has NO settlement row
    -- at all (never checked) -- always due immediately, regardless of creation order.
    INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, identity_basis)
    VALUES ('p23-fill-ready', '0xwallet', '0xasset', 'BUY', 'source_id')
    RETURNING id INTO v_fill_id;

    INSERT INTO public.sports_shadow_signals (
      episode_key, source_wallet, source_asset, first_fill_id, source_first_fill_at, source_last_fill_at,
      bet_type, selected_side, experiment_epoch_id
    ) VALUES (
      'p23-episode-ready', '0xwallet', '0xasset', v_fill_id, now(), now(), 'MONEYLINE', 'TEAM:BOS:SHORT', v_epoch_id
    ) RETURNING id INTO v_signal_ready;

    INSERT INTO public.sports_shadow_paper_fills (
      signal_id, requested_delay_ms, notional_tier_usd, decided_at, side, fill_status,
      contracts, all_in_cost_usd, chosen_venue, target_market_id, selected_side, experiment_epoch_id
    ) VALUES (
      v_signal_ready, 0, 5, now(), 'ENTRY', 'FULL', 10, 5.10, 'KALSHI', 'kalshi-market-ready', 'YES', v_epoch_id
    );
    INSERT INTO public.sports_shadow_paper_positions (signal_id, venue, notional_tier_usd, contracts_open, avg_entry_price, remaining_cost_basis_usd, status)
    VALUES (v_signal_ready, 'KALSHI', 5, 10, 0.5, 5.10, 'OPEN');

    -- A batch limited to 10 (far fewer than the 50 not-due rows) must still surface the
    -- ready position -- it is not competing with them at all, since they are excluded
    -- entirely by the due-time filter, not merely deprioritized.
    SELECT EXISTS (
      SELECT 1 FROM public.find_open_sports_shadow_paper_positions(10) WHERE signal_id = v_signal_ready
    ) INTO v_ready_found;
    IF NOT v_ready_found THEN
      RAISE EXCEPTION 'expected the ready position to be selectable within a small batch despite 50 older not-due PENDING rows existing';
    END IF;

    SELECT count(*) INTO v_not_due_count
    FROM public.find_open_sports_shadow_paper_positions(1000)
    WHERE target_market_id LIKE 'pmus-market-notdue-%';
    IF v_not_due_count <> 0 THEN
      RAISE EXCEPTION 'expected all 50 not-yet-due PENDING rows to be excluded entirely, got % selectable', v_not_due_count;
    END IF;

    -- Restart persistence: simulate runSettlementBatch's own post-check upsert (a real
    -- check found this position still PENDING) and confirm a FRESH read (a new
    -- transaction/process would see exactly this) recovers the same due-time/attempt
    -- state -- durable, not merely in-memory.
    INSERT INTO public.sports_shadow_settlements (signal_id, venue, notional_tier_usd, settlement_status, next_check_at, check_attempt_count)
    VALUES (v_signal_ready, 'KALSHI', 5, 'PENDING', now() + interval '10 minutes', 1)
    ON CONFLICT (signal_id, venue, notional_tier_usd) DO UPDATE SET
      next_check_at = EXCLUDED.next_check_at,
      check_attempt_count = EXCLUDED.check_attempt_count;

    SELECT next_check_at, check_attempt_count INTO v_persisted_next_check_at, v_persisted_attempt_count
    FROM public.sports_shadow_settlements
    WHERE signal_id = v_signal_ready AND venue = 'KALSHI' AND notional_tier_usd = 5;
    IF v_persisted_attempt_count <> 1 OR v_persisted_next_check_at IS NULL OR v_persisted_next_check_at <= now() THEN
      RAISE EXCEPTION 'expected the backoff state to persist durably (attempt_count=1, next_check_at in the future), got attempt_count=% next_check_at=%', v_persisted_attempt_count, v_persisted_next_check_at;
    END IF;

    -- And now correctly excluded until that persisted next_check_at arrives.
    IF EXISTS (SELECT 1 FROM public.find_open_sports_shadow_paper_positions(1000) WHERE signal_id = v_signal_ready) THEN
      RAISE EXCEPTION 'expected the ready position to become NOT due after its own backoff was persisted';
    END IF;
  END;

  RAISE NOTICE 'sports_shadow_open_positions regression passed';
END $$;

ROLLBACK;
