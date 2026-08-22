-- FINAL BUILD Part 21: proves supabase/scheduler/sports_shadow_pg_cron.sql is
-- syntactically valid, idempotent (safe to re-run), and installs correctly against a
-- REAL locally-migrated Postgres instance. Deliberately does NOT verify the job
-- actually FIRES successfully end-to-end (that requires a real HTTP target and real
-- vault secret values, which is exactly what this artifact defers to a human
-- production deploy step) -- only that the SQL itself is correct and installable.
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

-- Dummy secrets under the exact names the artifact references -- never real values.
SELECT vault.create_secret('http://localhost:0', 'sports_shadow_project_url');
SELECT vault.create_secret('test-secret-value', 'sports_shadow_hook_secret');

-- Applying the artifact TWICE proves the unschedule-then-schedule pattern is
-- idempotent -- re-running it (e.g. to change cadence) never creates a duplicate job.
\i supabase/scheduler/sports_shadow_pg_cron.sql
\i supabase/scheduler/sports_shadow_pg_cron.sql

DO $$
DECLARE
  v_job_count integer;
  v_schedule text;
BEGIN
  SELECT count(*) INTO v_job_count FROM cron.job WHERE jobname = 'sports-shadow-cycle';
  IF v_job_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 scheduled job named sports-shadow-cycle after applying the artifact twice, got %', v_job_count;
  END IF;

  SELECT schedule INTO v_schedule FROM cron.job WHERE jobname = 'sports-shadow-cycle';
  IF v_schedule <> '30 seconds' THEN
    RAISE EXCEPTION 'expected schedule ''30 seconds'', got %', v_schedule;
  END IF;

  RAISE NOTICE 'sports_shadow_scheduler_artifact.sql: all assertions passed';
END $$;

-- Cleanup: unschedule + remove dummy secrets so this test leaves no persistent side
-- effect on the shared local instance for any later test in the same CI run.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sports-shadow-cycle';
DELETE FROM vault.secrets WHERE name IN ('sports_shadow_project_url', 'sports_shadow_hook_secret');
