-- CODEX P1-2 / P1-4 / P2-3: paper routing is observation-keyed (first callback wins),
-- settlement can bind the wrong venue match, paper fills miss epoch/source provenance.
--
-- ROOT CAUSE (P1-2): sports_shadow_paper_fills was keyed UNIQUE(observation_id,
-- notional_tier_usd) -- i.e. per PHYSICAL quote-capture event, not per LOGICAL routing
-- opportunity (signal_id, requested_delay_ms, notional_tier_usd). If PM-US's +0
-- observation completed first, computePaperFillsForObservation ran immediately and
-- persisted a PM-US-only-informed row keyed by PM-US's own observation_id. When Kalshi's
-- +0 observation completed afterward, the SAME function ran again and persisted a SECOND,
-- independent row keyed by Kalshi's own observation_id -- two rows for what should be
-- exactly one routing decision, with no uniqueness constraint preventing it and no
-- record of which one a downstream DISTINCT ON query would keep.
--
-- ROOT CAUSE (P1-4): findOpenPositions joined sports_market_matches by signal_id alone
-- (no venue filter) to recover target_market_id/selected_side for settlement -- a signal
-- with BOTH a PM-US and a Kalshi match row could bind the WRONG venue's target/side to
-- settlement. sports_shadow_paper_fills also never excluded already-terminal-settled
-- positions from findOpenPositions's own selection, so a bounded batch could be entirely
-- consumed by rows that already have a terminal sports_shadow_settlements row, starving
-- genuinely unsettled positions.
--
-- ROOT CAUSE (P2-3): source_fill_id/experiment_epoch_id existed as nullable columns on
-- sports_shadow_paper_fills but were never populated at insertion -- epoch-scoped
-- counters silently under-counted paper activity.
--
-- FIX: sports_shadow_paper_fills becomes keyed by the LOGICAL routing opportunity
-- (signal_id, requested_delay_ms, notional_tier_usd), with BOTH venues' observation ids
-- recorded as provenance (populated independently, whichever arrives) and an explicit
-- decided_at/cutoff_reason pair proving exactly ONE terminal decision was ever made, no
-- matter which venue's observation completed first. Direct target_market_id/
-- selected_side provenance is persisted on the row itself (chosen at decision time, from
-- the ACTUAL chosen venue's own match row) so settlement never needs to re-derive it via
-- an ambiguous join. source_fill_id/experiment_epoch_id are populated at decision time.
--
-- Production currently has ZERO rows in sports_shadow_paper_fills (paper execution has
-- never run against a fixed go-live epoch) -- this migration is schema-only, no backfill
-- required.
ALTER TABLE public.sports_shadow_paper_fills
  DROP CONSTRAINT IF EXISTS sports_shadow_paper_fills_observation_id_notional_tier_usd_key;

ALTER TABLE public.sports_shadow_paper_fills
  ADD COLUMN IF NOT EXISTS requested_delay_ms integer,
  ADD COLUMN IF NOT EXISTS pmus_observation_id uuid REFERENCES public.sports_quote_observations(id),
  ADD COLUMN IF NOT EXISTS kalshi_observation_id uuid REFERENCES public.sports_quote_observations(id),
  ADD COLUMN IF NOT EXISTS fire_at timestamptz,
  ADD COLUMN IF NOT EXISTS decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS cutoff_reason text,
  ADD COLUMN IF NOT EXISTS target_market_id text,
  ADD COLUMN IF NOT EXISTS selected_side text;

ALTER TABLE public.sports_shadow_paper_fills
  ADD CONSTRAINT sports_shadow_paper_fills_cutoff_reason_check
    CHECK (cutoff_reason IS NULL OR cutoff_reason IN ('BOTH_COMPLETE', 'CUTOFF_EXPIRED'));

-- The old per-observation column is superseded by pmus_observation_id/kalshi_observation_id
-- above -- dropped rather than kept alongside, since zero rows exist to migrate and a
-- lingering ambiguous "which observation" column would only invite the exact bug this
-- migration fixes.
ALTER TABLE public.sports_shadow_paper_fills DROP COLUMN IF EXISTS observation_id;

-- Decision-time fields are meaningful only once decided_at IS NOT NULL -- a provenance-
-- only row (one venue's observation recorded, still awaiting the other or the cutoff)
-- has no fill_status/side/contracts yet.
ALTER TABLE public.sports_shadow_paper_fills ALTER COLUMN side DROP NOT NULL;
ALTER TABLE public.sports_shadow_paper_fills ALTER COLUMN fill_status DROP NOT NULL;
ALTER TABLE public.sports_shadow_paper_fills ALTER COLUMN routing_timestamp DROP NOT NULL;
ALTER TABLE public.sports_shadow_paper_fills ALTER COLUMN requested_delay_ms SET NOT NULL;

ALTER TABLE public.sports_shadow_paper_fills
  ADD CONSTRAINT sports_shadow_paper_fills_logical_key UNIQUE (signal_id, requested_delay_ms, notional_tier_usd);

-- Bounded periodic sweep support: "no later +5/+10 quote can alter a +0 decision" is
-- enforced by decided_at itself, but a routing opportunity where only ONE venue was ever
-- schedulable (the common case: most signals are not EXACT-matched on both venues) would
-- otherwise wait for a sibling observation that will never arrive. The sweep finds rows
-- past their cutoff window and finalizes them with whatever provenance is already known.
CREATE INDEX IF NOT EXISTS sports_shadow_paper_fills_pending_cutoff_idx
  ON public.sports_shadow_paper_fills (fire_at)
  WHERE decided_at IS NULL;

-- Step 1: record ONE venue's observation as provenance for a (signal, delay, tier)
-- routing opportunity, creating the row on first arrival. Never decides anything by
-- itself -- the caller reads back pmus_observation_id/kalshi_observation_id/decided_at
-- and applies the cutoff policy in application code (paper.server.ts), then calls
-- finalize_sports_shadow_routing_decision below.
CREATE OR REPLACE FUNCTION public.record_sports_shadow_routing_provenance(
  p_signal_id uuid,
  p_requested_delay_ms integer,
  p_notional_tier_usd numeric,
  p_venue text,
  p_observation_id uuid,
  p_fire_at timestamptz
) RETURNS TABLE (pmus_observation_id uuid, kalshi_observation_id uuid, decided_at timestamptz, fire_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'record_sports_shadow_routing_provenance: service_role required, got %', auth.role()
      USING ERRCODE = '42501';
  END IF;
  IF p_venue NOT IN ('PMUS', 'KALSHI') THEN
    RAISE EXCEPTION 'record_sports_shadow_routing_provenance: invalid venue %', p_venue;
  END IF;

  INSERT INTO public.sports_shadow_paper_fills (
    signal_id, requested_delay_ms, notional_tier_usd, fire_at,
    pmus_observation_id, kalshi_observation_id
  )
  VALUES (
    p_signal_id, p_requested_delay_ms, p_notional_tier_usd, p_fire_at,
    CASE WHEN p_venue = 'PMUS' THEN p_observation_id ELSE NULL END,
    CASE WHEN p_venue = 'KALSHI' THEN p_observation_id ELSE NULL END
  )
  ON CONFLICT (signal_id, requested_delay_ms, notional_tier_usd) DO UPDATE SET
    pmus_observation_id = COALESCE(public.sports_shadow_paper_fills.pmus_observation_id, EXCLUDED.pmus_observation_id),
    kalshi_observation_id = COALESCE(public.sports_shadow_paper_fills.kalshi_observation_id, EXCLUDED.kalshi_observation_id);

  RETURN QUERY
    SELECT f.pmus_observation_id, f.kalshi_observation_id, f.decided_at, f.fire_at
    FROM public.sports_shadow_paper_fills f
    WHERE f.signal_id = p_signal_id AND f.requested_delay_ms = p_requested_delay_ms AND f.notional_tier_usd = p_notional_tier_usd;
END;
$$;

REVOKE ALL ON FUNCTION public.record_sports_shadow_routing_provenance(uuid, integer, numeric, text, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_sports_shadow_routing_provenance(uuid, integer, numeric, text, uuid, timestamptz) TO service_role;

-- Step 2: atomically finalize a routing decision -- returns true only when THIS call
-- actually won (decided_at was NULL beforehand), false if some other concurrent/earlier
-- call already decided it. This is the sole mechanism that ever sets decided_at, and the
-- WHERE decided_at IS NULL guard is what makes "no later quote can alter a +0 decision"
-- an enforced DB invariant, not merely an application-level convention -- safe under the
-- two venues' observation lanes running concurrently (Promise.all in worker.server.ts).
CREATE OR REPLACE FUNCTION public.finalize_sports_shadow_routing_decision(
  p_signal_id uuid,
  p_requested_delay_ms integer,
  p_notional_tier_usd numeric,
  p_decided_at timestamptz,
  p_cutoff_reason text,
  p_chosen_venue text,
  p_fill_status text,
  p_contracts numeric,
  p_vwap numeric,
  p_fee_usd numeric,
  p_fee_model_version text,
  p_fee_valid boolean,
  p_all_in_cost_usd numeric,
  p_reject_reason text,
  p_pmus_result jsonb,
  p_kalshi_result jsonb,
  p_target_market_id text,
  p_selected_side text,
  p_side text,
  p_source_fill_id uuid,
  p_experiment_epoch_id uuid
) RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'finalize_sports_shadow_routing_decision: service_role required, got %', auth.role()
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.sports_shadow_paper_fills SET
    decided_at = p_decided_at,
    cutoff_reason = p_cutoff_reason,
    chosen_venue = p_chosen_venue,
    fill_status = p_fill_status,
    contracts = p_contracts,
    vwap = p_vwap,
    fee_usd = p_fee_usd,
    fee_model_version = p_fee_model_version,
    fee_valid = p_fee_valid,
    all_in_cost_usd = p_all_in_cost_usd,
    reject_reason = p_reject_reason,
    pmus_result = p_pmus_result,
    kalshi_result = p_kalshi_result,
    target_market_id = p_target_market_id,
    selected_side = p_selected_side,
    side = p_side,
    source_fill_id = p_source_fill_id,
    experiment_epoch_id = p_experiment_epoch_id,
    routing_timestamp = p_decided_at
  WHERE signal_id = p_signal_id
    AND requested_delay_ms = p_requested_delay_ms
    AND notional_tier_usd = p_notional_tier_usd
    AND decided_at IS NULL;

  IF FOUND AND p_side = 'ENTRY' AND p_chosen_venue IS NOT NULL AND p_fill_status IN ('FULL', 'PARTIAL') THEN
    -- CODEX P1-7 (scoped foundation): sports_shadow_paper_positions previously existed
    -- but was never populated anywhere -- follower inventory tracking was entirely dead
    -- schema. An ENTRY decision now durably opens the position it actually executed, in
    -- the SAME transaction as the routing decision itself (atomic -- a decision can never
    -- commit without its corresponding position, or vice versa). ADD/EXIT reacting to
    -- source DCA/partial-sell/full-sell is the natural next step once this foundation
    -- exists, but is explicitly NOT implemented by this migration/RPC -- see the
    -- accompanying report for the exact boundary of what this pass delivers.
    INSERT INTO public.sports_shadow_paper_positions (signal_id, venue, notional_tier_usd, contracts_open, avg_entry_price, status)
    VALUES (p_signal_id, p_chosen_venue, p_notional_tier_usd, p_contracts, p_vwap, 'OPEN')
    ON CONFLICT (signal_id, venue, notional_tier_usd) DO UPDATE SET
      contracts_open = EXCLUDED.contracts_open,
      avg_entry_price = EXCLUDED.avg_entry_price,
      status = 'OPEN',
      updated_at = now();
  END IF;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_sports_shadow_routing_decision(
  uuid, integer, numeric, timestamptz, text, text, text, numeric, numeric, numeric, text, boolean, numeric, text, jsonb, jsonb, text, text, text, uuid, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_sports_shadow_routing_decision(
  uuid, integer, numeric, timestamptz, text, text, text, numeric, numeric, numeric, text, boolean, numeric, text, jsonb, jsonb, text, text, text, uuid, uuid
) TO service_role;
