-- CODEX P1-3: follower paper lifecycle is ENTRY-only.
--
-- ROOT CAUSE: paper.server.ts hardcoded side='ENTRY' for every routing decision;
-- episode.ts's own AGGREGATED_BUY/LATE_RECONCILIATION (a source DCA buy) and
-- SELL_RECORDED-against-an-open-episode (a source partial/full sell) decisions never
-- triggered ANY follower reaction at all -- the paper simulator only ever bought the
-- source's FIRST entry and held to resolution, never following the source's own actual
-- trade lifecycle.
--
-- FIX: a new durable "lifecycle trigger" record (one per source fill requiring a
-- follower reaction) plus a new observation-scheduling identity
-- (trigger_source_fill_id) so a SEPARATE 5-tier quote-capture burst can be scheduled
-- for the SAME signal at the moment of a DCA buy or a partial/full sell, entirely
-- independent of the original ENTRY burst's own rows. Unlike ENTRY (which races BOTH
-- venues via the two-step provenance/finalize protocol, since the FIRST entry may
-- choose either venue), an ADD/EXIT is always scoped to whichever SINGLE venue the
-- follower's position is ALREADY open in -- there is no second venue to race, so a
-- lifecycle decision is made directly, once its own single observation is captured.
--
-- sports_shadow_paper_fills.side already supports 'ADD'/'EXIT' (CHECK constraint from
-- the original FINAL BUILD schema) -- this migration is what finally populates them.

CREATE TABLE public.sports_shadow_lifecycle_triggers (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  signal_id uuid NOT NULL REFERENCES public.sports_shadow_signals(id),
  source_fill_id uuid NOT NULL REFERENCES public.sports_shadow_source_fills(id),
  trigger_type text NOT NULL CHECK (trigger_type IN ('ADD', 'EXIT')),
  -- ADD: the source's own DCA shares this fill added. EXIT: the TRACKED portion of
  -- shares this sell fill reduced (episode.ts's own trackedShares, never untracked
  -- oversell -- see episode.ts's own P1-3 doc comment for that distinction).
  tracked_shares numeric NOT NULL CHECK (tracked_shares > 0),
  -- EXIT only: what fraction of the follower's OWN remaining tracked inventory (at
  -- each open tier independently) this sell represents -- 1.0 exactly for a full
  -- exit. NULL for ADD (sizing is the SAME frozen fixed-notional methodology ENTRY
  -- already uses, never proportional to the source's own DCA size).
  exit_fraction numeric CHECK (exit_fraction IS NULL OR (exit_fraction > 0 AND exit_fraction <= 1)),
  price numeric NOT NULL,
  source_ts bigint NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  -- One trigger per source fill -- idempotent-safe re-processing of an
  -- already-recorded lifecycle event (a crashed/retried poll finds this row already
  -- exists rather than creating a duplicate reaction to the identical fill).
  UNIQUE (source_fill_id),
  CONSTRAINT sports_shadow_lifecycle_triggers_type_fraction_check
    CHECK ((trigger_type = 'ADD' AND exit_fraction IS NULL) OR (trigger_type = 'EXIT' AND exit_fraction IS NOT NULL))
);
CREATE INDEX sports_shadow_lifecycle_triggers_signal_idx ON public.sports_shadow_lifecycle_triggers (signal_id);
GRANT ALL ON public.sports_shadow_lifecycle_triggers TO service_role;
ALTER TABLE public.sports_shadow_lifecycle_triggers ENABLE ROW LEVEL SECURITY;

-- sports_quote_observations: trigger_source_fill_id links a lifecycle-reaction
-- observation plan to the fill that caused it; NULL = the original ENTRY plan.
ALTER TABLE public.sports_quote_observations
  ADD COLUMN IF NOT EXISTS trigger_source_fill_id uuid REFERENCES public.sports_shadow_lifecycle_triggers(id);

-- The ORIGINAL 3-column UNIQUE(signal_id, venue, requested_delay_ms) constraint was
-- declared inline in the phase-1 CREATE TABLE (auto-generated name, never explicitly
-- named) -- looked up dynamically by its column membership rather than guessing the
-- generated name, since a wrong guess would silently no-op and leave a stale
-- constraint that rejects every lifecycle-reaction row.
DO $$
DECLARE
  v_conname text;
  v_expected smallint[];
BEGIN
  SELECT array_agg(attnum) INTO v_expected
  FROM pg_attribute
  WHERE attrelid = 'public.sports_quote_observations'::regclass
    AND attname IN ('signal_id', 'venue', 'requested_delay_ms');

  SELECT conname INTO v_conname
  FROM pg_constraint
  WHERE conrelid = 'public.sports_quote_observations'::regclass
    AND contype = 'u'
    AND conkey::int[] <@ v_expected::int[]
    AND v_expected::int[] <@ conkey::int[];

  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.sports_quote_observations DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

-- CODEX P1-3: `NULLS NOT DISTINCT` (Postgres 15+) treats every NULL
-- trigger_source_fill_id as equal for uniqueness purposes -- ONE ordinary
-- (non-partial) 4-column constraint now correctly enforces BOTH "one ENTRY-plan row
-- per (signal, venue, delay)" (trigger_source_fill_id NULL) AND "one lifecycle-plan
-- row per (signal, venue, delay, trigger)" (trigger_source_fill_id set) -- avoiding a
-- partial-index design that supabase-js's .upsert()/on_conflict column-list syntax
-- cannot target (Postgres only infers a partial unique index as an ON CONFLICT
-- arbiter when the conflict clause ALSO repeats its WHERE predicate, which PostgREST's
-- upsert has no way to express).
ALTER TABLE public.sports_quote_observations
  ADD CONSTRAINT sports_quote_observations_logical_key
  UNIQUE NULLS NOT DISTINCT (signal_id, venue, requested_delay_ms, trigger_source_fill_id);

-- sports_shadow_paper_fills: same trigger_source_fill_id + NULLS NOT DISTINCT pattern.
ALTER TABLE public.sports_shadow_paper_fills
  ADD COLUMN IF NOT EXISTS trigger_source_fill_id uuid REFERENCES public.sports_shadow_lifecycle_triggers(id);

ALTER TABLE public.sports_shadow_paper_fills
  DROP CONSTRAINT IF EXISTS sports_shadow_paper_fills_logical_key;

ALTER TABLE public.sports_shadow_paper_fills
  ADD CONSTRAINT sports_shadow_paper_fills_logical_key
  UNIQUE NULLS NOT DISTINCT (signal_id, requested_delay_ms, notional_tier_usd, trigger_source_fill_id);

-- sports_shadow_paper_positions: durable per-tier follower lifecycle state.
-- contracts_open/avg_entry_price/realized_pnl_usd/status already existed (populated
-- only for ENTRY until this migration); the columns below are new.
ALTER TABLE public.sports_shadow_paper_positions
  ADD COLUMN IF NOT EXISTS contracts_added numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS contracts_exited numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS add_cost_usd numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS exit_proceeds_usd numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_fees_usd numeric NOT NULL DEFAULT 0,
  -- The FEE-INCLUSIVE cost basis of currently-OPEN inventory only -- distinct from
  -- avg_entry_price (a per-contract price only, not fee-inclusive): ENTRY sets it to
  -- p_all_in_cost_usd; ADD adds its own p_all_in_cost_usd; EXIT reduces it
  -- PROPORTIONALLY to the fraction of contracts_open actually exited, so realized P&L
  -- (exit net proceeds minus the exited fraction's own true fee-inclusive cost) and
  -- settlement's own remaining-inventory valuation both stay exact across any number
  -- of partial ADDs/EXITs, never merely approximated via contracts * avg_entry_price.
  ADD COLUMN IF NOT EXISTS remaining_cost_basis_usd numeric NOT NULL DEFAULT 0;

-- ============================== RPCs ==============================

-- record_sports_shadow_routing_provenance_ladder gains a trailing
-- p_trigger_source_fill_id param -- ENTRY callers (paper.server.ts) always pass NULL
-- (byte-identical behavior to before this migration); a future lifecycle-observation
-- ladder use is not currently needed (ADD/EXIT decide directly, see
-- finalize_sports_shadow_lifecycle_decision below) but the ladder RPC's own ON
-- CONFLICT target must still match the table's new 4-column constraint.
DROP FUNCTION IF EXISTS public.record_sports_shadow_routing_provenance_ladder(uuid, integer, text, uuid, timestamptz);

CREATE OR REPLACE FUNCTION public.record_sports_shadow_routing_provenance_ladder(
  p_signal_id uuid,
  p_requested_delay_ms integer,
  p_venue text,
  p_observation_id uuid,
  p_fire_at timestamptz,
  p_trigger_source_fill_id uuid DEFAULT NULL
) RETURNS TABLE (notional_tier_usd numeric, pmus_observation_id uuid, kalshi_observation_id uuid, decided_at timestamptz, fire_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'record_sports_shadow_routing_provenance_ladder: service_role required, got %', auth.role()
      USING ERRCODE = '42501';
  END IF;
  IF p_venue NOT IN ('PMUS', 'KALSHI') THEN
    RAISE EXCEPTION 'record_sports_shadow_routing_provenance_ladder: invalid venue %', p_venue;
  END IF;

  INSERT INTO public.sports_shadow_paper_fills (
    signal_id, requested_delay_ms, notional_tier_usd, fire_at,
    pmus_observation_id, kalshi_observation_id, trigger_source_fill_id
  )
  SELECT
    p_signal_id, p_requested_delay_ms, tier.notional_tier_usd, p_fire_at,
    CASE WHEN p_venue = 'PMUS' THEN p_observation_id ELSE NULL END,
    CASE WHEN p_venue = 'KALSHI' THEN p_observation_id ELSE NULL END,
    p_trigger_source_fill_id
  FROM (VALUES (5::numeric), (10::numeric), (25::numeric), (50::numeric), (100::numeric)) AS tier(notional_tier_usd)
  ON CONFLICT (signal_id, requested_delay_ms, notional_tier_usd, trigger_source_fill_id) DO UPDATE SET
    pmus_observation_id = COALESCE(public.sports_shadow_paper_fills.pmus_observation_id, EXCLUDED.pmus_observation_id),
    kalshi_observation_id = COALESCE(public.sports_shadow_paper_fills.kalshi_observation_id, EXCLUDED.kalshi_observation_id);

  RETURN QUERY
    SELECT f.notional_tier_usd, f.pmus_observation_id, f.kalshi_observation_id, f.decided_at, f.fire_at
    FROM public.sports_shadow_paper_fills f
    WHERE f.signal_id = p_signal_id AND f.requested_delay_ms = p_requested_delay_ms
      AND f.trigger_source_fill_id IS NOT DISTINCT FROM p_trigger_source_fill_id
    ORDER BY f.notional_tier_usd ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.record_sports_shadow_routing_provenance_ladder(uuid, integer, text, uuid, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_sports_shadow_routing_provenance_ladder(uuid, integer, text, uuid, timestamptz, uuid) TO service_role;

-- finalize_sports_shadow_routing_decision (ENTRY's own step 2) gains the same
-- trailing p_trigger_source_fill_id param (ENTRY callers always pass NULL -- its own
-- WHERE clause and ON CONFLICT target both need the extra column to keep matching the
-- table's new constraint; behavior for NULL is byte-identical to before).
DROP FUNCTION IF EXISTS public.finalize_sports_shadow_routing_decision(
  uuid, integer, numeric, timestamptz, text, text, text, numeric, numeric, numeric, text, boolean, numeric, text, jsonb, jsonb, text, text, text, uuid, uuid
);

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
  p_experiment_epoch_id uuid,
  p_trigger_source_fill_id uuid DEFAULT NULL
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
    AND trigger_source_fill_id IS NOT DISTINCT FROM p_trigger_source_fill_id
    AND decided_at IS NULL;

  IF FOUND AND p_side = 'ENTRY' AND p_chosen_venue IS NOT NULL AND p_fill_status IN ('FULL', 'PARTIAL') THEN
    -- CODEX P1-3: remaining_cost_basis_usd starts as the ENTRY's own fee-inclusive
    -- all_in_cost_usd -- see the column's own doc comment for why this (not
    -- contracts * avg_entry_price) is the authoritative basis ADD/EXIT maintain.
    INSERT INTO public.sports_shadow_paper_positions (signal_id, venue, notional_tier_usd, contracts_open, avg_entry_price, remaining_cost_basis_usd, status)
    VALUES (p_signal_id, p_chosen_venue, p_notional_tier_usd, p_contracts, p_vwap, p_all_in_cost_usd, 'OPEN')
    ON CONFLICT (signal_id, venue, notional_tier_usd) DO UPDATE SET
      contracts_open = EXCLUDED.contracts_open,
      avg_entry_price = EXCLUDED.avg_entry_price,
      remaining_cost_basis_usd = EXCLUDED.remaining_cost_basis_usd,
      status = 'OPEN',
      updated_at = now();
  END IF;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_sports_shadow_routing_decision(
  uuid, integer, numeric, timestamptz, text, text, text, numeric, numeric, numeric, text, boolean, numeric, text, jsonb, jsonb, text, text, text, uuid, uuid, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_sports_shadow_routing_decision(
  uuid, integer, numeric, timestamptz, text, text, text, numeric, numeric, numeric, text, boolean, numeric, text, jsonb, jsonb, text, text, text, uuid, uuid, uuid
) TO service_role;

-- Records a lifecycle trigger, idempotently (UNIQUE(source_fill_id) -- a
-- crashed/retried poll that already recorded this fill's reaction gets back the SAME
-- row, never a duplicate). Returns the row so the caller can schedule its
-- observation plan.
CREATE OR REPLACE FUNCTION public.record_sports_shadow_lifecycle_trigger(
  p_signal_id uuid,
  p_source_fill_id uuid,
  p_trigger_type text,
  p_tracked_shares numeric,
  p_exit_fraction numeric,
  p_price numeric,
  p_source_ts bigint
) RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'record_sports_shadow_lifecycle_trigger: service_role required, got %', auth.role()
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.sports_shadow_lifecycle_triggers (signal_id, source_fill_id, trigger_type, tracked_shares, exit_fraction, price, source_ts)
  VALUES (p_signal_id, p_source_fill_id, p_trigger_type, p_tracked_shares, p_exit_fraction, p_price, p_source_ts)
  ON CONFLICT (source_fill_id) DO UPDATE SET source_fill_id = EXCLUDED.source_fill_id -- no-op update, forces RETURNING on conflict too
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_sports_shadow_lifecycle_trigger(uuid, uuid, text, numeric, numeric, numeric, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_sports_shadow_lifecycle_trigger(uuid, uuid, text, numeric, numeric, numeric, bigint) TO service_role;

-- Finalizes an ADD or EXIT decision DIRECTLY (no separate provenance-then-finalize
-- protocol needed -- unlike ENTRY, an ADD/EXIT is always scoped to the ONE venue the
-- position is already open in, so there is no sibling venue to race against; a single
-- captured observation is decided as soon as it exists). `WHERE decided_at IS NULL`
-- still guards against a duplicate/retried call ever double-applying the same
-- decision. Atomically mutates sports_shadow_paper_positions in the SAME transaction:
--   ADD: weighted-average cost basis, contracts_open/contracts_added/add_cost_usd/
--        total_fees_usd all increase. Requires an EXISTING OPEN position (an ADD
--        against a tier/venue with no open position is a caller error -- rejected
--        before this RPC is ever called, since there's nothing to add to).
--   EXIT: contracts_open decreases by p_contracts (never below 0), contracts_exited/
--        exit_proceeds_usd/total_fees_usd increase, realized_pnl_usd accumulates
--        (p_all_in_cost_usd for an EXIT row holds NET PROCEEDS -- proceeds minus fee,
--        the mirror convention of ENTRY/ADD's own "cost including fee" -- see
--        paper.server.ts's own doc comment for why the column name is reused rather
--        than duplicated for this one distinction). status flips to CLOSED once
--        contracts_open reaches (or numerically rounds to) zero.
CREATE OR REPLACE FUNCTION public.finalize_sports_shadow_lifecycle_decision(
  p_signal_id uuid,
  p_requested_delay_ms integer,
  p_notional_tier_usd numeric,
  p_trigger_source_fill_id uuid,
  p_observation_id uuid,
  p_decided_at timestamptz,
  p_venue text,
  p_side text, -- 'ADD' or 'EXIT'
  p_fill_status text,
  p_contracts numeric,
  p_vwap numeric,
  p_fee_usd numeric,
  p_fee_model_version text,
  p_fee_valid boolean,
  p_all_in_cost_usd numeric,
  p_reject_reason text,
  p_venue_result jsonb,
  p_target_market_id text,
  p_selected_side text,
  p_source_fill_id uuid,
  p_experiment_epoch_id uuid
) RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_won boolean;
  v_open numeric;
  v_avg_entry numeric;
  v_new_contracts_open numeric;
  v_new_avg_entry numeric;
  v_cost_basis numeric;
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'finalize_sports_shadow_lifecycle_decision: service_role required, got %', auth.role()
      USING ERRCODE = '42501';
  END IF;
  IF p_side NOT IN ('ADD', 'EXIT') THEN
    RAISE EXCEPTION 'finalize_sports_shadow_lifecycle_decision: invalid side %, must be ADD or EXIT', p_side;
  END IF;

  INSERT INTO public.sports_shadow_paper_fills (
    signal_id, requested_delay_ms, notional_tier_usd, trigger_source_fill_id, fire_at,
    pmus_observation_id, kalshi_observation_id, decided_at, cutoff_reason, chosen_venue,
    side, fill_status, contracts, vwap, fee_usd, fee_model_version, fee_valid,
    all_in_cost_usd, reject_reason, pmus_result, kalshi_result, target_market_id,
    selected_side, source_fill_id, experiment_epoch_id
  ) VALUES (
    p_signal_id, p_requested_delay_ms, p_notional_tier_usd, p_trigger_source_fill_id, p_decided_at,
    CASE WHEN p_venue = 'PMUS' THEN p_observation_id ELSE NULL END,
    CASE WHEN p_venue = 'KALSHI' THEN p_observation_id ELSE NULL END,
    p_decided_at, 'BOTH_COMPLETE', p_venue,
    p_side, p_fill_status, p_contracts, p_vwap, p_fee_usd, p_fee_model_version, p_fee_valid,
    p_all_in_cost_usd, p_reject_reason,
    CASE WHEN p_venue = 'PMUS' THEN p_venue_result ELSE NULL END,
    CASE WHEN p_venue = 'KALSHI' THEN p_venue_result ELSE NULL END,
    p_target_market_id, p_selected_side, p_source_fill_id, p_experiment_epoch_id
  )
  ON CONFLICT (signal_id, requested_delay_ms, notional_tier_usd, trigger_source_fill_id) DO UPDATE SET
    decided_at = EXCLUDED.decided_at,
    cutoff_reason = EXCLUDED.cutoff_reason,
    chosen_venue = EXCLUDED.chosen_venue,
    side = EXCLUDED.side,
    fill_status = EXCLUDED.fill_status,
    contracts = EXCLUDED.contracts,
    vwap = EXCLUDED.vwap,
    fee_usd = EXCLUDED.fee_usd,
    fee_model_version = EXCLUDED.fee_model_version,
    fee_valid = EXCLUDED.fee_valid,
    all_in_cost_usd = EXCLUDED.all_in_cost_usd,
    reject_reason = EXCLUDED.reject_reason,
    pmus_result = EXCLUDED.pmus_result,
    kalshi_result = EXCLUDED.kalshi_result,
    target_market_id = EXCLUDED.target_market_id,
    selected_side = EXCLUDED.selected_side,
    source_fill_id = EXCLUDED.source_fill_id,
    experiment_epoch_id = EXCLUDED.experiment_epoch_id
  WHERE public.sports_shadow_paper_fills.decided_at IS NULL;

  v_won := FOUND;
  IF NOT v_won THEN
    RETURN false;
  END IF;

  IF p_fill_status NOT IN ('FULL', 'PARTIAL') THEN
    RETURN true; -- REJECTED/NONE/INVALID: decided, but no position mutation
  END IF;

  IF p_side = 'ADD' THEN
    SELECT contracts_open, avg_entry_price, remaining_cost_basis_usd INTO v_open, v_avg_entry, v_cost_basis
    FROM public.sports_shadow_paper_positions
    WHERE signal_id = p_signal_id AND venue = p_venue AND notional_tier_usd = p_notional_tier_usd
    FOR UPDATE;

    IF NOT FOUND OR v_open IS NULL OR v_open <= 0 THEN
      RAISE EXCEPTION 'finalize_sports_shadow_lifecycle_decision: ADD requires an existing OPEN position for signal=% venue=% tier=%', p_signal_id, p_venue, p_notional_tier_usd;
    END IF;

    v_new_contracts_open := v_open + p_contracts;
    v_new_avg_entry := ((v_open * COALESCE(v_avg_entry, 0)) + (p_contracts * p_vwap)) / v_new_contracts_open;

    UPDATE public.sports_shadow_paper_positions SET
      contracts_open = v_new_contracts_open,
      avg_entry_price = v_new_avg_entry,
      -- CODEX P1-3: remaining_cost_basis_usd is the authoritative fee-inclusive basis
      -- -- an ADD's own all_in_cost_usd is simply added to whatever basis already
      -- remained (see the column's own doc comment).
      remaining_cost_basis_usd = COALESCE(v_cost_basis, 0) + p_all_in_cost_usd,
      contracts_added = contracts_added + p_contracts,
      add_cost_usd = add_cost_usd + p_all_in_cost_usd,
      total_fees_usd = total_fees_usd + p_fee_usd,
      status = 'OPEN',
      updated_at = now()
    WHERE signal_id = p_signal_id AND venue = p_venue AND notional_tier_usd = p_notional_tier_usd;
  ELSE -- EXIT
    SELECT contracts_open, avg_entry_price, remaining_cost_basis_usd INTO v_open, v_avg_entry, v_cost_basis
    FROM public.sports_shadow_paper_positions
    WHERE signal_id = p_signal_id AND venue = p_venue AND notional_tier_usd = p_notional_tier_usd
    FOR UPDATE;

    IF NOT FOUND OR v_open IS NULL OR v_open <= 0 THEN
      RAISE EXCEPTION 'finalize_sports_shadow_lifecycle_decision: EXIT requires an existing OPEN position for signal=% venue=% tier=%', p_signal_id, p_venue, p_notional_tier_usd;
    END IF;

    -- Never exit more than currently open -- a proportional exitFraction computed
    -- against source-side inventory can drift slightly from the follower's own
    -- contracts_open; capped here as the final, authoritative guard (CODEX P1-3's own
    -- "remaining >= 0, no EXIT beyond existing follower inventory" invariant).
    v_new_contracts_open := GREATEST(0, v_open - LEAST(p_contracts, v_open));
    -- CODEX P1-3: the EXITED fraction's own TRUE fee-inclusive cost basis --
    -- proportional to remaining_cost_basis_usd (never contracts * avg_entry_price,
    -- which would silently drop any ADD fees already folded into the basis).
    v_cost_basis := COALESCE(v_cost_basis, 0) * (LEAST(p_contracts, v_open) / v_open);

    UPDATE public.sports_shadow_paper_positions SET
      contracts_open = v_new_contracts_open,
      remaining_cost_basis_usd = GREATEST(0, COALESCE(remaining_cost_basis_usd, 0) - v_cost_basis),
      contracts_exited = contracts_exited + LEAST(p_contracts, v_open),
      exit_proceeds_usd = exit_proceeds_usd + p_all_in_cost_usd,
      total_fees_usd = total_fees_usd + p_fee_usd,
      realized_pnl_usd = realized_pnl_usd + (p_all_in_cost_usd - v_cost_basis),
      status = CASE WHEN v_new_contracts_open <= 1e-9 THEN 'CLOSED' ELSE 'OPEN' END,
      updated_at = now()
    WHERE signal_id = p_signal_id AND venue = p_venue AND notional_tier_usd = p_notional_tier_usd;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_sports_shadow_lifecycle_decision(
  uuid, integer, numeric, uuid, uuid, timestamptz, text, text, text, numeric, numeric, numeric, text, boolean, numeric, text, jsonb, text, text, uuid, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_sports_shadow_lifecycle_decision(
  uuid, integer, numeric, uuid, uuid, timestamptz, text, text, text, numeric, numeric, numeric, text, boolean, numeric, text, jsonb, text, text, uuid, uuid
) TO service_role;
