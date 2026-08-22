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
  v_count integer;
BEGIN
  -- ---------- Fixture 1: a TERMINAL-settled position and an OPEN one ----------
  INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, identity_basis)
  VALUES ('p14-fill-terminal', '0xwallet', '0xasset', 'BUY', 'source_id')
  RETURNING id INTO v_fill_id;

  INSERT INTO public.sports_shadow_signals (
    episode_key, source_wallet, source_asset, first_fill_id, source_first_fill_at, source_last_fill_at,
    bet_type, selected_side
  ) VALUES (
    'p14-episode-terminal', '0xwallet', '0xasset', v_fill_id, now(), now(), 'MONEYLINE', 'TEAM:NYY:LONG'
  ) RETURNING id INTO v_signal_terminal;

  INSERT INTO public.sports_shadow_paper_fills (
    signal_id, requested_delay_ms, notional_tier_usd, decided_at, side, fill_status,
    contracts, all_in_cost_usd, chosen_venue, target_market_id, selected_side
  ) VALUES (
    v_signal_terminal, 0, 5, now(), 'ENTRY', 'FULL', 10, 5.10, 'PMUS', 'pmus-market-terminal', 'TEAM:NYY:LONG'
  );

  INSERT INTO public.sports_shadow_settlements (signal_id, venue, notional_tier_usd, settlement_status)
  VALUES (v_signal_terminal, 'PMUS', 5, 'SETTLED_WIN');

  INSERT INTO public.sports_shadow_source_fills (event_key, wallet, asset, side, identity_basis)
  VALUES ('p14-fill-open', '0xwallet', '0xasset', 'BUY', 'source_id')
  RETURNING id INTO v_fill_id;

  INSERT INTO public.sports_shadow_signals (
    episode_key, source_wallet, source_asset, first_fill_id, source_first_fill_at, source_last_fill_at,
    bet_type, selected_side
  ) VALUES (
    'p14-episode-open', '0xwallet', '0xasset', v_fill_id, now(), now(), 'MONEYLINE', 'TEAM:BOS:SHORT'
  ) RETURNING id INTO v_signal_open;

  INSERT INTO public.sports_shadow_paper_fills (
    signal_id, requested_delay_ms, notional_tier_usd, decided_at, side, fill_status,
    contracts, all_in_cost_usd, chosen_venue, target_market_id, selected_side
  ) VALUES (
    v_signal_open, 0, 5, now(), 'ENTRY', 'FULL', 10, 5.10, 'KALSHI', 'kalshi-market-open', 'YES'
  );

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
    bet_type, selected_side
  ) VALUES (
    'p14-episode-dual', '0xwallet', '0xasset', v_fill_id, now(), now(), 'MONEYLINE', 'TEAM:NYY:LONG'
  ) RETURNING id INTO v_signal_dual_match;

  INSERT INTO public.sports_market_matches (signal_id, venue, match_status, target_market_id, selected_side)
  VALUES
    (v_signal_dual_match, 'PMUS', 'EXACT', 'pmus-dual-market', 'TEAM:NYY:LONG'),
    (v_signal_dual_match, 'KALSHI', 'EXACT', 'kalshi-dual-market', 'YES');

  -- The routing decision chose KALSHI -- the paper_fill's OWN stored provenance must be
  -- Kalshi's market/side, never PM-US's (which is what an unfiltered signal_id-only join
  -- against sports_market_matches could have returned instead).
  INSERT INTO public.sports_shadow_paper_fills (
    signal_id, requested_delay_ms, notional_tier_usd, decided_at, side, fill_status,
    contracts, all_in_cost_usd, chosen_venue, target_market_id, selected_side
  ) VALUES (
    v_signal_dual_match, 0, 5, now(), 'ENTRY', 'FULL', 10, 5.10, 'KALSHI', 'kalshi-dual-market', 'YES'
  );

  IF NOT EXISTS (
    SELECT 1 FROM public.find_open_sports_shadow_paper_positions(100)
    WHERE signal_id = v_signal_dual_match
      AND chosen_venue = 'KALSHI'
      AND target_market_id = 'kalshi-dual-market'
      AND selected_side = 'YES'
  ) THEN
    RAISE EXCEPTION 'expected the dual-matched signal to settle against its ACTUAL chosen (Kalshi) target, not an ambiguous join result';
  END IF;

  RAISE NOTICE 'sports_shadow_open_positions regression passed';
END $$;

ROLLBACK;
