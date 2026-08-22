-- FINAL BUILD Part 21: Sports Shadow scheduler activation artifact.
--
-- ============================== DO NOT APPLY TO PRODUCTION AUTOMATICALLY ==============================
-- This file lives OUTSIDE supabase/migrations/ deliberately -- `supabase db reset`/
-- migration replay never touches it. It is a deployment-time artifact for a human (or
-- a deliberate, separately-authorized deploy step) to apply by hand, once:
--   1. production pg_cron version is confirmed >= 1.5.0 (required for the 'N seconds'
--      schedule syntax used below -- `SELECT cron.schedule(name, '30 seconds', ...)`);
--   2. production pg_net is confirmed enabled;
--   3. the vault secret named 'sports_shadow_hook_secret' has been created with
--      `select vault.create_secret('<the real SPORTS_SHADOW_HOOK_SECRET value>',
--      'sports_shadow_hook_secret');` -- NEVER the literal secret pasted into this
--      file or any migration;
--   4. the project URL is available the same way (either its own vault secret, or
--      reuse of the project's existing 'project_url' vault secret if General Shadow's
--      own cron job already established one -- see docs/PRODUCTION-HARDENING.md).
-- Even if accidentally applied before SPORTS_SHADOW_ENABLED=true is set in the
-- application's own environment config, this is SAFE by construction: the hook route
-- (src/routes/api/public/hooks/sports-shadow.ts) reads SPORTS_SHADOW_ENABLED from
-- process.env, which this SQL file cannot set, so the cycle immediately no-ops
-- (configEnabled:false) on every invocation until a human separately flips that flag --
-- this is exactly Part 43's "disabled smoke" contract, satisfied structurally.
-- =========================================================================================
--
-- CADENCE: 30 seconds, matching Supabase's own documented pg_cron+pg_net example
-- cadence and General Shadow's proven-in-production 1-minute-scale pattern at half the
-- interval -- NOT chosen merely because the observation plan contains "+5s" (Section
-- 29's own explicit warning against that reasoning). The scheduled INVOCATION cadence
-- only needs to service due observation rows with acceptable measured lateness; the
-- rows' own fire_at timestamps (t0/+5/+10/+30/+60) are what determines correctness, not
-- the poll cadence. 30s is the SAFEST starting point given no production lateness
-- telemetry exists yet for this specific route (Part 29's explicit instruction: "Start
-- with the safest cadence supported by actual production telemetry" -- there is none
-- yet, so start conservative). Revisit only after real +5/+10 lateness p95/p99 is
-- observed via sports_shadow_telemetry_events once soak begins.
--
-- TIMEOUT: net.http_post's own `timeout_milliseconds` is set explicitly below --
-- pg_net's default (5000ms) would abort a real Sports Shadow cycle invocation before it
-- could even complete a single paced upstream request's worst-case bound (see
-- http-rate-limit.server.ts's documented ~20-35s worst case per request). 45000ms gives
-- headroom over SOURCE_LANE_BUDGET_MS (30s) plus one already-started request's own
-- ~12s ceiling, without being so long that a genuinely hung invocation blocks pg_net's
-- worker pool indefinitely.
--
-- OVERLAP SAFETY: not handled here at all -- by design. Two overlapping invocations of
-- this cron job hitting the SAME route concurrently is already made safe by the
-- application's own lease/fencing mechanism (sports-lease.server.ts), exactly the same
-- way General Shadow's own overlapping-invocation tolerance already works. This SQL
-- file does not need pg_cron's own run-history/skip-if-running features.
--
-- CODEX P2-6 RE-VERIFICATION (2026-08-25, full-route timing analysis after the complete
-- remediation pass): 30s cadence / 45000ms timeout REMAIN CORRECT -- neither changes.
-- Reviewed every fix in this pass for a NEW worst-case timing contribution:
--   - Source/matching lane (P1-1 coverage windowing, P1-3 episode lifecycle): windows
--     WHAT Phase 1 fetches within its EXISTING sub-budget, adds no new network calls
--     beyond what was already bounded -- the 30s+12s~=42s worst case this file's own
--     TIMEOUT section already accounts for is unchanged.
--   - Observation lane (P1-2 routing-decision provenance/finalize RPCs): a REAL new risk
--     was found and fixed here, not merely assumed safe -- computePaperFillsForObservation
--     runs synchronously inside takeDueSportsShadowObservations's own per-row loop via
--     onObservationClaimed, and its per-tier RPC round trips originally had NO deadline of
--     their own, which could have extended one row's hold time past
--     OBSERVATION_STAGE_DEADLINE_MS's own ~16s worst-case bound (Task 13I), uncounted by
--     the loop's between-ROW deadline check. FIXED (observation.server.ts,
--     paper.server.ts): the SAME absolute lane deadline now threads through, checked
--     before each of the five tiers -- restores the original ~16s bound rather than
--     requiring a larger one; an interrupted tier's decision is always safe to leave
--     pending for the sibling's own call or the periodic cutoff sweep.
--   - New periodic maintenance tasks added this pass (maybeDecideExpiredRoutingCutoffs)
--     run in worker.server.ts's already-best-effort onCycleComplete hook, the SAME place
--     capability probes and the integrity audit already run -- bounded by their own
--     internal LIMIT (100 rows), not by this file's own timeout, consistent with the
--     existing maintenance-task pattern's own (undocumented-here, pre-existing) timing
--     characteristics.
-- Conclusion: total worst-case cycle time is unchanged from before this remediation pass
-- (~42s source/matching lane + ~16s observation lane, well inside both the 30s cadence's
-- own overlap-safety margin and this file's 45000ms per-invocation pg_net timeout).
--
-- IDEMPOTENT INSTALL/REMOVAL: cron.unschedule is called first so re-running this script
-- (e.g. to change the cadence) never creates a second, duplicate job under the same name.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sports-shadow-cycle';
EXCEPTION
  WHEN OTHERS THEN NULL; -- no existing job under this name yet -- nothing to remove
END $$;

SELECT cron.schedule(
  'sports-shadow-cycle',
  '30 seconds',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'sports_shadow_project_url')
      || '/api/public/hooks/sports-shadow',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sports-shadow-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'sports_shadow_hook_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 45000
  ) AS request_id;
  $$
);

-- Health telemetry (Part 21's own explicit requirement): pg_cron's own run history is
-- already durable in cron.job_run_details -- no separate table needed for "did the
-- scheduler fire." A human/operator can inspect recent runs via:
--   SELECT jobid, status, return_message, start_time, end_time
--   FROM cron.job_run_details
--   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'sports-shadow-cycle')
--   ORDER BY start_time DESC LIMIT 20;
-- Application-level cycle telemetry (durations, lease outcomes, per-lane results) is
-- separately written to sports_shadow_telemetry_events by the route/worker itself.
