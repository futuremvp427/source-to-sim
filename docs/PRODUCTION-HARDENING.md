# Production hardening checklist

This document is the durable operations record for Mirror Trader. It separates changes that are safe to land in GitHub from changes that must be verified against the live Supabase/Lovable runtime before deployment.

## Current safety boundary

- Shadow/paper simulation only.
- Polymarket US authenticated capability remains limited to balances, positions, and order preview.
- No autonomous live order submission, cancel, modify, close-position, or withdrawal path is part of the application.
- V2 experiment history, bankrolls, P&L, source events, and paper trades must never be reset as part of hardening.

## Completed in GitHub

- Full PostgREST pagination for reconciliation and comparison histories, and for General Shadow's full-history reporting reads (paper trades, settlements, non-trade activity, copyability observations, post-go-live category totals).
- Atomic lease acquisition and fenced release.
- Atomic verified paper settlement RPC migration, including settlement lifecycle audit evidence (a `paper_trades` row with `action='SETTLEMENT'` and `realized_pnl` hardcoded to 0 — `paper_settlements` remains the sole authority for settlement P&L) and settlement-time slippage basis provenance (persisted once per settlement, never backfilled for legacy rows).
- Source-event consumption is experiment-scoped (Phase 1): each experiment independently tracks its own consumption and leader-position state via one fenced transaction (`process_source_event_atomic`) covering the paper trade idempotency row, source position state, paper position, experiment cash/realized P&L, pipeline audit, and source-event state together. `source_events.processed_at` is legacy provenance only and is not read by the current consumption path. Pre-Phase-1 history was not retroactively replayed — see `V2_V3_VALIDITY.md`.
- Checkpoint-driven source catch-up: an already-bootstrapped worker walks forward from its persisted checkpoint (or `follow_from_ts` when no checkpoint exists yet) until coverage of the backlog is proven, instead of a fixed recent-page window that could permanently strand older unseen events.
- Terminal settled paper positions (`settled_won`/`settled_lost`) cannot be reopened by a late source event; the event is still consumed and recorded as a SKIP with an explicit reason, but the position's accounting fields are never rewritten.
- Capacity mark coverage requires a fresh mark (a non-null mark whose `mark_ts` is within the freshness window), not merely a non-null mark value.
- Copyability observation scheduling uses a durable per-experiment cursor over `paper_trades` (stable `(created_at, id)` order) instead of a fixed latest-N window, so backlog of any size is eventually fully scheduled; due-observation transitions are compare-and-set (`WHERE status = 'pending'`) so two overlapping workers can never both win the same observation.
- Phase 2 historical slippage-adjusted figures use a precommitted prior-UTC-day cutoff (`prior-utc-day-v1`): a settled day's adjusted estimate can never be rewritten by samples observed during or after that day, and the current observed slippage median remains descriptive only. This is independent of, and does not by itself establish, the V2/V3 experiment-isolation clean epoch — see `V2_V3_VALIDITY.md`.
- Phantom closed-position classification fix.
- Telegram delivery state distinguishes attempted/failed/sent, and failed important alerts are retried from the scheduled ingest hook. Delivery is at-least-once, not exactly-once: a crash between Telegram accepting a message and the `notified_at` commit can duplicate a send — an accepted, documented limitation, not something the retry/index hardening closes.
- Scheduled ingest is POST-only and accepts only the dedicated `INGEST_HOOK_SECRET`; the former browser-visible publishable-key fallback has been removed.
- PMUS preview decisions are verified after the conditional database update so a no-op cannot be reported as success.
- Environment files are ignored/untracked.
- Dashboard is marked `noindex`/`nofollow`; robots disallow crawler indexing.
- CI runs tests, TypeScript, a production build, and a schema-contract check (clean migration replay, tracked indexes/constraints/columns/functions/RLS, experiment-scoped-isolation SQL) on pull requests.
- No autonomous live order submission, cancel, modify, close-position, or withdrawal path exists anywhere in the application; live execution remains unimplemented.

## Live rollout required

### 1. Apply pending database migrations

Before publishing code that depends on a new migration:

1. Inspect the live schema and data first.
2. Apply the migration in a transaction where possible.
3. Verify expected indexes/functions/permissions exist.
4. Run one manual/read-only verification before allowing the minute cron to exercise the new path.
5. Watch at least five real cron cycles after deployment.

### 2. Rotate the scheduler secret

1. Generate a dedicated high-entropy `INGEST_HOOK_SECRET` in server secrets.
2. Update the live `pg_cron` request header and any standalone worker to use it.
3. Verify successful scheduled calls.
4. Only then remove the `SUPABASE_PUBLISHABLE_KEY` compatibility fallback from the ingest route.

Do not expose `INGEST_HOOK_SECRET` to browser code or a `VITE_*` environment variable.

### 3. Add a real admin authentication boundary

Mutating server functions currently depend on application obscurity rather than an explicit authenticated administrator session. Before treating the dashboard as Internet-hardened, protect control-plane operations including:

- manual ingest/reconciliation,
- experiment settings/pause/resume,
- candidate research/status/promotion,
- PMUS verification/diagnostics,
- PMUS preview approve/reject,
- alert acknowledgement.

Do not bolt authentication onto the existing controls without first providing a tested sign-in/session flow; otherwise the owner can be locked out.

## Rehearsed migration required: wallet-scoped source identity

`source_events.event_key` is currently globally unique. In a multi-wallet system the desired identity is `(wallet, event_key)`, but this migration must be rehearsed because compatibility records and upsert conflict targets depend on the current key.

Preflight requirements:

- prove there are no duplicate `(wallet,event_key)` rows,
- inventory every foreign/dependent reference to `source_events` and `event_key`,
- move dependent records to `source_event_id` where possible,
- update application upserts to conflict on `(wallet,event_key)`,
- deploy schema and code as one coordinated rollout,
- confirm zero missed/duplicated paper events afterward.

## Done: atomic fenced event processing

`process_source_event_atomic` commits one source event as one fenced PostgreSQL transaction: it re-verifies the current lease fence and atomically applies the paper trade idempotency row, source position state, paper position, experiment cash/realized P&L, pipeline audit, and source-event state together. A stale worker whose fence is no longer current cannot commit. This is implemented and covered by CI's schema-contract check, not outstanding work.

## Verification standard

A production hardening change is not considered complete until all applicable checks pass:

- full test suite,
- TypeScript check,
- production build,
- migration applied successfully,
- live worker/checkpoint health,
- zero unexpected poll failures,
- zero duplicate paper trades,
- zero unprocessed eligible source events,
- no bankroll/P&L reset,
- no historical paper replay,
- no live order submission.
