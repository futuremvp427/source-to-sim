CREATE TABLE public.compatibility_checks (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  source_event_id uuid REFERENCES public.source_events(id) ON DELETE SET NULL,
  source_market text,
  source_slug text,
  compatibility_status text NOT NULL DEFAULT 'NO_MATCH',
  matched_us_market text,
  reason text,
  checks integer NOT NULL DEFAULT 1,
  checked_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
GRANT ALL ON public.compatibility_checks TO service_role;
ALTER TABLE public.compatibility_checks ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.us_market_scans (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  scanned_at timestamp with time zone NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'ok',
  relevant_count integer NOT NULL DEFAULT 0,
  new_count integer NOT NULL DEFAULT 0,
  slugs jsonb,
  detail text
);
CREATE INDEX us_market_scans_scanned_at_idx ON public.us_market_scans (scanned_at DESC);
GRANT ALL ON public.us_market_scans TO service_role;
ALTER TABLE public.us_market_scans ENABLE ROW LEVEL SECURITY;