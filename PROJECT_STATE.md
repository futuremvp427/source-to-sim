# Project State

## Agent Rule

Read PROJECT_STATE.md before beginning substantive work. Do not reopen a CLOSED finding unless a regression test fails or new production evidence directly contradicts it. Update PROJECT_STATE.md before finishing the task.

## Current Production State

- Sports Shadow cron is disabled after the failed production canary.
- `sports-shadow-cycle-observation`: `active=false`
- `sports-shadow-cycle-source`: `active=false`
- `sports-shadow-cycle-settlement`: `active=false`
- Legacy `sports-shadow-cycle` job: absent in the latest verified production state.
- Live execution is disabled. `LIVE_EXECUTION_IMPLEMENTED=false`.
- Failed-canary deployed commit SHA: `09faae89f97f4e128f6f1318b1ded558afd8096c`.
- Failed canary timestamp: 2026-08-25 UTC production canary; exact start/end should be read from production telemetry before final incident closure.
- Failed canary counts: 2,378 source fills, 24 signals, 0 matches, 0 observations, 0 paper fills, 0 paper positions, 0 settlements.
- Failed canary epoch attribution: 11 signals with `experiment_epoch_id IS NULL`, 8 signals on a later noncurrent epoch, 5 signals on the final current epoch.
- Failed canary rows are diagnostic evidence and must not be treated as formal calibration/OOS results.

## Closed Findings

- F1 tennis / market granularity safety: CLOSED.
- F2 friction-adjusted paper-trading metrics: CLOSED.
- F3 Sports Shadow schema contract coverage: CLOSED in code; production schema verification remains an operational deployment check.
- F4 external ingestion heartbeat: CLOSED in code; endpoint configuration is optional and operational.
- F5 production pg_cron configuration: CLOSED in repository/runbook; live schedule must always be verified from production metadata.
- Atomic lifecycle-trigger creation: CLOSED.
- DCA-proportional follower ADD sizing: CLOSED.
- Lifecycle-aware realized P&L: CLOSED.
- Kalshi incomplete-fee fail-closed behavior: CLOSED.
- Early source-coverage promotion block: CLOSED.
- Source lease telemetry semantics: CLOSED.
- Migration cost-basis backfill: CLOSED.
- Source coverage recovery/fail-closed semantics: CLOSED.
- Routing decision durability: CLOSED.
- Settlement provenance/backoff: CLOSED.
- EXACT economic-equivalence rules: CLOSED.
- Venue-complete lifecycle scheduling: CLOSED.
- Lease skip does not create source coverage gap: CLOSED.
- Legacy combined Sports Shadow cron cleanup: CLOSED.

## Current Blockers

### CANARY-1 Epoch Concurrency

- Status: IN PROGRESS.
- Evidence: Production emitted `duplicate key value violates unique constraint "sports_shadow_experiment_epochs_one_current_idx"` during overlapping canary workers, and canary signals were created with mixed/null epoch attribution.
- Fix: Move current epoch resolution into serialized database RPC `ensure_sports_shadow_current_epoch`, require nonempty deployment SHA/identity, and fail enabled cycles before source/matching work when epoch acquisition fails. Add fail-closed constraints for future epoch-bearing rows.
- Regression test: `supabase/tests/sports_shadow_epoch_concurrency.sql`; worker/config regression tests.
- Commit SHA once fixed: TBD.

### CANARY-2 Stale Deployment SHA

- Status: IN PROGRESS.
- Evidence: Production-deployed main SHA was `09faae89f97f4e128f6f1318b1ded558afd8096c`, while new epochs were stamped with stale `e2ac939a89ccba5964930d4e147f8dc855ca51f4`.
- Fix: Prefer provider-native deployment SHA environment variables over manual `SPORTS_SHADOW_GIT_SHA`; reject missing/invalid SHA when Sports Shadow is enabled.
- Regression test: `src/lib/sports-shadow/config.test.ts`.
- Commit SHA once fixed: TBD.

### CANARY-3 Kalshi 429 Handling

- Status: IN PROGRESS.
- Evidence: Production observed Kalshi discovery HTTP 429 and unresolved `venue_discovery_failed:KALSHI` alert.
- Fix: Use existing host-aware cooldown path for Kalshi discovery; persist cooldown, suppress upstream calls while blocked, keep PM-US independent, and resume automatically after cooldown expiry.
- Regression test: `src/lib/sports-shadow/kalshi.server.test.ts`.
- Commit SHA once fixed: TBD.

### CANARY-4 PM-US Deadline Starvation

- Status: IN PROGRESS.
- Evidence: Production source lane wrote fills/signals, but PM-US matching repeatedly reported `deadlineReached=true` with `pendingProcessed=0`.
- Fix: Reserve usable matching time inside the source worker by cutting off ingestion early enough to tolerate one source request overrun plus the venue matching reserve.
- Regression test: `src/lib/sports-shadow/worker.server.test.ts`.
- Commit SHA once fixed: TBD.

