# Hybrid Wallet → U.S. Weather Preflight

Research-only historical replay. Goal: determine, before any further Lovable build, whether existing profitable-wallet signals can actually reach a contemporaneous U.S. Kalshi daily-high contract often enough and at a usable price often enough to justify a forward experiment.

## Lanes

1. **Direct-copy diagnostic** — source wallet BUY on a daily-high bucket → same city/date/bucket Kalshi YES, fixed-size hold-to-settlement replay.
2. **Hybrid feasibility funnel** — source wallet signal is only a trigger. We measure whether the corresponding U.S. event/bucket and contemporaneous executable-price proxy exist at all. Weather Lab validation is intentionally not fabricated while the station-basis model is still blocked.

Primary wallets: BeefSlayer and ColdMath.

## Historical evidence used

- Polymarket public `/activity` TRADE rows for actual source BUY timestamps and bucket labels.
- Kalshi `historical/markets` plus current settled markets for target discovery.
- Kalshi 1-minute historical/live candlesticks for contemporaneous YES-ask proxies.
- Kalshi's actual U.S. market result for settlement P/L.
- Current quadratic taker-fee model with centicent trade-fee rounding; the extra non-direct-member balance-rounding accumulator is not reconstructable historically, so reported fee is a lower bound and adverse-price stress is also shown.

## Stress

Quotes are evaluated at source timestamp, +1 minute, +5 minutes, and +15 minutes when available, and at +0c/+1c/+2c adverse price. This is deliberately stricter than a same-minute price-only backtest.

## Guardrails

- One first BUY per wallet/city/date/bucket; repeated DCA does not create fake independent observations.
- Station-day is the independent sample unit in summary metrics.
- Historical candlesticks do **not** expose full historical order-book depth or queue position. A positive replay can justify forward paper collection but cannot prove executable capacity.
- International and U.S. weather settlement sources can differ. The replay therefore scores the **actual U.S. outcome**, not the source outcome. LA/SF/Miami are separately marked as previously audited same-airport translation corridors; NYC/Chicago remain trigger-only/unverified for literal copy semantics.
- This does not use `/closed-positions.realizedPnl`.
- No credentials, orders, production changes, Lovable changes, or live trading.

## Independent review addendum (2026-08-26)

Reviewed adversarially as part of the Polymarket 3.0 Weather decision memo. Two corrections:

1. **`scripts/research-weather-hybrid-preflight.mjs` could not run as committed.** It contained `\b?` (an optional quantifier on a zero-width assertion), which is invalid JavaScript regex syntax — `node --check` throws `SyntaxError: Nothing to repeat`. The workflow silently patched this in CI (`sed`-equivalent Python step) before every run, so the committed source never actually executed; only the CI-only patched copy did. Fixed directly in the source; the CI patch step is removed as unnecessary. Rerunning the corrected source locally reproduces the exact numbers in the `weather-hybrid-preflight` artifact from run `33010063930` (BeefSlayer 38 replay signals / 24 station-days; ColdMath 7/7; identical rejection counts), so the headline evidence itself is confirmed reproducible — only the repo hygiene was broken.

2. **`TARGET_BUCKET_NOT_FOUND` (146/186 BeefSlayer signals, 79%) is root-caused, not a bug.** Instrumented rerun shows Kalshi's own bucket ladder for a given city/date is frequently centered 5-10F away from the bucket the source wallet traded internationally on the *same nominal date* (e.g. NYC 2026-04-30: source traded 55-59F buckets; Kalshi's ladder that day ran 60F-69F+). Each platform centers its ladder on its own forecast, and those forecasts often disagree by more than one bucket width. This is further, independent evidence that the two platforms are not settlement/forecast-equivalent (consistent with the KSFO counterexample already on record), and it means literal same-bucket copy fails structurally on most days even before considering price — not merely a historical-data-coverage gap. It does not block the hybrid (event-only) architecture, which never required bucket equality.
