-- CODEX P1-1: /trades offset ceiling can strand post-go-live fills.
--
-- ROOT CAUSE: pollSportsShadowWallet's pagination hits the upstream Data API's own
-- offset > 10,000 rejection (MAX_TRADES_OFFSET, shadow.server.ts) after MAX_PAGES_PER_WALLET
-- (41) pages. Hitting that ceiling without ever finding a durable overlap or crossing
-- goLiveAtMs was previously treated exactly the same as a genuine completeness boundary
-- (an empty/short page, or an overlap with already-durable history): the fetched pages
-- were persisted and the scan ended. For a wallet whose total lifetime trade count (or
-- whose gap since a prior poll) exceeds 10,000, this silently converts "we ran out of
-- offset budget" into a PERMANENT false completeness boundary -- every later poll's own
-- overlap check finds the just-persisted newest page and stops there too, so any real,
-- eligible post-go-live fill older than the 10,000th-newest trade is never reached again.
--
-- FIX: a durable per-wallet coverage watermark. While a wallet's coverage is not yet
-- durably proven complete (back to at least goLiveAtMs, or to genuine history-start),
-- pollSportsShadowWallet pages within successive TIME WINDOWS (using the Data API's own
-- documented `end` timestamp parameter -- already a proven, production-used mechanism,
-- see shadow.server.ts's fetchUntilCheckpointCovered/buildTradesUrl -- never an invented
-- parameter). Hitting the offset ceiling within one window now durably advances
-- covered_through_ts to the oldest timestamp actually observed in that window (an
-- INCLUSIVE boundary, matching the same duplicate-safe convention already established by
-- fetchUntilCheckpointCovered) and leaves coverage_complete = false, so the NEXT poll
-- opens the following window from exactly that point rather than restarting from "now"
-- and re-discovering the same already-covered range forever. Coverage becomes durably
-- true only once a window's walk actually crosses goLiveAtMs or reaches genuine
-- history-start (an empty/short page) -- never merely because the offset ceiling was hit.
--
-- One row per wallet; the smallest-possible-table philosophy already used for
-- sports_shadow_wallet_cursor/http_rate_limits. No row for a wallet means "coverage not
-- yet verified under this model" -- the application's own repository layer treats that as
-- coverage_complete = false (must prove it), never as an implicit pass.
CREATE TABLE public.sports_shadow_wallet_coverage (
  wallet text NOT NULL PRIMARY KEY,
  covered_through_ts bigint,
  coverage_complete boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.sports_shadow_wallet_coverage TO service_role;
ALTER TABLE public.sports_shadow_wallet_coverage ENABLE ROW LEVEL SECURITY;
