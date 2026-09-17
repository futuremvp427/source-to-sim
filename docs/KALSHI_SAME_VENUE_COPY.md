# Kalshi Same-Venue Copy Research Path

## Status

Implementation started on branch `feature/kalshi-same-venue-copy-source`.

This path is **paper/research only**. It does not place live orders and does not change the existing Polymarket-source Sports Shadow production path.

## Why this path exists

The existing Sports Shadow system accepts a Polymarket source trade and then tries to prove that a Polymarket US or Kalshi contract is economically equivalent. That cross-venue proof is the hardest and least reliable part of the current system.

A Kalshi leaderboard/social source trade copied to the **same Kalshi market** does not need that translation step. If public source evidence contains the exact Kalshi market ticker and YES/NO side, the copy-research path can route by the source market identifier itself.

The first implementation step is `src/lib/sports-shadow/kalshi-source.ts`:

- validates a canonical Kalshi public-source trade;
- preserves BUY/SELL and YES/NO exactly;
- requires a concrete Kalshi market ticker;
- creates a deterministic same-venue route using that ticker;
- labels it `KALSHI_SAME_VENUE`, not `EXACT`, so it cannot contaminate historical cross-venue matching metrics;
- creates a stable source idempotency key;
- performs no network, database, order, or live-trading action.

## Architecture target

```text
Kalshi public leaderboard/social profile
        |
        v
verified public-activity source adapter
        |
        v
canonical KalshiSourceTrade
        |
        v
same-venue validation + dedupe
        |
        v
exact source market ticker + YES/NO side
        |
        v
existing Kalshi quote / observation / paper-fill infrastructure
        |
        v
paper position lifecycle + settlement + P&L
```

## Reuse from the existing bot

Keep and reuse:

- worker leases/fencing;
- rate-limit infrastructure;
- source-event deduplication concepts;
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
- `EXACT/NEAR/NONE/UNVERIFIED` as the proof that a same-venue source ticker maps to itself.

## Hard gates before server wiring

1. **Public activity evidence must be verified.** Do not hard-code an undocumented profile/activity endpoint until its request/response behavior has been independently observed and recorded.
2. **Every trade must have a stable source identity.** If the public feed has no trade ID, design a deterministic composite key only after verifying which fields are immutable and sufficiently discriminating.
3. **Market ticker and side must be explicit.** If either is absent, the event stays unrouteable; no text guessing.
4. **No live trading.** The initial adapter feeds only the paper/research ledger.
5. **Historical cross-venue path stays intact.** Same-venue work is additive until it passes its own forward paper validation.
6. **Trader qualification is separate from trade ingestion.** Leaderboard rank/profit/volume filters may decide which public profiles to observe, but they must never alter the meaning of a detected source trade.
7. **Observed-source timing is durable.** Persist the source trade timestamp and detection timestamp separately so copy latency can be measured without hindsight.

## Next implementation sequence

1. Verify the public Kalshi Social/leaderboard activity source contract and capture representative payloads.
2. Add a server-only source adapter that emits canonical `KalshiSourceTrade` records and contains no order code.
3. Add persistence for source trades with deterministic dedupe and source/detection timestamps.
4. Wire those records into the existing episode/lifecycle reducer.
5. Add a same-venue Kalshi observation/paper route that targets the exact source ticker and side.
6. Add dashboard provenance distinguishing `POLYMARKET_CROSS_VENUE` from `KALSHI_SAME_VENUE`.
7. Run forward paper validation; only after that consider any separate live-promotion design.

## Current external evidence

As of September 2026, Kalshi publicly exposes a Social leaderboard and public profile pages, and Kalshi Pro advertises a public live-trades tape. Kalshi's documented API provides public market data plus authenticated access to a user's own orders/trades, but the documented API material reviewed so far does **not** establish an official public API for another user's complete trade history. Therefore the public profile/activity transport remains an explicit research gate rather than an assumed API contract.
