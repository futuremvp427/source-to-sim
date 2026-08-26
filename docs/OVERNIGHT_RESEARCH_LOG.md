# Overnight Strategy Research Log

## 2026-08-26 01:xx ET — run 1

### Fresh untouched NBM replication

- Workflow run: `32933385070` (`Weather Fresh Replication`).
- Window: 2026-05-20 through 2026-07-19. This predates and does not overlap the prior WEATHER-STRATEGY-3 window (2026-07-20 through 2026-08-24).
- Train: through 2026-06-30. OOS reserve: 2026-07-01 through 2026-07-19.
- 563 forecast+quote market rows; 96 independent settled station-day events across KLAX, KSFO, KMIA.
- NBM top-bucket accuracy: 35.4%. Kalshi market top-bucket accuracy at the same entry snapshot: 42.7%.
- No TRAIN rule met the preregistered >=75% win-rate + positive after-fee P/L + minimum-20-trade gate. OOS was therefore not entered.
- Decision: the previous-day single-NBM probabilistic family is now rejected more strongly. The prior apparent 90% TRAIN result was not a stable edge. Do not retune this family.

### Profitable-wallet strategy decomposition now underway

- Added `scripts/research-weather-closed-positions.mjs` to use Polymarket's official public `GET /closed-positions?user=` endpoint and decompose actual realized high-temperature P/L by average entry-price band and event.
- This is intended to answer a key unresolved question: whether BeefSlayer/ColdMath/Maskache2 cheap-bucket profitability survives full lifecycle/exit accounting, rather than looking good only from BUY-side trade reconstruction.
- The analysis aggregates all closed bucket positions within the same weather event before computing event win rate, profit factor, worst/best event and approximate ROI.
- Approximate ROI denominator is `avgPrice * totalBought`; treat it as a diagnostic cost proxy, not audited cash-flow accounting.

### External evidence and data-source feasibility

- Official Polymarket docs confirm `/closed-positions` exposes `avgPrice`, `totalBought`, `realizedPnl`, title/outcome and timestamp, with pagination up to 50 rows/request: https://docs.polymarket.com/api-reference/core/get-closed-positions-for-a-user
- Official NOAA NBM docs confirm probabilistic max-temperature mean, standard deviation and 10/25/50/75/90th percentiles are available in the station/text products: https://vlab.noaa.gov/web/mdl/nbm-text-products and https://vlab.noaa.gov/web/mdl/nbm-textcard-v5.0
- Official NOAA/AWS registry confirms HRRR is hourly, 3-km, radar-assimilating and archived back to 2014 in public S3. This makes a fresh multi-model/intraday hypothesis technically testable without paid APIs: https://registry.opendata.aws/noaa-hrrr-pds/
- Official NCEI documentation confirms GEFS is a 21-member ensemble and public archive coverage is available from 2017-present, making ensemble-spread/convergence features testable: https://www.ncei.noaa.gov/products/weather-climate-models/global-ensemble-forecast
- Community claims about profitable weather tactics (cheap 3-20c buckets, clustered adjacent buckets, late dead-tail shorts) are treated only as hypothesis generators, not evidence. The useful Reddit threads found this run are: https://www.reddit.com/r/Polymarket/comments/1tvjsjy/weather_strategy_combo_on_peak_buckets_and/ and https://www.reddit.com/r/PredictionsMarkets/comments/1vrr4j3/this_trader_developed_a_strategy_for_trading_on/

### Candidate hierarchy after run 1

1. **Cheap-bucket asymmetric value with richer forecast state** — still the lead research family, but requires realized-PnL wallet confirmation plus fresh HRRR/GEFS/NBM testing. Single NBM is explicitly insufficient.
2. **Multi-bucket forecast cluster/basket** — plausible high-hit-rate fallback. Must be tested against combined executable asks + per-leg fees and event-level tail misses; no evidence yet sufficient to promote it.
3. **Late certainty/dead-tail capture** — known high outcome accuracy but low remaining margin on Kalshi; likely only viable if faster observation feeds or maker rebates materially alter economics. Lower priority.
4. **Cross-source/venue relative-value or market-making** — remains a non-weather fallback, but must respect settlement-rule equivalence and real fill/hedge risk.

### Hard rules for later overnight runs

- Do not reopen or tune WEATHER-STRATEGY-1/2/3 on their old holdouts.
- Do not count multiple buckets from the same station-day as independent evidence.
- Any new model/cluster strategy gets a fresh train/OOS split and realistic displayed ask/fee treatment.
- Stress test thin liquidity, partial fills, spread/slippage, latency, correlated same-day city exposure, settlement-source divergence, and worst-case losing streaks before any paper promotion.
- No production deployment and no live execution.
