# Overnight Strategy Source Audit

Research-only evidence log. No live trading or production deployment.

## High-value public evidence

### kachence/polymm / @b00k13 sports market-making arbitrage

Sources:
- https://github.com/kachence/polymm
- https://kacho.io/polymarket-arbitrage-real-numbers
- https://www.reddit.com/r/algotrading/comments/1u17e2v/ran_a_crossvenue_arb_bot_on_polymarket_for_3/

Publicly reported reconciled Jan-Apr 2026 result: about +$4,973 net on 3,858 fills / ~$95.8k volume. The author decomposes this into +$8,293 completed arbitrage, -$3,184 directional residual, and -$134 cancelled matches. The basic mechanism is de-vig external sportsbook odds to fair probability, post passive Polymarket limit orders only at a stated >=7% edge, then attempt to complete the opposite leg below $1 combined cost.

Important failure evidence from the author: stale quotes can be picked off by faster bots; one-leg fills create directional exposure; devig implementation/favorite bias and bugs can convert apparent positive edge into losses; the edge decayed enough that the original version was switched off. A July 2026 follow-up reports a Rust rewrite making roughly $650 in the preceding month, but that statement is author-reported and is not independently reconciled here.

Research status: **credible fallback architecture, not yet a transferable US-venue strategy.** To promote, require exact market/rule mapping, current legal US venue availability, independent odds source, historical target-venue BBO/order-book replay, passive-fill model, adverse-selection model, and a hard rule preventing unbounded one-leg residuals.

### Profitable weather-wallet archetypes

Polymarket official weather leaderboard source: https://polymarket.com/leaderboard/weather/all/profit

Current public leaderboard snapshot observed during this mission included ColdMath +$136,509, BeefSlayer +$74,758, and HighTempTation +$73,512. Our own 90-day public Data API reconstruction separates them into two materially different archetypes:

- HighTempTation / Weatherstappen: near-certainty carry/information reaction, overwhelmingly high-priced entries after lower buckets were already invalidated by station observations.
- BeefSlayer / ColdMath / Maskache2: low-price forecast-first/asymmetric-value behavior, frequently buying before the target bucket had been reached.

This distinction is now the basis for separate strategy families. Do not infer that a high wallet P/L proves transferability to Kalshi or Polymarket US because settlement source, market shape, liquidity, and entry price can differ.

## Open-source weather projects audited

### tobiasbischoff/polymarket-weather-bot

Sources:
- https://github.com/tobiasbischoff/polymarket-weather-bot
- https://github.com/tobiasbischoff/polymarket-weather-bot/blob/master/backtest/EXECUTIVE-SUMMARY.md

Claims an 8-day Feb 3-10, 2026 backtest with 58.7% overall win rate and +15.2% ROI, then projects 85-90% win rate after whitelisting Miami/Atlanta/Dallas/Wellington.

**Evidence defect:** its own executive summary states the backtest used actual temperatures as a proxy rather than real historical forecasts, did not model real spreads/slippage, covered only eight days, and selected profitable cities on the same sample. The 85-90% whitelist result is therefore in-sample projection, not valid OOS evidence. Do not use its headline win rate as support for deployment.

Useful hypothesis only: warm/stable climates and wider tail buckets may have lower forecast error. Must be independently retested with archived forecasts and untouched data.

### ventry089/weatherbot

Source: https://github.com/ventry089/weatherbot

Architecture combines ECMWF + HRRR + METAR, station-specific coordinates, EV filters, spread/volume filters, quarter-Kelly sizing, and per-city sigma calibration after resolved observations. The README explicitly defaults to paper trading and recommends >=50 resolved markets before live use.

**Evidence status:** useful architecture reference; no independently verified profitable backtest or live track record was established in this audit. Do not treat implementation sophistication as edge evidence.

### windgeek/polymarket-weather

Source: https://github.com/windgeek/polymarket-weather

Public README reports a negative live run: 111 resolved trades, ~51.4% win rate, -$62.51 net P/L, NAV falling from a peak around $44 to $4.83 before the bot stopped. It also reports a station-priority pricing bug discovered during operation.

Use as negative evidence: weather model sophistication alone does not prove positive expectancy; station mapping and pricing bugs are first-order failure modes.

### BallesJr/polymarket-weather-edge

Source: https://github.com/BallesJr/polymarket-weather-edge

Public description focuses on buying NO against overpriced same-day weather outcomes, with paper-only execution and a clean-data regime beginning after earlier station/data bugs. The README states the natural win rate is only around 32% versus ~31% break-even for its selected price region.

Research status: potentially useful asymmetric/contrarian family, but current public forward sample was still accumulating and does not establish a high-confidence edge.

## New preregistered test added this run

`research-weather-cheap-value.mjs` tests a genuinely different wallet-inspired hypothesis on a historical window that predates the failed WEATHER-STRATEGY-3 holdout:

- Window: 2026-05-01 through 2026-07-19.
- TRAIN: through 2026-06-30.
- untouched OOS: 2026-07-01 through 2026-07-19.
- Archived previous-day NOAA NBM probabilistic forecast.
- Contemporaneous Kalshi 1-minute executable YES ask.
- YES-only cheap buckets, max ask grid 5/10/15/20c.
- Model-probability and model-edge thresholds selected on TRAIN only.
- At most one selected trade per station-day.
- Taker fees plus +1c/+2c/+3c adverse-execution stress.
- OOS acceptance requires at least 10 trades and positive P/L/ROI even at +2c adverse execution.

This test is deliberately not a retune of the prior high-confidence NBM rule. It asks whether low-priced asymmetric-value entries form a distinct edge family similar to BeefSlayer/ColdMath behavior.
