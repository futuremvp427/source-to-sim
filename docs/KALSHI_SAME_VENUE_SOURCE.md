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
economic-equivalence resolver). `requiresCrossVenueResolution()` returns false for it, and
a regression test asserts the resolver is not invoked.

## What is implemented (source-independent adapter)

`src/lib/sports-shadow/kalshi-source.ts` — pure, no I/O:

- `KalshiTraderSourceEvent` raw contract and fail-closed validation
- verified-ticker shape check (no guessing, no cleanup)
- stable dedupe key `KALSHI_SRC:<traderId>:<sourceTradeId>`
- trader qualification/watchlist gate (explicit approval only; leaderboard rank alone never qualifies)
- `toEligibleFill()` bridge into the existing lifecycle reducer (`episode.ts`), which already
  handles BUY, ADD/DCA, partial SELL and full SELL
- `targetLegForTrade()` — byte-identical ticker + identical YES/NO side
- `KalshiTraderActivitySource` interface — the single plug point for a future transport

## Remaining blocker: no verified public-trader transport

Kalshi's documented trade API exposes:

- market data and orderbooks per ticker
- anonymous public market trades (`/markets/trades`) — no trader/profile identity
- portfolio endpoints scoped to the AUTHENTICATED account only

There is no documented endpoint that returns a SPECIFIC public trader's or leaderboard
account's trades. No transport implementation has been written, and no simulated transport
exists in production code.

### Evidence required before connecting a transport

1. A documented Kalshi endpoint (or officially supported data product) that returns trades
   or positions for a trader other than the authenticated account.
2. A stable public trader/profile identifier returned by that endpoint.
3. A per-trade identifier suitable for stable dedupe.
4. Market ticker, YES/NO side, BUY/SELL, quantity, execution price (cents), execution
   timestamp — all present per trade, none inferred.
5. Documented rate limits and terms permitting this read use.

Until all five exist, `KalshiTraderActivitySource` stays unimplemented.

## Trader qualification

`KalshiTraderQualification.approvedForPaperCopy` must be set by a deliberate decision.
The `evidence` bag is where later work records performance windows, trade count,
repeatability, concentration, market categories, liquidity, holding duration,
entry-to-detection latency, realized vs unrealized performance, copy slippage, fees,
drawdown, and single-win dependence. No numeric thresholds are invented in this pass.
