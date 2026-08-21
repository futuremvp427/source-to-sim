-- Task 12D / P1-B: fixed wallet ordering can permanently starve later wallets.
--
-- ROOT CAUSE: runSourceLane iterates config.wallets in the SAME fixed (alphabetically
-- sorted) order every single cycle. If an early wallet consistently consumes the entire
-- SOURCE_LANE_BUDGET_MS, budgetExceeded() breaks the loop before later wallets are ever
-- attempted -- not delayed, permanently skipped, cycle after cycle, forever.
--
-- FIX: one durable rotation cursor (a single row, matching the smallest-possible-table
-- philosophy already used for http_rate_limits/worker_status). Each cycle starts iterating
-- from `next_wallet_index` (wrapped modulo the CURRENT cohort size, so cohort
-- add/remove/reorder can never index out of bounds or crash -- see worker.ts's
-- rotateWallets), and durably advances the cursor by however many wallets were actually
-- attempted THIS cycle -- specifically including a cycle that hit its budget partway
-- through, since that is exactly the case a fixed start index would otherwise repeat
-- forever. This guarantees every configured wallet eventually becomes the FIRST wallet
-- attempted within a bounded number of cycles, so no wallet can be permanently starved
-- merely because an earlier one in cohort order is slow/busy.
CREATE TABLE public.sports_shadow_wallet_cursor (
  id text NOT NULL PRIMARY KEY,
  next_wallet_index integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.sports_shadow_wallet_cursor TO service_role;
ALTER TABLE public.sports_shadow_wallet_cursor ENABLE ROW LEVEL SECURITY;

INSERT INTO public.sports_shadow_wallet_cursor (id, next_wallet_index)
VALUES ('source_wallet_rotation', 0)
ON CONFLICT (id) DO NOTHING;
