# Kalshi Same-Venue Copy Research Path

## Status

Source-independent adapter complete on branch `feature/kalshi-same-venue-copy-source`.

This path is **paper/research only**. It does not place live orders and does not change the existing Polymarket-source Sports Shadow production path.

## Why this path exists

The existing Sports Shadow system accepts a Polymarket source trade and then tries to prove that a Polymarket US or Kalshi contract is economically equivalent. That cross-venue proof is the hardest and least reliable part of the current system.

A Kalshi leaderboard/social source trade copied to the **same Kalshi market** does not need that translation step. If public source evidence contains the exact Kalshi market ticker and YES/NO side, the copy-research path can route by the source market identifier itself.

## Implemented

`src/lib/sports-shadow/kalshi-source.ts` now:

- validates untrusted trader activity fail-closed;
- requires a stable trader id and source trade id;
- requires an explicit verified-format Kalshi market ticker;
- preserves BUY/SELL and YES/NO exactly;
- creates stable dedupe identity `KALSHI_SRC:<traderId>:<sourceTradeId>`;
- applies an explicit paper-copy trader qualification gate;
- bridges directly into the existing `episode.ts` lifecycle reducer;
- preserves exact ticker + side as target identity;
- marks the path `SAME_VENUE_KALSHI` so the cross-venue resolver is bypassed;
- defines `KalshiTraderActivitySource` as the one future transport interface;
- performs no network, database, order, or live-trading action.

Tests prove existing BUY, ADD/DCA, partial SELL, full SELL, duplicate-event, and fail-closed behavior can be reused directly.

## Architecture

```text
verified Kalshi public trader activity
        |
        v
KalshiTraderActivitySource
        |
        v
fail-closed normalization + qualification + dedupe
        |
        v
SAME_VENUE_KALSHI route
        |
        v
exact source market ticker + YES/NO side
        |
        v
existing lifecycle reducer
        |
        v
existing Kalshi observation / sizing / paper-fill infrastructure
        |
        v
paper position lifecycle + settlement + P&L
```

## Reuse from the existing bot

Keep and reuse:

- worker leases/fencing;
- rate-limit infrastructure;
- episode/lifecycle handling;
- Kalshi market and order-book code;
- quote observation;
- paper execution;
- settlement;
- P&L;
- telemetry, alerts, and dashboard;
- experiment epochs;
- promotion/soak gates.

Bypass for this path:

- Gamma source metadata;
- Polymarket condition-ID translation;
- PM-US/Kalshi cross-venue fuzzy/economic matching;
- `EXACT/NEAR/NONE/UNVERIFIED` as proof that a same-venue source ticker maps to itself.

## Hard external gate

The remaining blocker is source transport, not lifecycle or Kalshi paper execution.

Do not implement a production transport until a supported Kalshi source can provide:

1. another public trader's activity;
2. stable trader/profile identity;
3. stable per-trade identity;
4. exact ticker, side, action, quantity, execution price, and timestamp;
5. documented rate limits/terms permitting the read use.

See `docs/KALSHI_SAME_VENUE_SOURCE.md` for the detailed source contract.

## Next implementation sequence

1. Verify or rule out a supported public Kalshi trader-activity source.
2. If verified, implement exactly one server-only `KalshiTraderActivitySource` transport.
3. Add durable persistence for normalized source events and detection latency.
4. Wire direct same-venue events into existing paper observation/execution without invoking cross-venue matching.
5. Add provenance and dashboard reporting for `SAME_VENUE_KALSHI`.
6. Run forward paper validation before any promotion discussion.

No live-trading implementation is part of this path.
