# Weather Strategy Falsification Results

## Decision

The three bounded US-weather hypotheses tested in this research pass did **not** establish the requested high-win-rate, positive-expectancy edge. Do not build or deploy a production weather-trading bot from these rules.

This conclusion is intentionally narrow: it applies to the tested hypotheses, stations, time window, price reconstruction, and model. It is not a claim that no weather-market edge can ever exist.

No credentials, authenticated previews, orders, Lovable deployment, or real-money execution were used. `LIVE_EXECUTION_IMPLEMENTED=false` remains unchanged.

## Test 1 — already-dead bucket lag

Window: 2026-07-20 through 2026-08-24.

Stations/series:

- KLAX / KXHIGHLAX
- KSFO / KXHIGHTSFO
- KMIA / KXHIGHMIA

Signal: public timestamped station observations had already exceeded a bounded Kalshi daily-high bucket ceiling by at least 2 F. We then looked for a public 1-minute quote within ten minutes.

Result:

- 180 candidate quote episodes.
- 180/180 ultimately resolved NO.
- 0 false-dead signals.
- But 0 entries were available with inferred NO ask <= 75c, 80c, 85c, 90c, or 95c.
- Minimum observed NO ask was 96c and the median was 100c.

Verdict: **outcome certainty existed, but the market had already priced it. No practical stale-price edge was demonstrated.**

## Test 2 — late-day observed-max stagnation

Training: 2026-07-20 through 2026-08-11.

Reserved OOS: 2026-08-12 through 2026-08-24.

Candidate decision rows: 358 total; 232 train, 126 reserved OOS.

Fixed grid:

- Local hour: 15, 16, 17, 18.
- Maximum unchanged: >=60, >=120, >=180 minutes.
- Maximum YES ask: 60c, 70c, 75c, 80c, 85c, 90c.

Training gate required >=15 independent trades, >=75% win rate, and positive after-fee P/L.

Result: **no rule met the training gate**, so no rule was frozen and the OOS set was not used for selection.

Verdict: **failed before OOS. Do not tune the grid after seeing the result.**

## Test 3 — previous-day NBM probabilistic mispricing

Protocol:

- NOAA NBM v5 probabilistic NBP bulletin.
- 13Z cycle from the day before the target weather date.
- FHR 35 / UTC 00 maximum-temperature forecast.
- Probability model: Normal approximation using NBM QMD `TXNMN` mean and `TXNSD` standard deviation, with +/-0.5 F continuity boundaries for integer settlement buckets.
- Market snapshot: first public Kalshi 1-minute BBO at/after 16:00Z on the forecast-run date, no more than 30 minutes late.
- Maximum one selected trade per station-day.
- Training only selected the rule; OOS remained untouched until the rule was frozen.

Data:

- 594 market rows had both archived forecast and contemporaneous quote evidence.
- 104 independent settled station-day events.
- NBM top-bucket accuracy: 41.3%.
- Market top-bucket accuracy at the same entry snapshot: 49.0%.

Frozen training rule:

- Model confidence >=80%.
- Model edge over executable ask >=10 percentage points.
- Ask <=80c.
- 20 training trades.
- 18/20 wins = 90.0%.
- After-fee training P/L: +$325.27 on the 100-contract test sizing.
- Training ROI on cost: +22.1%.

Unseen OOS result using that exact frozen rule:

- 10 trades.
- 7 wins / 3 losses = 70.0%.
- After-fee P/L: **-$39.83**.
- ROI on cost: **-5.4%**.

The three OOS losses occurred despite model probabilities above the rule's 80% confidence floor. The requested acceptance condition was >=75% OOS win rate plus positive OOS P/L/ROI, so this is a clear failure.

Verdict: **promising training performance did not survive unseen data. This is exactly the kind of overfitting/failure the OOS gate was intended to catch.**

## What this means

Do not convert any of these rules into a production bot. Do not loosen thresholds or search the same OOS period for a different combination just to manufacture a passing result.

The research succeeded in a different sense: it rejected weak strategies quickly, with public historical data, before spending Lovable credits or months building production infrastructure.

Any future weather-strategy work should begin from a genuinely new, falsifiable hypothesis and a new untouched holdout period. It should not be presented as a continuation that rescues these failed rules.

## Reproducibility

Research scripts:

- `scripts/research-weather-lag.mjs`
- `scripts/research-weather-late-day.mjs`
- `scripts/research-weather-nbm.mjs`
- `.github/workflows/weather-lag-research.yml`

Primary completed NBM research workflow: GitHub Actions run `32927555964`.

Historical source references:

- NOAA NBM text-product archive documentation: https://vlab.noaa.gov/web/mdl/nbm-text-archives
- NOAA NBM v5 station-card documentation: https://vlab.noaa.gov/web/mdl/nbm-textcard-v5.0
- Kalshi public market/candlestick APIs and individual market settlement rules were used for quote/result evidence.
