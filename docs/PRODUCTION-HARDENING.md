# Production hardening checklist

This document is the durable operations record for Mirror Trader. It separates changes that are safe to land in GitHub from changes that must be verified against the live Supabase/Lovable runtime before deployment.

## Current safety boundary

- Shadow/paper simulation only.
- Polymarket US authenticated capability remains limited to balances, positions, and order preview.
- No autonomous live order submission, cancel, modify, close-position, or withdrawal path is part of the application.
- V2 experiment history, bankrolls, P&L, source events, and paper trades must never be reset as part of hardening.

## Completed in GitHub

- Full PostgREST pagination for reconciliation and comparison histories.
- Atomic lease acquisition and fenced release.
- Atomic verified paper settlement RPC migration.
- Phantom closed-position classification fix.
- Telegram delivery state distinguishes attempted/failed/sent, and failed important alerts are retried from the scheduled ingest hook.
- Scheduled ingest is POST-only and accepts only the dedicated `INGEST_HOOK_SECRET`; the former browser-visible publishable-key fallback has been removed.
- PMUS preview decisions are verified after the conditional database update so a no-op cannot be reported as success.
- Environment files are ignored/untracked.
- Dashboard is marked `noindex`/`nofollow`; robots disallow crawler indexing.
- CI runs tests, TypeScript, and a production build on pull requests.

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

## Architecture work required: atomic fenced event processing

The remaining highest-value reliability change is to commit one source event as one fenced PostgreSQL transaction. The transaction should verify the current lease fence and atomically apply all relevant state:

- paper trade idempotency row,
- source position state,
- paper position,
- experiment cash/realized P&L,
- pipeline audit,
- source-event processed/backfilled state.

A stale worker whose fence is no longer current must be unable to commit. This should be implemented and tested on a branch, then deployed only after live-schema preflight.

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
