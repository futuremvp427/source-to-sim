-- Production canary 2026-08-25 proved current-epoch rollover was not safe under
-- overlapping source/observation invocations: application code performed
-- update-is_current=false and insert-is_current=true as separate operations, so
-- concurrent workers could collide on sports_shadow_experiment_epochs_one_current_idx
-- and then continue with NULL epoch attribution. This migration moves the complete
-- current-epoch decision into one serialized database function.

CREATE OR REPLACE FUNCTION public.ensure_sports_shadow_current_epoch(
  p_go_live_at timestamptz,
  p_wallet_cohort text[],
  p_git_sha text,
  p_config_hash text,
  p_classifier_version text,
  p_episode_version text,
  p_resolver_version text,
  p_router_version text,
  p_pmus_fee_model_version text,
  p_kalshi_fee_model_version text,
  p_execution_simulator_version text,
  p_settlement_version text
) RETURNS public.sports_shadow_experiment_epochs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current public.sports_shadow_experiment_epochs%ROWTYPE;
  v_created public.sports_shadow_experiment_epochs%ROWTYPE;
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'ensure_sports_shadow_current_epoch: service_role required, got %', auth.role()
      USING ERRCODE = '42501';
  END IF;

  IF p_go_live_at IS NULL THEN
    RAISE EXCEPTION 'ensure_sports_shadow_current_epoch: p_go_live_at is required';
  END IF;
  IF p_wallet_cohort IS NULL OR cardinality(p_wallet_cohort) = 0 THEN
    RAISE EXCEPTION 'ensure_sports_shadow_current_epoch: p_wallet_cohort is required';
  END IF;
  IF p_git_sha IS NULL OR btrim(p_git_sha) = '' OR lower(btrim(p_git_sha)) = 'unknown' THEN
    RAISE EXCEPTION 'ensure_sports_shadow_current_epoch: p_git_sha must be a real deployment commit SHA';
  END IF;
  IF btrim(p_git_sha) !~* '^[0-9a-f]{7,64}$' THEN
    RAISE EXCEPTION 'ensure_sports_shadow_current_epoch: p_git_sha must be 7-64 hex characters';
  END IF;
  IF p_config_hash IS NULL OR btrim(p_config_hash) = '' THEN
    RAISE EXCEPTION 'ensure_sports_shadow_current_epoch: p_config_hash is required';
  END IF;
  IF p_classifier_version IS NULL OR btrim(p_classifier_version) = ''
    OR p_episode_version IS NULL OR btrim(p_episode_version) = ''
    OR p_resolver_version IS NULL OR btrim(p_resolver_version) = ''
    OR p_router_version IS NULL OR btrim(p_router_version) = ''
    OR p_pmus_fee_model_version IS NULL OR btrim(p_pmus_fee_model_version) = ''
    OR p_kalshi_fee_model_version IS NULL OR btrim(p_kalshi_fee_model_version) = ''
    OR p_execution_simulator_version IS NULL OR btrim(p_execution_simulator_version) = ''
    OR p_settlement_version IS NULL OR btrim(p_settlement_version) = '' THEN
    RAISE EXCEPTION 'ensure_sports_shadow_current_epoch: all subsystem versions are required';
  END IF;

  -- Serialize every current-epoch decision across all app/serverless workers in this
  -- transaction. Same-identity concurrent callers converge on the one row created by
  -- the first caller; different identities are still applied one at a time.
  PERFORM pg_advisory_xact_lock(20260825, 42755);

  SELECT *
  INTO v_current
  FROM public.sports_shadow_experiment_epochs
  WHERE is_current
  FOR UPDATE;

  IF FOUND
    AND v_current.go_live_at IS NOT DISTINCT FROM p_go_live_at
    AND v_current.wallet_cohort IS NOT DISTINCT FROM p_wallet_cohort
    AND v_current.git_sha IS NOT DISTINCT FROM lower(btrim(p_git_sha))
    AND v_current.config_hash IS NOT DISTINCT FROM p_config_hash
    AND v_current.classifier_version IS NOT DISTINCT FROM p_classifier_version
    AND v_current.episode_version IS NOT DISTINCT FROM p_episode_version
    AND v_current.resolver_version IS NOT DISTINCT FROM p_resolver_version
    AND v_current.router_version IS NOT DISTINCT FROM p_router_version
    AND v_current.pmus_fee_model_version IS NOT DISTINCT FROM p_pmus_fee_model_version
    AND v_current.kalshi_fee_model_version IS NOT DISTINCT FROM p_kalshi_fee_model_version
    AND v_current.execution_simulator_version IS NOT DISTINCT FROM p_execution_simulator_version
    AND v_current.settlement_version IS NOT DISTINCT FROM p_settlement_version THEN
    RETURN v_current;
  END IF;

  UPDATE public.sports_shadow_experiment_epochs
  SET is_current = false
  WHERE is_current;

  INSERT INTO public.sports_shadow_experiment_epochs (
    go_live_at,
    wallet_cohort,
    git_sha,
    config_hash,
    classifier_version,
    episode_version,
    resolver_version,
    router_version,
    pmus_fee_model_version,
    kalshi_fee_model_version,
    execution_simulator_version,
    settlement_version,
    stage,
    is_current
  ) VALUES (
    p_go_live_at,
    p_wallet_cohort,
    lower(btrim(p_git_sha)),
    p_config_hash,
    p_classifier_version,
    p_episode_version,
    p_resolver_version,
    p_router_version,
    p_pmus_fee_model_version,
    p_kalshi_fee_model_version,
    p_execution_simulator_version,
    p_settlement_version,
    'PRE_SOAK',
    true
  )
  RETURNING * INTO v_created;

  RETURN v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_sports_shadow_current_epoch(
  timestamptz, text[], text, text, text, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_sports_shadow_current_epoch(
  timestamptz, text[], text, text, text, text, text, text, text, text, text, text
) TO service_role;

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
#variable_conflict use_column
DECLARE
  v_experiment_epoch_id uuid;
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'record_sports_shadow_routing_provenance_ladder: service_role required, got %', auth.role()
      USING ERRCODE = '42501';
  END IF;
  IF p_venue NOT IN ('PMUS', 'KALSHI') THEN
    RAISE EXCEPTION 'record_sports_shadow_routing_provenance_ladder: invalid venue %', p_venue;
  END IF;

  SELECT s.experiment_epoch_id INTO v_experiment_epoch_id
  FROM public.sports_shadow_signals s
  WHERE s.id = p_signal_id;
  IF v_experiment_epoch_id IS NULL THEN
    RAISE EXCEPTION 'record_sports_shadow_routing_provenance_ladder: signal % has no experiment_epoch_id', p_signal_id;
  END IF;

  INSERT INTO public.sports_shadow_paper_fills (
    signal_id, requested_delay_ms, notional_tier_usd, fire_at,
    pmus_observation_id, kalshi_observation_id, trigger_source_fill_id,
    experiment_epoch_id
  )
  SELECT
    p_signal_id, p_requested_delay_ms, tier.notional_tier_usd, p_fire_at,
    CASE WHEN p_venue = 'PMUS' THEN p_observation_id ELSE NULL END,
    CASE WHEN p_venue = 'KALSHI' THEN p_observation_id ELSE NULL END,
    p_trigger_source_fill_id,
    v_experiment_epoch_id
  FROM (VALUES (5::numeric), (10::numeric), (25::numeric), (50::numeric), (100::numeric)) AS tier(notional_tier_usd)
  ON CONFLICT (signal_id, requested_delay_ms, notional_tier_usd, trigger_source_fill_id) DO UPDATE SET
    pmus_observation_id = COALESCE(public.sports_shadow_paper_fills.pmus_observation_id, EXCLUDED.pmus_observation_id),
    kalshi_observation_id = COALESCE(public.sports_shadow_paper_fills.kalshi_observation_id, EXCLUDED.kalshi_observation_id),
    experiment_epoch_id = COALESCE(public.sports_shadow_paper_fills.experiment_epoch_id, EXCLUDED.experiment_epoch_id);

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

CREATE OR REPLACE FUNCTION public.find_pending_sports_shadow_signals(
  p_venue text,
  p_limit integer
)
RETURNS TABLE (
  id uuid,
  created_at timestamptz,
  source_first_fill_at timestamptz,
  source_wallet text,
  source_condition_id text,
  source_asset text,
  bet_type text,
  away_team text,
  home_team text,
  scheduled_start_at timestamptz,
  line numeric,
  selected_side text,
  source_event_slug text,
  source_market_slug text,
  missing_pmus boolean,
  missing_kalshi boolean,
  source_rules_description text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    s.id,
    s.created_at,
    s.source_first_fill_at,
    s.source_wallet,
    s.source_condition_id,
    s.source_asset,
    s.bet_type,
    s.away_team,
    s.home_team,
    s.scheduled_start_at,
    s.line,
    s.selected_side,
    s.source_event_slug,
    s.source_market_slug,
    (pmus_match.id IS NULL) AS missing_pmus,
    (kalshi_match.id IS NULL) AS missing_kalshi,
    s.source_rules_description
  FROM public.sports_shadow_signals s
  LEFT JOIN public.sports_market_matches pmus_match
    ON pmus_match.signal_id = s.id AND pmus_match.venue = 'PMUS'
  LEFT JOIN public.sports_market_matches kalshi_match
    ON kalshi_match.signal_id = s.id AND kalshi_match.venue = 'KALSHI'
  WHERE
    s.experiment_epoch_id IS NOT NULL
    AND (
      (p_venue = 'PMUS' AND (
        pmus_match.id IS NULL
        OR (
          pmus_match.match_status <> 'EXACT'
          AND pmus_match.next_recheck_at IS NOT NULL
          AND pmus_match.next_recheck_at <= now()
          AND now() < COALESCE(s.scheduled_start_at, s.created_at + interval '4 hours')
        )
      ))
      OR (p_venue = 'KALSHI' AND (
        kalshi_match.id IS NULL
        OR (
          kalshi_match.match_status <> 'EXACT'
          AND kalshi_match.next_recheck_at IS NOT NULL
          AND kalshi_match.next_recheck_at <= now()
          AND now() < COALESCE(s.scheduled_start_at, s.created_at + interval '4 hours')
        )
      ))
    )
  ORDER BY s.created_at ASC, s.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 0), 100);
$$;

REVOKE ALL ON FUNCTION public.find_pending_sports_shadow_signals(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_pending_sports_shadow_signals(text, integer) TO service_role;

-- Preserve failed-canary rows as diagnostic evidence, but enforce fail-closed epoch
-- attribution for every future row on epoch-bearing research tables.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sports_shadow_experiment_epochs'::regclass
      AND conname = 'sports_shadow_experiment_epochs_git_sha_real_check'
  ) THEN
    ALTER TABLE public.sports_shadow_experiment_epochs
      ADD CONSTRAINT sports_shadow_experiment_epochs_git_sha_real_check
      CHECK (git_sha ~* '^[0-9a-f]{7,64}$' AND lower(git_sha) <> 'unknown') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sports_shadow_signals'::regclass
      AND conname = 'sports_shadow_signals_experiment_epoch_id_present_check'
  ) THEN
    ALTER TABLE public.sports_shadow_signals
      ADD CONSTRAINT sports_shadow_signals_experiment_epoch_id_present_check
      CHECK (experiment_epoch_id IS NOT NULL) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sports_shadow_paper_fills'::regclass
      AND conname = 'sports_shadow_paper_fills_experiment_epoch_id_present_check'
  ) THEN
    ALTER TABLE public.sports_shadow_paper_fills
      ADD CONSTRAINT sports_shadow_paper_fills_experiment_epoch_id_present_check
      CHECK (experiment_epoch_id IS NOT NULL) NOT VALID;
  END IF;
END
$$;
