ALTER TABLE public.paper_experiments
  ADD COLUMN IF NOT EXISTS market_scope text NOT NULL DEFAULT 'ALL';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.paper_experiments'::regclass
      AND conname = 'paper_experiments_market_scope_allowed'
  ) THEN
    ALTER TABLE public.paper_experiments
      ADD CONSTRAINT paper_experiments_market_scope_allowed
      CHECK (market_scope IN ('ALL', 'WEATHER', 'CRYPTO', 'MENTIONS', 'WORLD_POLITICS'));
  END IF;
END
$$;

-- Preserve legacy semantics for any historical weather-restricted experiment.
UPDATE public.paper_experiments
SET market_scope = 'WEATHER', updated_at = now()
WHERE weather_only = true
  AND market_scope = 'ALL';

INSERT INTO public.tracked_wallets (address, label, active)
VALUES ('0xa7011667f22c121c6cea7aab30192307c58c47cd', 'Candidate: BadTattoo', true)
ON CONFLICT (address) DO NOTHING;

INSERT INTO public.paper_experiments (
  name,
  wallet_address,
  starting_cash,
  cash,
  buy_amount,
  poll_interval_seconds,
  enabled,
  weather_only,
  market_scope,
  realized_pnl,
  simulated,
  sizing_rule,
  follow_from_ts
)
SELECT
  'CANDIDATE: BadTattoo',
  '0xa7011667f22c121c6cea7aab30192307c58c47cd',
  380,
  380,
  5,
  60,
  true,
  false,
  'CRYPTO',
  0,
  true,
  'dynamic-v1',
  1786945086::bigint
WHERE NOT EXISTS (
  SELECT 1
  FROM public.paper_experiments existing
  WHERE lower(existing.wallet_address) = lower('0xa7011667f22c121c6cea7aab30192307c58c47cd')
    AND existing.enabled = true
    AND existing.simulated = true
    AND existing.sizing_rule = 'dynamic-v1'
    AND existing.starting_cash = 380
    AND existing.follow_from_ts IS NOT NULL
)
ON CONFLICT (name) DO NOTHING;