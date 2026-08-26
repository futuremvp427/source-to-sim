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

## badatmath event-net and survivorship falsification

Dedicated event netting did **not** make the extraordinary closed-position pattern disappear: 9,996 high-temperature closed-position rows collapsed to 3,341 event groups. Single-position events were 940 with 96.2% positive event P/L; 2-position events 677 with 88.8%; 3-5 positions 1,361 with 88.0%; 6+ positions 363 with 84.6%. The cohort in which every closed position had average price <=20c contained 221 events, 98.2% positive event P/L, and only a -$0.09 worst event in the endpoint aggregation.

The follow-up `/positions` check found 10,485 size-bearing weather rows, but **10,484 were redeemable/settled inventory**; only **one** row was active and non-redeemable, with positive current economics. Thus unresolved open losses do **not** explain the enormous closed-position aggregate. The large negative `cashPnl` on redeemable rows is an API/state-accounting artifact for settled inventory and must not be interpreted as a real $382k open loss.

The central discrepancy therefore remains unresolved: Polymarket's official Weather profit leaderboard does not put badatmath in the top 20 by profit, while the wallet is top-20 by Weather volume, and third-party whole-wallet trackers report only tens of thousands of dollars of profit. Consequently, summing `/closed-positions.realizedPnl` is not accepted as audited economic P/L. badatmath remains quarantined until lifecycle-level cash flows can be reconciled.

## Fresh-holdout cheap-bucket test status

A distinct YES-only cheap-bucket NBM-vs-Kalshi test was preregistered on 2026-05-01 through 2026-07-19 (training through June 30; OOS July 1-19) so the already-consumed July 20-August 24 OOS period would not be reused. Execution returned **0 rows with archived NBM + contemporaneous Kalshi quote**. This is **inconclusive**, not a statistical strategy failure. Public Kalshi evidence confirms KXHIGH daily-high markets existed during at least part of this period, so the quote-history/retrieval path must be diagnosed rather than interpreting zero rows as zero opportunities.

## Structural hypothesis result: exhaustive-bucket NO basket

A prediction-independent structural test was run on **50 untouched daily-high events**: 25 NYC and 25 Chicago events from 2026-07-31 through 2026-08-24, six buckets per event. Every admitted event had exactly one settled YES outcome and simultaneous 1-minute BBO on all six legs.

The BUY-YES-all-buckets form was not useful: only 1/50 events showed any after-fee edge, just **$0.16 per 100-contract basket**, and none survived +2c adverse execution per leg.

The **BUY-NO-all-buckets** form is materially more interesting. With six mutually exclusive/exhaustive buckets, exactly five NO contracts settle at $1, so a fully filled six-leg NO basket has a deterministic **$500 gross payout per 100 contracts per leg**, independent of the temperature outcome. Historical BBO reconstruction found an after-taker-fee positive basket in **49/50 events**; the best displayed after-fee profit was **$3.65**. Under the deliberately harsh stress of adding up to **+2c adverse execution to every NO leg**, **35/50 events (70%) still contained a positive basket**, with best stressed profit **$1.44**. Multiple NYC dates showed the same $1.44 stressed maximum, so the result is not a one-day outlier.

This is the strongest new candidate from the overnight search **at the hypothesis level**, because the edge does not require predicting the weather correctly: if and only if all six contracts are valid, exhaustive, and completely filled, payout is mechanically fixed. The historical sample therefore has a theoretical 100% outcome hedge once the full basket exists.

But it is **not yet proven executable**. The remaining risk is almost entirely microstructure/execution rather than outcome prediction:

- historical 1-minute close BBO does not prove displayed depth at the required size;
- Kalshi has no atomic six-leg order, so partial fills create directional exposure;
- prices can move while the basket is being assembled;
- the fee schedule can vary by market, so a forward scanner must read/verify applicable fees rather than assume the generic formula forever;
- mutually-exclusive language and complete bucket coverage must be verified for each event before trading;
- liquidity/capital efficiency may be poor because roughly ~$496-$499 of capital is tied to a $1-$4 gross edge per 100-contract six-leg basket;
- quote precision and API latency can erase the edge quickly.

Kalshi's current public weather pages explicitly label these daily-high events as mutually exclusive, and the current general fee documentation says taker fees are based on `0.07 × contracts × P × (1-P)` rounded up, although Kalshi warns that some markets can have different fee schedules. The Aug. 14, 2026 settlement-source transition from NWS to The Weather Company changes settlement provenance but does not alter the basket logic if the six buckets remain exhaustive and exactly one resolves YES.

**Next gate:** prospective, read-only collection of all six live order-book depths and timestamps, then atomicity-aware paper execution simulation. Require full six-leg fillability at the same moment and positive profit after actual market-specific fees. If this fails, reject the strategy. Do not infer capacity from historical candles.

## Current ranking of research families (not deployment ranking)

1. **Exhaustive-bucket NO basket / structural arb** — strongest candidate now. 49/50 historical events had an after-fee displayed edge; 35/50 survived +2c-per-leg stress. Outcome risk can be mechanically hedged, but fill/depth/leg risk is still unproven and is the decisive next test.
2. **Maskache2 mechanism** — 76.1% event-positive endpoint reconstruction and broad price-band profitability; still needs exact lifecycle/entry-timing reconstruction and target-venue replay.
3. **ColdMath segmented mechanism** — strong official all-time Weather ranking and highly segmented behavior; likely multiple sub-strategies, not one price rule.
4. **BeefSlayer asymmetric value** — officially top-tier Weather profit and profitable reconstructed cheap-tail cohorts, but lower win rate and meaningful loss tail.
5. **HighTempTation / Weatherstappen certainty carry** — real high win rates, but likely speed/capital intensive and weakly transferable to Kalshi after the dead-bucket price test.
6. **badatmath mechanism** — quarantined despite extraordinary closed-position endpoint metrics because endpoint accounting cannot be reconciled with whole-wallet/leaderboard profit.

## Failure-mode checklist still open

- For structural baskets, prospectively verify all-leg order-book **depth**, not just best quotes, and model sequential/partial fills.
- Verify market-specific fee schedule on every candidate basket.
- Fail closed unless every bucket is present, mutually exclusive/exhaustive, same event/date/source, and exactly one YES is possible.
- Quantify capital lockup, settlement time, and annualized return, not just dollars per basket.
- Reconcile `/closed-positions.realizedPnl` against lifecycle cash flows before trusting wallet-derived ROI.
- Reconstruct wallet entry/exit lifecycle rather than BUY-only inference.
- Determine maker vs taker and whether rebates are material.
- Verify target-venue settlement source/rules and any rule-version transitions.
- Stress concentration, correlated exposure, latency, and loss-tail events.
- Require fresh untouched OOS or prospective paper data before promotion.

## Running next

- Extend structural-basket stress by city/date and stronger execution assumptions.
- Design/read-only prospective six-leg BBO+depth collector and paper fill simulator; no authenticated preview or order submission.
- Continue lifecycle reconstruction of Maskache2/ColdMath/BeefSlayer as fallback families.
- The production application is untouched and `LIVE_EXECUTION_IMPLEMENTED=false` remains unchanged.
