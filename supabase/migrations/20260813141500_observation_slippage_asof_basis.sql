-- Phase 2: indexed no-lookahead slippage reads for the out-of-sample log.
--
-- Historical adjusted P&L must never be rebuilt with today's slippage median.
-- For each settlement UTC day D, application reads use only the most recent
-- observed slippage samples whose observed_at is strictly before 00:00:00 UTC
-- on D. This covering partial index keeps those as-of reads bounded and cheap.

CREATE INDEX IF NOT EXISTS copyability_observations_experiment_observed_slippage_idx
  ON public.copyability_observations (experiment_id, observed_at DESC, id DESC)
  INCLUDE (slippage_cents)
  WHERE status = 'observed'
    AND observed_at IS NOT NULL
    AND slippage_cents IS NOT NULL;
