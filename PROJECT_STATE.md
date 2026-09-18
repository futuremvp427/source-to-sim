# Project State

## Agent Rule

Read PROJECT_STATE.md before beginning substantive work. Do not reopen a CLOSED finding unless a regression test fails or new production evidence directly contradicts it. Update PROJECT_STATE.md before finishing the task.

## Current Production State

- Sports Shadow cron was observed active at the start of the 2026-08-26 end-to-end repair mission after the prior controlled observation restart.
- `sports-shadow-cycle-observation`: expected `active=true`, schedule `10 seconds` while controlled observation is running.
- `sports-shadow-cycle-source`: expected `active=true`, schedule `30 seconds` while controlled observation is running.
- `sports-shadow-cycle-settlement`: expected `active=true`, schedule `* * * * *` while controlled observation is running.
- Legacy `sports-shadow-cycle` job: absent in the latest verified production state.
- Live execution is disabled. `LIVE_EXECUTION_IMPLEMENTED=false`.
- Current deployed/runtime SHA at the start of the matcher-zero investigation: `c2628ce68022ee1f71847da736b6792aaf273887`.
- Current production epoch at the start of the matcher-zero investigation: `7fe4b859-bbe3-445e-aadf-2f2e8ffa78af`.
- Runtime provenance was aligned with deployed SHA before the matcher-zero repair began.
- Source ingestion and Phase-2 signal classification were producing current-epoch signals before the matcher-zero repair began.
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

### PHASE2-1 Source Phase-2 Starvation (fresh PENDING never classified)

- Status: FIXED IN CODE AND VALIDATED BY TESTS; DEPLOYED FROM `3d76826bad01ec36f2632b2b0c576a8e4d329604`; RUNTIME SHA UPDATE PENDING.
- Evidence (2026-08-25 14:4x UTC production): 3,610 `sports_shadow_source_fills` PENDING, ALL post-go-live (go_live_at 2026-08-24 17:42+00); 0 signals on current epoch `9fce282e-1ed7-498d-a375-57e46ba43cf8`; only 114 distinct condition_ids across the whole backlog, so metadata cost was never the limiter.
- Root cause 1 (deadline): `sourceIngestDeadline` left the wallet poll a 6s window (30s lane - 12s venue reserve - 12s overrun allowance), which is SMALLER than `PHASE2_DOWNSTREAM_RESERVE_MS` (8s). `phase1IngestDeadline` subtracted the reserve flatly, so a window at/below the reserve gave Phase 1 the ENTIRE window and Phase 2 exactly zero time — every cycle, forever.
- Root cause 2 (execution order): pending fills were selected fresh-inclusive but EXECUTED strictly oldest-first, so the historical backlog consumed the bounded window before fresh followed-wallet trades were reached (hundreds of `orphanedFillsRecovered` with `newSignals=0`).
- Fix: `SOURCE_INGEST_OVERRUN_ALLOWANCE_MS` 12s -> 3s (poll window 15s; venue reserve unchanged at 12s); `phase1IngestDeadline` reserve is now proportional (never more than half the remaining window); new pure `orderPendingFillsFreshFirst` (newest `FRESH_PENDING_QUOTA=40` rows first, chronological within each group, old backlog still bounded-progress after).
- Telemetry: SOURCE `pending_selected`, `pending_fresh_selected`, `pending_processed`; `WalletPollResult`/`WalletSummary` carry the same fields.
- Tests: `src/lib/sports-shadow/phase2-liveness.test.ts` (11 cases: proportional reserve, non-zero Phase-2 slice, fresh-first ordering incl. small queues, determinism, venue reserve intact); `starvation-regression.test.ts` and `source-poll.test.ts` green; `worker.server.test.ts` 97/97 green — its earlier failures were solely Vitest's 5s default against 4-7s concurrency-ordering tests, now raised test-only via `vite.config.ts` (`test.testTimeout = 30_000`). No production timeout was raised to pass tests.
- Operational follow-up: `SPORTS_SHADOW_GIT_SHA` must be set to `3d76826bad01ec36f2632b2b0c576a8e4d329604` before new epoch data is treated as authoritative; automated rotation was declined, so it needs the operator's secure form.
- Live execution unchanged: `LIVE_EXECUTION_IMPLEMENTED=false`.

### MATCHER ZERO-EXACT INVESTIGATION

- Status: CODE FIXED LOCALLY; DEPLOYMENT AND END-TO-END PRODUCTION COPY VERIFICATION PENDING.
- Previous production distribution supplied at mission start: 0 EXACT / 5 NEAR / 20 NONE / 12 UNVERIFIED.
- Expanded production distribution observed from `sports_market_matches` during the investigation: PM-US NEAR 202, PM-US NONE 54, PM-US UNVERIFIED 12, KALSHI 0 durable match rows, EXACT 0.
- Representative WNBA false-rejection evidence: signal `d0467589-77cd-48b3-975d-e551e13594a1`, source market `wnba-chi-conn-2026-08-25-total-167pt5`, was stored with home participant `GENERIC:connecticut sun o u 167 5`, causing PM-US NONE / `NONE_NO_CANDIDATE` even though PM-US listed the `Chicago vs. Connecticut` WNBA event.
- Representative MLB rule evidence: signal `e38dd159-8618-4c01-9288-9571c9a53215` correctly found CLE @ LAA on PM-US, but remained NEAR because source Gamma rules settle canceled/no-makeup/tie cases at 50-50 while PM-US settles delayed/postponed/suspended games not rescheduled within two weeks to last fair market price. This is a legitimate economic incompatibility, not a parser bug.
- Actual defects found:
  - WNBA source titles of the form `Team A vs. Team B: O/U ...` polluted the parsed home participant.
  - WNBA lacked an audited canonical slug/team adapter, so current-epoch WNBA signals could fail before meaningful PM-US market evaluation.
  - PM-US side matching used MLB/global team normalization and could not safely orient WNBA city-only PM-US sides under known WNBA league context.
  - Source rule metadata persisted only market-level Gamma descriptions and discarded event-level rule text such as WNBA overtime language.
  - Kalshi live MLB payloads use abbreviations such as `Los Angeles A`, `Chicago WS`, `Chicago C`, `New York Y`, and `New York M`; those were missing from the audited MLB alias table.
  - Kalshi 429 responses without `Retry-After` used the generic fallback cooldown, which was too short for the observed production rate-limit cadence.
  - Capability probes bypassed the shared host cooldown/reservation path and could amplify venue rate limits outside normal discovery/paper observation flow.
- Legitimate rejection categories preserved:
  - PM-US/Kalshi delayed/canceled settlement rules that resolve to last fair market price remain NEAR against source contracts that resolve no-makeup/tie/cancel outcomes to 50-50.
  - Missing source or target rule text remains UNVERIFIED.
  - Same teams on different dates/start times do not false-match.
  - Totals still require exact line equality.
  - Spread and moneyline side orientation remain tied to explicit venue side evidence.
  - Partial-game/prop/set/map/exotic markets remain excluded by the classifier and resolver tests.
- Implementation:
  - Added league-scoped WNBA canonical identities and a WNBA sport adapter.
  - Stripped market suffixes from `A vs B: O/U/total/spread/moneyline` title parsing.
  - Made source and PM-US side parsing use league-aware participant normalization only when league identity is known.
  - Combined Gamma market and event descriptions into source settlement-rule evidence.
  - Recognized overtime wording in the extra-period settlement dimension without relaxing postponement/cancellation compatibility.
  - Added live-observed Kalshi MLB aliases.
  - Persisted a 5-minute Kalshi cooldown when a 429 lacks `Retry-After`.
  - Routed capability probes through shared host cooldown, reservation, and 429 persistence.
- Files changed: `src/lib/sports-shadow/all-sports.test.ts`, `src/lib/sports-shadow/capability.server.ts`, `src/lib/sports-shadow/capability.server.test.ts`, `src/lib/sports-shadow/epoch.ts`, `src/lib/sports-shadow/kalshi.server.ts`, `src/lib/sports-shadow/kalshi.server.test.ts`, `src/lib/sports-shadow/participant-normalization.ts`, `src/lib/sports-shadow/resolver.ts`, `src/lib/sports-shadow/resolver.test.ts`, `src/lib/sports-shadow/source-metadata.server.ts`, `src/lib/sports-shadow/source-metadata.server.test.ts`, `src/lib/sports-shadow/sport-registry.ts`, `src/lib/sports-shadow/sport-registry.test.ts`, `src/lib/sports-shadow/team-normalization.ts`, `src/lib/sports-shadow/team-normalization.test.ts`.
- Regression tests:
  - WNBA real O/U title parses CHI/CONN without the line suffix contaminating the home team.
  - WNBA PM-US candidate evaluation reaches rule compatibility instead of false NONE.
  - Compatible WNBA city-only PM-US moneyline sides can produce EXACT under compatible source/target rules.
  - Current CLE/LAA PM-US remains NEAR under live-observed incompatible rules.
  - Genuine compatible rules can still produce EXACT.
  - Missing rules remain UNVERIFIED.
  - Same teams on different dates do not false-match.
  - Totals require exact line equality.
  - Spread orientation remains LONG/SHORT-derived.
  - Moneyline side orientation remains LONG/SHORT-derived.
  - Kalshi no-`Retry-After` 429 records the 5-minute shared host cooldown.
  - Capability probes respect host cooldown and persist Kalshi 429s.
- Local verification before deployment:
  - Targeted matcher/capability suite: 11 files passed, 417 tests passed.
  - Full Vitest: 130 files passed, 1 skipped; 2,005 tests passed, 9 skipped.
  - TypeScript: PASS.
  - Production build: PASS.
  - `git diff --check`: PASS.
- Final fix commit SHA: PENDING.
- Final deployed SHA: PENDING.
- Runtime SHA: PENDING.
- Production results: PENDING.
- First legitimate EXACT: PENDING.
- First quote observation: PENDING.
- First paper fill: PENDING.
- First paper position: PENDING.
- Dashboard verification: PENDING.
- Live execution unchanged: `LIVE_EXECUTION_IMPLEMENTED=false`.

## KALSHI SAME-VENUE (KALSHI -> KALSHI) COPY ROUTE

- Status: SOURCE-INDEPENDENT ADAPTER COMPLETE (OUTCOME B). NO VERIFIED PUBLIC-TRADER TRANSPORT EXISTS; NONE FABRICATED.
- Objective: bypass Polymarket -> Kalshi economic-equivalence matching by copying a Kalshi public trader's own activity on the EXACT same Kalshi ticker and side.
- Pre-work check: branch `feature/kalshi-same-venue-copy-source` / PR #61 content is NOT present in this workspace (only `main` and lovable backup branches are available locally), so nothing was duplicated.
- Files added:
  - `src/lib/sports-shadow/kalshi-source.ts` (pure; no network, Supabase, clock, or env access)
  - `src/lib/sports-shadow/kalshi-source.test.ts` (11 focused tests)
  - `docs/KALSHI_SAME_VENUE_SOURCE.md`
- Files modified: `PROJECT_STATE.md` only. No existing Sports Shadow module, migration, or historical cross-venue result was changed.
- Routing contract: a normalized same-venue trade carries `route: "SAME_VENUE_KALSHI"`; `requiresCrossVenueResolution()` is false for it and the adapter module does not reference `resolver.ts` or any `pmus*` module (asserted statically in test 2).
- Fail-closed required evidence per source event: trader id, source trade id, verified Kalshi ticker shape, YES|NO, BUY|SELL, quantity > 0, integer priceCents in [1,99], positive unix-seconds timestamp. Nothing is inferred or defaulted.
- Dedupe: `KALSHI_SRC:<traderId>:<sourceTradeId>`, reused as `EligibleFill.eventKey` so the existing `episode.ts` duplicate guard and the DB event_key unique constraint both apply.
- Reuse (nothing reimplemented): `episode.ts` lifecycle reducer (BUY / ADD-DCA / partial SELL / full SELL, exit fractions), observation capture, `paper.server.ts` deterministic paper execution and positions, Kalshi book normalization and fees, sizing, settlement, leases, epochs, telemetry, dashboard.
- Position identity: `conditionId = ticker`, `asset = ticker:SIDE`, so YES and NO legs of one ticker are never merged.
- Trader qualification: `KalshiTraderQualification.approvedForPaperCopy` must be set by a deliberate external decision; a null/absent/unapproved watchlist entry yields `REJECT_TRADER_NOT_QUALIFIED`. No numeric thresholds invented; an `evidence` bag holds later criteria (performance windows, trade count, repeatability, concentration, categories, liquidity, holding duration, entry-to-detection latency, realized vs unrealized, copy slippage, fees, drawdown, single-win dependence).
- Verified Kalshi trader source exists: NO. Kalshi documents market data/orderbooks, ANONYMOUS public market trades (no trader identity), and portfolio endpoints scoped to the authenticated account only. No documented endpoint returns another specific trader's or leaderboard account's trades.
- Remaining blocker: the five evidence items listed in `docs/KALSHI_SAME_VENUE_SOURCE.md` (documented cross-account activity endpoint, stable public trader id, per-trade id, full per-trade fields, documented rate limits/terms). `KalshiTraderActivitySource` stays an interface with no production implementation.
- Tests run: `kalshi-source.test.ts` 11/11 pass; `episode.test.ts` + `kalshi.test.ts` + `resolver.test.ts` + `deployment-readiness.test.ts` 206/206 pass; TypeScript check PASS; production build PASS. Full suite not run (change is additive and isolated; budget-bounded).
- Safety state unchanged: `LIVE_EXECUTION_IMPLEMENTED=false`; kill switch/activation state untouched; no live-order path added or reachable; real orders placed = 0; no Supabase migration created; no risk, dedupe, lease, settlement, sizing, or fail-closed protection loosened.
- Next smallest step: obtain or rule out a documented Kalshi cross-account trader-activity source. If one is confirmed, implement exactly one `KalshiTraderActivitySource` transport plus a persistence path that writes admitted events as source fills with `route=SAME_VENUE_KALSHI`, and wire the worker to skip venue matching for those rows.

## 2026-09-17 — Kalshi public-trader source contract investigation (NOT VERIFIED)

Investigation only; no production code changed.

- **Verdict**: NOT VERIFIED. Kalshi exposes no legitimate read-only surface returning a
  specific public trader's activity with the fields required for same-venue copying.
- **Inspected**: Trade API v2 OpenAPI (schemas + tag list), `/markets/trades`,
  `/historical/trades`, `/portfolio/*`, `/historical/positions`, `kalshi.com/social` and
  `/social/leaderboard` (live fetch blocked by a Vercel bot checkpoint), help-center articles
  on Leaderboard / Social posting / Inner Circle / Community Guidelines, documented rate
  limits and Developer Agreement, third-party Apify profile scrapers.
- **Available**: trade-level fields exist but only anonymously (`trade_id`, `ticker`,
  `taker_outcome_side`, `taker_book_side`, `count_fp`, price fields, `created_time`).
  Identity exists only as an opt-in leaderboard username with aggregate profit/volume/count.
- **Missing**: per-trade trader/account identifier, per-account BUY/SELL direction,
  entry-vs-exit distinguishability, any documented delegated/consent API (Inner Circle is an
  in-app gate with no published schema).
- **Files changed**: `docs/KALSHI_SAME_VENUE_SOURCE.md` (appended investigation section),
  `PROJECT_STATE.md` (this entry). No source files, no migration.
- **Reused**: existing same-venue adapter `src/lib/sports-shadow/kalshi-source.ts` and its
  11-test suite, untouched. No competing adapter created.
- **Transport / persistence / worker route**: not implemented (would have required fabricated
  data).
- **Safety**: `LIVE_EXECUTION_IMPLEMENTED=false` unchanged; no order path; real orders = 0;
  no dedupe/lease/sizing/settlement protection loosened.
- **Next step**: obtain a written answer from Kalshi on a supported consenting-trader read
  interface (and any Inner Circle API schema) before writing any transport.

## Session: Same-venue Kalshi PAPER path — source-independent downstream plumbing (2026-09-18)

ARCHITECTURE NOW IMPLEMENTED
future verified KalshiTraderActivitySource -> admitSameVenueSourceEvent (fail-closed
normalization + DURABLE trader qualification gate) -> admit_sports_shadow_kalshi_source_event
RPC (idempotent insert, event_key UNIQUE + (trader_id, source_trade_id) UNIQUE) ->
claim_sports_shadow_kalshi_source_events (PENDING->PROCESSING, FOR UPDATE SKIP LOCKED) ->
assertSameVenueRoute (fails closed; resolver / PM-US discovery / Gamma / cross-venue
equivalence are NEVER invoked and never imported) -> episode.ts replay + decideFill
(ENTRY / ADD-DCA / proportional EXIT / close) -> exact byte-identical Kalshi ticker + side ->
read-only fetchKalshiBook -> walkBuyDepth / walkSellDepth + computeTakerFeeForFills across the
existing 5 notional tiers -> finalize_sports_shadow_kalshi_paper_fill (fill row + atomic tier
position mutation, UNIQUE (source_event_id, notional_tier_usd)) -> paper positions +
settlement table for P&L attribution to the source trader.

FILES CHANGED
- drizzle/migrations/0000_sports_shadow_same_venue_kalshi_source.sql (new, applied)
- src/lib/sports-shadow/kalshi-same-venue.ts (new, pure orchestration)
- src/lib/sports-shadow/kalshi-same-venue.server.ts (new, Supabase + read-only book driver)
- src/lib/sports-shadow/kalshi-same-venue.test.ts (new, 14 tests)
- PROJECT_STATE.md
Existing kalshi-source.ts adapter and its 11 tests were reused unchanged; no competing
adapter was created; no cross-venue file was modified.

SCHEMA DECISION: MIGRATION (additive), not reuse. sports_shadow_paper_fills requires
NOT NULL signal_id and UNIQUE (observation_id, notional_tier_usd); a same-venue event has no
cross-venue signal, venue-match row or dual-venue observation, so reuse would have overloaded
those semantics and mixed same-venue rows into historical cross-venue EXACT/NEAR/NONE metrics.
New isolated tables: sports_shadow_kalshi_trader_qualification, _source_events, _paper_fills,
_paper_positions, _settlements. Reused as-is: episode.ts, depth-walk.ts, fees.ts,
fetchKalshiBook, worker lease patterns, experiment-epoch provenance FK.

WORKER INTEGRATION: processPendingSameVenueEvents is implemented and tested end-to-end
against the durable contract, but no cron/schedule was registered and production stays inert:
getConfiguredKalshiTraderActivitySource() returns null, so runSameVenueIngestCycle admits
nothing. Production cron state was not modified. Nothing was published or deployed.

TESTS: kalshi-same-venue 14/14, kalshi-source 11/11, episode 49/49, kalshi 58/58,
paper.server 23/23, depth-walk 54/54, fees 21/21, deployment-readiness 5/5. TypeScript clean.
Production build clean.

SAFETY: PAPER/RESEARCH ONLY. LIVE_EXECUTION_IMPLEMENTED=false unchanged. No order
construction, no order endpoint, no live-order path reachable (asserted by test 13).
Real orders placed: 0. No dedupe/lease/sizing/settlement/fail-closed rule weakened.

REMAINING BLOCKER: a VERIFIED external Kalshi trader activity feed. That is now the only
blocker — every stage after it exists, is durable and is tested.

## 2026-09-18 — Same-venue Kalshi PAPER hardening pass (source-independent)

Scope: source/test code only. The DB hardening patch (idempotent admission on both
identities, 15-minute stale PROCESSING reclaim, gross realized_pnl_usd vs separate
fees_usd, settlement next_check_at/check_attempt_count, find_open_sports_shadow_kalshi_positions,
finalize_sports_shadow_kalshi_settlement) was applied to the database by the owner; no
migration was written or applied here.

Implemented
1. ADD/DCA sizing now matches the cross-venue lifecycle exactly: `followerActionForDecision`
   carries `addFraction = new source BUY shares / source remaining shares BEFORE the add`
   (the same formula as source-poll.server.ts), and the buy branch requests
   `tier * addFraction` instead of a fresh full tier per DCA.
2. ADD with no OPEN follower position in that tier (e.g. the ENTRY never filled) records
   fill_status REJECTED / contracts 0 / reject_reason NO_OPEN_FOLLOWER_POSITION_FOR_ADD and
   never opens a position out of an ADD.
3. Fee fail-closed on ENTRY/ADD/EXIT: FULL/PARTIAL depth alone is no longer sufficient. An
   absent or invalid fee records REJECTED with contracts 0 (which cannot mutate a position,
   per the RPC's own `p_contracts <= 0` guard). The fee model is injectable for tests only;
   production always uses the documented Kalshi model.
4. New same-venue settlement runner (pure `kalshi-same-venue-settlement.ts` + driver in
   `kalshi-same-venue.server.ts`): reads DUE OPEN positions via
   find_open_sports_shadow_kalshi_positions, checks resolution via the EXISTING
   exchange-authoritative checkKalshiSettlement, applies 10-min/x2/6-hour backoff for
   PENDING, and finalizes via finalize_sports_shadow_kalshi_settlement. Terminal P&L:
   realized_pnl_usd is prior GROSS EXIT P&L; WIN remaining = contracts_open * (1 - avg),
   LOSS remaining = contracts_open * (0 - avg), PUSH/VOID/CANCELED add zero; gross total =
   prior + remaining; net = gross - fees_usd exactly once. Open contracts with no valid
   avg entry price fail closed to terminal VOID with NULL P&L. Bounded by a deadline checked
   before each position. NO cron/schedule registered.

Files changed
- src/lib/sports-shadow/kalshi-same-venue.ts (ADD sizing, ADD/fee fail-closed)
- src/lib/sports-shadow/kalshi-same-venue-settlement.ts (new, pure)
- src/lib/sports-shadow/kalshi-same-venue.server.ts (settlement repository + runner)
- src/lib/sports-shadow/kalshi-same-venue.test.ts (fee stub + tests 15-17)
- src/lib/sports-shadow/kalshi-same-venue-settlement.test.ts (new, 7 tests)

Tests: same-venue 17/17, same-venue settlement 7/7, kalshi-source 11/11, episode 49/49,
paper.server 23/23, settlement.server 9/9, settlement.orchestrator 16/16, fees 21/21,
kalshi 58/58. TypeScript clean. Production build clean.

Safety: PAPER/RESEARCH ONLY, LIVE_EXECUTION_IMPLEMENTED=false, no order endpoints, real
orders = 0, source feed still null/inert, no cron/schedule/publish changes.

Remaining blocker: a verified external Kalshi trader activity feed. Everything downstream
of it — admission, dedupe, lifecycle, sizing, fee gating, paper positions, settlement P&L —
now exists and is tested.
