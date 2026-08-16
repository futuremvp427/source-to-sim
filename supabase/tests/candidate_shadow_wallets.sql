\set ON_ERROR_STOP on

-- Regression contract for the three separate category-agnostic paper
-- candidates. This runs after a clean migration replay in Audit CI.

DO $$
DECLARE
  candidate_count integer;
  distinct_boundary_count integer;
  bad_config_count integer;
  duplicate_wallet_count integer;
  wrong_cohort_count integer;
BEGIN
  SELECT count(*) INTO candidate_count
  FROM public.paper_experiments
  WHERE name IN (
    'CANDIDATE: russell110320',
    'CANDIDATE: jjavi',
    'CANDIDATE: opopv.'
  );

  IF candidate_count <> 3 THEN
    RAISE EXCEPTION 'expected exactly 3 named candidate experiments, got %', candidate_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.paper_experiments
    WHERE name = 'CANDIDATE: russell110320'
      AND lower(wallet_address) = '0x118689b24aead1d6e9507b8068d056b2ec4f051b'
  ) THEN
    RAISE EXCEPTION 'russell110320 candidate wallet mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.paper_experiments
    WHERE name = 'CANDIDATE: jjavi'
      AND lower(wallet_address) = '0x6ff2cb14da8be7eb57541d250a0196c5f295f140'
  ) THEN
    RAISE EXCEPTION 'jjavi candidate wallet mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.paper_experiments
    WHERE name = 'CANDIDATE: opopv.'
      AND lower(wallet_address) = '0x7c63520c2ca9b336af0c205b9ccf68217bb393d4'
  ) THEN
    RAISE EXCEPTION 'opopv. candidate wallet mismatch';
  END IF;

  SELECT count(*) INTO bad_config_count
  FROM public.paper_experiments
  WHERE name IN (
    'CANDIDATE: russell110320',
    'CANDIDATE: jjavi',
    'CANDIDATE: opopv.'
  )
    AND NOT (
      starting_cash = 380
      AND cash = 380
      AND buy_amount = 5
      AND poll_interval_seconds = 60
      AND enabled = true
      AND simulated = true
      AND weather_only = false
      AND sizing_rule = 'dynamic-v1'
      AND realized_pnl = 0
      AND follow_from_ts IS NOT NULL
      AND follow_from_ts > 0
    );

  IF bad_config_count <> 0 THEN
    RAISE EXCEPTION '% candidate experiment(s) have an unexpected baseline configuration', bad_config_count;
  END IF;

  SELECT count(DISTINCT follow_from_ts) INTO distinct_boundary_count
  FROM public.paper_experiments
  WHERE name IN (
    'CANDIDATE: russell110320',
    'CANDIDATE: jjavi',
    'CANDIDATE: opopv.'
  );

  IF distinct_boundary_count <> 1 THEN
    RAISE EXCEPTION 'candidate experiments must share one prospective follow_from_ts boundary; got %', distinct_boundary_count;
  END IF;

  SELECT count(*) INTO duplicate_wallet_count
  FROM (
    SELECT lower(wallet_address)
    FROM public.paper_experiments
    WHERE name LIKE 'CANDIDATE: %'
      AND lower(wallet_address) IN (
        '0x118689b24aead1d6e9507b8068d056b2ec4f051b',
        '0x6ff2cb14da8be7eb57541d250a0196c5f295f140',
        '0x7c63520c2ca9b336af0c205b9ccf68217bb393d4'
      )
    GROUP BY lower(wallet_address)
    HAVING count(*) <> 1
  ) duplicates;

  IF duplicate_wallet_count <> 0 THEN
    RAISE EXCEPTION 'duplicate candidate experiment found for one of the three exact wallets';
  END IF;

  SELECT count(*) INTO wrong_cohort_count
  FROM public.paper_experiments
  WHERE name IN (
    'CANDIDATE: russell110320',
    'CANDIDATE: jjavi',
    'CANDIDATE: opopv.'
  )
    AND (name LIKE 'SHADOW V2: %' OR name LIKE 'SHADOW V3 CAPACITY: %');

  IF wrong_cohort_count <> 0 THEN
    RAISE EXCEPTION 'candidate experiment was incorrectly placed in the V2/V3 qualification cohort';
  END IF;
END
$$;

-- Prove rerunning the seed logic is idempotent and, critically, cannot reset
-- the candidate clock. Snapshot the boundary, attempt the same seed with a
-- deliberately later timestamp, then assert row count and boundary are intact.
CREATE TEMP TABLE candidate_seed_snapshot AS
SELECT name, follow_from_ts
FROM public.paper_experiments
WHERE name IN (
  'CANDIDATE: russell110320',
  'CANDIDATE: jjavi',
  'CANDIDATE: opopv.'
);

WITH candidate_boundary AS (
  SELECT (floor(extract(epoch FROM statement_timestamp()))::bigint + 86400) AS follow_from_ts
), candidates(name, wallet_address) AS (
  VALUES
    ('CANDIDATE: russell110320', '0x118689b24aead1d6e9507b8068d056b2ec4f051b'),
    ('CANDIDATE: jjavi', '0x6ff2cb14da8be7eb57541d250a0196c5f295f140'),
    ('CANDIDATE: opopv.', '0x7c63520c2ca9b336af0c205b9ccf68217bb393d4')
)
INSERT INTO public.paper_experiments (
  name, wallet_address, starting_cash, cash, buy_amount,
  poll_interval_seconds, enabled, weather_only, realized_pnl, simulated,
  sizing_rule, follow_from_ts
)
SELECT
  c.name, c.wallet_address, 380, 380, 5,
  60, true, false, 0, true,
  'dynamic-v1', b.follow_from_ts
FROM candidates c
CROSS JOIN candidate_boundary b
WHERE NOT EXISTS (
  SELECT 1
  FROM public.paper_experiments existing
  WHERE lower(existing.wallet_address) = lower(c.wallet_address)
    AND existing.enabled = true
    AND existing.simulated = true
    AND existing.weather_only = false
    AND existing.sizing_rule = 'dynamic-v1'
    AND existing.starting_cash = 380
    AND existing.follow_from_ts IS NOT NULL
)
ON CONFLICT (name) DO NOTHING;

DO $$
DECLARE
  changed integer;
  total integer;
BEGIN
  SELECT count(*) INTO total
  FROM public.paper_experiments
  WHERE name IN (
    'CANDIDATE: russell110320',
    'CANDIDATE: jjavi',
    'CANDIDATE: opopv.'
  );

  IF total <> 3 THEN
    RAISE EXCEPTION 'rerun changed candidate row count: expected 3, got %', total;
  END IF;

  SELECT count(*) INTO changed
  FROM public.paper_experiments pe
  JOIN candidate_seed_snapshot s USING (name)
  WHERE pe.follow_from_ts IS DISTINCT FROM s.follow_from_ts;

  IF changed <> 0 THEN
    RAISE EXCEPTION 'rerun changed follow_from_ts for % candidate(s)', changed;
  END IF;
END
$$;
