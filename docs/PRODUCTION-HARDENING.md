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
- `mark_refresh` runs under its own bounded deadline (`MARK_REFRESH_DEADLINE_MS`), with a neutral zero fallback, so a stalled public CLOB `/books` chunk can no longer prevent a cycle from reaching `releaseLease()`. Regression: `mark-refresh-budget.test.ts`, `shadow-source.test.ts`.
- `worker_status.last_poll_events_inserted` is populated directly from the cycle's own `persistEvents()` count on every lease release (success and error paths), replacing the previous timestamp-derived figure that structurally under-reported. Diagnostic telemetry only.
- The `worker_checkpoints` load and the one-time `follow_from_ts` bootstrap write now run inside the same `withDeadline`-bounded region as every other cycle stage (timed as `"checkpoint_load"`), instead of before it. Before this fix, a hung query at that exact point stranded the lease indefinitely: `heartbeat_at`/`fence` kept advancing on each retry's lease acquisition, but `stage_ms`/`last_error`/`poll_failures` stayed frozen forever, never reaching the existing catch-and-release-lease path — indistinguishable in `worker_status` from a permanent hang. No fallback value is substituted on a checkpoint-load timeout (unlike the auxiliary `boundedStage()` stages): the cycle fails cleanly through the existing catch block instead, since a guessed catchup boundary would risk correctness. Regression: `shadow-source.test.ts`.
- `persistEvents` (the `source_events` upsert) now accepts a real `AbortSignal`, threaded via `postgrest-js`'s `.abortSignal()`, tied to a cycle-scoped `AbortController` firing at the same `EXPERIMENT_DEADLINE_MS` as the outer race. `Promise.race` (used throughout by `withDeadline`/`boundedStage`) never cancels its losing promise; this was the one call site proven (via `pg_stat_statements`) to have repeated, extreme overruns (44s/67s/82s of wall-clock time against a 40s budget, while the underlying SQL itself never exceeded ~8s), so it is the one given real cancellation. No other call site was touched — no other stage showed this pattern in the evidence. Regression: `persist-events-cancellation.test.ts`, `shadow-source.test.ts`.

- Full-history `copyability_observations` reads use keyset paging instead of `.range()`/OFFSET. Proven on production: the page at offset 50,000 for the largest experiment took 22.3s (walking 51,000 rows) even on an exactly-matching index, against an 8s role `statement_timeout` — that read could never complete, and its per-cycle retries across 10 experiments amplified the shared write-latency spikes. Regression: `copyability-keyset-pagination.test.ts`.
- Wallet reconciliation is serialized across sibling experiments sharing a wallet via a wallet-scoped lease (`try_acquire_reconcile_lease` / `release_reconcile_lease`); a sibling that loses the lease skips instead of racing, which closes the reconciliation-cache oscillation. Regression: `reconcile-wallet-lease.test.ts`.
- The sequential paper-processing loop receives a real `AbortSignal`: it stops starting new `process_source_event_atomic` calls once the cycle deadline fires and threads the signal into each RPC, so a deadline can no longer leave event RPCs running past the cycle. Regression: `paper-processing-cancellation.test.ts`.
- Post-cycle cleanup (`releaseLease`, alerting) runs under its own small bounded budgets, so a stalled status read or Telegram call can no longer strand a lease.
- T_clean was withdrawn as a result of this timeout wave — see `V2_V3_VALIDITY.md`.

## Completed in production (2026-08-14)

Applied via `supabase/migrations/20260814050000_production_schema_reconciliation.sql` against the live Supabase project (`tltnlpsnikertqaxowal`), inside one explicit transaction, after a pre-mutation row-count/value snapshot and a full post-migration `schema-contract.json` re-verification (indexes, constraints, columns, function signatures/security/grants, RLS — all confirmed matching). No bankroll, cash, realized P&L, or historical source/trade/settlement row was modified or deleted; every change was additive (new nullable columns, new guarded indexes, legacy-seeded consumption rows for pre-existing history). Part of this schema (notably the Phase 6 copyability-cursor columns, and a materially larger slice of Phase 1's `experiment_event_state` than initially estimated — verified after the fact by rows with `legacy_seeded=false` predating this migration) had already been synced to production ahead of its recorded migration.

The code at the deployed commit (`main` @ `974d518f79407deac086cecf556d22909ed30166`, later `a6f3e6bcd684db292274f4da6f5093dfebb43acf`) was already live on the published Lovable project before/immediately after each merge — Lovable's GitHub sync auto-publishes on merge to `main` within seconds, so no separate `deploy_project` action was needed or taken for either change.

Net effect observed directly in production after the schema migration: most previously wedged workers (stuck at `state='running'` for roughly 13.5 hours with `poll_failures` in the hundreds) self-recovered within minutes, confirming the missing Phase 1 schema objects were at least one real, independent cause of that incident, separate from the `mark_refresh` timeout gap.

**Checkpoint-load cycle-budget fix (`a6f3e6b`).** Two of the ten V2/V3-cohort experiments (`SHADOW V2: badatmath.`, `SHADOW V3 CAPACITY: Poligarch`) and, separately, `GENERAL SHADOW: RN1` kept failing with `fence`/`heartbeat_at` advancing on every retry but `stage_ms`/`last_error`/`poll_failures` frozen for many minutes at a time — proven (via `pg_stat_activity`-style evidence and direct code reading) to be a hang in the `worker_checkpoints` load, which ran *before* the cycle's 40-second deadline race started. Fixed by moving that load inside the bounded region.

**Systemic reliability fix — real cancellation for `persistEvents` (`3074352`).** Hours after the checkpoint-load fix, a broader failure wave hit many V2/V3 experiments, including several already-succeeded ones (`canceling statement due to statement timeout`, fresh `"exceeded 40000ms deadline"`, one `error code: 520` — the last most consistent in shape with Supabase's own Cloudflare-fronted edge, not the app's own `"<url> responded <status>"` format used for Polymarket API errors). Root-caused with `pg_stat_statements`, not guessed:
- The actual `source_events` upsert query never exceeded ~8s of real Postgres execution (42,875 calls, mean 148.2ms, max 7,951.6ms).
- `pg_cron`'s own internal `cron.job_run_details` bookkeeping writes occasionally took **80-95 seconds** despite averaging under 500ms — proof of a shared, external, infrastructure-level write-latency spike, not an application query/index defect.
- `stage_ms` directly recorded `persist_events` taking **44s, 67s, and 82s** of wall-clock time on multiple production attempts — because `Promise.race` (`withDeadline`/`boundedStage`) never cancels its losing promise, the request just kept running in the background well past the 40s deadline, holding a connection/request slot while a *new* attempt started concurrently (the lease is released at 40s regardless) — compounding load during exactly the window the database was least able to absorb it.

Fixed by threading a real `AbortSignal` into `persistEvents` (see above). **Confirmed effective in production**: 8+ minutes and 30+ scheduler invocations observed directly post-deploy, covering the full 10-experiment cohort multiple times each, with all 10 reaching clean successes (`poll_failures = 0`, `last_error = null`) and only one isolated, non-cascading, self-resolved `statement timeout`. See `V2_V3_VALIDITY.md` for the full T_clean determination.

**Separately diagnosed, not fixed (out of scope, insufficient proof for a narrow fix, or explicitly excluded from the V2/V3-cohort scope):**
- `GENERAL SHADOW: RN1` (not a V2/V3-cohort member) still shows a frozen-stage signature after both fixes deployed, meaning its root cause is different from, or additional to, either fixed mechanism. Its `worker_checkpoints` row showed a ~20-hour-stale checkpoint against an apparently active source wallet; a plausible but unproven contributing factor is unbounded work inside the `source_ingest` checkpoint catch-up paging loop for a large gap. Not fixed — insufficient proof, and explicitly out of scope for a V2/V3-scoped change.
- `GENERAL SHADOW: swisstony` (not a V2/V3-cohort member) has an unrelated external-API issue (`data-api.polymarket.com/trades` responding `400`), predating and independent of this rollout. Not investigated further via live requests per the read-only/no-hammering constraint on this task; still open.
- Scheduling interaction: `runIngestCycle` batches experiments (`EXPERIMENT_CONCURRENCY = 2`) ordered least-recently-succeeded-first, and defers the remainder of a cron tick once a shared `CYCLE_BUDGET_MS` (50s) is exhausted. Because `RN1`/`swisstony` never record a fresh success, they sort permanently near the front of every queue; when they land in an early batch and hang, `Promise.allSettled` cannot resolve that batch until they do, which can delay unrelated experiments queued behind them. Not fixed, since RN1/swisstony's own root cause is unproven and a scheduling redesign is out of scope for this session.
- Wallet-scoped `reconcile()` oscillation between sibling experiments sharing a wallet — see the dedicated section in `V2_V3_VALIDITY.md`. Zero effect on paper accounting; not fixed.
- Telegram `poll_failure` alert cadence (`failures === 1 || failures % 5 === 0`) was inspected for objective miscounting/duplicate-firing and found clean: every repeated alert for the same experiment was separated by 6+ minutes, consistent with genuinely distinct failure events at the intended throttled cadence, not a bug. No change made — operational failures must remain visible, and this one was accurately reporting a real (now resolved) high failure rate.

None of the above required or received any bankroll, cash, P&L, sizing, qualification, or strategy change; no historical ledger was replayed, reset, or deleted; no checkpoint was reset merely to clear an error.

*Operational note: all dates/times in this document and in `V2_V3_VALIDITY.md` are sourced from production PostgreSQL (`SELECT now()`) and the GitHub API, per a standing instruction that the executing host's shell clock is not authoritative for production timestamps. In this specific session the shell clock, production `now()`, and the GitHub API `Date` header all agreed within seconds; a prior session reported a several-day discrepancy that was not reproduced here.*

## Live rollout required

### 1. Rotate the scheduler secret

1. Generate a dedicated high-entropy `INGEST_HOOK_SECRET` in server secrets.
2. Update the live `pg_cron` request header and any standalone worker to use it.
3. Verify successful scheduled calls.
4. Only then remove the `SUPABASE_PUBLISHABLE_KEY` compatibility fallback from the ingest route.

Do not expose `INGEST_HOOK_SECRET` to browser code or a `VITE_*` environment variable.

Note: as of 2026-08-14, the live `shadow-ingest` `pg_cron` job is already calling the ingest route successfully on a one-minute schedule (confirmed by direct observation of successful worker polls), so the currently configured secret is confirmed working. Rotation is optional hardening, not a blocker, and should not be done reactively without a reason — rotating a working secret carries its own risk of a self-inflicted outage.

### 2. Add a real admin authentication boundary

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
