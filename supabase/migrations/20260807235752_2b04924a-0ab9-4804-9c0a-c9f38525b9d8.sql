CREATE TABLE public.candidate_watchlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle text NOT NULL UNIQUE,
  wallet text,
  wallet_resolved boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'USER_OBSERVED_WEEKLY_LEADERBOARD_SNAPSHOT',
  status text NOT NULL DEFAULT 'RESEARCH',
  notes text,
  weekly_snapshot_rank integer,
  weekly_snapshot_pnl numeric,
  promoted_experiment_id uuid REFERENCES public.paper_experiments(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.candidate_watchlist TO service_role;
ALTER TABLE public.candidate_watchlist ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.candidate_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES public.candidate_watchlist(id) ON DELETE CASCADE,
  computed_at timestamptz NOT NULL DEFAULT now(),
  coverage_start timestamptz,
  coverage_end timestamptz,
  sample_count integer NOT NULL DEFAULT 0,
  completeness numeric,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX candidate_metrics_candidate_key ON public.candidate_metrics (candidate_id);
GRANT ALL ON public.candidate_metrics TO service_role;
ALTER TABLE public.candidate_metrics ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.candidate_fingerprint (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES public.candidate_watchlist(id) ON DELETE CASCADE,
  computed_at timestamptz NOT NULL DEFAULT now(),
  bot_likelihood numeric,
  bot_label text NOT NULL DEFAULT 'BEHAVIORAL / PROBABILISTIC',
  fingerprint jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX candidate_fingerprint_candidate_key ON public.candidate_fingerprint (candidate_id);
GRANT ALL ON public.candidate_fingerprint TO service_role;
ALTER TABLE public.candidate_fingerprint ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.candidate_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES public.candidate_watchlist(id) ON DELETE CASCADE,
  computed_at timestamptz NOT NULL DEFAULT now(),
  mirror_similarity numeric,
  profit_quality numeric,
  copyability numeric,
  consistency numeric,
  capacity numeric,
  final_score numeric,
  score_status text NOT NULL DEFAULT 'SCORED',
  completeness jsonb NOT NULL DEFAULT '{}'::jsonb,
  strengths jsonb NOT NULL DEFAULT '[]'::jsonb,
  risks jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE UNIQUE INDEX candidate_scores_candidate_key ON public.candidate_scores (candidate_id);
GRANT ALL ON public.candidate_scores TO service_role;
ALTER TABLE public.candidate_scores ENABLE ROW LEVEL SECURITY;