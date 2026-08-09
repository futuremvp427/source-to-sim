-- Persist settlement scan progress so coverage depends on completed scans,
-- never on wall-clock minute parity. This keeps the 25-position lookup budget
-- while preventing a stable open position from starving when cron cycles are
-- irregular or skipped.
ALTER TABLE public.paper_experiments
  ADD COLUMN IF NOT EXISTS settlement_cursor_asset text;
