-- CODEX P1-4 (part 2): findOpenPositions selected every FULL/PARTIAL ENTRY paper fill
-- with a chosen_venue, with no exclusion for a position that ALREADY has a terminal
-- sports_shadow_settlements row -- a bounded batch could be entirely consumed by
-- already-settled positions on every single call, starving genuinely unsettled ones.
--
-- An RPC (rather than a client-side NOT EXISTS via PostgREST, which the JS query builder
-- cannot express directly) excludes any position whose settlement is already in a
-- TERMINAL state (anything other than PENDING) in one indexed round trip. Ordered
-- oldest-decided-first so a persistent backlog drains in order rather than resampling
-- the same page every call.
CREATE OR REPLACE FUNCTION public.find_open_sports_shadow_paper_positions(p_limit integer)
RETURNS TABLE (
  signal_id uuid,
  chosen_venue text,
  notional_tier_usd numeric,
  contracts numeric,
  all_in_cost_usd numeric,
  target_market_id text,
  selected_side text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT f.signal_id, f.chosen_venue, f.notional_tier_usd, f.contracts, f.all_in_cost_usd, f.target_market_id, f.selected_side
  FROM public.sports_shadow_paper_fills f
  WHERE f.side = 'ENTRY'
    AND f.fill_status IN ('FULL', 'PARTIAL')
    AND f.chosen_venue IS NOT NULL
    AND f.target_market_id IS NOT NULL
    AND f.selected_side IS NOT NULL
    AND f.all_in_cost_usd IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.sports_shadow_settlements s
      WHERE s.signal_id = f.signal_id
        AND s.venue = f.chosen_venue
        AND s.notional_tier_usd = f.notional_tier_usd
        AND s.settlement_status <> 'PENDING'
    )
  ORDER BY f.decided_at ASC NULLS LAST, f.id ASC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.find_open_sports_shadow_paper_positions(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_open_sports_shadow_paper_positions(integer) TO service_role;
