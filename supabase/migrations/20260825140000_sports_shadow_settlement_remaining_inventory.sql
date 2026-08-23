-- CODEX P1-3 follow-up: find_open_sports_shadow_paper_positions previously read
-- `contracts`/`all_in_cost_usd` directly off the ENTRY paper_fill row -- correct back
-- when ENTRY was the only lifecycle action that ever existed, but now that ADD/EXIT are
-- implemented, an ENTRY row is a FROZEN snapshot of the position's ORIGINAL size,
-- completely blind to any ADD/EXIT activity since. Settlement was computing P&L
-- against the position's INITIAL inventory, not its CURRENT remaining inventory --
-- exactly the "settlement should settle only remaining open inventory" requirement.
--
-- FIX: sources contracts/cost-basis from sports_shadow_paper_positions (the durable,
-- continuously-maintained CURRENT state -- see 20260825120000's own
-- remaining_cost_basis_usd doc comment) instead of the static ENTRY fill row.
-- target_market_id/selected_side are still joined from the ENTRY fill (those never
-- change across ADD/EXIT -- fixed at ENTRY time, the position table has no need to
-- duplicate them). Driven by sports_shadow_paper_positions.status = 'OPEN'
-- (maintained by both the ENTRY-open and EXIT-close paths) rather than re-deriving
-- "open" from the fill row's own fill_status.
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
    p.signal_id, p.venue AS chosen_venue, p.notional_tier_usd,
    p.contracts_open AS contracts, p.remaining_cost_basis_usd AS all_in_cost_usd,
    f.target_market_id, f.selected_side,
    COALESCE(s.check_attempt_count, 0) AS check_attempt_count
  FROM public.sports_shadow_paper_positions p
  JOIN public.sports_shadow_paper_fills f
    ON f.signal_id = p.signal_id AND f.chosen_venue = p.venue AND f.notional_tier_usd = p.notional_tier_usd
    AND f.side = 'ENTRY' AND f.trigger_source_fill_id IS NULL
  LEFT JOIN public.sports_shadow_settlements s
    ON s.signal_id = p.signal_id AND s.venue = p.venue AND s.notional_tier_usd = p.notional_tier_usd
  WHERE p.status = 'OPEN'
    AND p.contracts_open > 0
    AND f.target_market_id IS NOT NULL
    AND f.selected_side IS NOT NULL
    AND (s.settlement_status IS NULL OR s.settlement_status = 'PENDING')
    AND (s.next_check_at IS NULL OR s.next_check_at <= now())
  ORDER BY COALESCE(s.next_check_at, p.updated_at) ASC NULLS LAST, p.id ASC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.find_open_sports_shadow_paper_positions(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_open_sports_shadow_paper_positions(integer) TO service_role;
