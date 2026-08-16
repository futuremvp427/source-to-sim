-- Harden public.record_http_rate_limit's execution privileges.
--
-- Production evidence (post-deploy): despite the original migration
-- (20260815160000_http_rate_limit_cooldown.sql) issuing
-- `REVOKE ALL ... FROM PUBLIC` immediately after CREATE FUNCTION,
-- production's actual EXECUTE grants ended up including anon and
-- authenticated alongside service_role. This is the exact same gap already
-- hit once before in this repo for acquire_worker_lease: its first hardening
-- migration (20260807222552_527a3a82-...) also only revoked FROM PUBLIC, and
-- a follow-up migration (20260807222615_9916bbd2-...) had to explicitly
-- REVOKE ALL ... FROM anon and REVOKE ALL ... FROM authenticated by name,
-- because a bare PUBLIC revoke does not remove EXECUTE that anon/authenticated
-- hold directly (Supabase's platform grants these roles EXECUTE on newly
-- created public-schema functions independent of PUBLIC's own privileges).
-- Every RPC hardening migration since 20260808155820 has used the combined
-- `FROM PUBLIC, anon, authenticated` form for exactly this reason; this one
-- adopts it for record_http_rate_limit.
--
-- This is security-sensitive specifically because an untrusted anon/
-- authenticated caller must never be able to place data-api.polymarket.com
-- into a durable rate-limit cooldown (which would silently defer every V2/V3
-- and General Shadow ingestion cycle without ever having triggered a real
-- 429).
--
-- SECURITY DEFINER is preserved (still required: the function must write to
-- http_rate_limits regardless of the caller's own table privileges, exactly
-- like acquire_worker_lease/process_source_event_atomic). search_path stays
-- fixed to `public` (unchanged from the original migration; still required
-- so an unqualified `http_rate_limits` reference cannot be hijacked by a
-- schema earlier in a caller-controlled search_path).
--
-- Defense-in-depth: because production already demonstrated that a single
-- REVOKE statement is not durably trustworthy on its own, the function body
-- is also changed from LANGUAGE sql to LANGUAGE plpgsql to add a runtime
-- guard using Supabase's own auth.role() helper (already relied on
-- elsewhere in this project for RLS -- see auth.uid() usage in
-- 20260808152339 and 20260815120000). auth.role() reads the
-- request.jwt.claim(s) GUC that PostgREST sets per request from the
-- caller's API key/JWT; unlike current_user (which reflects this function's
-- OWNER once SECURITY DEFINER has elevated execution, not the caller) it is
-- unaffected by that elevation and reliably reflects who actually called in
-- via PostgREST. A NULL role (no PostgREST JWT context at all -- a direct
-- psql/superuser session, e.g. this repo's own schema-contract CI or a
-- migration replay) is allowed through: such a caller already bypasses
-- table/function grants entirely by definition, so gating on it would not
-- add real security, only break legitimate direct-SQL tooling. The guard
-- therefore targets exactly the demonstrated failure mode: an
-- anon/authenticated PostgREST caller that, despite the GRANT/REVOKE below,
-- somehow retains EXECUTE.
CREATE OR REPLACE FUNCTION public.record_http_rate_limit(
  p_host text,
  p_blocked_until timestamptz,
  p_reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'record_http_rate_limit: service_role required, got %', auth.role()
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.http_rate_limits (host, blocked_until, reason, updated_at)
  VALUES (p_host, p_blocked_until, p_reason, now())
  ON CONFLICT (host) DO UPDATE SET
    blocked_until = GREATEST(public.http_rate_limits.blocked_until, excluded.blocked_until),
    reason = excluded.reason,
    updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.record_http_rate_limit(text, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_http_rate_limit(text, timestamptz, text) TO service_role;
