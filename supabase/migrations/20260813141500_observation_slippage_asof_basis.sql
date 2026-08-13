-- Phase 2: no-lookahead slippage basis for the out-of-sample observation log.
--
-- Historical adjusted P&L must never be rebuilt with today's slippage median.
-- For each settlement UTC day D, the committed methodology uses only the most
-- recent observed slippage samples whose observed_at is strictly before
-- 00:00:00 UTC on D. Samples collected during or after D therefore cannot
-- retrospectively redefine D's research metric.

CREATE INDEX IF NOT EXISTS copyability_observations_experiment_observed_slippage_idx
  ON public.copyability_observations (experiment_id, observed_at DESC, id DESC)
  INCLUDE (slippage_cents)
  WHERE status = 'observed'
    AND observed_at IS NOT NULL
    AND slippage_cents IS NOT NULL;

CREATE VIEW public.observation_day_slippage_basis
WITH (security_invoker = true)
AS
WITH days AS (
  SELECT DISTINCT
    ps.experiment_id,
    (ps.resolution_ts AT TIME ZONE 'UTC')::date AS settlement_day
  FROM public.paper_settlements ps
  WHERE ps.resolution_ts IS NOT NULL
)
SELECT
  d.experiment_id,
  d.settlement_day,
  (d.settlement_day::timestamp AT TIME ZONE 'UTC') AS cutoff_at,
  basis.median_cents,
  basis.sample_count,
  'prior-utc-day-v1'::text AS methodology_version
FROM days d
LEFT JOIN LATERAL (
  SELECT
    percentile_cont(0.5) WITHIN GROUP (ORDER BY sampled.slippage_cents)::numeric AS median_cents,
    count(*)::integer AS sample_count
  FROM (
    SELECT co.slippage_cents
    FROM public.copyability_observations co
    WHERE co.experiment_id = d.experiment_id
      AND co.status = 'observed'
      AND co.observed_at IS NOT NULL
      AND co.slippage_cents IS NOT NULL
      AND co.observed_at < (d.settlement_day::timestamp AT TIME ZONE 'UTC')
    ORDER BY co.observed_at DESC, co.id DESC
    LIMIT 2000
  ) sampled
) basis ON true;

REVOKE ALL ON public.observation_day_slippage_basis FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.observation_day_slippage_basis TO service_role;
