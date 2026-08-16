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

## Incident: data-api.polymarket.com 429 burst (2026-08-15)

Simultaneous `poll_failure` alerts (HTTP 429 from `https://data-api.polymarket.com/trades`) were reported across multiple V2/V3-cohort experiments (Poligarch V2/V3, badatmath V3, HighTempTation V2) and possibly the full 10-experiment cohort. This session's investigation was code-only: this sandbox has no network path to the live Supabase project and no production log/alerts access, so the exact first/last 429 timestamps, per-worker failure counts, and confirmed source-event gap could not be pulled directly. The queries below answer those questions from the live database; they were written but not run here.

```sql
-- Which experiments/workers hit 429s, when, how often, still occurring?
select
  context->>'experiment' as experiment,
  min(created_at) as first_alert,
  max(created_at) as last_alert,
  count(*) as alert_count,
  max((context->>'failures')::int) as max_consecutive_failures
from alerts
where kind = 'poll_failure' and message ilike '%429%'
group by 1
order by 2;

-- Current worker state for anything that has ever failed
select id, state, poll_failures, last_error, last_success_at, last_poll_at, heartbeat_at
from worker_status
where poll_failures > 0 or last_error ilike '%429%'
order by last_poll_at desc;

-- Is it still occurring right now? (state='error' with a recent heartbeat)
select id, state, last_error, heartbeat_at
from worker_status
where state = 'error' and heartbeat_at > now() - interval '15 minutes';
```

**Root cause (confirmed by code reading, `shadow.server.ts`).** `runIngestCycle` fans out over every enabled `paper_experiments` row once per ~1-minute `pg_cron` tick. The V2 and V3 cohorts each follow the identical 5 wallets (`v3-cohort.ts` reuses `V2_COHORT` verbatim), so 10 experiments issue what is architecturally 5 unique `/trades` requests' worth of data — but every experiment fetched independently, with no shared cache, doubling the identical-wallet request volume. Retries (`getJson`, 3 attempts) used a fixed 400ms/800ms backoff with no jitter and never read the `Retry-After` header, so a 429 on one worker and its retries had no mechanism to avoid re-colliding with the next tick or with sibling workers hitting the same limit at the same moment. Two additional, uncoordinated contributors to the same host's request volume: `candidates/research.server.ts` runs its own independent `/trades` fetcher (throttled to every 6h, lower impact) and `health.server.ts`'s dashboard self-check pings `/trades?limit=1` once a minute **per open browser tab**, entirely decoupled from the server-side cron.

**Telegram "74.7 KB trades.json attachment" claim — not reproducible in this codebase.** `notify.server.ts` sends only a plain-text Telegram `sendMessage` (`chat_id`, `text`); there is no `sendDocument`/multipart/attachment code path anywhere in this repository, and the `poll_failure` message body is a short string (`"<experiment>: ingestion poll failed: <url> responded 429"`), not a raw API payload. If a file attachment was actually observed on a real alert, it did not originate from this app's code — worth checking any Telegram-side integration configured outside this repository (bot commands, a browser extension, etc.) before assuming this app needs a fix here. (A 250-trade `/trades` page is very plausibly ~75 KB, which may explain the number if what was actually seen was a raw API response captured elsewhere, not something this app attached.)

**Fix applied (`shadow.server.ts`, `health.server.ts`):**
- A per-`runIngestCycle` shared request cache (`TradesRequestCache`, keyed by request URL) so sibling V2/V3 experiments on the same wallet reuse one in-flight/completed `/trades` fetch instead of issuing duplicate requests. Never persisted or reused across cycles; a failed shared fetch doesn't poison the cache for the next retry. Each experiment still independently evaluates its own checkpoint/accounting from the shared page — no change to paper-trading logic.
- The cache-populating fetch is deliberately **not** bound to any individual experiment's own cycle-abort signal — an early first version of this fix did tie it to the first caller's signal, which risked reintroducing the exact "outer deadline stops waiting, inner fetch keeps running" failure mode already proven in production for `persistEvents` (see that stage's own doc comment above). Instead, the shared fetch gets its own independent `AbortController` and hard deadline (`SHARED_TRADES_FETCH_DEADLINE_MS`, 45s — bounded below `CYCLE_BUDGET_MS` so it can never outlive the whole scheduler invocation), so no sibling can cancel a request another sibling still needs, and a genuinely stuck upstream response is still really aborted once every experiment's own deadline has passed, not merely abandoned by `Promise.race`. `Retry-After` waits are honored but clamped to whatever budget remains before that hard deadline, so a pathological Retry-After value cannot extend a shared request indefinitely.
- `getJson` now reads `Retry-After` (delay-seconds or HTTP-date) and honors it verbatim (subject to the shared-deadline clamp above); absent that header, backoff is full-jitter exponential (`random(0, min(8s, 500ms * 2^attempt))`) instead of the old fixed 400ms/800ms schedule, so concurrent retries spread out instead of re-colliding.
- `poll_failure` alerts now record `rateLimited`/`retryAfterMs` in `alerts.context` so a future 429 incident is diagnosable directly from the alerts table.
- `health.server.ts`'s dashboard self-check now caches the public-API reachability probe for 55s, so any number of concurrently open dashboard tabs collapse to one upstream ping per window instead of one each.

Not changed in this pass (identified, out of scope for a minimal fix): `general-shadow.server.ts`'s `/activity` fetch has no retry at all, and `candidates/research.server.ts` has its own separate, weaker retry implementation. Both hit the same host and would benefit from the same Retry-After/jitter treatment, but touching them was not necessary to address the reported burst and is left for a follow-up pass.

**Backfill / gap assessment — mechanism confirmed by code, actual gap NOT yet measured.** `fetchUntilCheckpointCovered` means a failed cycle never advances `worker_checkpoints.last_source_ts`; the next successful cycle walks pages backward until it re-proves coverage of that checkpoint, so a transient 429 outage is architecturally self-healing as long as the gap stays within the API's `offset <= 10,000` ceiling per wallet (see `MAX_TRADES_OFFSET`). This is a description of the mechanism, not a proof that this specific incident stayed inside it: the actual duration of the 429 window, how many events accumulated per affected wallet during it, and whether every affected experiment's checkpoint has since caught up were not measured from this sandbox (no production access) and must be confirmed by running the queries below before this incident is considered closed.

```sql
-- Any experiment whose checkpoint stalled during the incident window and
-- hasn't advanced since should show up here.
select id, last_source_ts, to_timestamp(last_source_ts) as last_source_at, updated_at
from worker_checkpoints
order by updated_at desc;

-- How many source events landed per wallet during/after the incident window,
-- to size the actual gap against the 10,000-offset ceiling instead of
-- assuming it fits.
select wallet, count(*) as events_in_window
from source_events
where source_ts >= extract(epoch from '<incident_start>'::timestamptz)
group by 1
order by 2 desc;
```

**August 14 clean epoch (`T_clean`) / August 21 checkpoint (`T_7d`) — provisionally preserved, not confirmed.** No code, migration, or data in this fix touched `T_clean` (2026-08-14 11:29:19.638 UTC per `V2_V3_VALIDITY.md`) or `T_7d` (2026-08-21 11:29:19.638 UTC); nothing here resets a checkpoint, bankroll, or paper-trading history. That is a true but narrower claim than "still valid": whether August 21 can definitively stand as the qualification checkpoint depends on the production gap measurement above, which was not run from this sandbox. Treat both dates as **provisionally preserved pending production verification** — run the diagnostic queries in this section first; only report August 21 as definitively valid once they confirm every affected V2/V3 experiment's checkpoint fully caught up and no event count during the outage exceeded what checkpoint replay could recover.

Regression tests: `src/lib/trades-request-storm.test.ts` — dedup collapses 10 V2/V3-style workers over 5 unique wallets to 5 upstream requests; one sibling's own AbortSignal aborting never cancels a shared request another sibling still needs (asserted directly on the signal handed to `fetch`); the shared fetch does not settle merely because every experiment's own 40s deadline has passed, but does terminate — with the underlying fetch signal genuinely aborted, not just abandoned — at its own independent hard deadline; a 429 on every attempt rejects, clears the cache entry, and a later caller performs a genuinely new fetch sequence; Retry-After parsing and jittered-backoff bounds; a pathological Retry-After is clamped to the remaining shared-deadline budget instead of honored in full.

No bankroll, cash, P&L, checkpoint, source-event, or live-trading-safety control was reset or modified as part of this fix.

## Incident phase 2: host-level rate-limit cooldown (2026-08-16)

Production evidence after the phase 1 dedup fix (above) landed showed it helped but did not eliminate the 429s: fresh 429s continued across all 10 V2/V3 experiments, recurring roughly every 5-6 minutes, `Retry-After` was absent, and — importantly — every continuity check (checkpoints, `experiment_event_state` anti-joins) came back clean, with no `CatchupProgressionError`, checkpoint, offset, statement-timeout, or 520 errors. This confirmed the remaining problem was **host/IP-level rate limiting plus retry amplification**, not a strategy, accounting, or checkpoint defect. General Shadow was also confirmed to hit the same upstream host.

**Root cause of the residual bursts.** Phase 1's dedup cache is scoped to one `runIngestCycle` invocation; a fresh scheduler tick has no memory of the previous one. A 429 observed on tick N was therefore independently rediscovered by every experiment on tick N+1, N+2, etc. — nothing paced requests *across* ticks. Additionally, `getJson` still retried up to 3 times per request even on 429 (with jittered backoff from phase 1), so a single rate-limit event could still generate up to 3 upstream 429s per experiment per cycle.

**Fix applied.**
- `getJson` (`shadow.server.ts`) no longer retries in-process on a 429 at all, regardless of `Retry-After` — it fails that request immediately. A non-429 transient failure (network blip, 5xx) keeps its existing bounded 3-attempt retry with jittered backoff; that path is unchanged.
- A new table, `http_rate_limits` (migration `20260815160000_http_rate_limit_cooldown.sql`), holds one row per host with a `blocked_until` timestamp. `getJson` records a cooldown there the moment it sees a 429 (`recordHostRateLimit`, `src/lib/http-rate-limit.server.ts`), via an atomic `GREATEST`-upsert RPC (`record_http_rate_limit`) that mirrors the existing `acquire_worker_lease` lease-fencing pattern — deliberately the smallest existing durable coordination mechanism in this repo, not a new subsystem. Two experiments recording a 429 for the same host in the same tick converge on the longer cooldown instead of one write clobbering the other.
- `runExperimentCycle` reads that cooldown fresh (not threaded from `runIngestCycle`, so a cooldown recorded by an earlier experiment in the same cycle is seen immediately by a later one) right after acquiring its lease, **before any checkpoint or network work starts**. If the host is in cooldown, it releases the lease as `idle` (not `error` — no `poll_failures` increment, no alert) and returns a `skipped` result, exactly like the existing "another worker holds the lease" pattern. Because this check happens before `worker_checkpoints` is ever touched, a deferred cycle can never advance a checkpoint.
- This single gate covers **every** experiment type uniformly, including General Shadow (which reaches `/activity` through the same `runExperimentCycle`), so General Shadow respects the same host budget without any special-casing. `general-shadow.server.ts`'s `getActivityPage` additionally records the cooldown itself (and also stops retrying on 429) if it happens to be the request that first discovers a fresh rate limit, so the shared budget is symmetric regardless of which endpoint (`/trades` or `/activity`) sees the 429 first.
- `getHostCooldown` fails **closed**: if the cooldown row itself cannot be read (a query error), the host is treated as blocked rather than risking a request against an upstream that may already be limiting this app. The cost of deferring one cycle is far lower than the cost of amplifying a live storm.
- Cooldown duration: `Retry-After` is honored when present, clamped to `[60s, 600s]` (`MIN_COOLDOWN_MS`/`MAX_COOLDOWN_MS`) so a pathological header value can neither fail to pace anything nor lock ingestion out indefinitely; absent `Retry-After` (the observed production case), a `90s` default is used.

**429 retry behavior, before vs. after:**
| | Before (phase 1) | After (phase 2) |
|---|---|---|
| In-process retries on 429 | Up to 3, jittered backoff | 0 — fails immediately |
| Pacing mechanism | Per-request backoff only | Shared DB-backed cooldown, survives across ticks |
| Scope | Per `runIngestCycle` invocation | All experiments (V2/V3 + General Shadow), across invocations |
| Non-429 failures | 3 attempts, jittered backoff | Unchanged — 3 attempts, jittered backoff |

**Checkpoint semantics unchanged.** The cooldown gate sits entirely before the `stages` pipeline that loads/writes `worker_checkpoints`; a deferred cycle never enters that pipeline, so `last_source_ts`/`bootstrap_complete` are untouched. When the cooldown lapses, the next cycle proceeds through the existing checkpoint-driven catch-up (`fetchUntilCheckpointCovered`) exactly as before — this mechanism itself was not modified.

**Live-trading safety unchanged.** No change to strategy, sizing, bankrolls, P&L, positions, settlement logic, `T_clean`, `T_7d`, or Poligarch live-pilot safety state (kill switch, activation lock, $0 caps, submission disabled).

**Trade-off, stated explicitly.** Gating the entire experiment cycle (not just the `/trades` fetch) means mark refresh, reconciliation, settlement, and preview generation for an experiment are also deferred while the host cooldown is active — bounded to the cooldown window (60-600s, one scheduler tick or so in practice), and resumed on the very next successful cycle. This was chosen over a narrower per-stage gate because partially gating only the network call while still writing `bootstrap_complete`/checkpoint state on a request that was never actually attempted risked exactly the kind of subtle correctness bug this whole incident is about avoiding; the simpler, coarser gate is easier to reason about and verify.

Regression tests: `src/lib/http-rate-limit-cooldown.test.ts` — `clampCooldownMs` bounds; `getHostCooldown` fail-closed and normal read paths; `recordHostRateLimit` clamps duration and never throws even if the RPC fails; a single 429 gets zero retries while a non-429 failure still retries up to 3 times; `runExperimentCycle` defers before touching any table other than `http_rate_limits`/`worker_status`, releases the lease as `idle`, and suppresses upstream calls across repeated invocations while the cooldown is active; General Shadow's `getActivityPage` records the same cooldown and doesn't retry on 429. `src/lib/trades-request-storm.test.ts` was updated in place for the new zero-retry-on-429 behavior (previously asserted 3 attempts).

**Final hardening pass, post-review.** Two follow-up gaps were found by review before this branch was cleared for merge, both in the cooldown-recording/lease-release plumbing rather than the cooldown design itself:
- `recordHostRateLimit`'s RPC write was originally either fire-and-forget (`/trades` path, via `getJson`) or a bare unbounded `await` (General Shadow's `/activity` path) — two different failure modes, neither acceptable: fire-and-forget risks the write silently losing a race against a reader, and a bare await risks a stalled RPC hanging the caller indefinitely. Fixed by giving the write its own real deadline: a fresh `AbortController` per call, tied to the RPC via postgrest-js's `.abortSignal()` (the same real-cancellation mechanism already used elsewhere in this file, e.g. `process_source_event_atomic`/`persistEvents`), aborted after `COOLDOWN_WRITE_DEADLINE_MS` (5s) via `setTimeout` — not a bare `Promise.race`, which would leave the underlying DB request running uncancelled. Both 429 paths now safely `await` this bounded call directly.
- The cooldown-defer branch in `runExperimentCycle` released the lease via a bare `await releaseLease(...)`, an unbounded Supabase update — a stalled `worker_status` write here could strand the function even though the whole point of this branch is to return quickly. Fixed by routing it through the same `boundedStage` + `CLEANUP_RELEASE_DEADLINE_MS` (5s) pattern already used by the cycle's error path; fencing (fence/worker_id match) keeps a late-landing write safe regardless.

New regression tests cover both: the write is proven to actually complete before the caller's promise settles on a normal 429, a permanently stalled write is proven to be really cancelled (not merely abandoned — asserted directly on the `AbortSignal` handed to the RPC) for both the `/trades` and `/activity` paths, and a stalled lease-release update is proven not to strand `runExperimentCycle` past its own cleanup bound.

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

## Consolidated hardening pass — 2026-08-16

Authoritative clean-window boundary is unchanged: **T_clean = 2026-08-16 12:09:43.355885 UTC**. No trading strategy, sizing formula, bankroll, cohort membership, settlement economics or live-safety default was touched by this pass, and `POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED` remains `false` with every live cap at $0.

- **Reconciliation write correctness** — `reconcileHeld` now inspects the returned error of every `source_position_state` repair upsert chunk and throws before any `reconciliation_advanced` / `reconciliation_mismatch` alert. A failed repair can no longer be reported as repaired. Wallet-scoped reconcile leases and paper accounting tables are unchanged.
- **Proven safety persistence** — `writeState` in `live-safety.server.ts` and `poligarch-safety.server.ts` returns the affected row and throws on both a DB error and a zero-row match. Callers can no longer say "kill switch engaged", "armed" or "activated" for a write that never landed. Activation gates, caps and constants are unchanged.
- **Telegram retry cutover** — retry candidates are floored at `TELEGRAM_RETRY_CUTOVER_AT` (2026-08-16T20:26:30Z, the hardening deployment boundary — commit 66bc02d), so every pre-deployment alert, including the never-delivered Aug 14-15 settlement alerts, stay stored for history but are never replayed. Actual paper BUYs keep strict FIFO tier-1 priority. Durable kinds (`paper_buy`, `paper_sell`, `position_settled`, `settlement`, `settlement_verified`, `LOW_SPENDABLE_CASH`, `CASH_RESERVE_REACHED`, exact-match previews) stay retryable indefinitely after the cutover; high-volume operational diagnostics (`poll_failure`, reconciliation noise) remain bounded to the 2-hour freshness window. `new_source_trades` stays dashboard-only. Delivery remains at-least-once; nothing is deleted.
- **Fail-closed source side** — an unrecognized, missing or malformed `side` is skipped rather than copied as a BUY, in both `normalizeSourceEvents` and the public candidate-trade parser. Event identity for valid trades is unchanged.
- **Bounded, resumable candidate research** — the pass now refreshes an oldest-computed-first batch (`RESEARCH_BATCH_SIZE`) under a `RESEARCH_BUDGET_MS` wall-clock budget well inside the 300s lease, so repeated scheduled runs progress across the watchlist instead of restarting and overrunning it. `worker_status` run-state writes are error-checked. Scoring and promotion rules, and the three active candidate followers, are untouched.
- **General Shadow safe-resume guard** — `GENERAL_SHADOW_POLLING_ENABLED` stays `false`; RN1 and swisstony remain paused. If polling is later re-enabled, General Shadow catch-up is capped at `GENERAL_SHADOW_CATCHUP_PAGE_BUDGET` upstream pages per cycle and fails closed (checkpoint not advanced, retried from the same boundary) rather than replaying the whole backlog as one request storm. V2/V3 and candidate polling keep unbounded catch-up and are unaffected.
- **CI** — `audit-ci.yml` now also runs validate + schema-contract on direct pushes to `main`. `schema-drift.yml` fails loudly when `PRODUCTION_SCHEMA_DATABASE_URL` is missing, instead of reporting green for a skipped verification.
- **Migration history** — already-applied migrations, including the historically duplicated `live_pilot_state` migration, are intentionally left in place. Applied migration history is immutable; the duplication is documented as historical only.
