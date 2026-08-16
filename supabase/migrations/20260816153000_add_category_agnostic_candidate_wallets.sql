-- Add three prospective, paper-only candidate shadow experiments.
--
-- These rows are deliberately separate from the 10-experiment V2/V3
-- qualification cohort. They do not change that cohort's T_clean/T_7d/T_14d,
-- bankrolls, checkpoints, paper history, strategy, or live-safety state.
--
-- Category policy for these candidates is intentionally agnostic:
-- weather_only=false means a supported source event is not excluded merely
-- because it is politics, sports, economics, crypto, weather, breaking news,
-- or another category. All existing paper-engine copyability/sizing/cash/
-- settlement safeguards continue to apply unchanged.
--
-- The candidate observation boundary is prospective and database-authored.
-- All three rows receive the same statement_timestamp() second as
-- follow_from_ts. Existing processPendingEvents semantics backfill earlier
-- source fills into experiment-scoped source-position state without opening a
-- paper position or spending simulated cash.
--
-- Idempotency / duplicate safety:
--   * exact names remain protected by paper_experiments.name UNIQUE;
--   * if the same wallet is already under an equivalent enabled simulated
--     category-agnostic dynamic-v1 $380 paper experiment, this migration does
--     not create a duplicate experiment for that wallet;
--   * rerunning this SQL never rewrites an existing candidate's follow_from_ts
--     or ledger state.

INSERT INTO public.tracked_wallets (address, label, active)
VALUES
  ('0x118689b24aead1d6e9507b8068d056b2ec4f051b', 'Candidate: russell110320', true),
  ('0x6ff2cb14da8be7eb57541d250a0196c5f295f140', 'Candidate: jjavi', true),
  ('0x7c63520c2ca9b336af0c205b9ccf68217bb393d4', 'Candidate: opopv.', true)
ON CONFLICT (address) DO NOTHING;

WITH candidate_boundary AS (
  SELECT floor(extract(epoch FROM statement_timestamp()))::bigint AS follow_from_ts
), candidates(name, wallet_address) AS (
  VALUES
    ('CANDIDATE: russell110320', '0x118689b24aead1d6e9507b8068d056b2ec4f051b'),
    ('CANDIDATE: jjavi', '0x6ff2cb14da8be7eb57541d250a0196c5f295f140'),
    ('CANDIDATE: opopv.', '0x7c63520c2ca9b336af0c205b9ccf68217bb393d4')
)
INSERT INTO public.paper_experiments (
  name,
  wallet_address,
  starting_cash,
  cash,
  buy_amount,
  poll_interval_seconds,
  enabled,
  weather_only,
  realized_pnl,
  simulated,
  sizing_rule,
  follow_from_ts
)
SELECT
  c.name,
  c.wallet_address,
  380,
  380,
  5,
  60,
  true,
  false,
  0,
  true,
  'dynamic-v1',
  b.follow_from_ts
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
