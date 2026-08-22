-- FINAL BUILD Part 8: durable, versioned, NEVER-overwritten milestone analysis
-- snapshots. UNIQUE(epoch_id, milestone_kind, snapshot_version) means the same
-- (epoch, milestone, code version) combination can only ever be inserted once --
-- re-evaluating under the SAME version is a no-op (checked before insert by
-- snapshot.server.ts), and a genuinely new analysis-code version can only ever ADD a
-- new row, never recompute/replace an old one in place (the mission's own explicit
-- rule).
CREATE TABLE public.sports_shadow_milestone_snapshots (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  experiment_epoch_id uuid NOT NULL REFERENCES public.sports_shadow_experiment_epochs(id),
  milestone_kind text NOT NULL CHECK (milestone_kind IN ('CALIBRATION', 'FINAL_OOS')),
  snapshot_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  frozen_config jsonb NOT NULL,
  report jsonb NOT NULL,
  classification text NOT NULL,
  UNIQUE (experiment_epoch_id, milestone_kind, snapshot_version)
);
CREATE INDEX sports_shadow_milestone_snapshots_epoch_idx ON public.sports_shadow_milestone_snapshots (experiment_epoch_id);
GRANT ALL ON public.sports_shadow_milestone_snapshots TO service_role;
ALTER TABLE public.sports_shadow_milestone_snapshots ENABLE ROW LEVEL SECURITY;
