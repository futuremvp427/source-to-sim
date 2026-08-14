# V2/V3 comparison validity

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

**T_clean is established: 2026-08-14 11:29:19.638 UTC (2026-08-14 07:29:19.638 America/New_York).**

This required closing a second, broader-impact systemic gap beyond the checkpoint-load fix: a shared, external, infrastructure-level write-latency spike (proven via `pg_stat_statements` — even `pg_cron`'s own internal bookkeeping writes occasionally took 80-95s despite averaging under 500ms) was being amplified by `persistEvents`' request never being cancelled when the cycle's 40s deadline fired (`Promise.race` never cancels its losing promise), so a slow request kept consuming a connection/request slot for up to 82s while a *new* attempt started concurrently — compounding load exactly when the database was least able to absorb it. Fixed in `fix/real-cancellation-persist-events` (merge `30743529a6fec2bccef7839abc201bbf148241f2`): `persistEvents` now receives a real `AbortSignal` tied to the same deadline. This was the one call site with proven, repeated, extreme overruns (44s/67s/82s); no other stage showed this pattern, so no other call site was touched.

Both criteria for T_clean were satisfied and the later one governs:
- **A.** All 10 cohort experiments completed at least one successful cycle after T_reconcile (2026-08-14 05:01:50.655580 UTC) — the last two to qualify, `SHADOW V2: badatmath.` and `SHADOW V3 CAPACITY: Poligarch`, first succeeded at 11:28:52 and 11:29:15 UTC respectively, essentially at the deploy boundary.
- **B.** A sustained, verified stable window followed the fix's deploy (T_deploy = 2026-08-14 11:29:19.638 UTC, Lovable's own publish timestamp): ~8 minutes and 30+ scheduler invocations observed directly, covering the full cohort multiple times each, with all 10 reaching `poll_failures = 0` / `last_error = null` and only one isolated, non-cascading, self-resolved failure (a single `statement timeout` for one experiment that succeeded cleanly on its very next attempt) — within the master task's own tolerance for a bounded individual upstream failure that does not destabilize the cohort.

T_clean = max(A, B) = T_deploy = **2026-08-14 11:29:19.638 UTC**.

Milestones (PostgreSQL-computed, not host-clock-derived):
- **T_7d** = 2026-08-21 11:29:19.638 UTC = 2026-08-21 07:29:19.638 America/New_York
- **T_14d** = 2026-08-28 11:29:19.638 UTC = 2026-08-28 07:29:19.638 America/New_York

## Separately diagnosed, not a T_clean blocker: reconciliation cache oscillation

Sibling experiments sharing a wallet (e.g. `SHADOW V2: gghff` / `SHADOW V3 CAPACITY: gghff`) each independently call the wallet-scoped `reconcile()` whenever they persist new events, with no fencing/locking between them, since `source_position_state` is a per-wallet (not per-experiment) compact cache. Both experiments' cycles run within ~1 second of each other every cron tick, so their full-history replays can race on the same cache rows, producing an oscillating (not monotonically-converging) `reconciliation_mismatch` count (observed: 55 → 111 → 2 → 20 → 5 for `gghff`'s wallet within a 13-minute span). Confirmed via code reading that `reconcile()` writes only to `source_position_state`; it never touches `paper_trades`, `paper_positions`, `paper_settlements`, `experiment_source_position_state`, or any experiment's cash/realized P&L, so this has zero effect on paper accounting or the V2/V3 comparison itself — it is a noisy diagnostic-cache artifact, not a correctness issue. Not fixed in this session (out of scope for the persist_events cancellation fix; would need its own proof and narrow PR).

## Related: Phase 2 slippage-adjusted metrics (no-lookahead)

Phase 2 (prior-utc-day-v1) changed how the observation panel computes historical slippage-adjusted P&L: for a settled UTC day D, the adjusted estimate uses only entry-slippage samples observed strictly before `D 00:00:00 UTC` (capped at the most recent 2,000 eligible samples). A sample observed during or after day D can never retroactively change day D's adjusted figure. The current (today's) observed slippage median remains descriptive only and is never substituted into a historical day's adjusted estimate. This is a correctness fix to that one derived metric — it is unrelated to, and does not substitute for, the experiment-isolation clean epoch described above.

This document is reporting guidance only. It does not change sizing, accounting, settlement, leases/fencing, bankrolls, source-event identity, or live-order safety.
