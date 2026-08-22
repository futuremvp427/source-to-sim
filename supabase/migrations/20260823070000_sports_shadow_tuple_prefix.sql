-- FINAL BUILD, Part 2: closes the last known degraded-tuple liveness residual that
-- Task 13G intentionally left open (documented in source-poll.server.ts's
-- countDurableOrdinalFills doc comment): a page with many distinct degraded event
-- tuple prefixes requires one exact-count query PER PREFIX (chunked concurrently at
-- RECONCILE_PREFIX_CAP=25), so a page with more distinct prefixes than the shared
-- deadline allows chunks for can repeatedly fail to fully reconcile.
--
-- FIX: an indexed, GENERATED (not separately maintained -- cannot drift from
-- event_key) `tuple_prefix` column lets an entire page's distinct prefixes be counted
-- in ONE bounded grouped query instead of one request per prefix.
--
-- tuple_prefix is populated ONLY for degraded ("ord:...#N") event keys -- see
-- shadow-core.ts's normalizeSourceEvents: a degraded key is built as
-- `ord:${txHash}:${asset}:${side}:${sourceTs}:${shares}:${price}#${n}`, where the
-- trailing `#${n}` is the per-poll ordinal disambiguator. tuple_prefix strips exactly
-- the digits after the LAST `#` but keeps the `#` itself -- matching
-- source-poll.server.ts's existing `ordinalPrefix()` helper's convention
-- (`eventKey.slice(0, eventKey.lastIndexOf("#") + 1)`) byte-for-byte, so
-- `reconcileDegradedEvents`'s already-built prefix strings (`[...groups.keys()]`,
-- built by that exact helper) need no changes at any call site to match this column's
-- values. Native-id (`sid:...`) and tx-hash/log-index (`tx:...`) keys are reliable on
-- their own and never need prefix counting, so tuple_prefix is NULL for them -- this
-- migration does not touch how those event keys are computed or matched at all.
--
-- Implementation note: computed via position()/reverse()/left()/length() rather than
-- a regex (substring(... from pattern)) specifically to avoid any ambiguity about
-- whether Postgres's regex-based text functions are classified IMMUTABLE (a
-- requirement for STORED generated columns) on every supported build -- these four
-- built-ins have been IMMUTABLE since core Postgres and carry no such risk.
--
-- Existing rows: ADD COLUMN ... GENERATED ALWAYS AS (...) STORED computes and
-- backfills every existing row's value as part of this single statement (a table
-- rewrite under ACCESS EXCLUSIVE lock, same as any STORED generated column addition)
-- -- no separate backfill step, no data loss, no change to any existing column or to
-- event_key/identity semantics. Native-ID and reliable tx-hash/log-index rows are
-- entirely unaffected (their tuple_prefix is simply NULL, exactly as newly-inserted
-- rows of the same kind will be).
ALTER TABLE public.sports_shadow_source_fills
  ADD COLUMN tuple_prefix text GENERATED ALWAYS AS (
    CASE
      WHEN event_key LIKE 'ord:%' AND position('#' in event_key) > 0
        -- Keeps the trailing '#' itself, strips only the ordinal digits after it --
        -- see ordinalPrefix()'s identical convention in source-poll.server.ts.
        THEN left(event_key, length(event_key) - position('#' in reverse(event_key)) + 1)
      ELSE NULL
    END
  ) STORED;

-- Partial index: only degraded rows ever get looked up by tuple_prefix, so indexing
-- only WHERE tuple_prefix IS NOT NULL keeps the index small and keeps the (far more
-- common, per Task 13's own findings) native-id/reliable rows out of it entirely.
CREATE INDEX sports_shadow_source_fills_wallet_tuple_prefix_idx
  ON public.sports_shadow_source_fills (wallet, tuple_prefix)
  WHERE tuple_prefix IS NOT NULL;

-- Replaces countDurableOrdinalFills's one-`.like()`-query-per-prefix loop (still
-- present in source-poll.server.ts prior to this migration's application-code
-- follow-up commit) with a single grouped, exact, bounded count across every
-- requested prefix at once. Prefixes with zero durable rows simply do not appear in
-- the result set -- the caller (unchanged contract) treats an absent key as count 0,
-- identical to today's per-prefix query returning count 0.
--
-- SECURITY INVOKER (read-only, single SELECT, LANGUAGE sql) -- same rationale as
-- find_pending_sports_shadow_signals in 20260820230000: RLS-enabled-no-policy on the
-- underlying table means a non-service_role caller sees zero rows regardless, so
-- INVOKER is defense-in-depth on top of the REVOKE/GRANT below, not a substitute for it.
CREATE OR REPLACE FUNCTION public.count_durable_ordinal_fills(
  p_wallet text,
  p_tuple_prefixes text[]
)
RETURNS TABLE (
  tuple_prefix text,
  fill_count bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT f.tuple_prefix, COUNT(*)::bigint AS fill_count
  FROM public.sports_shadow_source_fills f
  WHERE f.wallet = p_wallet
    AND f.tuple_prefix = ANY(COALESCE(p_tuple_prefixes, ARRAY[]::text[]))
  GROUP BY f.tuple_prefix;
$$;

REVOKE ALL ON FUNCTION public.count_durable_ordinal_fills(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_durable_ordinal_fills(text, text[]) TO service_role;
