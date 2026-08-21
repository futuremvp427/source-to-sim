-- Task 12F / P1-H: permanently-UNVERIFIED fills starve the downstream retry batch.
--
-- ROOT CAUSE: findPendingDownstreamFills reads downstream_status='PENDING' ORDER BY
-- source_ts ASC LIMIT 500. A fill whose Gamma metadata classifies as a deterministic
-- semantic UNVERIFIED reason (e.g. UNVERIFIED_UNKNOWN_TEAM) stayed PENDING forever --
-- retrying it reproduces the identical result every time, since it depends only on that
-- conditionId's own immutable market record. Enough old such rows permanently occupy the
-- oldest-500 batch, starving newer, genuinely-retryable fills.
--
-- FIX: an explicit TERMINAL_UNVERIFIED downstream_status, reached only for the reason
-- codes eligibility.ts's classifyUnverifiedDisposition (Task 12F/P1-H) classifies as
-- TERMINAL -- i.e. only after a successfully-parsed Gamma response. Genuinely transient
-- reasons (UNVERIFIED_FETCH_FAILED/EMPTY_RESPONSE/MALFORMED_RESPONSE) are UNCHANGED and
-- remain PENDING. downstream_unverified_reason durably retains the exact reason code for
-- later audit/accounting -- terminal-unverified evidence is never deleted, never
-- reclassified as TERMINAL_INELIGIBLE (which means something different: a positive
-- determination of ineligibility, not "we could not verify"), and can never produce a
-- source signal (the fill simply stops occupying PENDING retry capacity).
--
-- Additive only, per this task's explicit instruction to never retroactively edit an
-- already-existing migration (20260821040000_sports_shadow_fill_retry.sql, which
-- originally defined downstream_status, is left untouched).
ALTER TABLE public.sports_shadow_source_fills
  DROP CONSTRAINT sports_shadow_source_fills_downstream_status_check;

ALTER TABLE public.sports_shadow_source_fills
  ADD CONSTRAINT sports_shadow_source_fills_downstream_status_check
    CHECK (downstream_status IN ('PENDING', 'COMPLETE', 'TERMINAL_INELIGIBLE', 'TERMINAL_INVALID', 'TERMINAL_UNVERIFIED'));

ALTER TABLE public.sports_shadow_source_fills
  ADD COLUMN downstream_unverified_reason text;
