# Overnight Strategy Research

Research-only evidence ledger for the 2026-08-26 strategy search. No production deployment and no live trading.

## Round: realized-PnL wallet decomposition

Source: Polymarket public Data API `/closed-positions`, 180-day lookback, high-temperature markets only. Results are event-net realized P/L. The ROI denominator (`avgPrice × totalBought`) is a diagnostic cost proxy, not audited cash-flow accounting, and does not establish transferability to another venue.

| Wallet | Events | Event win rate | Realized P/L | Approx ROI | Profit factor | Worst event | Best event |
|---|---:|---:|---:|---:|---:|---:|---:|
| HighTempTation | 1,451 | 99.5% | $65,991.91 | 9.2% | 16.19x | -$1,571.95 | $1,594.89 |
| Weatherstappen | 1,122 | 99.0% | $135,967.77 | 15.5% | 126.53x | -$926.55 | $2,739.37 |
| BeefSlayer | 445 | 53.5% | $29,075.24 | 15.8% | 1.97x | -$2,904.79 | $5,371.38 |
| JoeTheMeteorologist | 565 | 31.0% | -$48,161.10 | -40.1% | 0.52x | -$20,718.50 | $11,839.70 |
| ColdMath | 1,226 | 85.3% | $212,192.56 | 8.6% | 5.32x | -$11,944.54 | $14,040.81 |
| Maskache2 | 663 | 76.1% | $180,087.62 | 42.2% | 4.29x | -$4,402.30 | $7,980.24 |
| badatmath | 2,089 | 94.6% | $414,217.47 | 143.1% | 119.72x | -$915.28 | $5,493.25 |

### Price-band clues

- BeefSlayer `<5c`: 212 events, 21.2% win, +$5,385.70, 140.2% proxy ROI, 3.26x PF. `10-20c`: 83 events, 38.6% win, +$4,507.56, 55.7%, 1.79x PF. `55-90c`: 116 events, 90.5% win, +$16,731.88, 34.8%, 11.81x PF. The `5-10c` band was negative (-$1,035.86), so "cheap is always good" is false.
- ColdMath `<5c`: 255 events, 64.7% win, +$139,924.08, 258.18x PF. `55-90c`: 574 events, 98.1% win, +$252,445.68, 216.75x PF. `>=90c` was strongly negative (-$155,731.24), and 10-55c bands were negative. This is not a simple monotonic price rule.
- Maskache2 was positive in every reported price band: `<5c` +$12,731.98; `5-10c` +$19,155.04; `10-20c` +$23,263.33; `20-55c` +$65,547.46; `55-90c` +$57,868.40; `>=90c` +$1,521.42. Event win rate overall 76.1%.
- badatmath produced extraordinary reported results: `<5c` 74 events / 89.2% wins / +$20,805.82; `5-10c` 174 / 91.4% / +$40,967.93; `10-20c` 539 / 96.7% / +$130,804.89; `20-55c` 1,581 / 94.8% / +$203,500.59. These figures are too strong to treat as a transferable edge without falsification. A dedicated event-net dissection is now running to test whether multi-bucket portfolios/accounting explain the apparent win rate.
- JoeTheMeteorologist is not a candidate to copy wholesale: overall 565 events, 31.0% event win, -$48,161.10, -40.1% proxy ROI.

## Fresh-holdout cheap-bucket test status

A distinct YES-only cheap-bucket NBM-vs-Kalshi test was preregistered on 2026-05-01 through 2026-07-19 (training through June 30; OOS July 1-19) so the already-consumed July 20-August 24 OOS period would not be reused. The first execution returned **0 rows with archived NBM + contemporaneous Kalshi quote**. Therefore it is **inconclusive**, not a strategy failure. We must establish whether the issue is historical quote availability, event-candlestick parsing, or coverage of those series before any statistical conclusion.

Public Kalshi pages confirm at least one KXHIGHLAX daily-high event existed on July 14, 2026, so the zero-row result cannot be assumed to mean the series did not exist before July 20. The retrieval/quote path needs diagnosis.

## Current ranking of research families (not deployment ranking)

1. **badatmath mechanism** — highest observed event-net metrics, but highest suspicion of hidden portfolio/accounting structure. Must be decomposed before promotion.
2. **Maskache2 mechanism** — broad positive realized P/L across price bands and 76.1% event win rate; promising because it does not rely solely on 98-99c near-certainty entries.
3. **ColdMath segmented mechanism** — very strong realized results but highly regime/price-band dependent; likely multiple sub-strategies rather than one simple rule.
4. **BeefSlayer asymmetric value** — profitable overall and in selected cheap bands, but only 53.5% event win rate and significant event loss tail.
5. **HighTempTation / Weatherstappen certainty carry** — real historical profitability but likely execution-speed/capital intensive, with small margins at >=90c and weak transferability to Kalshi where prior dead-bucket test found no entries <=95c.

## Failure-mode checklist still open

- Net all mutually exclusive buckets per event; do not count correlated bucket positions as independent wins.
- Reconstruct entry/exit lifecycle rather than BUY-only inference.
- Determine maker vs taker and whether rebates are material.
- Verify target-venue contemporaneous BBO, depth, fillability, fees, and slippage.
- Verify exact target settlement source/rules; same city/date/bucket is not sufficient.
- Stress concentration, correlated city/weather-regime exposure, and loss-tail events.
- Quantify latency requirements and whether the edge survives +1c/+2c/+3c adverse execution.
- Require fresh untouched OOS or prospective paper data before promotion.
- Reject any strategy whose apparent edge disappears after event-netting or realistic target execution.

## Running experiment

`scripts/research-badatmath-event-net.mjs` + Weather Lag Research workflow: event-net dissection by number of positions/buckets in each high-temperature event, including single-position vs multi-position cohorts and cost-proxy ROI. This is specifically designed to falsify the extraordinary badatmath results before treating them as a strategy.
