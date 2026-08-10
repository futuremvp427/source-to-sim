# Capacity comparison metric notes

The V2 vs V3 capacity panel is a **paper-simulation capacity comparison**, not a mark-to-market performance report.

## Cash-basis drawdown

`maxDrawdownCash` is calculated from the recorded `paper_trades.cash_after` sequence as the largest drop from a running peak in simulated cash. It excludes the value of open positions.

Because BUYs move simulated cash into open paper positions, this number can become large even when the experiment has not realized a comparable loss. Treat it as a **cash-deployment / cash-pressure indicator**, not as portfolio equity drawdown.

Use realized P&L and, when every open position has a fresh mark, simulated equity for performance interpretation.

## Cash-reserve skips

`INSUFFICIENT_CASH_RESERVE` counts source BUYs that could not be copied because spendable cash would have breached the fixed 10% starting-bankroll reserve. A high count is evidence of a capacity constraint at that bankroll; it is not a source-trade failure.

## Equity availability

Simulated equity is intentionally reported as unavailable unless every open position has a sufficiently fresh public mark. Missing or stale marks are not substituted with historical prices.

## V2 vs V3 interpretation

V2 and V3 use the same `dynamic-v1` sizing rule. Their intended difference is starting simulated bankroll ($380 vs $1,000). Keep the cohorts isolated and compare cash-reserve skips, realized P&L, settled markets, and mark coverage before drawing conclusions about capital requirements.
