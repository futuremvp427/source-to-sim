# Integrated four-wallet paper workflow — October 22, 2026

This is a separate prospective study implementation, not a restart of the frozen
October 17/18 ledgers. The initial launch mode is **prepare**, not paper entries.
No current software or live-feed preflight can guarantee sufficient future
activity, no outages or a profitable result.

## What the earlier 24-hour run did

Run 39540142731 was explicitly a **data-only** recorder/recovery/publication soak.
Its published summary says `ready_for_new_paper_study=false`,
`actual_in_play_phase_certified=false`, `source_wallet_coverage_evaluated=false`.
Most of its valid observations were already-verified settled-game payouts, not
continuously available live trading books. It was not a profitability study.
It did test repaired journal saving, repeated publication and segment recovery.
Source: https://github.com/futuremvp427/source-to-sim/blob/cf516aee9c493dc509e057385db80e31872945f9/data-results/39540142731/summary.json

The reporting error was presenting preparatory progress without consistently
distinguishing it from a running, evaluable paper study. No claim here repairs
missing historical observations or relabels that soak as a profit test.

## One pipeline, not another series of unrelated tests

`.github/workflows/pmus-four-wallet-unified-20261022.yml` orders these stages:

1. Frozen accounting/signal regressions, repaired transport/recovery fault tests,
   live-gate rules, readiness/evaluator tests and integrated end-to-end tests.
2. In initial **prepare** mode: complete recent 48-hour source reads per wallet,
   actual same-event/team US metadata associations/rejection reasons, schedule
   risk inventory and a short market-data-only connection smoke. No fictional
   accounts or paper entry epoch are initialized. Candidate activity is not
   follower profitability or a guaranteed future trade count.
3. Only after independently verified live evidence and full readiness proof:
   set the explicit launch mode to **collect** once. Runtime rejects missing
   proof, changed code bundle, a changed requirement hash or an inadequate
   per-wallet sample plan before initializing any paper account.
4. One ordered chain of up to twenty five-hour segments covers the unchanged
   48-hour entry window plus at most 48-hour settlement drain. Each segment
   verifies the preceding exact-run backup and resumes its clock, cash,
   pending signals, raw chain and inventory. No new epoch or old checkpoint
   fallback. The fixed state branch prevents a second run starting this study.
5. Every checkpoint contains account evaluation and a human-readable report.
   At terminal completion, automatically re-download immutable Git files,
   check their observed blob SHA-1/length, compressed/body hashes and raw links,
   replay fills from captured books, replay US settlements and cash/inventory,
   and regenerate exactly the same evaluation/report. No later evaluator task
   needs to be written.

The same already-authorized follow-through can inspect this one exact workflow,
update the existing report and deliver the interim/final. It must not create a
new automation or claim a paper start from this preparation run.

## Integration repairs included

- Retain the pinned original accounting, fee/stress, mapping, fresh-BUY,
  additions/reductions/flips, ten-contract cap and independent $1,000 accounts.
- Authenticate only `/v1/ws/markets`; public source/metadata/settlement GETs.
  No private/account/order/funding code or credentials extraction.
- Add current market subscriptions without clearing books of existing holdings;
  reconnect clears obsolete session books. Exact selected receipt/full book
  evidence is fsynced before its modeled decision. Unused updates are not
  needlessly written as repeated full books.
- Process verified US settlements independently **before** foreign inventory.
  A failed source-position read cannot prevent a separately valid US payout.
- Copy payloads before hashing, so future mutable account changes cannot corrupt
  past WAL records. Commit account-state patches and fill/settlement records
  atomically. Buffered, uncommitted fills are not reported as actual paper fills.
- Preserve an incomplete, never-acknowledged final WAL line as diagnostic bytes;
  recover complete acknowledged rows. A corrupt complete row or newest backup
  remains a hard stop, never permission to rewind.
- Count missed scheduled observations. Report/gate held-exposure marks separately
  so later flat or settled ticks cannot hide missing exposed-period valuations.
- Recheck quote/signal freshness after metadata/source work. Never fill from a
  book that aged out while an HTTP read was in progress.
- Distinguish rate limits from permission denials; do not retry a denied route.
  Publish asynchronously, retain pending generations and stop new entries when
  publication acknowledgement is stale. Fixed-cap resource forecasts warn
  before an evidence budget is exhausted.
- Bound transient backups to alternating current/preceding slots, one-day
  retention and standard public-repository Ubuntu runners. Overwriting an older
  slot does not delete immutable published checkpoint history. No paid runner,
  generation, API or external messaging is authorized.

## What remains externally unverified before launch

The frozen actual-live gate, service behavior under changing live subscriptions,
independent runtime proof and adequate per-wallet 48-hour sample/settlement
feasibility are not established by unit fixtures. Initial preparation must report
measured source and mapping counts, not manufacture forecasts. A candidate count
of 30 is not 30 executed follower markets; price/depth/skips, future activity and
settlement dates can reduce the realized sample.

The historical 0/3/8/4 completed markets do not support promising that 48 hours
will be enough. If the measured plan is not credible, explain before starting;
do not silently extend this horizon, replace wallets, pool accounts, weaken the
screen or stop only when P&L is positive. No code can force wallets to trade.

## Final gates and scope

Unresolved holdings take precedence; then fewer than 30 completed distinct US
markets or less than 95% full-planned source/complete mark coverage (including
held-exposure coverage); then nonpositive base/stress or observed drawdown above
$200; then uncertain lower event-cluster bootstrap; otherwise only
PROMISING_SCREEN_ONLY. No summed realizable portfolio, independent-win claims
across wallets on the same game, lasting-profit proof or zero-P&L treatment of
missing data. Preserve unknown/late holdings rather than inventing settlements.

Default/production branches, PR62, old studies/reviews and unrelated experiments
are outside this change. Nothing can promise that GitHub or the venue will never
fail. The recovery design preserves acknowledged work and exposes blockers;
it does not erase missing time or fabricate an evaluation pass.

Official market-only WebSocket messages/authentication:
https://docs.polymarket.us/api-reference/websocket/overview
