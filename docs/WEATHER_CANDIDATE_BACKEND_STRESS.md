# Weather Candidate Backend Stress

Research-only evidence report for the 2026-08-26 Polymarket 3.0 weather-strategy investigation. Nothing in this report authorizes production deployment or real-money trading. `LIVE_EXECUTION_IMPLEMENTED=false` remains unchanged.

## Executive result

The deeper backend pass changed the ranking materially.

1. **Maskache2-style 20-90c forecast/value selection is the strongest wallet-derived research prior.** It is not a copy-trading strategy and is not yet a U.S.-venue strategy. Its public closed-position reconstruction is temporally more stable than the other leading wallets, survives winner-concentration stress, and still shows useful economics in the five U.S. cities most relevant to the current U.S. daily-high research set.
2. **BeefSlayer remains the strongest fallback wallet archetype.** Its U.S.-city share is much larger, its economics remain positive after concentration stress, and its 55-90c segment has a high historical event-positive rate, but recent results weakened and its overall hit rate is lower.
3. **The exhaustive all-NO basket is demoted from implementation candidate to microstructure watch.** The historical anomaly is broad and survives price stress in candles, but repeated live depth scans found zero profitable complete baskets and frequent missing legs. Current sequential leg-risk scans also show negative full-basket economics.
4. **The cheap-tail <=10c NBM proxy is inconclusive and fails its sample gate.** It produced positive TRAIN and OOS P/L, but only six baseline OOS trades and three at +2c adverse execution; its hit rate was 14-17%, not a high-win-rate strategy.
5. **ColdMath is demoted sharply as a wholesale strategy prior.** Its public reconstruction has high event-positive rates but poor temporal stability, a huge drawdown, only two positive months in the 240-day slice, negative second-half P/L, and negative P/L after removing the largest 5% of winning events.

All wallet P/L below is **diagnostic public endpoint reconstruction**, not audited cash accounting and not a counterfactual U.S.-venue P/L. International source contracts can use different settlement stations/sources/windows.

## 1. Wallet temporal-stability and concentration stress

Script: `scripts/research-weather-wallet-stability.mjs`

Method:

- public Polymarket `/closed-positions` only;
- high-temperature events;
- 240-day window;
- event-level aggregation so multiple correlated buckets from one event are not counted as independent wins;
- first-half vs second-half comparison;
- monthly P/L consistency;
- maximum drawdown on reconstructed event P/L sequence;
- 2,000 deterministic event-bootstrap resamples;
- top-winner concentration;
- re-score after deleting the largest 1% and 5% of winning events.

### Maskache2

- 760 events.
- Event-positive rate: **76.1%**.
- Diagnostic endpoint P/L: **+$175,574.88**.
- Proxy ROI: **39.2%**.
- Profit factor: **4.13x**.
- Reconstructed max drawdown: **-$8,808.27**.
- Positive months: **6/8**.
- 95% bootstrap interval for event-positive rate: **73.0%-79.1%**.
- Top five winning events: **15.0%** of gross winning P/L.
- After removing the largest 5% of winning events: **+$39,405.71** remains.
- First half: 380 events, 76.3% event-positive, +$43,244.65, PF 4.19x.
- Second half: 380 events, 75.8% event-positive, +$132,330.23, PF 4.11x.

Price-band reconstruction:

| Event-average price | Events | Event-positive | Diagnostic P/L | Interpretation |
|---|---:|---:|---:|---|
| <5c | 37 | 29.7% | +$207.57 | Weak/sparse tail edge |
| 5-10c | 44 | 45.5% | +$1,169.45 | Positive but not high-confidence |
| 10-20c | 111 | 50.5% | +$11,544.17 | Positive value regime |
| 20-55c | 322 | 75.5% | +$87,480.78 | Strongest large-sample value regime |
| 55-90c | 155 | 99.4% | +$80,400.87 | High-confidence regime; strong historical PF |
| >=90c | 91 | 97.8% | **-$5,227.95** | Critical warning: high hit rate but negative economics |

This is the clearest evidence from the entire pass that **win rate alone is not a sufficient objective**. Maskache2's >=90c cohort was right almost all the time and still lost money in the public endpoint reconstruction.

### ColdMath

- 2,197 events.
- Event-positive rate: **81.7%**.
- Diagnostic endpoint P/L: +$111,782.67.
- Proxy ROI: 4.1%.
- PF: 2.02x.
- Reconstructed max drawdown: **-$94,334.16**.
- Positive months: **2/8**.
- Bootstrap event-positive interval: 80.1%-83.3%.
- First half: 82.5%, +$143,710.45, PF 2.38x.
- Second half: 81.0%, **-$31,927.78**, PF 0.59x.
- After removing largest 5% of winning events: **-$52,230.51**.

Conclusion: high hit rate masks unstable economics and winner dependence. Do not copy ColdMath wholesale. Only independently test narrow sub-regimes with fresh data.

### BeefSlayer

- 466 events in the 240-day stability slice.
- Event-positive rate: **54.7%**.
- Diagnostic P/L: **+$38,999.46**.
- Proxy ROI: 27.7%.
- PF: 2.37x.
- Max drawdown: -$13,461.21.
- Positive months: **6/8**.
- Bootstrap event-positive interval: 50.0%-59.0%.
- After removing largest 5% of winning events: **+$5,551.57** remains.
- First half: 61.3%, +$31,285.70, PF 5.63x.
- Second half: 47.9%, +$7,713.76, PF 1.36x.

Price-band clues:

- <5c: 34.2% event-positive, positive reconstructed economics.
- 5-10c: negative.
- 10-20c: 38.9%, positive.
- 20-55c: 63.6%, positive.
- **55-90c: 94.5% event-positive, +$25.4k diagnostic P/L, PF 11.26x.**
- >=90c: 97.0% event-positive but only weak economics.

Conclusion: potentially useful barbell/value archetype, but recent weakening is a real risk.

## 2. Five-U.S.-city transferability stress

Script: `scripts/research-weather-wallet-us-transfer.mjs`
Workflow run: **32959222539**

This test asks a narrower question: how much of each leading wallet's source-market evidence occurs in NYC, San Francisco, Miami, Chicago, or Los Angeles? It **does not** treat the source contracts as settlement-equivalent to U.S. contracts.

| Wallet | All events | Target-city events | Target share | Target event-positive | Target diagnostic P/L | Proxy ROI | PF | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Maskache2 | 760 | 166 | 21.8% | 72.3% | +$27,160.51 | 23.6% | 2.49x | -$4,255.11 |
| ColdMath | 2,242 | 372 | 16.6% | 74.7% | +$18,980.26 | 1.7% | 1.55x | -$5,767.27 |
| BeefSlayer | 809 | 376 | **46.5%** | 63.3% | +$27,975.14 | 14.0% | 2.70x | -$7,624.30 |

### Maskache2 by target city

- NYC: 120 events, 71.7%, +$24,215.12, proxy ROI 28.6%, PF 2.74x.
- SF: 13 events, 84.6%, +$1,585.55, proxy ROI 30.5%, PF 3.72x.
- Miami: 11 events, 54.5%, **-$2,144.81**, proxy ROI -59.3%, PF 0.22x.
- Chicago: 12 events, 66.7%, +$906.97, proxy ROI 5.0%, PF 1.92x.
- LA: 10 events, 90.0%, +$2,597.68, proxy ROI 72.1%, PF 66.77x.

The LA/SF samples are too small for strong inference. NYC is the only large Maskache2 target-city sample and is therefore the best initial research prior. Miami is a negative warning, not a candidate to assume transferable.

### ColdMath by target city

- NYC: 123, 71.5%, +0.6% proxy ROI.
- SF: 28, 82.1%, +3.4% proxy ROI.
- Miami: 95, 64.2%, negative P/L/ROI.
- Chicago: 96, 81.3%, +2.7% proxy ROI.
- LA: 30, 93.3%, +9.6% proxy ROI.

High hit rates are again accompanied by thin economics outside LA.

### BeefSlayer by target city

- NYC: 207, 62.3%, +13.4% proxy ROI, PF 2.33x.
- SF: 9, 44.4%, positive but tiny sample.
- Miami: 60, 63.3%, +10.6% proxy ROI, PF 6.42x.
- Chicago: 85, 64.7%, +13.0% proxy ROI, PF 2.45x.
- LA: 15, 80.0%, +34.5% proxy ROI, tiny sample.

BeefSlayer supplies the largest target-city sample share and therefore remains important even though its overall hit rate is lower than Maskache2.

## 3. Expanded exhaustive-NO structural-basket stress

Scripts:

- `scripts/research-weather-basket-stress.mjs`
- `scripts/research-weather-basket-prospective.mjs`
- `scripts/research-weather-basket-leg-risk.mjs`

Historical five-city stress used **125 events** (25 each NYC, Chicago, LA, SF, Miami), 2026-07-31 through 2026-08-24, 100 contracts/leg.

| Stress assumption | Events with any positive displayed basket | Rate |
|---|---:|---:|
| Displayed 1-minute BBO | 120/125 | 96.0% |
| +1c adverse execution on every leg | 106/125 | 84.8% |
| +2c every leg | 80/125 | 64.0% |
| +3c every leg | 67/125 | 53.6% |

Best historical profits per 100-contract/leg complete basket:

- displayed: +$3.69;
- +1c/leg: +$2.51;
- +2c/leg: +$1.44;
- +3c/leg: +$0.38.

The historical effect is broad, but **fragile in time**. Median longest positive +2c run was only about 0-1 minute by city. A coarse one-leg-per-minute permutation proxy often found a profitable ordering historically, but this still cannot prove historical depth, queue position, or real fills.

### Prospective live-depth falsification

Workflow run **32959085859** included five consecutive read-only live scans 30 seconds apart.

- Complete-depth snapshots: **5**, all from only one event.
- Profitable complete snapshots: **0 at every tested size**.
- Best observed basket result:
  - 1/leg: -$0.14;
  - 5/leg: -$0.60;
  - 10/leg: -$1.16;
  - 25/leg: -$3.12;
  - 50/leg: -$7.25;
  - 100/leg: -$16.76.
- Other current city events lacked at least one required leg/depth.

This follows multiple earlier live snapshots that also produced zero profitable complete baskets. The most likely current interpretation is that much of the historical one-minute candle effect is **transient, intra-minute, or unsupported by simultaneous executable depth**.

### Current sequential prefix/leg risk

Workflow run **32959356012**.

At that scan, only San Francisco had complete all-leg depth. NYC, Chicago, LA, and Miami were each missing at least one required leg. SF exposed `collateral_return_type=MECNET`, but the complete basket was negative:

| Size/leg | Full guaranteed P/L | Minimum worst prefix risk under optimized leg order |
|---:|---:|---:|
| 1 | -$0.11 | $0.74 |
| 10 | -$1.42 | $7.49 |
| 25 | -$4.08 | $19.03 |
| 50 | -$8.65 | $38.35 |
| 100 | -$20.54 | $77.12 |

Collateral return can improve capital efficiency after mutually-exclusive hedges exist; it does not repair a negative basket or remove partial-fill/price-movement risk.

**Classification: INCONCLUSIVE / WATCH-ONLY.** The all-NO basket is no longer the leading implementation candidate. A future passive-maker variant could be investigated, but current evidence does not support building a taker execution engine.

## 4. Cheap-tail NBM proxy with corrected historical routing

Script: `scripts/research-weather-cheap-value.mjs`
Workflow run: **32959085859**

Window: 2026-05-01 through 2026-07-19; TRAIN through June 30; OOS July 1-19. Correct Kalshi historical market/candlestick routing recovered **640 rows across 240 station-days**.

Frozen TRAIN rule selected without using OOS:

- NBM bucket probability >=20%;
- model edge over ask >=15 percentage points;
- YES ask <=10c.

TRAIN:

- 21 trades;
- 14.3% wins;
- +$154.01 after modeled fee;
- 105.5% ROI on the research cost denominator;
- max drawdown -$45.81.

OOS:

| Added adverse price | Trades still qualifying | Win rate | P/L | ROI | Max DD |
|---|---:|---:|---:|---:|---:|
| +0c | 6 | 16.7% | +$56.31 | 128.9% | -$28.77 |
| +1c | 6 | 16.7% | +$49.94 | 99.8% | -$33.02 |
| +2c | 3 | 33.3% | +$73.38 | 275.7% | -$19.16 |
| +3c | 2 | 50.0% | +$81.90 | 452.5% | -$9.58 |

The preregistered acceptance gate required at least 10 OOS trades and positive +2c economics. **FAIL: too few OOS events.** The positive payoff is interesting but too sparse, and the baseline hit rate is far below the user's high-win-rate objective.

This result must not be retuned on the same OOS. A richer ensemble model is a genuinely different future hypothesis and would require a new holdout.

## 5. Updated candidate ranking

### #1 Maskache2-inspired U.S.-specific 20-90c value model — PROMISING RESEARCH PRIOR

The actual candidate is **not** "copy Maskache2." The proposed hypothesis is:

> Construct a probability distribution for the exact U.S. settlement contract, use Maskache2/BeefSlayer-like wallet behavior only as a feature or trigger, and buy only when the independently calculated U.S. fair probability exceeds the executable target-market ask by a robust margin.

Initial regime split to test independently:

- **20-55c value regime**: largest Maskache2 historical reconstructed dollars with 75.5% event-positive rate.
- **55-90c high-confidence regime**: 99.4% event-positive in Maskache2 endpoint reconstruction, but must be independently validated because source contracts are different.
- **Do not automatically trade >=90c**: Maskache2's >=90c cohort was 97.8% event-positive yet negative in reconstructed P/L.

NYC is the largest Maskache2 U.S.-city evidence set and should be the first station-specific model hypothesis. Miami should not be assumed transferable given the negative source-wallet subset.

Required before forward paper trading: exact target settlement-source model, full lifecycle reconstruction, actual target BBO/depth, fresh holdout, no lookahead, realistic costs.

### #2 BeefSlayer-inspired segmented/barbell value model — PROMISING FALLBACK

Strongest reasons to retain it:

- 46.5% of its all-event source reconstruction falls in the five target cities;
- target-city proxy ROI 14.0%, PF 2.70x;
- positive reconstructed economics remain after deleting the top 5% winning events;
- 55-90c source cohort historically had 94.5% event-positive rate and PF 11.26x;
- cheap tails can have positive EV despite low hit rate.

Main risk: second-half edge weakened materially, so fresh validation is mandatory.

### #3 Exhaustive NO basket — INCONCLUSIVE / MICROSTRUCTURE WATCH

Keep the read-only scanner and perhaps test passive maker quotes. Do not implement taker execution unless complete profitable depth recurs prospectively and survives leg-risk/fee/latency stress.

### #4 Cheap-tail <=10c asymmetric ensemble — INCONCLUSIVE FALLBACK

The corrected NBM proxy is positive but sample-fails. A richer multi-model forecast hypothesis may justify a new experiment, but it will not satisfy a high-win-rate objective and must use a new untouched holdout.

### ColdMath — DEMOTED / DO NOT COPY WHOLESALE

High hit rate is not enough. Temporal stability and concentration stress are poor. Only separately preregistered narrow regimes should be considered in future work.

## 6. Backend artifacts produced

- `scripts/research-weather-wallet-stability.mjs`
- `scripts/research-weather-wallet-us-transfer.mjs`
- `scripts/research-weather-basket-stress.mjs`
- `scripts/research-weather-basket-prospective.mjs`
- `scripts/research-weather-basket-leg-risk.mjs`
- corrected `scripts/research-weather-cheap-value.mjs`
- `.github/workflows/weather-candidate-backend.yml`
- `.github/workflows/weather-wallet-transfer.yml`
- `.github/workflows/weather-basket-leg-risk.yml`

Key runs:

- `32959085859` — comprehensive candidate backend jobs; wallet-stability, basket-stress, cheap-value-OOS, prospective-depth all completed successfully.
- `32959222539` — U.S.-city wallet transferability, SUCCESS.
- `32959356012` — sequential basket leg-risk scan, SUCCESS.

## 7. Remaining highest-information research

The next agent should not build production execution yet. Highest-value next work is:

1. reconstruct Maskache2 and BeefSlayer lifecycle/entry-state at event level, separating 20-55c and 55-90c regimes;
2. build a U.S.-settlement-specific probability model for the exact target station/window, initially prioritizing NYC and then separately testing other cities;
3. obtain contemporaneous target-venue BBO/depth and use genuinely fresh OOS/forward paper data;
4. independently audit maker-vs-taker behavior and whether wallet edge comes from forecast skill, portfolio construction, DCA/exits, liquidity provision, or information timing;
5. keep the NO-basket read-only watcher as a separate structural hypothesis, but reject it as a taker strategy if positive complete depth continues not to appear.

No production deployment was performed. No real orders were submitted. Sports Shadow was not modified. No Lovable or Codex credits were required for this backend research pass.
