-- FINAL BUILD Part 7 (repository-completion pass): scalable, authoritative per-epoch
-- milestone counters. The dashboard previously derived milestone counts (raw episodes,
-- independent clusters, settled-independent count) from a query bounded to the most
-- recent 500 sports_shadow_signals rows -- correct only while the experiment stays
-- under that window, silently wrong once it grows past it. This indexed SQL aggregate
-- computes the COMPLETE-epoch counts server-side (via sports_shadow_signals'
-- experiment_epoch_id and cluster_key indexes, and sports_shadow_paper_fills'
-- experiment_epoch_id index -- see 20260823090000), so dashboard.server.ts's own read
-- stays a single bounded RPC call regardless of how large the epoch has grown.
--
-- Independent-cluster counting mirrors independence.ts's own fallback rule exactly:
-- a signal with no cluster_key (missing team/schedule identity) is its own singleton
-- cluster, via COALESCE(cluster_key, id::text) -- never merged into one giant "unknown"
-- bucket, never silently dropped.
--
-- Codex review (commit fa34d0f) caught a real P1: "settled" was determined from
-- sports_shadow_signals.status LIKE 'SETTLED%', but settlement.orchestrator.server.ts
-- NEVER writes that column -- settlement outcome lives exclusively on
-- sports_shadow_settlements.settlement_status. signals.status only ever reaches
-- 'OPEN'/'BURST_COMPLETE' in the real pipeline, so every settled-count/independent-
-- settled-count value would be permanently zero, and CALIBRATION/OOS could never
-- reach their gates. Fixed by deriving "settled" from an EXISTS against
-- sports_shadow_settlements instead (a signal counts as settled once ANY of its tiers
-- has settled -- all tiers of one signal settle to the identical real-world game
-- outcome, so any one settled tier is sufficient evidence).
CREATE OR REPLACE FUNCTION public.get_sports_shadow_epoch_counters(p_epoch_id uuid)
RETURNS TABLE (
  raw_episode_count bigint,
  independent_episode_count bigint,
  settled_independent_count bigint,
  settled_count bigint,
  rejected_count bigint,
  calibration_independent_settled_count bigint,
  oos_independent_settled_count bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH epoch_row AS (
    SELECT calibration_started_at, oos_started_at
    FROM public.sports_shadow_experiment_epochs
    WHERE id = p_epoch_id
  ),
  sig AS (
    SELECT
      s.id,
      s.created_at,
      COALESCE(s.cluster_key, s.id::text) AS effective_cluster,
      EXISTS (
        SELECT 1 FROM public.sports_shadow_settlements st
        WHERE st.signal_id = s.id AND st.settlement_status LIKE 'SETTLED%'
      ) AS is_settled
    FROM public.sports_shadow_signals s
    WHERE s.experiment_epoch_id = p_epoch_id
  )
  SELECT
    (SELECT count(*) FROM sig)::bigint AS raw_episode_count,
    (SELECT count(DISTINCT effective_cluster) FROM sig)::bigint AS independent_episode_count,
    (SELECT count(DISTINCT effective_cluster) FROM sig WHERE is_settled)::bigint AS settled_independent_count,
    (SELECT count(*) FROM sig WHERE is_settled)::bigint AS settled_count,
    (SELECT count(DISTINCT pf.signal_id) FROM public.sports_shadow_paper_fills pf
      WHERE pf.experiment_epoch_id = p_epoch_id AND pf.fill_status = 'REJECTED')::bigint AS rejected_count,
    (SELECT count(DISTINCT sig.effective_cluster) FROM sig, epoch_row
      WHERE sig.is_settled AND epoch_row.calibration_started_at IS NOT NULL
        AND sig.created_at >= epoch_row.calibration_started_at
        AND (epoch_row.oos_started_at IS NULL OR sig.created_at < epoch_row.oos_started_at)
    )::bigint AS calibration_independent_settled_count,
    (SELECT count(DISTINCT sig.effective_cluster) FROM sig, epoch_row
      WHERE sig.is_settled AND epoch_row.oos_started_at IS NOT NULL
        AND sig.created_at >= epoch_row.oos_started_at
    )::bigint AS oos_independent_settled_count;
$$;

REVOKE ALL ON FUNCTION public.get_sports_shadow_epoch_counters(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_sports_shadow_epoch_counters(uuid) TO service_role;
