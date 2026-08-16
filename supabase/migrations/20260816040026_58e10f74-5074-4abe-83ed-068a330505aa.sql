-- Host-level rate-limit cooldown, shared across scheduler invocations.
--
-- Phase 1 of the 429 incident deduplicated identical /trades requests
-- within a single runIngestCycle invocation, but every scheduler tick is a
-- fresh invocation with no memory of the previous one -- so a 429 seen on
-- tick N was independently rediscovered by every experiment on tick N+1,
-- N+2, etc. This table gives ingestion (V2/V3 and General Shadow alike) a
-- durable, host-scoped cooldown that survives across ticks: the first 429
-- observed anywhere records a short blocked_until, and every experiment
-- checks it before touching data-api.polymarket.com again, instead of each
-- one rediscovering the limit on its own.
--
-- Never touches paper accounting, checkpoints, bankrolls, settlements, or
-- live-trading state -- this table exists purely to pace outbound HTTP
-- requests to one external host.
--
-- IF NOT EXISTS (2026-08-16, reliability-cleanup-pre-aug21 PR): this file is
-- a Lovable auto-sync duplicate of 20260815160000_http_rate_limit_cooldown.sql
-- -- both were committed to this repo with the same CREATE TABLE content, so
-- a clean migration replay (schema-contract CI, or any fresh environment)
-- always failed on this statement with "relation already exists" once the
-- earlier migration had already created the table. This guard makes replay
-- idempotent without changing anything about what either migration actually
-- creates; it is a no-op wherever this file previously succeeded (there is
-- no evidence it ever ran as raw SQL against a database that already had
-- this table -- the identical failure reproduced here on a byte-for-byte
-- fresh replay), so this cannot alter production's already-applied schema.
CREATE TABLE IF NOT EXISTS public.http_rate_limits (
  host text NOT NULL PRIMARY KEY,
  blocked_until timestamptz,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.http_rate_limits TO service_role;
ALTER TABLE public.http_rate_limits ENABLE ROW LEVEL SECURITY;

-- Atomically extends (never shortens) a host's cooldown. Mirrors the
-- acquire_worker_lease pattern already used for lease fencing: a single SQL
-- statement decides the outcome, so two experiments recording a 429 for the
-- same host in the same tick converge on the longer cooldown instead of one
-- write clobbering the other.
CREATE OR REPLACE FUNCTION public.record_http_rate_limit(
  p_host text,
  p_blocked_until timestamptz,
  p_reason text
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.http_rate_limits (host, blocked_until, reason, updated_at)
  VALUES (p_host, p_blocked_until, p_reason, now())
  ON CONFLICT (host) DO UPDATE SET
    blocked_until = GREATEST(public.http_rate_limits.blocked_until, excluded.blocked_until),
    reason = excluded.reason,
    updated_at = now();
$$;

REVOKE ALL ON FUNCTION public.record_http_rate_limit(text, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_http_rate_limit(text, timestamptz, text) TO service_role;