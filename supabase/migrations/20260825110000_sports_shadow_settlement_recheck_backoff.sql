-- CODEX P2-3: pending settlement rows can starve ready positions.
--
-- ROOT CAUSE: find_open_sports_shadow_paper_positions excluded terminal-settled rows
-- (CODEX P1-4) but treated every remaining PENDING/never-checked position as equally
-- eligible on every single call, oldest-decided-first. If the first LIMIT oldest
-- positions were all future games (genuinely still PENDING, nothing wrong), every
-- batch re-selected the SAME oldest positions forever -- a later position whose market
-- had already settled, sitting just past the LIMIT cutoff, could never be reached.
--
-- FIX: sports_shadow_settlements gains a durable due-time/backoff pair --
-- next_check_at (when this position becomes eligible again) and check_attempt_count
-- (how many times it has been checked and found still-PENDING, feeding an exponential
-- backoff computed in settlement.orchestrator.server.ts's own
-- computeNextSettlementCheckAtMs). find_open_sports_shadow_paper_positions now LEFT
-- JOINs settlements (rather than excluding via NOT EXISTS) so it can read this
-- due-time, and only selects rows that are actually due: next_check_at IS NULL (never
-- checked at all -- always due) OR next_check_at <= now(). Ordered by
-- COALESCE(next_check_at, decided_at) -- both are "the timestamp since which this row
-- has been ready," giving brand-new never-checked positions fair FIFO treatment
-- against genuinely-due rechecks without needing separate priority logic, then a
-- stable f.id tie-breaker.
ALTER TABLE public.sports_shadow_settlements
  ADD COLUMN IF NOT EXISTS next_check_at timestamptz,
  ADD COLUMN IF NOT EXISTS check_attempt_count integer NOT NULL DEFAULT 0;

DROP FUNCTION IF EXISTS public.find_open_sports_shadow_paper_positions(integer);

CREATE OR REPLACE FUNCTION public.find_open_sports_shadow_paper_positions(p_limit integer)
RETURNS TABLE (
  signal_id uuid,
  chosen_venue text,
  notional_tier_usd numeric,
  contracts numeric,
  all_in_cost_usd numeric,
  target_market_id text,
  selected_side text,
  check_attempt_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    f.signal_id, f.chosen_venue, f.notional_tier_usd, f.contracts, f.all_in_cost_usd, f.target_market_id, f.selected_side,
    COALESCE(s.check_attempt_count, 0) AS check_attempt_count
  FROM public.sports_shadow_paper_fills f
  LEFT JOIN public.sports_shadow_settlements s
    ON s.signal_id = f.signal_id AND s.venue = f.chosen_venue AND s.notional_tier_usd = f.notional_tier_usd
  WHERE f.side = 'ENTRY'
    AND f.fill_status IN ('FULL', 'PARTIAL')
    AND f.chosen_venue IS NOT NULL
    AND f.target_market_id IS NOT NULL
    AND f.selected_side IS NOT NULL
    AND f.all_in_cost_usd IS NOT NULL
    AND (s.settlement_status IS NULL OR s.settlement_status = 'PENDING')
    AND (s.next_check_at IS NULL OR s.next_check_at <= now())
  ORDER BY COALESCE(s.next_check_at, f.decided_at) ASC NULLS LAST, f.id ASC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.find_open_sports_shadow_paper_positions(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_open_sports_shadow_paper_positions(integer) TO service_role;
