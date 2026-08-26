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

## STRATEGY-DISCOVERY MISSION (branch: strategy-discovery-research, 2026-08-26)

- Status: MISSION COMPLETE FOR THIS PASS. ALL TESTED/CHECKED CANDIDATES REJECTED. WEATHER DIRECTIONAL FAMILY REMAINS CLOSED AND WAS NOT REOPENED. PAPER/RESEARCH ONLY.
- Purpose: independently discover, kill-screen, and minimally backtest NON-weather prediction-market strategy candidates for a US-legal system. Full board, kill-screen reasoning, and preregistration in `docs/STRATEGY_DISCOVERY_BOARD.md`.
- Branch created fresh from `main` at `aafe7a5f0966abb4a30de07b96bd1932ad8d356f`. Sports Shadow inspected read-only (`src/lib/sports-shadow/kalshi.ts`, `source-poll.server.ts`) to confirm real Kalshi API mechanics -- not imported, not modified.
- **10 candidate families (A-J) surveyed.** A/D/E (sportsbook fair value, sports info latency, sportsbook line lead-lag) killed on verified data unavailability: ESPN's free/keyless odds API is real but snapshot-only (no historical time series); Pinnacle's public API has been closed since 2025-07-23; The Odds API needs a paid key; no free historical tick-level sportsbook odds source was found. F (non-weather exhaustive-set arb) killed on the already-verified Kalshi quadratic-fee-floor prior from the weather basket work, spot-checked live against a non-weather ladder (Fed threshold series) before rejecting rather than merely assumed. G (resolution/rule mispricing) deprioritized to `INCONCLUSIVE` -- no concrete current case surfaced within session scope.
- **J (`kachence/polymm`) fully code-audited (not README-trusted), commit `f598cf8`.** Real, honestly-documented retired bot, but: crudest standard de-vig method only (multiplicative), with a documented bug where a `method="shin"` parameter silently fell through to proportional; odds source requires a paid key; no fee model in the code; its own verification/analytics tool computes P&L from Polymarket's `/positions`/`/closed-positions`, the exact survivorship-filtered endpoint already independently proven broken in this project's weather wallet-cashflow audit. Author's own README: "mostly stopped being profitable" once it "got too slow to defend its edge"; the scraping pipeline that was "half the edge" is not included in the public repo. Claimed Jan-Apr 2026 figures (~+$4,973 net) are NOT reproducible from anything committed to the repo -- unverified marketing, not evidence. REJECTED before any backtest.
- **I (wallet mining): documented incomplete lead, not a rejection of the category.** polymm's linked handle `@b00k13` could not be resolved to a `0x...` address via any public unauthenticated Polymarket endpoint tried. Public leaderboard scan (all-time and monthly, sports category) surfaced only mega-scale entries ($7M-$23M lifetime; $500K-$3.6M/month) -- too large-scale to be a legible, retail-copyable mechanism; using them would repeat the "wallet profitability is not evidence copying works" mistake already flagged twice in the weather work.
- **Shortlisted and tested: H (liquidity-shock mean reversion) and B (passive maker value), on Kalshi MLB game markets (`KXMLBGAME`), 30-day window, confirmed live to carry $800K-$11M+ volume per market (genuinely liquid, unlike weather's thin markets).**
  - H: mechanical fade of an unconfirmed 1-minute price shock (>=8c move, no immediate continuation), full delay(0/1/5/15m) x hold(5/15/30/45/60m) x adverse(0/1/2/3c) grid, fees both legs, one signal per ticker/day. **367 station-days** at the preregistered key cell (+5m delay/+15m hold/+1c adverse): P/L -$2,155.05, ROI -13.9%, PF 0.30x, win rate 22.9%. Bootstrap 95% CI entirely negative (-$2,652.61..-$1,651.66). Negative across the ENTIRE 20-cell grid (PF never exceeds 0.67x anywhere). Not outlier-dependent: P/L is -$2,187.76 after top-1%-winner removal and -$2,312.33 after top-5% (gets WORSE, not better, after trimming). **REJECTED, decisively, on the largest sample size reached in this project to date.**
  - B: explicitly a PRICE-BACKTEST, not an execution proof (candle data cannot prove queue position). Passive resting order one tick inside best bid, entered only when a trailing fair-value proxy implies >=3c margin. **321 station-days** (80.3% naive-touch fill rate). Negative at every hold (5/15/30/45/60m) and every fill-probability haircut tested (100%/50%/25%) -- even the most conservative 25%-fill assumption stays negative (-$156 to -$227). **REJECTED.**
- **C (cross-venue Kalshi/Polymarket-US dislocation): live-snapshot test, explicitly not a historical backtest** (sufficient matched-pair historical quote depth was not established as available). Found a genuinely matched, low-ambiguity pair (September 2026 FOMC decision, official `federalreserve.gov` resolution source cited by Polymarket itself, matched to Kalshi's `KXFED-26SEP` threshold ladder). Reconstructed implied P(no change): Kalshi ~66.0% (from the threshold ladder), Polymarket 66.5% -- a ~0.5-point gap, smaller than the round-trip taker fee on either venue alone at that price. **No executable dislocation found in this specific live check. REJECTED for this snapshot** (a real negative result, not a data gap -- a matched pair did exist). Caveat: a $54M-volume, actively-arbitraged market is exactly where professional cross-venue arbitrageurs would already have closed any gap; a thinner/less-followed pair was not reached within this minimal test's time budget.
- **Reproducibility:** `scripts/research-microstructure-shootout.mjs`; workflow `.github/workflows/microstructure-shootout.yml`; CI run `33024146518`, success. Verified via a 15-market smoke test before the full run (real signals, no crashes, sensible non-degenerate economics).
- **Overall mission verdict: NONE OF THE TESTED/CHECKED CANDIDATES QUALIFY. NONE — STOP BUILDING THIS SET AND CONTINUE DISCOVERY**, per the mission's own pre-registered instruction for exactly this outcome. Do not force a "best of the losers" promotion.
- No production deployment, no Sports Shadow change, no Supabase modification, no Lovable credits, no orders, `LIVE_EXECUTION_IMPLEMENTED=false` unchanged, `main` untouched.
