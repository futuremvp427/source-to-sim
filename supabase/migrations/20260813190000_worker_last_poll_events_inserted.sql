-- Finding K: correct the "latest poll inserted" telemetry.
--
-- The dashboard previously derived this figure from
-- source_events.first_seen_at >= worker_status.last_poll_at. last_poll_at is
-- stamped when the cycle ENDS (releaseLease), strictly after that same
-- cycle's own inserts, so the comparison structurally missed them and always
-- reported approximately zero. The worker already computes the authoritative
-- per-cycle count via persistEvents(); this persists that count directly
-- instead of trying to reconstruct it from timestamps.
--
-- Diagnostic telemetry only: never read by paper accounting, sizing,
-- bankroll, qualification, settlement, copyability or live-safety logic.
-- Existing rows default to 0 — the exact historical latest-poll count cannot
-- be reliably reconstructed and is not guessed at.
ALTER TABLE public.worker_status
  ADD COLUMN IF NOT EXISTS last_poll_events_inserted integer NOT NULL DEFAULT 0;
