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
