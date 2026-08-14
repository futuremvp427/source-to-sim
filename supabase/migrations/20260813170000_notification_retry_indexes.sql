-- Notification claim/retry hardening.
--
-- Delivery is already at-least-once (see notify.server.ts): a crash after
-- Telegram accepts the message but before the notified_at commit can
-- duplicate delivery. That limitation is inherent to the claim-then-send
-- design and is not changed here — this migration only corrects the index
-- shape backing the two real query patterns.
--
-- The single three-column index below (notification_status,
-- notification_attempted_at, created_at) WHERE notified_at IS NULL served
-- both the stale-sending recovery sweep and the pending/failed retry scan
-- with one broad index. Two targeted partial indexes, each matching one
-- query's actual predicate, replace it.
DROP INDEX IF EXISTS public.alerts_notification_retry_idx;

-- Stale-sending recovery: WHERE notified_at IS NULL AND notification_status
-- = 'sending' AND notification_attempted_at < :cutoff.
CREATE INDEX IF NOT EXISTS alerts_notification_stale_sending_idx
  ON public.alerts (notification_attempted_at)
  WHERE notified_at IS NULL AND notification_status = 'sending';

-- Retry/pending scan: WHERE notified_at IS NULL AND notification_status IN
-- ('pending', 'failed') ORDER BY created_at ASC LIMIT :n.
CREATE INDEX IF NOT EXISTS alerts_notification_pending_retry_idx
  ON public.alerts (created_at)
  WHERE notified_at IS NULL AND notification_status IN ('pending', 'failed');
