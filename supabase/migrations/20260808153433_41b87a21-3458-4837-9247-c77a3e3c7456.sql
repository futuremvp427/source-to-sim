-- alerts de-duplication key (dedup_key is nullable; only non-null keys de-duplicate)
DELETE FROM public.alerts a
USING public.alerts b
WHERE a.dedup_key IS NOT NULL
  AND a.dedup_key = b.dedup_key
  AND a.created_at < b.created_at;

CREATE UNIQUE INDEX IF NOT EXISTS alerts_dedup_key_key
  ON public.alerts (dedup_key)
  WHERE dedup_key IS NOT NULL;

-- one current research row per candidate
DELETE FROM public.candidate_metrics a
USING public.candidate_metrics b
WHERE a.candidate_id = b.candidate_id AND a.computed_at < b.computed_at;

DELETE FROM public.candidate_fingerprint a
USING public.candidate_fingerprint b
WHERE a.candidate_id = b.candidate_id AND a.computed_at < b.computed_at;

DELETE FROM public.candidate_scores a
USING public.candidate_scores b
WHERE a.candidate_id = b.candidate_id AND a.computed_at < b.computed_at;

CREATE UNIQUE INDEX IF NOT EXISTS candidate_metrics_candidate_id_key
  ON public.candidate_metrics (candidate_id);
CREATE UNIQUE INDEX IF NOT EXISTS candidate_fingerprint_candidate_id_key
  ON public.candidate_fingerprint (candidate_id);
CREATE UNIQUE INDEX IF NOT EXISTS candidate_scores_candidate_id_key
  ON public.candidate_scores (candidate_id);