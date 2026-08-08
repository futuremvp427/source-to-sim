DROP INDEX IF EXISTS public.alerts_dedup_key_key;
CREATE UNIQUE INDEX alerts_dedup_key_key ON public.alerts (dedup_key);