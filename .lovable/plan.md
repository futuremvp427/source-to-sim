# Sports Forward Shadow — recovery diagnostic (read-only)

No code, data, secrets, cron, or publish changes were made. Scheduler stays absent/paused. `LIVE_EXECUTION_IMPLEMENTED` remains false; zero order paths were touched.

## 1) What is causing cycle_error_count=1 / source_unhealthy

**Proven**
- `source_unhealthy` is raised whenever a cycle reports `sourcePollFailed` — i.e. at least one wallet poll returned a non-null `error` (`alerts.server.ts:190`). Latest unresolved: 2026-08-23 15:08:24.
- The **error text is never persisted anywhere**. `runSportsShadowCycle` collects strings in `summary.errors`, but `onCycleComplete` records only `cycle_error_count` (a count) to telemetry; the strings are returned in the HTTP response body only. There is no error-message column in `sports_shadow_telemetry_events` and no sports error rows in `alerts`/`pipeline_audit`.
- Consistent with a wallet-level failure: the last three cycles (15:06, 15:09, 15:15) each had `wallets_attempted=1`, but `sports_shadow_wallet_coverage` was written only at 15:06:06 and 15:09:06 — the 15:15 cycle's attempted wallet produced no coverage row, which is exactly the fail-closed path taken when a poll errors or throws.
- Contention evidence: `http_rate_limits` shows `data-api.polymarket.com` with `next_request_at` still advancing at 15:28 (i.e. after the sports cycles stopped) — the V2/V3/candidate/general shadow workers keep that host busy. Global pacing is `MIN_REQUEST_INTERVAL_MS = 500` per host, shared by all cohorts, and `fetchSourceMarketMetadata` throws `DeadlineExceededError` when the pacing wait exceeds the caller budget.

**Unknown (cannot be proven from current evidence)**
- The exact error string. Candidates, all reachable in one wallet poll: `fetchSourceMarketMetadata failed: … deadline reached after pacing wait`, `findPendingDownstreamFills failed: …` (statement timeout on the 500-row pending query), or a `data-api` trade-page failure. Distinguishing them requires either persisting `summary.errors` or reading one cycle's HTTP response — neither done here.

## 2) Why 33,593 rows are still PENDING and zero signals exist

**Proven**
- Backlog composition: `PENDING = 33,593`, `TERMINAL_UNVERIFIED = 211`, and **no rows at all** in `COMPLETE`, `TERMINAL_INELIGIBLE`, or `TERMINAL_INVALID`. Every `TERMINAL_UNVERIFIED` row was written in a 19-second burst on 2026-08-22 17:00:43–17:01:01. Since that burst, **not one fill has changed disposition** — so Phase 2 has made zero durable progress for ~22 hours, not slow progress.
- `source_ts` on PENDING rows spans 1782340964 (June) to 1787496855 (today), and titles are historic UFC/MLB/tennis markets — the bulk is pre-go-live history that should end as `COMPLETE` via `suppressedPreGoLive`, or `TERMINAL_INELIGIBLE`. None have.
- Structural budget: source lane 30s, minus `VENUE_MATCH_RESERVE_MS` 12s → 18s ingest; Phase 1 stops at ingest−`PHASE2_DOWNSTREAM_RESERVE_MS` (8s), leaving ~8s for Phase 2. Observed `cycle_duration_ms` 18.4s/19.0s matches that budget being fully consumed. Every disposition in Phase 2 is gated behind a Gamma metadata fetch that must first win a 500 ms-paced slot; on a `DeadlineExceededError` or fetch failure the fill **stays PENDING** by design.
- Every one of the 33,804 fills has `identity_degraded = true`.
- `sports_shadow_signals = 0` follows directly: an episode/signal is only inserted after a fill reaches an ELIGIBLE metadata verdict, so zero dispositions ⇒ zero signals ⇒ zero paper fills/positions/settlements. `new_signals=0` with `deadline_reached=0` on both venues is therefore consistent — the venue lanes are idle because there is nothing pending to match, not starved.

**Unknown**
- Whether Phase 2 is aborting *before* its first metadata fetch (deadline already spent by Phase 1) or *at* the fetch (pacing/429). Both are consistent with the observed zero-progress; the persisted counters (`metadataFetchFailures`, `suppressedPreGoLive`, etc.) are returned per-poll but not stored.

## 3) Are the PR #55 schema objects actually present?

**Proven — yes, verified object-by-object, not by ledger.** The merge (`c745bfc`) carries 14 migration files (not 6). Checked against production catalogs:
- Functions present: `get_sports_shadow_soak_telemetry_rollup`, `insert_sports_shadow_episode` (with `p_source_rules_description`), `update_sports_shadow_episode` (with lifecycle/untracked params), `find_pending_sports_shadow_signals`, `find_open_sports_shadow_paper_positions`, `get_sports_shadow_episode_outcomes`, `record_sports_shadow_routing_provenance_ladder`, `finalize_sports_shadow_routing_decision`, `record_sports_shadow_lifecycle_trigger`, `finalize_sports_shadow_lifecycle_decision`, `find_unscheduled_sports_shadow_lifecycle_triggers`.
- `record_sports_shadow_routing_provenance` (non-ladder) is absent **by design** — dropped in `20260825100000_sports_shadow_routing_tier_ladder.sql` and unreferenced in code.
- Indexes present: `sports_shadow_source_fills_pending_idx`, `sports_shadow_paper_fills_pending_cutoff_idx`, `sports_shadow_lifecycle_triggers_signal_idx`, `sports_quote_observations_lifecycle_schedule_idx`.
- Columns present: all 22 added columns across `sports_shadow_signals`, `paper_fills`, `paper_positions`, `settlements`, `source_sell_events`, `wallet_coverage`, `sports_quote_observations`, `sports_market_matches`.
- Independent confirmation: `scripts/verify_schema_contract.py` against production returned `SCHEMA CONTRACT PASS {columns 43, constraints 17, functions 12, indexes 15, policies 4, rls 14, table_grants 15}`.

Schema is **not** the blocker.

## 4) Why wallet_coverage has 2 rows and wallets_attempted=1

**Proven**
- `wallets_attempted=1` is expected-by-construction, not a config defect: the lane breaks out of the wallet loop at the 18s ingest deadline, and the rotation cursor (`sports_shadow_wallet_cursor.next_wallet_index = 1`) advances only past what was attempted. With a 33k backlog, one wallet consumes the whole budget, so the cohort is covered round-robin over cycles — three cycles minimum per full sweep, and only three cycles have run today.
- All three cohort wallets have fills (10,272 / 13,269 / 10,263), so the cohort config itself is intact.
- Coverage rows exist only for `0x32ed…f960` (15:06:06) and `0xa710…23c4` (15:09:06); `0x5268…135d` — the largest backlog — has **no** row. Both existing rows have `coverage_complete = true` but `covered_through_ts = NULL`.

**Assessment:** the *rotation* is expected; the *missing third row* is a defect signal — it is the fail-closed footprint of the wallet error in (1). Also, `coverage_complete=true` with a NULL `covered_through_ts` is a weak coverage claim worth auditing before any soak is counted.

## 5) Is the deployed runtime actually running c745bfc?

**Proven: yes, the code is post-#55; the runtime *configuration* and epoch metadata are stale.**
- The epoch created today at 15:06:06 records `kalshi_fee_model_version = KALSHI_FEE_V2_2026-07-07`. That constant exists only at/after the merge — the merge's first parent still had `KALSHI_FEE_V1_2026-02-05`. Only post-#55 code can write V2, so the process that created that epoch was running merged code.
- Stale runtime config, independently: `git_sha = d2c29760…` comes verbatim from the `SPORTS_SHADOW_GIT_SHA` env value (`config.ts:102`), and `go_live_at = 2026-08-22T17:10Z` from `SPORTS_SHADOW_GO_LIVE_AT`. Neither was updated for this rollout, so epoch `5fd8ee27…` is correctly flagged in its own `notes` as an INVALID recovery/canary epoch and must not be counted as a soak.
- Route probing gave no signal: GET on all three hook paths returns 200 (SPA fallback), so it cannot distinguish route presence.

## 6) Smallest safe recovery sequence (nothing executed)

Ordered, each step gated on the previous, scheduler stays off until step 4.

1. **Make the failure observable.** Persist `summary.errors` (truncated, PII-free) for source/observation/settlement cycles — e.g. a `SYSTEM`/`cycle_error` telemetry row per error string, or a `last_error` write on the sports worker row. Without this, every later step is guesswork.
2. **One manual, authenticated `lanes="source"` invocation** with the response body captured (scheduler still absent). Read the returned `errors[]`, `metadataFetchFailures`, `suppressedPreGoLive`, and per-wallet `error` to convert item (1) from hypothesis to fact.
3. **Fix the pre-go-live backlog drain, once the error is known.** The likely change is to dispose fills whose decision needs *no* network call before spending any metadata budget: `sourceTs < goLiveAtMs` is decidable from the row alone, so those ~33k rows can be marked `COMPLETE` in bounded batches without a single Gamma request. Pair with a Phase 2 budget that can't be zeroed by Phase 1. Add a regression test asserting a pre-go-live fill is disposed with zero metadata fetches.
4. **Drain, then verify** with manual invocations only: PENDING must fall monotonically, and dispositions must appear in `COMPLETE`/`TERMINAL_*`. Only when PENDING is at steady-state (post-go-live rows only) and `wallets_attempted` reaches the full cohort per sweep does the pipeline deserve a scheduler.
5. **Only then start a genuinely fresh epoch:** update `SPORTS_SHADOW_GIT_SHA` to `c745bfc…` and `SPORTS_SHADOW_GO_LIVE_AT` to a future timestamp, leave epoch `5fd8ee27…` marked INVALID, install cron, and confirm the new epoch row carries the new SHA and go-live before counting soak time.

Not in scope for recovery: any live-execution path, any deletion or rewrite of existing fills, and any change to the V2/V3/candidate/general cohorts (they are healthy and actively settling).
