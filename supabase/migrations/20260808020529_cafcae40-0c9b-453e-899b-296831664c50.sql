ALTER TABLE public.paper_experiments
  ADD COLUMN IF NOT EXISTS sizing_rule text NOT NULL DEFAULT 'dynamic-v1',
  ADD COLUMN IF NOT EXISTS sizing_rule_updated_at timestamp with time zone NOT NULL DEFAULT now();
UPDATE public.paper_experiments SET sizing_rule = 'dynamic-v1', sizing_rule_updated_at = now();