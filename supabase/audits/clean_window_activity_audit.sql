-- CLEAN-WINDOW ACTIVITY AUDIT — 10-experiment V2/V3 cohort
--
-- READ-ONLY. Every statement below is a SELECT; nothing here writes, deletes,
-- or resets any row. Safe to run against production at any time, but per the
-- "FINAL PRE-AUG-21 RELIABILITY CLEANUP" task this bundle is PREPARED ONLY —
-- it must be run manually against production AFTER the PR that adds this
-- file has merged, not before, and not as part of CI.
--
-- Run with, e.g.:
--   psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/audits/clean_window_activity_audit.sql
--
-- Purpose: measure, per V2/V3 experiment, how much genuinely NEW post-T_clean
-- trading evidence exists, per docs/V2_V3_VALIDITY.md's "August 21
-- qualification methodology" section. T_7d (2026-08-21 11:29:19.638 UTC) is
-- only the EARLIEST date qualification may be considered — this audit is what
-- turns "time has passed" into an actual evidence count so each experiment can
-- be classified QUALIFIED / NOT QUALIFIED / INSUFFICIENT NEW DATA. No minimum
-- sample-size threshold is assumed here; that should be set only after
-- inspecting the distribution this audit returns across all 10 experiments.
--
-- Clean-lifecycle rule (load-bearing, applied throughout): a position's
-- OPENING BUY must have occurred strictly after T_clean for that position's
-- lifecycle to count as clean/new evidence. A position opened before T_clean
-- that happens to settle or close after T_clean is legacy evidence — its
-- entry decision predates the fix this clean epoch exists to isolate — and is
-- reported SEPARATELY (see the final query) and EXCLUDED from every "clean
-- sample" figure above it.
--
-- Does NOT move T_clean/T_7d, does not touch qualification criteria, sizing,
-- bankrolls, cash, P&L, positions, checkpoints, or settlements — read-only
-- measurement only.

\set ON_ERROR_STOP on

-- Fixed epoch boundary. Keep in sync with docs/V2_V3_VALIDITY.md; do not
-- derive this from any host clock.
\set t_clean '''2026-08-14 11:29:19.638+00'''

-- ------------------------------------------------------------------------
-- 0. Cohort membership (sanity check: must return exactly 10 rows)
-- ------------------------------------------------------------------------
SELECT id, name, wallet_address, enabled, follow_from_ts
FROM public.paper_experiments
WHERE name LIKE 'SHADOW V2: %' OR name LIKE 'SHADOW V3 CAPACITY: %'
ORDER BY name;

-- ------------------------------------------------------------------------
-- 1 & 2. Source BUY / SELL counts per experiment's wallet, from T_clean
-- ------------------------------------------------------------------------
SELECT
  pe.name AS experiment,
  se.side,
  count(*) AS source_event_count
FROM public.paper_experiments pe
JOIN public.source_events se
  ON lower(se.wallet) = lower(pe.wallet_address)
WHERE (pe.name LIKE 'SHADOW V2: %' OR pe.name LIKE 'SHADOW V3 CAPACITY: %')
  AND to_timestamp(se.source_ts) >= :t_clean::timestamptz
GROUP BY pe.name, se.side
ORDER BY pe.name, se.side;

-- ------------------------------------------------------------------------
-- 3 & 4. Copied BUY / SELL counts (actual paper fills), from T_clean
-- ------------------------------------------------------------------------
SELECT
  pe.name AS experiment,
  pt.action,
  count(*) AS copied_count,
  sum(pt.notional) AS total_notional
FROM public.paper_experiments pe
JOIN public.paper_trades pt ON pt.experiment_id = pe.id
WHERE (pe.name LIKE 'SHADOW V2: %' OR pe.name LIKE 'SHADOW V3 CAPACITY: %')
  AND pt.action IN ('BUY', 'SELL')
  AND pt.created_at >= :t_clean::timestamptz
GROUP BY pe.name, pt.action
ORDER BY pe.name, pt.action;

-- ------------------------------------------------------------------------
-- 5 & 6. Skipped BUY count and reasons, from T_clean
-- ------------------------------------------------------------------------
SELECT
  pe.name AS experiment,
  pt.reason,
  count(*) AS skipped_buy_count
FROM public.paper_experiments pe
JOIN public.paper_trades pt ON pt.experiment_id = pe.id
WHERE (pe.name LIKE 'SHADOW V2: %' OR pe.name LIKE 'SHADOW V3 CAPACITY: %')
  AND pt.action = 'SKIP'
  AND pt.side = 'BUY'
  AND pt.created_at >= :t_clean::timestamptz
GROUP BY pe.name, pt.reason
ORDER BY pe.name, skipped_buy_count DESC;

-- ------------------------------------------------------------------------
-- 17. Cash-starvation skips specifically (subset of 5/6, called out per spec)
-- ------------------------------------------------------------------------
SELECT
  pe.name AS experiment,
  count(*) AS cash_starvation_skip_count
FROM public.paper_experiments pe
JOIN public.paper_trades pt ON pt.experiment_id = pe.id
WHERE (pe.name LIKE 'SHADOW V2: %' OR pe.name LIKE 'SHADOW V3 CAPACITY: %')
  AND pt.action = 'SKIP'
  AND pt.reason ILIKE '%cash%'
  AND pt.created_at >= :t_clean::timestamptz
GROUP BY pe.name
ORDER BY pe.name;

-- ------------------------------------------------------------------------
-- Clean-lifecycle base set: paper_positions is a single mutable row per
-- (experiment_id, asset) -- it does NOT preserve history across a full
-- sell-down-and-later-rebuy of the same asset, and a plain min(BUY) per
-- (experiment_id, asset) would collapse every such reopening into the very
-- first BUY ever recorded. paper_trades DOES retain the full BUY/SELL
-- history, so lifecycles are reconstructed here: a new lifecycle starts at
-- any BUY whose running share balance immediately before it is <= 0, and
-- lifecycle boundaries are the zero-balance crossings in between. Only the
-- MOST RECENT lifecycle for a given (experiment_id, asset) can still be open
-- or ever receive a settlement, because paper_settlements has UNIQUE
-- (experiment_id, asset) -- a market settles once, so an earlier lifecycle
-- that was already fully sold down before a later reopen is always
-- classified 'closed' here (it cannot be the one a later settlement
-- belongs to).
--
-- The opening-BUY boundary uses source_ts (the source fill's real market
-- time), NOT created_at (when this app's database row was written). A
-- pre-T_clean fill that gets caught up and copied only after T_clean would
-- otherwise show a created_at after T_clean and be misclassified as clean
-- even though its entry decision predates the fix. source_ts is what the
-- "opening BUY occurred after T_clean" rule in docs/V2_V3_VALIDITY.md
-- actually means.
-- ------------------------------------------------------------------------
WITH buysell AS (
  SELECT
    pt.id,
    pt.experiment_id,
    pt.asset,
    pt.action,
    pt.shares,
    pt.notional,
    pt.realized_pnl,
    to_timestamp(pt.source_ts) AS trade_ts
  FROM public.paper_trades pt
  WHERE pt.action IN ('BUY', 'SELL') AND pt.source_ts IS NOT NULL
),
balances AS (
  SELECT
    b.*,
    sum(CASE WHEN action = 'BUY' THEN shares ELSE -shares END) OVER (
      PARTITION BY experiment_id, asset ORDER BY trade_ts, id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS balance_before
  FROM buysell b
),
lifecycle_marks AS (
  SELECT
    *,
    (action = 'BUY' AND coalesce(balance_before, 0) <= 0) AS opens_lifecycle
  FROM balances
),
lifecycle_seqs AS (
  SELECT
    *,
    sum(CASE WHEN opens_lifecycle THEN 1 ELSE 0 END) OVER (
      PARTITION BY experiment_id, asset ORDER BY trade_ts, id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS lifecycle_seq
  FROM lifecycle_marks
),
lifecycles AS (
  SELECT
    experiment_id,
    asset,
    lifecycle_seq,
    min(trade_ts) FILTER (WHERE opens_lifecycle) AS opening_buy_ts,
    sum(CASE WHEN action = 'BUY' THEN shares ELSE -shares END) AS net_shares,
    sum(CASE WHEN action = 'BUY' THEN notional ELSE 0 END) AS capital_deployed,
    sum(CASE WHEN action = 'SELL' THEN realized_pnl ELSE 0 END) AS realized_pnl_from_sells
  FROM lifecycle_seqs
  GROUP BY experiment_id, asset, lifecycle_seq
),
lifecycles_marked AS (
  SELECT
    l.*,
    (l.lifecycle_seq = max(l.lifecycle_seq) OVER (PARTITION BY l.experiment_id, l.asset)) AS is_latest_lifecycle
  FROM lifecycles l
),
clean_lifecycles AS (
  SELECT * FROM lifecycles_marked WHERE opening_buy_ts >= :t_clean::timestamptz
)
-- ------------------------------------------------------------------------
-- 7. Positions whose opening BUY occurred after T_clean (the clean sample) --
-- one row per reconstructed lifecycle, not per (experiment, asset)
-- ------------------------------------------------------------------------
SELECT
  pe.name AS experiment,
  count(*) AS post_t_clean_lifecycles_opened
FROM clean_lifecycles cl
JOIN public.paper_experiments pe ON pe.id = cl.experiment_id
WHERE pe.name LIKE 'SHADOW V2: %' OR pe.name LIKE 'SHADOW V3 CAPACITY: %'
GROUP BY pe.name
ORDER BY pe.name;

-- ------------------------------------------------------------------------
-- 8, 9, 10, 11. Post-T_clean lifecycles: closed / settled won / settled lost
-- / still open. A non-latest lifecycle for its (experiment, asset) is always
-- 'closed' by construction (it was fully sold down before a later reopen).
-- Only the latest lifecycle can carry paper_positions' live status or a
-- paper_settlements row.
-- ------------------------------------------------------------------------
WITH buysell AS (
  SELECT pt.id, pt.experiment_id, pt.asset, pt.action, pt.shares, pt.notional, pt.realized_pnl,
    to_timestamp(pt.source_ts) AS trade_ts
  FROM public.paper_trades pt
  WHERE pt.action IN ('BUY', 'SELL') AND pt.source_ts IS NOT NULL
),
balances AS (
  SELECT b.*, sum(CASE WHEN action = 'BUY' THEN shares ELSE -shares END) OVER (
    PARTITION BY experiment_id, asset ORDER BY trade_ts, id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
  ) AS balance_before
  FROM buysell b
),
lifecycle_marks AS (
  SELECT *, (action = 'BUY' AND coalesce(balance_before, 0) <= 0) AS opens_lifecycle FROM balances
),
lifecycle_seqs AS (
  SELECT *, sum(CASE WHEN opens_lifecycle THEN 1 ELSE 0 END) OVER (
    PARTITION BY experiment_id, asset ORDER BY trade_ts, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS lifecycle_seq
  FROM lifecycle_marks
),
lifecycles AS (
  SELECT experiment_id, asset, lifecycle_seq,
    min(trade_ts) FILTER (WHERE opens_lifecycle) AS opening_buy_ts,
    sum(CASE WHEN action = 'BUY' THEN shares ELSE -shares END) AS net_shares
  FROM lifecycle_seqs
  GROUP BY experiment_id, asset, lifecycle_seq
),
lifecycles_marked AS (
  SELECT l.*, (l.lifecycle_seq = max(l.lifecycle_seq) OVER (PARTITION BY l.experiment_id, l.asset)) AS is_latest_lifecycle
  FROM lifecycles l
),
clean_lifecycles AS (
  SELECT * FROM lifecycles_marked WHERE opening_buy_ts >= :t_clean::timestamptz
),
classified AS (
  SELECT
    cl.experiment_id,
    CASE
      WHEN NOT cl.is_latest_lifecycle THEN 'closed'
      ELSE coalesce(pp.settlement_status, 'closed')
    END AS status,
    CASE WHEN cl.is_latest_lifecycle THEN coalesce(pp.shares, 0) ELSE 0 END AS current_shares,
    CASE WHEN cl.is_latest_lifecycle THEN coalesce(pp.cost_basis, 0) ELSE 0 END AS current_cost_basis
  FROM clean_lifecycles cl
  LEFT JOIN public.paper_positions pp ON pp.experiment_id = cl.experiment_id AND pp.asset = cl.asset
)
SELECT
  pe.name AS experiment,
  c.status,
  count(*) AS lifecycle_count,
  sum(c.current_shares) AS open_shares,
  sum(c.current_cost_basis) AS open_cost_basis
FROM classified c
JOIN public.paper_experiments pe ON pe.id = c.experiment_id
WHERE pe.name LIKE 'SHADOW V2: %' OR pe.name LIKE 'SHADOW V3 CAPACITY: %'
GROUP BY pe.name, c.status
ORDER BY pe.name, c.status;

-- ------------------------------------------------------------------------
-- 12. Capital deployed into post-T_clean lifecycles (sum of BUY notional
-- within each clean lifecycle)
-- ------------------------------------------------------------------------
WITH buysell AS (
  SELECT pt.id, pt.experiment_id, pt.asset, pt.action, pt.shares, pt.notional, pt.realized_pnl,
    to_timestamp(pt.source_ts) AS trade_ts
  FROM public.paper_trades pt
  WHERE pt.action IN ('BUY', 'SELL') AND pt.source_ts IS NOT NULL
),
balances AS (
  SELECT b.*, sum(CASE WHEN action = 'BUY' THEN shares ELSE -shares END) OVER (
    PARTITION BY experiment_id, asset ORDER BY trade_ts, id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
  ) AS balance_before
  FROM buysell b
),
lifecycle_marks AS (
  SELECT *, (action = 'BUY' AND coalesce(balance_before, 0) <= 0) AS opens_lifecycle FROM balances
),
lifecycle_seqs AS (
  SELECT *, sum(CASE WHEN opens_lifecycle THEN 1 ELSE 0 END) OVER (
    PARTITION BY experiment_id, asset ORDER BY trade_ts, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS lifecycle_seq
  FROM lifecycle_marks
),
lifecycles AS (
  SELECT experiment_id, asset, lifecycle_seq,
    min(trade_ts) FILTER (WHERE opens_lifecycle) AS opening_buy_ts,
    sum(CASE WHEN action = 'BUY' THEN notional ELSE 0 END) AS capital_deployed
  FROM lifecycle_seqs
  GROUP BY experiment_id, asset, lifecycle_seq
),
clean_lifecycles AS (
  SELECT * FROM lifecycles WHERE opening_buy_ts >= :t_clean::timestamptz
)
SELECT
  pe.name AS experiment,
  sum(cl.capital_deployed) AS capital_deployed_post_t_clean
FROM clean_lifecycles cl
JOIN public.paper_experiments pe ON pe.id = cl.experiment_id
WHERE pe.name LIKE 'SHADOW V2: %' OR pe.name LIKE 'SHADOW V3 CAPACITY: %'
GROUP BY pe.name
ORDER BY pe.name;

-- ------------------------------------------------------------------------
-- 13. Realized P&L attributable ONLY to post-T_clean lifecycles: SELL
-- realized_pnl within each clean lifecycle, plus paper_settlements.realized_pnl
-- where the settlement belongs to that (experiment, asset)'s latest -- and
-- therefore only settleable -- lifecycle.
-- ------------------------------------------------------------------------
WITH buysell AS (
  SELECT pt.id, pt.experiment_id, pt.asset, pt.action, pt.shares, pt.notional, pt.realized_pnl,
    to_timestamp(pt.source_ts) AS trade_ts
  FROM public.paper_trades pt
  WHERE pt.action IN ('BUY', 'SELL') AND pt.source_ts IS NOT NULL
),
balances AS (
  SELECT b.*, sum(CASE WHEN action = 'BUY' THEN shares ELSE -shares END) OVER (
    PARTITION BY experiment_id, asset ORDER BY trade_ts, id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
  ) AS balance_before
  FROM buysell b
),
lifecycle_marks AS (
  SELECT *, (action = 'BUY' AND coalesce(balance_before, 0) <= 0) AS opens_lifecycle FROM balances
),
lifecycle_seqs AS (
  SELECT *, sum(CASE WHEN opens_lifecycle THEN 1 ELSE 0 END) OVER (
    PARTITION BY experiment_id, asset ORDER BY trade_ts, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS lifecycle_seq
  FROM lifecycle_marks
),
lifecycles AS (
  SELECT experiment_id, asset, lifecycle_seq,
    min(trade_ts) FILTER (WHERE opens_lifecycle) AS opening_buy_ts,
    sum(CASE WHEN action = 'SELL' THEN realized_pnl ELSE 0 END) AS realized_pnl_from_sells
  FROM lifecycle_seqs
  GROUP BY experiment_id, asset, lifecycle_seq
),
lifecycles_marked AS (
  SELECT l.*, (l.lifecycle_seq = max(l.lifecycle_seq) OVER (PARTITION BY l.experiment_id, l.asset)) AS is_latest_lifecycle
  FROM lifecycles l
),
clean_lifecycles AS (
  SELECT * FROM lifecycles_marked WHERE opening_buy_ts >= :t_clean::timestamptz
),
sell_pnl AS (
  SELECT experiment_id, sum(realized_pnl_from_sells) AS realized_pnl_from_sells
  FROM clean_lifecycles GROUP BY experiment_id
),
settlement_pnl AS (
  SELECT cl.experiment_id, sum(ps.realized_pnl) AS realized_pnl_from_settlements
  FROM clean_lifecycles cl
  JOIN public.paper_settlements ps ON ps.experiment_id = cl.experiment_id AND ps.asset = cl.asset
  WHERE cl.is_latest_lifecycle
  GROUP BY cl.experiment_id
)
SELECT
  pe.name AS experiment,
  coalesce(sp.realized_pnl_from_sells, 0) AS realized_pnl_from_sells,
  coalesce(stp.realized_pnl_from_settlements, 0) AS realized_pnl_from_settlements,
  coalesce(sp.realized_pnl_from_sells, 0) + coalesce(stp.realized_pnl_from_settlements, 0) AS total_post_t_clean_realized_pnl
FROM public.paper_experiments pe
LEFT JOIN sell_pnl sp ON sp.experiment_id = pe.id
LEFT JOIN settlement_pnl stp ON stp.experiment_id = pe.id
WHERE pe.name LIKE 'SHADOW V2: %' OR pe.name LIKE 'SHADOW V3 CAPACITY: %'
ORDER BY pe.name;

-- ------------------------------------------------------------------------
-- 14. Distinct markets (assets) with post-T_clean exposure
-- ------------------------------------------------------------------------
WITH buysell AS (
  SELECT pt.id, pt.experiment_id, pt.asset, pt.action, pt.shares,
    to_timestamp(pt.source_ts) AS trade_ts
  FROM public.paper_trades pt
  WHERE pt.action IN ('BUY', 'SELL') AND pt.source_ts IS NOT NULL
),
balances AS (
  SELECT b.*, sum(CASE WHEN action = 'BUY' THEN shares ELSE -shares END) OVER (
    PARTITION BY experiment_id, asset ORDER BY trade_ts, id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
  ) AS balance_before
  FROM buysell b
),
lifecycle_marks AS (
  SELECT *, (action = 'BUY' AND coalesce(balance_before, 0) <= 0) AS opens_lifecycle FROM balances
),
lifecycle_seqs AS (
  SELECT *, sum(CASE WHEN opens_lifecycle THEN 1 ELSE 0 END) OVER (
    PARTITION BY experiment_id, asset ORDER BY trade_ts, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS lifecycle_seq
  FROM lifecycle_marks
),
lifecycles AS (
  SELECT experiment_id, asset, lifecycle_seq,
    min(trade_ts) FILTER (WHERE opens_lifecycle) AS opening_buy_ts
  FROM lifecycle_seqs
  GROUP BY experiment_id, asset, lifecycle_seq
),
clean_lifecycles AS (
  SELECT * FROM lifecycles WHERE opening_buy_ts >= :t_clean::timestamptz
)
SELECT
  pe.name AS experiment,
  count(DISTINCT cl.asset) AS distinct_markets_with_post_t_clean_exposure
FROM clean_lifecycles cl
JOIN public.paper_experiments pe ON pe.id = cl.experiment_id
WHERE pe.name LIKE 'SHADOW V2: %' OR pe.name LIKE 'SHADOW V3 CAPACITY: %'
GROUP BY pe.name
ORDER BY pe.name;

-- ------------------------------------------------------------------------
-- 15. Number of distinct calendar/trading days (UTC) containing a NEW
-- copied BUY, from T_clean forward
-- ------------------------------------------------------------------------
SELECT
  pe.name AS experiment,
  count(DISTINCT date_trunc('day', pt.created_at)) AS trading_days_with_new_buy
FROM public.paper_experiments pe
JOIN public.paper_trades pt ON pt.experiment_id = pe.id
WHERE (pe.name LIKE 'SHADOW V2: %' OR pe.name LIKE 'SHADOW V3 CAPACITY: %')
  AND pt.action = 'BUY'
  AND pt.created_at >= :t_clean::timestamptz
GROUP BY pe.name
ORDER BY pe.name;

-- ------------------------------------------------------------------------
-- 16. Fillability / slippage metrics where available (public-CLOB
-- copyability sampling; measurement only, see copyability_observations)
-- ------------------------------------------------------------------------
SELECT
  pe.name AS experiment,
  count(*) AS copyability_samples,
  avg(co.slippage_pct) AS avg_slippage_pct,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY co.slippage_pct) AS median_slippage_pct
FROM public.paper_experiments pe
JOIN public.copyability_observations co ON co.experiment_id = pe.id
WHERE (pe.name LIKE 'SHADOW V2: %' OR pe.name LIKE 'SHADOW V3 CAPACITY: %')
  AND co.created_at >= :t_clean::timestamptz
  AND co.slippage_pct IS NOT NULL
GROUP BY pe.name
ORDER BY pe.name;

-- ------------------------------------------------------------------------
-- 18. Current open shares / cost basis (ALL open positions, regardless of
-- when opened — for context alongside the clean-only figures above)
-- ------------------------------------------------------------------------
SELECT
  pe.name AS experiment,
  count(*) AS open_position_count,
  sum(pp.shares) AS current_open_shares,
  sum(pp.cost_basis) AS current_open_cost_basis
FROM public.paper_experiments pe
JOIN public.paper_positions pp ON pp.experiment_id = pe.id
WHERE (pe.name LIKE 'SHADOW V2: %' OR pe.name LIKE 'SHADOW V3 CAPACITY: %')
  AND pp.settlement_status = 'open'
GROUP BY pe.name
ORDER BY pe.name;

-- ------------------------------------------------------------------------
-- 19. Pre-T_clean positions settling/closing after T_clean — LEGACY evidence.
-- Reported separately and MUST be excluded from every clean-sample figure
-- above. This is exactly the case the qualification methodology in
-- docs/V2_V3_VALIDITY.md warns about: a settlement after T_clean does not by
-- itself make a position's lifecycle "clean" if its opening BUY predates
-- T_clean.
-- ------------------------------------------------------------------------
WITH buysell AS (
  SELECT pt.id, pt.experiment_id, pt.asset, pt.action, pt.shares,
    to_timestamp(pt.source_ts) AS trade_ts
  FROM public.paper_trades pt
  WHERE pt.action IN ('BUY', 'SELL') AND pt.source_ts IS NOT NULL
),
balances AS (
  SELECT b.*, sum(CASE WHEN action = 'BUY' THEN shares ELSE -shares END) OVER (
    PARTITION BY experiment_id, asset ORDER BY trade_ts, id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
  ) AS balance_before
  FROM buysell b
),
lifecycle_marks AS (
  SELECT *, (action = 'BUY' AND coalesce(balance_before, 0) <= 0) AS opens_lifecycle FROM balances
),
lifecycle_seqs AS (
  SELECT *, sum(CASE WHEN opens_lifecycle THEN 1 ELSE 0 END) OVER (
    PARTITION BY experiment_id, asset ORDER BY trade_ts, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS lifecycle_seq
  FROM lifecycle_marks
),
lifecycles AS (
  SELECT experiment_id, asset, lifecycle_seq,
    min(trade_ts) FILTER (WHERE opens_lifecycle) AS opening_buy_ts
  FROM lifecycle_seqs
  GROUP BY experiment_id, asset, lifecycle_seq
),
lifecycles_marked AS (
  SELECT l.*, (l.lifecycle_seq = max(l.lifecycle_seq) OVER (PARTITION BY l.experiment_id, l.asset)) AS is_latest_lifecycle
  FROM lifecycles l
),
-- Only the latest lifecycle for an (experiment, asset) can ever hold a
-- settlement (paper_settlements is UNIQUE on experiment_id, asset), so a
-- legacy settlement is one whose latest lifecycle opened before T_clean.
legacy_settleable_lifecycles AS (
  SELECT * FROM lifecycles_marked
  WHERE is_latest_lifecycle AND opening_buy_ts < :t_clean::timestamptz
)
SELECT
  pe.name AS experiment,
  ps.resolution_outcome,
  count(*) AS legacy_settlement_count,
  sum(ps.realized_pnl) AS legacy_realized_pnl
FROM legacy_settleable_lifecycles lp
JOIN public.paper_experiments pe ON pe.id = lp.experiment_id
JOIN public.paper_settlements ps
  ON ps.experiment_id = lp.experiment_id AND ps.asset = lp.asset
WHERE (pe.name LIKE 'SHADOW V2: %' OR pe.name LIKE 'SHADOW V3 CAPACITY: %')
  AND ps.settled_at >= :t_clean::timestamptz
GROUP BY pe.name, ps.resolution_outcome
ORDER BY pe.name, ps.resolution_outcome;
