-- Durable read cursor for a future verified Kalshi trader-activity source.
-- The source adapter is still intentionally unconfigured; this only makes repeated
-- read-only ingestion restart-safe once a supported feed exists.

CREATE TABLE IF NOT EXISTS public.sports_shadow_kalshi_source_cursors (
  trader_id text NOT NULL
    REFERENCES public.sports_shadow_kalshi_trader_qualification(trader_id) ON DELETE CASCADE,
  source_name text NOT NULL,
  last_source_ts bigint NOT NULL DEFAULT 0 CHECK (last_source_ts >= 0),
  last_polled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trader_id, source_name)
);

GRANT ALL ON public.sports_shadow_kalshi_source_cursors TO service_role;
ALTER TABLE public.sports_shadow_kalshi_source_cursors ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.list_approved_sports_shadow_kalshi_traders()
RETURNS TABLE (trader_id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT q.trader_id
  FROM public.sports_shadow_kalshi_trader_qualification q
  WHERE q.approved_for_paper_copy = true
  ORDER BY q.trader_id;
$$;

CREATE OR REPLACE FUNCTION public.get_sports_shadow_kalshi_source_cursor(
  p_trader_id text,
  p_source_name text
)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT c.last_source_ts
      FROM public.sports_shadow_kalshi_source_cursors c
      WHERE c.trader_id = p_trader_id
        AND c.source_name = p_source_name
    ),
    0
  );
$$;

CREATE OR REPLACE FUNCTION public.advance_sports_shadow_kalshi_source_cursor(
  p_trader_id text,
  p_source_name text,
  p_last_source_ts bigint,
  p_polled_at timestamptz
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last_source_ts bigint;
BEGIN
  IF p_last_source_ts < 0 THEN
    RAISE EXCEPTION 'source cursor cannot be negative';
  END IF;

  INSERT INTO public.sports_shadow_kalshi_source_cursors (
    trader_id, source_name, last_source_ts, last_polled_at, updated_at
  ) VALUES (
    p_trader_id, p_source_name, p_last_source_ts, p_polled_at, now()
  )
  ON CONFLICT (trader_id, source_name) DO UPDATE
  SET last_source_ts = GREATEST(
        public.sports_shadow_kalshi_source_cursors.last_source_ts,
        EXCLUDED.last_source_ts
      ),
      last_polled_at = EXCLUDED.last_polled_at,
      updated_at = now()
  RETURNING last_source_ts INTO v_last_source_ts;

  RETURN v_last_source_ts;
END;
$$;

REVOKE ALL ON FUNCTION public.list_approved_sports_shadow_kalshi_traders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_approved_sports_shadow_kalshi_traders() TO service_role;
REVOKE ALL ON FUNCTION public.get_sports_shadow_kalshi_source_cursor(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sports_shadow_kalshi_source_cursor(text,text) TO service_role;
REVOKE ALL ON FUNCTION public.advance_sports_shadow_kalshi_source_cursor(text,text,bigint,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.advance_sports_shadow_kalshi_source_cursor(text,text,bigint,timestamptz) TO service_role;
