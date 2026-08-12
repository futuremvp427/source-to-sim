-- Per-stage duration telemetry for each worker cycle. Diagnostic only: no
-- accounting, bankroll, sizing or qualification semantics are affected.
ALTER TABLE public.worker_status
  ADD COLUMN IF NOT EXISTS stage_ms jsonb;
