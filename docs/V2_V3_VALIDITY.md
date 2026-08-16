# V2/V3 comparison validity

## Current authoritative status (read this first)

**T_clean = 2026-08-16 12:09:43.355885 UTC. T_7d = 2026-08-23 12:09:43.355885 UTC. T_14d = 2026-08-30 12:09:43.355885 UTC.**

This is a **new, distinct epoch boundary**, established from a dedicated 2026-08-16 production audit — it is **not** a resurrection of the 2026-08-14 value discussed at length below. The earlier `T_clean = 2026-08-14 11:29:19.638 UTC` value remains **withdrawn and historical**; it was never re-established, a further full-cohort 429 storm occurred as recently as 2026-08-16 03:12–03:52 UTC (well after that value's own window), and nothing in this document should be read as reviving it. See `docs/CURRENT_OBSERVATION_STATUS.md` for the current authoritative status and the two documents' agreed relationship, and see "2026-08-16 production continuity audit: new T_clean established" below for the full evidence trail behind the new boundary.

Because this boundary was only just established, expect the 10 cohort experiments' post-T_clean sample sizes to stay small until well after T_7d — the formal QUALIFIED / NOT QUALIFIED / INSUFFICIENT NEW DATA classification below does not apply until at or after T_7d (2026-08-23), per the methodology's own gate.

## Current status

Phase 1 (`experiment_scoped_event_consumption`) made source-event consumption experiment-scoped: each experiment now has its own `experiment_event_state` (consumption) and `experiment_source_position_state` (leader-position) rows, and `get_pending_experiment_source_events` selects an experiment's pending events via an anti-join against its own consumption state — not a shared wallet-global bit. `source_events.processed_at` is retained only as legacy provenance on the dashboard; it is no longer read by `processPendingEvents` or `process_source_event_atomic` to gate consumption.

This closes the mechanism that produced *prospective* contamination (one experiment silently consuming an event before another experiment could evaluate it). It does **not** retroactively fix history: source events processed before this migration were seeded as legacy-consumed for every experiment following that wallet at the time, and that pre-Phase-1 history was **not** replayed. Any V2/V3 comparison that spans across the Phase 1 migration boundary still mixes contaminated pre-fix data with clean post-fix data.

## Reporting rule

- Any V2/V3 window that includes activity from before the Phase 1 migration remains **contaminated / not comparable** for that period.
- Do not use V2-versus-V3 ROI, P&L, skip-rate, or capacity differences spanning the pre-fix period as evidence that one bankroll configuration outperformed the other under identical inputs.
- Individual experiment rows may still be inspected as historical paper-ledger records, but a pre-fix-spanning window should not be presented as a controlled A/B result.
- Preserve the existing data for forensic analysis; do not reset or rewrite historical paper ledgers merely to make the comparison look clean.
- A methodology fix to a downstream metric (for example, Phase 2's prior-utc-day-v1 slippage-adjusted P&L, see below) does not by itself make a pre-Phase-1-spanning comparison controlled — the two are independent: one is about consumption isolation, the other is about lookahead in a derived metric.

## What establishes validity again

The experiment-scoped-consumption mechanism prerequisite is now met. A specific V2/V3 comparison is valid only once it is restricted to a clearly labeled observation epoch that starts at or after the Phase 1 migration boundary, so every included experiment independently evaluated the same immutable source-event stream from the start of that epoch. Declaring and starting that clean epoch (and keeping the pre-fix run separated from the post-fix evidence) is a separate operational step from this document.

## Production clean observation epoch

On 2026-08-14, the Phase 1 schema (`experiment_event_state`, `experiment_source_position_state`, `process_source_event_atomic`, and related objects) was reconciled onto the live production database via a single guarded migration, applied inside one explicit transaction. **T_reconcile = 2026-08-14 05:01:50.655580 UTC**, established from a persisted database value (the fixed transaction timestamp `now()` captured by the migration's own legacy-seeding write to `experiment_source_position_state.updated_at`), not from any host clock. The corresponding application code (already auto-published to production ahead of this migration via Lovable's GitHub sync) began exercising experiment-scoped consumption for the first time in production at that boundary.

The **V2/V3 comparison cohort is exactly 10 enabled experiments**: `SHADOW V2: badatmath.`, `SHADOW V2: gghff`, `SHADOW V2: HighTempTation`, `SHADOW V2: Poligarch`, `SHADOW V2: Weather-Guru`, `SHADOW V3 CAPACITY: badatmath.`, `SHADOW V3 CAPACITY: gghff`, `SHADOW V3 CAPACITY: HighTempTation`, `SHADOW V3 CAPACITY: Poligarch`, `SHADOW V3 CAPACITY: Weather-Guru`. `GENERAL SHADOW: *` experiments (including `RN1` and `swisstony`) are operationally relevant but are **not** members of this cohort and are never counted in the T_clean numerator or denominator.

**[Historical, 2026-08-14 ~12:20 UTC] T_clean was WITHDRAWN and provisional at this point in the chronology.** This entry is preserved for audit continuity. At the time, the previously recorded value (2026-08-14 11:29:19.638 UTC) did not hold: fresh production evidence showed a renewed wave of `canceling statement due to statement timeout` errors for multiple V2/V3 experiments (including `SHADOW V2: badatmath.` and Poligarch) from ~08:17 UTC onward, so criterion **B** (a sustained stable window after deploy) was not satisfied at that moment. No V2/V3 comparison window could be presented as controlled until a new T_clean was established under the same two criteria — see "[Historical, superseded] T_clean was believed re-established" below for what was thought to resolve this at the time, and "2026-08-16 production continuity audit" further below for the value that actually governs today.

Root cause of this wave, proven directly on production rather than inferred: full-history reads of `copyability_observations` used PostgREST `.range()`, which compiles to SQL `OFFSET`. With that history now at 20k-55k rows per experiment, a deep page is structurally unservable — `explain (analyze)` of the page at offset 50,000 for the largest experiment took **22.3s** while walking 51,000 rows, even on a newly added exactly-matching index `(experiment_id, created_at desc, id desc)`, against the role `statement_timeout` of **8s**. Those reads therefore could never complete, retried every cycle across 10 experiments, and amplified the shared write-latency spikes already documented above.

Fix (paper-only, no strategy/sizing/bankroll/safety change): the two full-history `copyability_observations` reads (`summarizeCopyability`, General Shadow's panel read) now use keyset paging (`fetchAllRowsAfterId`, ordering and seeking on `id`), making every page O(page size) regardless of history depth; the aggregates they feed are order-insensitive. Supporting indexes `copyability_observations_experiment_created_id_idx` and `copyability_observations_experiment_id_asc_idx` are tracked in `supabase/schema-contract.json`. Sibling-wallet reconciliation is now serialized through a wallet-scoped lease (`try_acquire_reconcile_lease` / `release_reconcile_lease`), which also closes the reconciliation-cache oscillation described below. Regression: `copyability-keyset-pagination.test.ts`, `reconcile-wallet-lease.test.ts`, `paper-processing-cancellation.test.ts`.

Previously recorded (withdrawn at this point in the chronology) value, kept for audit continuity: T_clean = 2026-08-14 11:29:19.638 UTC, with the milestone dates derived from it below. Those milestone dates were void until a new T_clean was established — which happened later the same day; see "Current authoritative status" at the top of this document for what governs today.

### [Historical] 2026-08-14 ~13:25 UTC: pending-event scan optimized, T_clean still NOT established at this point

`get_pending_experiment_source_events` was rewritten to drive an ordered scan on `source_events_wallet_order_idx` with a correlated per-row consumption probe (`CROSS JOIN LATERAL` + `NOT EXISTS`) instead of a set-level hash anti-join over the whole wallet history. Measured on production: warm 68-294ms and cold 1.3-4.9s, versus 38-49s cold for the previous shape. Returned rows are semantically identical (proven by `EXCEPT` in both directions across all experiments): earliest unconsumed events for that experiment in `(source_ts, event_key)` order, with the same clamped limit. The semantically duplicate index `source_events_wallet_ts_key_idx` was dropped; the Phase 1 `source_events_wallet_order_idx` remains the sole wallet/ts/key index. Execute privileges on the function are restricted to `service_role`. Bankrolls, cash, realized P&L, event/trade counts and checkpoints were unchanged by the migration.

Regression coverage: `src/lib/pending-experiment-events-sql.test.ts` (SQL shape, limit clamp, permission envelope, index dedup) and `supabase/tests/pending_experiment_events.sql` (long consumed prefix does not hide the pending tail, earliest-first ordering, limit clamping, cross-experiment isolation for same-wallet siblings, no duplicates, stable repeated reads), wired into Audit CI.

**[Historical] T_clean remained NOT established at this point.** A fresh ~10-minute production observation window starting 2026-08-14 13:24:20 UTC still showed recurring `canceling statement due to statement timeout` for several V2/V3 experiments, with `stage_ms.paper_processing` at 8.2-13.7s against the 8s role `statement_timeout`. The pending-event lookup was no longer the offender, so the residual cost was elsewhere inside the paper-processing stage and needed its own separate diagnosis. Criterion **B** was therefore still unsatisfied at this point and no V2/V3 window could be presented as controlled.

This required closing a second, broader-impact systemic gap beyond the checkpoint-load fix: a shared, external, infrastructure-level write-latency spike (proven via `pg_stat_statements` — even `pg_cron`'s own internal bookkeeping writes occasionally took 80-95s despite averaging under 500ms) was being amplified by `persistEvents`' request never being cancelled when the cycle's 40s deadline fired (`Promise.race` never cancels its losing promise), so a slow request kept consuming a connection/request slot for up to 82s while a *new* attempt started concurrently — compounding load exactly when the database was least able to absorb it. Fixed in `fix/real-cancellation-persist-events` (merge `30743529a6fec2bccef7839abc201bbf148241f2`): `persistEvents` now receives a real `AbortSignal` tied to the same deadline. This was the one call site with proven, repeated, extreme overruns (44s/67s/82s); no other stage showed this pattern, so no other call site was touched.

**[Historical, superseded] T_clean was believed re-established following this fix, at this point in the chronology.** Both criteria appeared satisfied at the time and the later one appeared to govern:
- **A.** All 10 cohort experiments completed at least one successful cycle after T_reconcile (2026-08-14 05:01:50.655580 UTC) — the last two to qualify, `SHADOW V2: badatmath.` and `SHADOW V3 CAPACITY: Poligarch`, first succeeded at 11:28:52 and 11:29:15 UTC respectively, essentially at the deploy boundary.
- **B.** A sustained, verified stable window appeared to follow the fix's deploy (T_deploy = 2026-08-14 11:29:19.638 UTC, Lovable's own publish timestamp): ~8 minutes and 30+ scheduler invocations observed directly, covering the full cohort multiple times each, with all 10 reaching `poll_failures = 0` / `last_error = null` and only one isolated, non-cascading, self-resolved failure (a single `statement timeout` for one experiment that succeeded cleanly on its very next attempt).

At the time, this produced T_clean = max(A, B) = T_deploy = 2026-08-14 11:29:19.638 UTC, with derived T_7d = 2026-08-21 11:29:19.638 UTC and T_14d = 2026-08-28 11:29:19.638 UTC. **This conclusion did not hold.** `docs/CURRENT_OBSERVATION_STATUS.md` was published later the same day (2026-08-14, ~14:05 UTC) explicitly re-withdrawing this value, and a further full-cohort 429 storm occurred on 2026-08-16 (03:12–03:52 UTC) — well after this window — confirming the withdrawal was correct. **This 2026-08-14 value and its milestones are void and must not be used.** The current, separately-established T_clean is stated at the top of this document and in the next section.

## 2026-08-16 production continuity audit: new T_clean established

A dedicated read-only production audit was performed 2026-08-16 (~13:17 UTC) specifically to determine whether a new, independent T_clean could be established from current evidence — not to resurrect the 2026-08-14 value above. Findings, checked directly against live production data for all 10 V2/V3 cohort experiments:

- **A full-cohort 429 storm occurred 2026-08-16 03:12–03:52 UTC**: repeated `data-api.polymarket.com/trades responded 429` failures recorded across all 10 experiments in multiple waves.
- **The last failure of any kind for the cohort** was an isolated, non-cascading, self-resolved `ingest cycle exceeded 40000ms deadline` timeout affecting only `SHADOW V2: Poligarch` and `SHADOW V3 CAPACITY: Poligarch`, at **2026-08-16 12:04:47.381845 UTC** — not a 429, and not repeated. Both experiments completed a clean cycle by **2026-08-16 12:09:43.355885 UTC**, confirmed directly via `pipeline_audit` rows. No other experiment in the cohort failed at all between the storm's end and this point, or since.
- **Zero poll failures of any kind** have been recorded for any of the 10 cohort experiments since 12:04:47.381845 UTC (checked against `poll_failure` alerts and all `level = 'error'` alerts for the cohort).
- All 10 cohort experiments currently show `poll_failures = 0`, `last_error = null`, and a fresh heartbeat.
- **`source_events` → `experiment_event_state` anti-join = zero** missing rows for all 10 experiments as of the new boundary, verified against non-trivial totals (1,483–32,932 events per experiment, all fully consumed) — including `SHADOW V2: Poligarch` specifically (32,932/32,932 consumed), satisfying the Poligarch-specific check separately.
- **V2/V3 sibling checkpoints remain exactly aligned per wallet**: `badatmath.`, `gghff`, `HighTempTation`, `Poligarch`, and `Weather-Guru` each show an identical `last_source_ts` between their V2 and V3 CAPACITY rows.
- No `CatchupProgressionError`, checkpoint/offset error, recurring statement-timeout, or abandoned-cycle instability was found for the cohort after the boundary.

This satisfies the same two-criterion standard used (unsuccessfully, in hindsight) to establish the earlier value: (A) full-cohort successful-cycle completion after the boundary — satisfied at 12:09:43.355885 UTC — and (B) a sustained, verified stable window following it, which has held continuously (zero failures, checkpoints advancing, anti-join clean) from 12:09:43.355885 UTC through the audit time and beyond.

**T_clean = 2026-08-16 12:09:43.355885 UTC** — the earliest point supported by this evidence: the moment the last two (of 10) cohort experiments proved recovery from the last known failure, with nothing having failed for any experiment since.

Milestones (PostgreSQL-computed, not host-clock-derived):
- **T_7d** = 2026-08-23 12:09:43.355885 UTC
- **T_14d** = 2026-08-30 12:09:43.355885 UTC

Separately, and not affecting this determination: the durable host-level rate-limit cooldown (`http_rate_limits` / `record_http_rate_limit`) is confirmed operating in production (earliest observed write 2026-08-16 10:32:09 UTC). A follow-up migration hardening that function's privileges has been merged to the repository but is **not yet deployed** to production as of this audit — production's live function definition still matches the original, pre-hardening version. This is a distinct, security-relevant deployment gap, tracked separately, and does not affect the T_clean determination above.

## Separately diagnosed, not a T_clean blocker: reconciliation cache oscillation

Sibling experiments sharing a wallet (e.g. `SHADOW V2: gghff` / `SHADOW V3 CAPACITY: gghff`) each independently call the wallet-scoped `reconcile()` whenever they persist new events, with no fencing/locking between them, since `source_position_state` is a per-wallet (not per-experiment) compact cache. Both experiments' cycles run within ~1 second of each other every cron tick, so their full-history replays can race on the same cache rows, producing an oscillating (not monotonically-converging) `reconciliation_mismatch` count (observed: 55 → 111 → 2 → 20 → 5 for `gghff`'s wallet within a 13-minute span). Confirmed via code reading that `reconcile()` writes only to `source_position_state`; it never touches `paper_trades`, `paper_positions`, `paper_settlements`, `experiment_source_position_state`, or any experiment's cash/realized P&L, so this has zero effect on paper accounting or the V2/V3 comparison itself — it is a noisy diagnostic-cache artifact, not a correctness issue. Not fixed in this session (out of scope for the persist_events cancellation fix; would need its own proof and narrow PR).

## Related: Phase 2 slippage-adjusted metrics (no-lookahead)

Phase 2 (prior-utc-day-v1) changed how the observation panel computes historical slippage-adjusted P&L: for a settled UTC day D, the adjusted estimate uses only entry-slippage samples observed strictly before `D 00:00:00 UTC` (capped at the most recent 2,000 eligible samples). A sample observed during or after day D can never retroactively change day D's adjusted figure. The current (today's) observed slippage median remains descriptive only and is never substituted into a historical day's adjusted estimate. This is a correctness fix to that one derived metric — it is unrelated to, and does not substitute for, the experiment-isolation clean epoch described above.

## T_7d qualification methodology (documentation only — no logic change)

T_7d (2026-08-23 12:09:43.355885 UTC, derived from the T_clean established above) is the **earliest** date at which any of the 10 V2/V3 cohort experiments may be evaluated for promotion out of the clean-epoch observation window. It is not a fixed evaluation date and it does not by itself imply enough evidence has accumulated. Calendar time elapsed since T_clean is a necessary but not sufficient condition: a bot must also have accumulated enough genuinely new post-T_clean trading evidence to support a promotion decision.

**The post-T_clean sample is defined by the opening BUY, not by when a position settles.** Only positions whose opening BUY occurred strictly after T_clean (2026-08-16 12:09:43.355885 UTC) count toward an experiment's clean promotion sample. A settlement observed after T_clean for a position that was opened *before* T_clean does not count as a complete clean post-fix lifecycle — that position's entry decision was made under the pre-fix (or transitional) consumption path this document's clean epoch exists to exclude, so its outcome cannot be attributed to post-fix behavior even if the outcome itself lands inside the clean window. Such positions must be reported separately, labeled as legacy/pre-clean evidence, and excluded from the clean promotion sample (see the read-only clean-window activity audit below for the concrete query that partitions the two populations).

At or after T_7d, each of the 10 experiments must be classified into exactly one of three states — this is a reporting classification, not a change to the qualification criteria themselves:

- **QUALIFIED** — the experiment has a sufficient, representative sample of complete post-T_clean lifecycles (opening BUY after T_clean, and enough of them across enough distinct trading days/markets to be representative) whose aggregate result meets the qualification bar.
- **NOT QUALIFIED** — the experiment has a sufficient post-T_clean sample, but that sample's aggregate result does not meet the qualification bar.
- **INSUFFICIENT NEW DATA** — calendar time has passed T_7d, but the experiment has not yet accumulated enough post-T_clean opening-BUY activity (too few positions, too few distinct trading days, or too little capital deployed) to support either a QUALIFIED or NOT QUALIFIED call. Passing T_7d does not force a premature verdict.

This document deliberately does not fix a minimum sample-size threshold for "sufficient" above. That number should be set from the actual observed post-T_clean activity distribution across all 10 experiments (see the audit below) rather than guessed in advance.

This section adds reporting/classification guidance only. It does not move T_clean or T_7d, does not change qualification math, sizing, accounting, settlement, or any other logic.

## Read-only clean-window activity audit (run against the current T_clean)

The read-only SQL audit bundle at `supabase/audits/clean_window_activity_audit.sql` has been run against production against the current T_clean (2026-08-16 12:09:43.355885 UTC). It is SELECT-only and made no changes to sizing, accounting, settlement, leases/fencing, bankrolls, source-event identity, checkpoints, or live-order safety. See that file's header comment for the full list of measures and the exact opening-BUY-after-T_clean partitioning logic; the file's own boundary constant should be kept in sync with the T_clean stated at the top of this document.

Observed high-level facts, measured against the **current** T_clean:

- Exactly 10 enabled V2/V3 experiments were audited, matching the cohort defined above.
- Post-T_clean clean lifecycles opened per experiment so far (V2 / V3 CAPACITY): `gghff` 2/2, `HighTempTation` 1/1, `Poligarch` 0/0, `Weather-Guru` 0/0, `badatmath.` 0/0.
- Only **1 distinct trading day** with new post-T_clean BUY exposure so far — expected, given T_clean was established only recently.
- **No formal QUALIFIED / NOT QUALIFIED / INSUFFICIENT NEW DATA classification is being assigned yet.** Per the methodology above, that classification applies only at or after T_7d (2026-08-23 12:09:43.355885 UTC) — assigning it now, five-plus days early, would itself violate the gate. The counts above are reported as raw observed evidence only.
- **No experiment is being promoted yet.** This document does not fix a minimum sample-size threshold, and none is being asserted here.
- T_7d (2026-08-23 12:09:43.355885 UTC) remains the **earliest** evaluation gate, not an automatic promotion date, per the qualification methodology above: passing T_7d does not by itself qualify, disqualify, or promote any experiment.

### Historical: audit results measured against the withdrawn 2026-08-14 boundary

The counts below were measured in an earlier run of this audit against the **withdrawn** 2026-08-14 T_clean value. They are retained here as a historical record of that run only — **they are not the current clean sample and must not be presented as such**, since the boundary they were measured against was itself withdrawn (see "History" in `docs/CURRENT_OBSERVATION_STATUS.md` and the chronology above):

- Post-(withdrawn-boundary) clean lifecycles opened per experiment (V2 / V3 CAPACITY): `gghff` 97/95, `HighTempTation` 59/59, `Poligarch` 542/585, `Weather-Guru` 79/73, `badatmath.` 0/0.
- 3 distinct trading days with new BUY exposure were observed against that withdrawn boundary.
- That earlier run's text described `badatmath.` as INSUFFICIENT NEW DATA; per the correction above, no formal classification should have been asserted before a T_7d gate regardless, so that label is also historical only and not a standing classification.

This document is reporting guidance only. It does not change sizing, accounting, settlement, leases/fencing, bankrolls, source-event identity, or live-order safety.
