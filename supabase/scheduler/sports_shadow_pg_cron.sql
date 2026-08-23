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
-- application's own environment config, this is SAFE by construction: every hook route
-- below reads SPORTS_SHADOW_ENABLED from process.env, which this SQL file cannot set,
-- so every job immediately no-ops (configEnabled:false) on every invocation until a
-- human separately flips that flag -- this is exactly Part 43's "disabled smoke"
-- contract, satisfied structurally.
-- =========================================================================================
--
-- ============================== CODEX P2-1: THREE INDEPENDENT JOBS ==============================
-- ROOT CAUSE (Codex P2-1 finding, re-verified during the FINAL CODEX CLEANUP PASS):
-- the ORIGINAL version of this artifact scheduled exactly ONE cron job
-- ('sports-shadow-cycle') hitting ONE route that ran the FULL combined cycle --
-- observation (both venues) THEN source/matching THEN a final observation catch-pass --
-- sequentially, inside ONE pg_net HTTP call. worker.server.ts's own DEFENSIBLE WORST
-- CASE analysis for each stage is:
--   observation (main pass):        ~16s  (OBSERVATION_STAGE_DEADLINE_MS + one in-flight fetch)
--   source/matching:                 ~42s  (SOURCE_LANE_BUDGET_MS + one in-flight fetch)
--   observation (final +0 catch):   ~14s  (FINAL_OBSERVATION_STAGE_DEADLINE_MS + one in-flight fetch)
--   TOTAL SEQUENTIAL WORST CASE:     ~72s
-- This 72s figure EXCEEDS both the 30s cron cadence (tolerable -- overlap safety is
-- lease-guarded, see below) AND the artifact's own previous 45000ms pg_net timeout --
-- meaning a genuinely slow cycle could have its underlying HTTP request aborted by
-- pg_net mid-execution, an entirely different (and less safe, less observable) failure
-- mode than the application's own internal deadlines, which always stop cleanly and
-- leave state safely retryable.
--
-- FIX: the combined cycle is split into THREE independently scheduled, independently
-- leased, independently deadlined, independently timed-out, independently
-- heartbeat/telemetry'd jobs -- each hitting its OWN route:
--   1. sports-shadow-cycle-observation  -> /api/public/hooks/sports-shadow-observation
--      Runs BOTH venues' observation lanes (worst case ~16s -- see worker.server.ts's
--      OBSERVATION-LANE LATENCY AUDIT) on its own tight cadence, completely independent
--      of the source job's own much slower cadence. No final +0 catch pass is needed
--      here -- this job's own tight, frequent cadence naturally catches any fresh +0
--      row within a few seconds of the source job creating it, without needing a second
--      pass appended to any single invocation.
--   2. sports-shadow-cycle-source       -> /api/public/hooks/sports-shadow
--      Runs ONLY the source/matching lane (worst case ~42s) -- never runs observation at
--      all, so it can never be the reason an observation row is captured late.
--   3. sports-shadow-cycle-settlement   -> /api/public/hooks/sports-shadow-settlement
--      NEW: wires runSettlementBatch (settlement.orchestrator.server.ts) into an actual
--      production call site for the first time -- it had none before this pass. Worst
--      case ~30s (SETTLEMENT_BATCH_BUDGET_MS + one in-flight ~10s settlement check).
-- Each job's own lease (OBSERVATION_LOCK_ID_PMUS/KALSHI, SOURCE_LOCK_ID,
-- SETTLEMENT_LOCK_ID) is completely independent of the other two -- a slow/backlogged
-- job can never block or delay either of the other two from acquiring ITS OWN lease and
-- running on ITS OWN schedule. Each job's own pg_net timeout_milliseconds is now sized
-- with real headroom over ONLY that job's own worst case (never the old combined-cycle
-- figure), so a genuinely slow invocation of any one job can complete cleanly via its
-- own internal deadline well before pg_net would ever consider aborting it.
-- ================================================================================
--
-- OVERLAP SAFETY: not handled by pg_cron's own run-history/skip-if-running features for
-- any of the three jobs -- by design, unchanged from the original single-job artifact.
-- Two overlapping invocations of the SAME job hitting the SAME route concurrently are
-- already made safe by that job's own lease/fencing mechanism (sports-lease.server.ts),
-- exactly the same way General Shadow's own overlapping-invocation tolerance already
-- works. Two DIFFERENT jobs (e.g. observation and source) running concurrently is not
-- "overlap" at all in the sense this section means -- they were always designed to
-- coexist via fully independent leases, even back when both ran inside one combined
-- invocation (Task 12H/P1-N's per-venue observation isolation; Task 12F/P1-G's
-- independent source lease).
--
-- IDEMPOTENT INSTALL/REMOVAL: cron.unschedule is called first for each current job name
-- AND the legacy combined job name ('sports-shadow-cycle'), so re-running this script
-- (e.g. to change any one job's cadence) never creates duplicates and never leaves the
-- old fourth source invocation behind in an existing deployment.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('sports-shadow-cycle', 'sports-shadow-cycle-observation', 'sports-shadow-cycle-source', 'sports-shadow-cycle-settlement');
EXCEPTION
  WHEN OTHERS THEN NULL; -- no existing job under these names yet -- nothing to remove
END $$;

-- JOB 1: OBSERVATION (worst case ~16s). Tight cadence -- the whole point of splitting
-- this out is to let it run frequently and independently of the much slower source job.
-- timeout_milliseconds (25000ms) gives comfortable headroom over the ~16s worst case
-- without being so long that a genuinely hung invocation blocks pg_net's worker pool
-- for materially longer than the job's own cadence.
SELECT cron.schedule(
  'sports-shadow-cycle-observation',
  '10 seconds',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'sports_shadow_project_url')
      || '/api/public/hooks/sports-shadow-observation',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sports-shadow-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'sports_shadow_hook_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  ) AS request_id;
  $$
);

-- JOB 2: SOURCE/MATCHING (worst case ~42s). Same 30s cadence and same reasoning the
-- original combined job used for this lane specifically -- see SOURCE_LANE_BUDGET_MS's
-- own doc comment (worker.server.ts) for why 30s is the safest starting cadence absent
-- real production lateness telemetry. timeout_milliseconds (50000ms) gives headroom
-- over the ~42s worst case for JUST this lane, now that it never has to also account
-- for a sequential observation pass on either side of it.
SELECT cron.schedule(
  'sports-shadow-cycle-source',
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
    timeout_milliseconds := 50000
  ) AS request_id;
  $$
);

-- JOB 3: SETTLEMENT (worst case ~30s, new). A settled/PENDING position's own recheck
-- backoff (10min-6h, see computeNextSettlementCheckAtMs) already spaces individual
-- positions out generously -- a once-a-minute cadence is conservative headroom for a
-- lane that has never run in production before, matching SOURCE_LEASE_TTL_SECONDS's own
-- cadence. pg_cron's 'N seconds' interval syntax only accepts 1-59 -- standard cron
-- syntax '* * * * *' is the correct way to express exactly once per minute.
-- timeout_milliseconds (40000ms) gives headroom over the ~30s worst case.
SELECT cron.schedule(
  'sports-shadow-cycle-settlement',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'sports_shadow_project_url')
      || '/api/public/hooks/sports-shadow-settlement',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sports-shadow-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'sports_shadow_hook_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 40000
  ) AS request_id;
  $$
);

-- Health telemetry (Part 21's own explicit requirement, now per-job): pg_cron's own run
-- history is already durable in cron.job_run_details -- no separate table needed for
-- "did each job fire." A human/operator can inspect recent runs via:
--   SELECT j.jobname, r.status, r.return_message, r.start_time, r.end_time
--   FROM cron.job_run_details r JOIN cron.job j ON j.jobid = r.jobid
--   WHERE j.jobname IN ('sports-shadow-cycle-observation', 'sports-shadow-cycle-source', 'sports-shadow-cycle-settlement')
--   ORDER BY r.start_time DESC LIMIT 60;
-- Application-level per-job telemetry (durations, lease outcomes, per-lane results) is
-- separately written to sports_shadow_telemetry_events by each job's own route/worker
-- function -- SYSTEM/cycle_duration_ms for the source job (unchanged from before this
-- pass, preserving soak.server.ts's existing rollup semantics exactly), SYSTEM/
-- observation_cycle_duration_ms for the observation job, and SYSTEM/
-- settlement_cycle_duration_ms for the settlement job -- each with its own independent
-- "scheduler_stopped:<job>" staleness alert (worker.server.ts).
