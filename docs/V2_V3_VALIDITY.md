# V2/V3 comparison validity

## Current status

The V2-versus-V3 capacity comparison must not be interpreted as a controlled comparison until source-event consumption is experiment-scoped.

At the current implementation boundary, `source_events.processed_at` is stored on the wallet-level source event. `processPendingEvents` selects wallet events with `processed_at IS NULL`, and `process_source_event_atomic` marks that source event processed after one experiment handles it. Because V2 and V3 can follow the same wallet, one experiment can therefore consume an event before the other experiment evaluates it.

This does **not** mean the individual paper ledgers are necessarily arithmetically wrong. It means the causal claim "V2 and V3 saw the same source events and differed only by bankroll" is not established by the current implementation.

## Reporting rule

Until the processing model is corrected and a clean post-fix observation epoch is started:

- Treat V2/V3 *relative* capacity conclusions as **contaminated / not comparable**.
- Do not use V2-versus-V3 ROI, P&L, skip-rate, or capacity differences as evidence that one bankroll configuration outperformed the other under identical inputs.
- Individual experiment rows may still be inspected as historical paper-ledger records, but they should not be presented as a controlled A/B result.
- Preserve the existing data for forensic analysis; do not reset or rewrite historical paper ledgers merely to make the comparison look clean.

## What establishes validity again

A future comparison is valid only after every experiment following a wallet can independently evaluate the same immutable source-event stream, with idempotent experiment-specific processing state. After that change, start a new clearly labeled observation epoch and keep the pre-fix run separated from the post-fix evidence.

This document is reporting guidance only. It does not change sizing, accounting, settlement, leases/fencing, bankrolls, source-event identity, or live-order safety.
