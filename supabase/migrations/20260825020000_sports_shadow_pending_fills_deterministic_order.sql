-- CODEX P2-1: tied source_ts queue order is nondeterministic.
--
-- findPendingDownstreamFills's oldest/newest slices ordered ONLY by source_ts, with no
-- secondary tie-breaker. Rows sharing an identical source_ts (a real, not merely
-- theoretical, case for a wallet with bulk-imported/degraded-identity history) had no
-- guaranteed stable relative order across repeated calls -- risking a large tied group
-- never converging (the same arbitrary subset could keep winning the bounded slice
-- forever, or the excluded remainder could never be reached) rather than making the
-- deterministic forward progress the bounded-batch design otherwise relies on.
--
-- FIX (application-side, source-poll.server.ts): both slices now add `id` as a secondary,
-- total-order tie-breaker (oldest ascending, newest descending -- matching each query's
-- own primary direction so the two slices remain a consistent, deterministic partition of
-- the same total order). This index extends the existing pending-fills index with that
-- same trailing column so the added ORDER BY does not require a separate sort step.
DROP INDEX IF EXISTS public.sports_shadow_source_fills_pending_idx;
CREATE INDEX sports_shadow_source_fills_pending_idx
  ON public.sports_shadow_source_fills (wallet, source_ts, id)
  WHERE downstream_status = 'PENDING';
