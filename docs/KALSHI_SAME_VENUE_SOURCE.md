# Kalshi same-venue copy source (Kalshi -> Kalshi)

PAPER / RESEARCH ONLY. `LIVE_EXECUTION_IMPLEMENTED=false`. No real orders are placed by any
code described here.

## Why this route exists

Cross-venue copying (Polymarket source trade -> equivalent PM-US/Kalshi market -> prove
economic equivalence) produced almost no legitimate EXACT matches. The same-venue route
removes the matching problem entirely: if the source trade already names a verified Kalshi
market ticker and side, we copy that exact ticker and side.

## Routing contract

A normalized same-venue trade carries `route: "SAME_VENUE_KALSHI"`. Such a trade must
NEVER be sent through `src/lib/sports-shadow/resolver.ts` (the Polymarket->Kalshi
economic-equivalence resolver). `requiresCrossVenueResolution()` returns false for it.

## What is implemented

`src/lib/sports-shadow/kalshi-source.ts` is pure and performs no I/O. It provides:

- `KalshiTraderSourceEvent` raw contract and fail-closed validation
- verified ticker-shape validation with no guessing or cleanup
- stable dedupe key `KALSHI_SRC:<traderId>:<sourceTradeId>`
- explicit trader qualification/watchlist gate
- `toEligibleFill()` bridge into the existing lifecycle reducer (`episode.ts`)
- exact same-ticker and same-side target routing
- `KalshiTraderActivitySource` as the single plug point for a future verified transport

The existing lifecycle reducer handles BUY, ADD/DCA, partial SELL, and full SELL behavior.

## Remaining blocker: no verified public-trader transport

The documented Kalshi interfaces reviewed so far expose market/order-book data, anonymous
public market trades, and portfolio data for the authenticated account. They do not establish
a documented endpoint that returns another specific public or leaderboard trader's trade
history.

No production `KalshiTraderActivitySource` implementation should be written until the source
contract is verified.

### Evidence required before connecting a transport

1. A documented or officially supported Kalshi interface that returns another trader's
   trades or positions.
2. A stable public trader/profile identifier.
3. A per-trade identifier suitable for deterministic dedupe.
4. Per-trade market ticker, YES/NO side, BUY/SELL action, quantity, execution price, and
   execution timestamp, with none of those fields inferred.
5. Documented rate limits and terms permitting this read use.

Until those requirements are met, `KalshiTraderActivitySource` remains an interface with no
production transport.

## Trader qualification

`KalshiTraderQualification.approvedForPaperCopy` must be set by a deliberate decision. A
leaderboard rank alone never qualifies a trader. The `evidence` field can later retain
performance windows, trade count, repeatability, concentration, market categories,
liquidity, holding duration, entry-to-detection latency, realized versus unrealized results,
copy slippage, fees, drawdown, and dependence on one large win.

No numeric qualification thresholds are invented in this implementation step.
