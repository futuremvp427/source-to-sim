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

## Related: Phase 2 slippage-adjusted metrics (no-lookahead)

Phase 2 (prior-utc-day-v1) changed how the observation panel computes historical slippage-adjusted P&L: for a settled UTC day D, the adjusted estimate uses only entry-slippage samples observed strictly before `D 00:00:00 UTC` (capped at the most recent 2,000 eligible samples). A sample observed during or after day D can never retroactively change day D's adjusted figure. The current (today's) observed slippage median remains descriptive only and is never substituted into a historical day's adjusted estimate. This is a correctness fix to that one derived metric — it is unrelated to, and does not substitute for, the experiment-isolation clean epoch described above.

This document is reporting guidance only. It does not change sizing, accounting, settlement, leases/fencing, bankrolls, source-event identity, or live-order safety.
