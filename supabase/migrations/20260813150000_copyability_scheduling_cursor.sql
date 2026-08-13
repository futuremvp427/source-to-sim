-- Phase 6: durable copyability scheduling cursor.
--
-- The prior scheduler only ever examined the latest SCHEDULE_BATCH paper_trades
-- rows (ORDER BY created_at DESC LIMIT N). Once backlog exceeded that window,
-- older unscheduled trades were permanently stranded: the scan never reached
-- them again. The cursor instead walks paper_trades forward exactly once per
-- row, in stable (created_at, id) order, so a backlog of any size is
-- eventually fully covered and newly inserted trades are always reached once
-- the cursor catches up. Advanced only after a page's scheduling persistence
-- succeeds (see scheduleObservations in observe.server.ts).
ALTER TABLE public.paper_experiments
  ADD COLUMN IF NOT EXISTS copyability_cursor_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS copyability_cursor_id uuid;

-- Supports the cursor's tuple range scan: WHERE experiment_id = :id AND
-- (created_at, id) > (:cursor_created_at, :cursor_id) ORDER BY created_at, id.
CREATE INDEX IF NOT EXISTS paper_trades_experiment_created_id_idx
  ON public.paper_trades (experiment_id, created_at, id);
