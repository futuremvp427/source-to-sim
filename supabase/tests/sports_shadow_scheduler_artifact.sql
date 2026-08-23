-- FINAL BUILD Part 21 (CODEX P2-1 rewrite): proves
-- supabase/scheduler/sports_shadow_pg_cron.sql is syntactically valid, idempotent (safe
-- to re-run), and installs correctly against a REAL locally-migrated Postgres instance.
-- Deliberately does NOT verify any job actually FIRES successfully end-to-end (that
-- requires a real HTTP target and real vault secret values, which is exactly what this
-- artifact defers to a human production deploy step) -- only that the SQL itself is
-- correct and installable.
--
-- CODEX P2-1: the artifact now installs THREE independent jobs (observation/source/
-- settlement -- see the artifact's own doc comment for why) instead of one combined
-- job. This test was rewritten to match: same idempotent-double-apply proof, now
-- asserting all three job names/schedules/timeouts instead of one.
--
-- Not wrapped in BEGIN/ROLLBACK: pg_cron's cron.schedule/unschedule and vault secret
-- operations are not reliably transactional against a surrounding client transaction
-- (the pg_cron background worker reads job state independently), so this test instead
-- does its own explicit cleanup (unschedule + delete the dummy secrets) at the end,
-- regardless of transaction semantics.
--
-- Run via: psql -f supabase/tests/sports_shadow_scheduler_artifact.sql (after
-- `supabase db reset --local`)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

-- Start from a known local-test state, then deliberately seed the pre-split legacy job
-- that existing deployments may still have. The artifact must remove it before
-- installing the current three-job architecture.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname LIKE 'sports-shadow-cycle%';
SELECT cron.schedule(
  'sports-shadow-cycle',
  '30 seconds',
  $$ SELECT 1; $$
);

-- Dummy secrets under the exact names the artifact references -- never real values.
SELECT vault.create_secret('http://localhost:0', 'sports_shadow_project_url');
SELECT vault.create_secret('test-secret-value', 'sports_shadow_hook_secret');

-- Applying the artifact TWICE proves the unschedule-then-schedule pattern is
-- idempotent -- re-running it (e.g. to change any one job's cadence) never creates a
-- duplicate job for any of the three names.
\i supabase/scheduler/sports_shadow_pg_cron.sql
\i supabase/scheduler/sports_shadow_pg_cron.sql

DO $$
DECLARE
  v_job_count integer;
  v_schedule text;
  v_body text;
  v_timeout integer;
BEGIN
  -- JOB 1: observation
  SELECT count(*) INTO v_job_count FROM cron.job WHERE jobname = 'sports-shadow-cycle-observation';
  IF v_job_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 scheduled job named sports-shadow-cycle-observation after applying the artifact twice, got %', v_job_count;
  END IF;
  SELECT schedule INTO v_schedule FROM cron.job WHERE jobname = 'sports-shadow-cycle-observation';
  IF v_schedule <> '10 seconds' THEN
    RAISE EXCEPTION 'expected sports-shadow-cycle-observation schedule ''10 seconds'', got %', v_schedule;
  END IF;
  SELECT command INTO v_body FROM cron.job WHERE jobname = 'sports-shadow-cycle-observation';
  IF v_body NOT LIKE '%/api/public/hooks/sports-shadow-observation%' THEN
    RAISE EXCEPTION 'expected sports-shadow-cycle-observation to target the observation route, got %', v_body;
  END IF;
  IF v_body NOT LIKE '%timeout_milliseconds := 25000%' THEN
    RAISE EXCEPTION 'expected sports-shadow-cycle-observation timeout_milliseconds 25000, got %', v_body;
  END IF;

  -- JOB 2: source
  SELECT count(*) INTO v_job_count FROM cron.job WHERE jobname = 'sports-shadow-cycle-source';
  IF v_job_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 scheduled job named sports-shadow-cycle-source after applying the artifact twice, got %', v_job_count;
  END IF;
  SELECT schedule INTO v_schedule FROM cron.job WHERE jobname = 'sports-shadow-cycle-source';
  IF v_schedule <> '30 seconds' THEN
    RAISE EXCEPTION 'expected sports-shadow-cycle-source schedule ''30 seconds'', got %', v_schedule;
  END IF;
  SELECT command INTO v_body FROM cron.job WHERE jobname = 'sports-shadow-cycle-source';
  -- The source job's URL is the ORIGINAL combined route path (/sports-shadow), which is
  -- also a strict prefix of the observation/settlement routes' own paths -- assert it
  -- targets that route WITHOUT accidentally matching either of those longer paths.
  IF v_body NOT LIKE '%/api/public/hooks/sports-shadow''%' THEN
    RAISE EXCEPTION 'expected sports-shadow-cycle-source to target the base sports-shadow route, got %', v_body;
  END IF;
  IF v_body LIKE '%sports-shadow-observation%' OR v_body LIKE '%sports-shadow-settlement%' THEN
    RAISE EXCEPTION 'sports-shadow-cycle-source must not target the observation or settlement routes, got %', v_body;
  END IF;
  IF v_body NOT LIKE '%timeout_milliseconds := 50000%' THEN
    RAISE EXCEPTION 'expected sports-shadow-cycle-source timeout_milliseconds 50000, got %', v_body;
  END IF;

  -- JOB 3: settlement
  SELECT count(*) INTO v_job_count FROM cron.job WHERE jobname = 'sports-shadow-cycle-settlement';
  IF v_job_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 scheduled job named sports-shadow-cycle-settlement after applying the artifact twice, got %', v_job_count;
  END IF;
  SELECT schedule INTO v_schedule FROM cron.job WHERE jobname = 'sports-shadow-cycle-settlement';
  -- pg_cron's 'N seconds' interval syntax only accepts 1-59 -- standard cron syntax
  -- '* * * * *' is how the artifact expresses "once a minute" for this job.
  IF v_schedule <> '* * * * *' THEN
    RAISE EXCEPTION 'expected sports-shadow-cycle-settlement schedule ''* * * * *'', got %', v_schedule;
  END IF;
  SELECT command INTO v_body FROM cron.job WHERE jobname = 'sports-shadow-cycle-settlement';
  IF v_body NOT LIKE '%/api/public/hooks/sports-shadow-settlement%' THEN
    RAISE EXCEPTION 'expected sports-shadow-cycle-settlement to target the settlement route, got %', v_body;
  END IF;
  IF v_body NOT LIKE '%timeout_milliseconds := 40000%' THEN
    RAISE EXCEPTION 'expected sports-shadow-cycle-settlement timeout_milliseconds 40000, got %', v_body;
  END IF;

  SELECT count(*) INTO v_job_count FROM cron.job WHERE jobname = 'sports-shadow-cycle';
  IF v_job_count <> 0 THEN
    RAISE EXCEPTION 'expected legacy sports-shadow-cycle job to be unscheduled, got %', v_job_count;
  END IF;

  -- Exactly 3 sports-shadow-* jobs total -- no stray fourth job (e.g. a leftover
  -- pre-P2-1 'sports-shadow-cycle' job) left behind by an incomplete migration path.
  SELECT count(*) INTO v_job_count FROM cron.job WHERE jobname LIKE 'sports-shadow-cycle%';
  IF v_job_count <> 3 THEN
    RAISE EXCEPTION 'expected exactly 3 sports-shadow-cycle* jobs total, got %', v_job_count;
  END IF;

  RAISE NOTICE 'sports_shadow_scheduler_artifact.sql: all assertions passed';
END $$;

-- Cleanup: unschedule + remove dummy secrets so this test leaves no persistent side
-- effect on the shared local instance for any later test in the same CI run.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname LIKE 'sports-shadow-cycle%';
DELETE FROM vault.secrets WHERE name IN ('sports_shadow_project_url', 'sports_shadow_hook_secret');
