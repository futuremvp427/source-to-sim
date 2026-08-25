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
- Canary remediation code is merged to `main` at `28ec0d99e8daf896db2da7648d44232cf1fc7c51`; Audit CI run `32806326974` passed validate and schema-contract, including the real Postgres epoch-concurrency harness.
- Follow-up canary attempt began at production DB time `2026-08-25 04:04:45.1327+00` and was stopped after the hard deployment-provenance gate failed.
- Follow-up canary cron final state: observation/source/settlement jobs `active=false`; Sports Shadow pg_net queued requests: 0.
- Follow-up canary evidence: 12 source fills, 0 signals, 0 matches, 0 observations, 0 paper fills, 0 paper positions, 0 settlements.
- Follow-up canary failure: Lovable live page assets/preview metadata matched `28ec0d99`, but Sports Shadow workers still returned epoch `8a965380-d3e3-4d5c-b33a-13bc0f4b2b90` stamped `e2ac939a89ccba5964930d4e147f8dc855ca51f4`; runtime deployment SHA configuration must be corrected before cron is re-enabled.
- Runtime SHA was later corrected for the generated `main` commit `b97da7c5c09c6acf080b6f034e5c65499aa8b778`; that value must be updated again after the PM-US discovery fix creates a new `main` commit.
- Latest production canary evidence for PM-US: 40 pending found, 0 pending processed, 0 exact matches, 0 rejected, 2 discovery-failed cycles, 0 deadline-reached cycles, 0 observations; concrete error `discovery truncated at DISCOVERY_MAX_PAGES (10)`.

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

- Status: FIXED IN CODE.
- Evidence: Production emitted `duplicate key value violates unique constraint "sports_shadow_experiment_epochs_one_current_idx"` during overlapping canary workers, and canary signals were created with mixed/null epoch attribution.
- Fix: Move current epoch resolution into serialized database RPC `ensure_sports_shadow_current_epoch`, require nonempty deployment SHA/identity, and fail enabled cycles before source/matching work when epoch acquisition fails. Add fail-closed constraints for future epoch-bearing rows.
- Regression test: `supabase/tests/sports_shadow_epoch_concurrency.sh`; worker/config regression tests.
- Fix commit SHA: `28ec0d99e8daf896db2da7648d44232cf1fc7c51`.

### CANARY-2 Stale Deployment SHA

- Status: FIXED IN CODE.
- Evidence: Production-deployed main SHA was `09faae89f97f4e128f6f1318b1ded558afd8096c`, while new epochs were stamped with stale `e2ac939a89ccba5964930d4e147f8dc855ca51f4`.
- Fix: Prefer provider-native deployment SHA environment variables over manual `SPORTS_SHADOW_GIT_SHA`; reject missing/invalid SHA when Sports Shadow is enabled. Production follow-up showed the runtime is still receiving stale manual provenance, so operator configuration remains required before canary can pass.
- Regression test: `src/lib/sports-shadow/config.test.ts`.
- Fix commit SHA: `28ec0d99e8daf896db2da7648d44232cf1fc7c51`.

### CANARY-3 Kalshi 429 Handling

- Status: FIXED IN CODE.
- Evidence: Production observed Kalshi discovery HTTP 429 and unresolved `venue_discovery_failed:KALSHI` alert.
- Fix: Use existing host-aware cooldown path for Kalshi discovery; persist cooldown, suppress upstream calls while blocked, keep PM-US independent, and resume automatically after cooldown expiry.
- Regression test: `src/lib/sports-shadow/kalshi.server.test.ts`.
- Fix commit SHA: `28ec0d99e8daf896db2da7648d44232cf1fc7c51`.

### CANARY-4 PM-US Deadline Starvation

- Status: FIXED IN CODE.
- Evidence: Production source lane wrote fills/signals, but PM-US matching repeatedly reported `deadlineReached=true` with `pendingProcessed=0`.
- Fix: Reserve usable matching time inside the source worker by cutting off ingestion early enough to tolerate one source request overrun plus the venue matching reserve.
- Regression test: `src/lib/sports-shadow/worker.server.test.ts`.
- Fix commit SHA: `28ec0d99e8daf896db2da7648d44232cf1fc7c51`.

### CANARY-5 Runtime Deployment SHA Configuration

- Status: CORRECTED FOR `b97da7c5c09c6acf080b6f034e5c65499aa8b778`; MUST BE UPDATED AFTER NEXT MAIN COMMIT.
- Evidence: During the follow-up canary at `2026-08-25 04:04:45.1327+00`, Sports Shadow workers ran successfully but reused current epoch `8a965380-d3e3-4d5c-b33a-13bc0f4b2b90` with stale `git_sha=e2ac939a89ccba5964930d4e147f8dc855ca51f4`; no new epoch was created for `28ec0d99e8daf896db2da7648d44232cf1fc7c51`.
- Fix: Lovable confirmed it does not expose a reliable provider-native deployment SHA; use manual `SPORTS_SHADOW_GIT_SHA` and update it to the exact deployed `main` SHA before re-enabling cron.
- Regression test: `src/lib/sports-shadow/config.test.ts` proves provider SHA wins over stale manual fallback, but production env must be corrected operationally.
- Fix commit SHA: operational configuration item, not a source-code commit.

### CANARY-6 PM-US Discovery Truncation

- Status: FIXED IN CODE; DEPLOYMENT PENDING.
- Evidence: Latest production canary showed PM-US matching received time but made no downstream progress: 40 pending found, 0 pending processed, 0 exact matches, 0 rejected, 2 discovery-failed cycles, 0 deadline-reached cycles, 0 observations, with `discovery truncated at DISCOVERY_MAX_PAGES (10)`.
- Root cause: PM-US discovery scanned the unfiltered `/v1/events?category=sports` all-sports catalog. Live API probes on 2026-08-25 showed attempted `/v1/events` filters for `league`, `sport`, `seriesSlug`, and `tag` did not narrow results, while `/v2/leagues/mlb/events` returned the bounded MLB universe with required `marketSides` orientation data.
- Fix: Switch PM-US baseline discovery to paginated `/v2/leagues/mlb/events?limit=200&offset=...&active=true&closed=false`, preserving host-aware rate limits, lease/deadline checks, cache TTL, marketSlug dedupe, and fail-closed truncation when the MLB endpoint itself cannot prove completeness.
- Regression test: `src/lib/sports-shadow/pmus.server.test.ts` asserts the MLB endpoint is used and all-sports `/v1/events` is not; `src/lib/sports-shadow/worker.server.test.ts` proves 40 pending signals share one PM-US discovery pass and process while Kalshi is independently in cooldown; existing PM-US/resolver tests preserve wrong-event and market-granularity fail-closed behavior.
- Fix commit SHA: `ea941bad72424c54f3b4d8f7c5391bcf6d55a122`.
