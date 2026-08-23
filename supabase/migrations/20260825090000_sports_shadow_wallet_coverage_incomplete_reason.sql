-- CODEX P1-1 (round 2): source coverage is now a CONTINUOUS invariant, not a one-time
-- bootstrap property -- source-poll.server.ts can downgrade coverage_complete back to
-- false at ANY time (a steady-state overlap search exhausting the /trades offset ceiling
-- without finding overlap, proving more than MAX_TRADES_OFFSET new trades accumulated
-- since the last proven watermark). incomplete_reason persists the human-readable "why"
-- alongside that downgrade -- Codex's own explicit requirement: "Persist explicit: wallet
-- coverage incomplete, unresolved gap/range, reason." Nullable, cleared (set back to
-- NULL) the moment coverage_complete is durably re-proven true.
ALTER TABLE public.sports_shadow_wallet_coverage
  ADD COLUMN IF NOT EXISTS incomplete_reason text;
