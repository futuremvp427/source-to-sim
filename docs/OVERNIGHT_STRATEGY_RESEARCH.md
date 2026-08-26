# Overnight Strategy Research

Research-only evidence ledger for the 2026-08-26 strategy search. No production deployment and no live trading.

## Round: realized-PnL wallet decomposition

Source: Polymarket public Data API `/closed-positions`, 180-day lookback, high-temperature markets only. Results below are diagnostic event-net sums of the endpoint's `realizedPnl` field. The ROI denominator (`avgPrice × totalBought`) is a cost proxy, not audited cash-flow accounting, and does not establish transferability to another venue.

| Wallet | Events | Event win rate | Endpoint-summed P/L | Approx ROI | Profit factor | Worst event | Best event |
|---|---:|---:|---:|---:|---:|---:|---:|
| HighTempTation | 1,451 | 99.5% | $65,991.91 | 9.2% | 16.19x | -$1,571.95 | $1,594.89 |
| Weatherstappen | 1,122 | 99.0% | $135,967.77 | 15.5% | 126.53x | -$926.55 | $2,739.37 |
| BeefSlayer | 445 | 53.5% | $29,075.24 | 15.8% | 1.97x | -$2,904.79 | $5,371.38 |
| JoeTheMeteorologist | 565 | 31.0% | -$48,154.99 | -40.1% | 0.52x | -$20,718.50 | $11,839.70 |
| ColdMath | 1,226 | 85.3% | $212,192.56 | 8.6% | 5.32x | -$11,944.54 | $14,040.81 |
| Maskache2 | 663 | 76.1% | $180,159.75 | 42.2% | 4.30x | -$4,402.30 | $7,980.24 |
| badatmath | 2,089 | 94.6% | $414,217.47 | 143.1% | 119.72x | -$915.28 | $5,493.25 |

### Price-band clues

- BeefSlayer `<5c`: 212 events, 21.2% win, +$5,385.70, 140.2% proxy ROI, 3.26x PF. `10-20c`: 83 events, 38.6% win, +$4,507.56, 55.7%, 1.79x PF. `55-90c`: 116 events, 90.5% win, +$16,731.88, 34.8%, 11.81x PF. The `5-10c` band was negative (-$1,035.86), so "cheap is always good" is false.
- ColdMath `<5c`: 255 events, 64.7% win, +$139,924.08, 258.18x PF. `55-90c`: 574 events, 98.1% win, +$252,445.68, 216.75x PF. `>=90c` was strongly negative (-$155,731.24), and 10-55c bands were negative. This is not a simple monotonic price rule.
- Maskache2 was positive in every reported price band in this endpoint reconstruction. Event win rate overall 76.1%.
- JoeTheMeteorologist is not a candidate to copy wholesale in this reconstruction: overall 565 events, 31.0% event win, negative endpoint-summed P/L.

## badatmath event-net falsification

Dedicated event netting did **not** make the extraordinary closed-position pattern disappear: 9,996 high-temperature closed-position rows collapsed to 3,341 event groups. Single-position events were 940 with 96.2% positive event P/L; 2-position events 677 with 88.8%; 3-5 positions 1,361 with 88.0%; 6+ positions 363 with 84.6%. The cohort in which every closed position had average price <=20c contained 221 events, 98.2% positive event P/L, and only a -$0.09 worst event in the endpoint aggregation.

**However this result is now downgraded from evidence of a strategy to evidence of an accounting/mechanism anomaly that requires reconciliation.** Independent public sources are not consistent with the $414k endpoint-summed figure: Polymarket's all-time Weather profit leaderboard does not place badatmath in the current top 20 (rank 20 is about +$55k), while the same wallet is #14 by Weather volume at about $8.32M. Third-party whole-wallet analytics currently report roughly +$38k to +$48k total P/L, not +$414k. Therefore the raw sum of `/closed-positions.realizedPnl` cannot be treated as audited economic profit. Possible causes to test include endpoint/accounting semantics, repeated lifecycle accounting, closed-vs-open survivorship, and category/time-window differences.

This is a major correction: **badatmath is not promoted despite the 94-98% apparent closed-position event win rates.** The next test explicitly queries current/open weather positions to see whether omitted open inventory explains part of the discrepancy.

## Fresh-holdout cheap-bucket test status

A distinct YES-only cheap-bucket NBM-vs-Kalshi test was preregistered on 2026-05-01 through 2026-07-19 (training through June 30; OOS July 1-19) so the already-consumed July 20-August 24 OOS period would not be reused. Execution returned **0 rows with archived NBM + contemporaneous Kalshi quote**. This is **inconclusive**, not a statistical strategy failure. Public Kalshi evidence confirms KXHIGH daily-high markets existed during at least part of this period, so the quote-history/retrieval path must be diagnosed rather than interpreting zero rows as zero opportunities.

## New structural hypothesis: exhaustive-bucket basket arbitrage

A prediction-independent family is now under test on previously unused NYC/Chicago Kalshi corridors. Daily-high bucket events are mutually exclusive; if the full set is exhaustive, buying YES on every bucket guarantees one winning payout, while buying NO on every bucket guarantees N-1 winning payouts. The test requires exactly one settled YES, simultaneous 1-minute BBO on every leg, applies Kalshi taker-fee math, and stresses +1c/+2c adverse execution per leg. This is potentially much higher-probability than forecasting if occasional all-in basket prices fall below guaranteed payout.

The hard failure mode is execution: historical 1-minute BBO cannot prove depth, simultaneous fills, or atomic execution. Any apparent edge that does not survive +2c per leg will be rejected. A positive historical result would qualify only for prospective all-leg depth collection and paper execution.

## Current ranking of research families (not deployment ranking)

1. **Maskache2 mechanism** — 76.1% event-positive endpoint reconstruction and broad price-band profitability; still needs exact lifecycle/entry-timing reconstruction and target-venue replay.
2. **ColdMath segmented mechanism** — strong official all-time Weather ranking and highly segmented behavior; likely multiple sub-strategies, not one price rule.
3. **BeefSlayer asymmetric value** — officially top-tier Weather profit and profitable reconstructed cheap-tail cohorts, but lower win rate and meaningful loss tail.
4. **HighTempTation / Weatherstappen certainty carry** — real high win rates, but likely speed/capital intensive and weakly transferable to Kalshi after the dead-bucket price test.
5. **badatmath mechanism** — temporarily quarantined despite extraordinary closed-position endpoint metrics until accounting/open-position reconciliation explains the large conflict with whole-wallet/leaderboard P/L.
6. **Exhaustive-bucket structural arbitrage** — unranked until the focused historical run finishes; it would move high in the ranking only if after-fee edges survive realistic adverse execution.

## Failure-mode checklist still open

- Reconcile `/closed-positions.realizedPnl` against current positions and whole-wallet/leaderboard P/L before trusting wallet-derived ROI.
- Net all mutually exclusive buckets per event; do not count correlated bucket positions as independent wins.
- Reconstruct entry/exit lifecycle rather than BUY-only inference.
- Determine maker vs taker and whether rebates are material.
- Verify target-venue contemporaneous BBO, depth, fillability, fees, and slippage.
- Verify exact target settlement source/rules; same city/date/bucket is not sufficient.
- Stress concentration, correlated city/weather-regime exposure, and loss-tail events.
- Quantify latency requirements and whether the edge survives +1c/+2c/+3c adverse execution.
- Require fresh untouched OOS or prospective paper data before promotion.
- Reject any strategy whose apparent edge disappears after event-netting or realistic target execution.

## Running experiments

- `scripts/research-badatmath-open-risk.mjs`: current/open-position survivorship-risk reconciliation.
- `scripts/research-weather-basket-arb.mjs`: NYC/Chicago all-bucket YES/NO structural arbitrage with fees and +1c/+2c per-leg stress.
- The production application is untouched and `LIVE_EXECUTION_IMPLEMENTED=false` remains unchanged.
