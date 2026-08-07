ALTER TABLE public.paper_experiments
  ADD COLUMN IF NOT EXISTS follow_from_ts bigint;

ALTER TABLE public.source_events
  ADD COLUMN IF NOT EXISTS backfilled boolean NOT NULL DEFAULT false;