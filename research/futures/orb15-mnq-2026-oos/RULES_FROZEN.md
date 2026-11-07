# FROZEN RULES — 15-min ORB, MNQ (NQ proxy), 2026 out-of-sample validation

Frozen: 2026-11-07, before any 2026 price bar was loaded or any result computed.
Committed separately (first commit of this study) so the freeze is auditable in git history.
No parameter below may be changed after results are seen. Any deviation found necessary
for *data-handling* reasons must be logged in REPORT.md as a deviation, and the frozen
version must also be run and reported.

## Source of the strategy rules
- Publisher: https://www.backtestingmax.com/backtests/opening-range-breakout-15-minute
- **The publisher page could NOT be retrieved from this environment** (host not in the
  session network allowlist; an archive fallback was refused). The rules below are the ones
  given by the user in the task statement, which the user describes as the published rules.
  Any discrepancy between these and the publisher's page is unverified.
- The publisher's own 2020–2025 statistics and risk-gate failures could not be read here.
  They are NOT reproduced or reinterpreted; see REPORT.md "Publisher risk gates".

## Instrument
- Traded instrument: 1 MNQ contract. Multiplier $2.00 / index point; tick 0.25 = $0.50.
- Price data: NQ 1-minute bars (same underlying index, same tick size; NQ multiplier $20)
  used as an **explicit proxy** for MNQ prices. P&L = NQ point moves x $2.00.

## Session / bars
- Time zone America/New_York. Bars are 1-minute, timestamped at bar OPEN (verified in DATA_AUDIT).
- RTH bars considered: 09:30 … 15:59 (390 bars).
- Opening range (OR): high = max(high), low = min(low) of 1-min bars 09:30–09:44 (i.e. 09:30:00–09:44:59).
- 5-minute confirmation candles: built from 1-min bars, aligned at 09:45, 09:50, …, 15:55.
  Candle [t, t+5): open = first open, high = max, low = min, close = close of the t+4 1-min bar.
  A candle is "completed" at t+5.

## Entry
- Signal: the FIRST completed 5-min candle (starting with 09:45–09:50) whose close is
  strictly > OR high (long) or strictly < OR low (short). Only the first such candle counts.
- Signal candles may close no later than 15:55 (the last candle that can signal is 15:50–15:55).
- Entry: at the open of the next 1-min bar after the signal candle closes (= next 5-min bar open).
- One trade maximum per session. No re-entry after exit.

## Risk, stop, target
- Stop: long → OR low; short → OR high (the opposite side of the opening range).
- R = |signal candle close − stop| (in points).
- Target: long → signal close + 2R; short → signal close − 2R (measured from SIGNAL close, not fill).
- Exits are evaluated on 1-min bars starting with the entry bar itself:
  - If the entry bar open is already at/through the stop or target, exit at that open.
  - Stop hit if bar low ≤ stop (long) / high ≥ stop (short). Fill = stop price, or bar open
    if the bar opened through the stop (gap).
  - Target hit if bar high ≥ target (long) / low ≤ target (short). Fill = target price (touch).
  - If the same 1-min bar touches both stop and target, assume the STOP was hit first (conservative).
- Time exit: if still open, exit at the close of the 15:59 bar (16:00 ET).

## Session exclusion (applied before signals, independent of outcome)
- Skip NYSE holidays and NYSE/CME early-close sessions (2026 in-window: none scheduled for early
  close before 2026-10-08; holidays: Jan 1, Jan 19, Feb 16, Apr 3, May 25, Jun 19, Jul 3, Sep 7).
- Skip any session that does not contain all 390 RTH 1-min bars (09:30–15:59).
- Skip any session in which the RTH bars are not attributable to a single contract
  (roll mixing; see DATA_AUDIT) — determined from data, not from trade outcome.

## Costs (hypothetical; NOT verified broker fees)
Adverse slippage applied to EVERY fill (entry and exit, incl. limit/target fills), per side:
| Scenario | Adverse ticks/side | Round-trip fees+commissions | Role |
|---|---|---|---|
| S0 gross | 0 | $0.00 | reference only |
| S1 light | 1 | $1.50 | sensitivity |
| **S2 conservative** | **2** | **$4.00** | **PRIMARY decision scenario** |
| S3 stress | 3 | $6.00 | sensitivity |
Per-trade cost in S2 = 2 sides x 2 ticks x $0.50 + $4.00 = $6.00.

## Evaluation windows (no tuning on either)
- P1: 2026-01-01 … 2026-05-31
- P2: 2026-06-01 … 2026-10-08 (end of available data)

## Decision rule (frozen)
PASS only if ALL hold, in BOTH periods, under S2:
1. Trade count n ≥ 50.
2. Net P&L > 0 and profit factor ≥ 1.20.
3. Mean trade P&L bootstrap 95% CI (10,000 resamples, seed 20261107) lower bound > 0.
4. Net P&L remains > 0 after removing the single best trade, after removing the best day
   (identical here: one trade/day), and after removing the top 3 trades.
5. Net P&L > 0 under S3 stress is reported but NOT required.
6. Data completeness: ≥ 90% of scheduled sessions in the period usable.
INSUFFICIENT DATA if (1) or (6) fails in either period. Otherwise any failure → FAIL.

## Comparisons
- No-trade: $0, zero risk.
- Passive exposure: long 1 MNQ at 09:30 open → flat at 15:59 close every included session,
  same S2 costs (intraday buy-and-hold; avoids overnight/roll gaps).
