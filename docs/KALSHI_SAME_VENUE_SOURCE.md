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

---

## Public-trader source investigation (2026-09-17) — VERDICT: NOT VERIFIED

Read-only investigation of every Kalshi surface that could plausibly carry another public
trader's activity. No endpoint was invented, no auth bypassed, no private data read, no
order path touched. `LIVE_EXECUTION_IMPLEMENTED` remains `false`.

### Surfaces inspected

1. `docs.kalshi.com` Trade API v2 OpenAPI (full component schemas + tag list).
2. `GET /trade-api/v2/markets/trades` and `GET /trade-api/v2/historical/trades`.
3. `GET /trade-api/v2/portfolio/*`, `/account/*`, `/historical/positions`.
4. `kalshi.com/social/leaderboard` and `kalshi.com/social` (live browser fetch attempt).
5. Kalshi help center: Leaderboard, Kalshi Social posting, **Inner Circle**, Social
   Community Guidelines.
6. Documented rate limits + Developer Agreement scope.
7. Third-party "Kalshi profile scraper" products (Apify).

### Field availability

| Field | public trade tape | social leaderboard | user-shared social post | `/portfolio/*` |
|---|---|---|---|---|
| stable trader id | absent | username only (opt-in) | poster handle, not a stable id | own account only |
| stable trade id | `trade_id` | – | – | yes |
| market ticker | `ticker` | – | market named | yes |
| YES/NO side | `taker_outcome_side` | – | direction only | yes |
| BUY/SELL | only inferable from `taker_book_side`, taker leg only | – | – | yes |
| quantity | `count_fp` | – | – | yes |
| execution price | `yes_price_dollars` / `no_price_dollars` | – | – | yes |
| execution timestamp | `created_time` | – | post time only | yes |
| sells / partial exits distinguishable | no (no account identity to link legs) | n/a | no | yes |

### Why each candidate is insufficient

- **Public trade tape** — has every trade-level field but is fully anonymized: the `Trade`
  schema contains no account/user/maker/taker identifier, so fills can never be attributed
  to a trader, and entries cannot be linked to exits.
- **Social leaderboard** — carries identity (opt-in username) but only aggregate profit /
  volume / prediction-count per timeframe. No ticker, side, price, quantity, or timestamp.
- **User-shared social posts** — voluntary, sparse, non-real-time; market + direction only.
  No price, quantity, execution time, or trade id, and no completeness guarantee.
- **`/portfolio/*`** — complete, but authenticated-self-only. Using our own authenticated
  account as a stand-in for another trader's feed is explicitly out of scope.
- **Third-party scrapers** — unofficial, unsupported by Kalshi, and screen-scrape the public
  profile UI; not a verified data contract.

### Closest available public data
The anonymous public trade tape (`/markets/trades`). Missing exactly one thing that would
make the same-venue copy path viable: **a per-trade trader/account identifier**. Also
missing: a per-account BUY/SELL direction (tape gives taker book side only) and any way to
distinguish an exit from an entry.

### Kalshi Social visibility and consent
Kalshi Social does gate richer data behind an opt-in relationship called **Inner Circle**,
which controls who can see "positions, trade history, and P&L" that a user has not made
public. This is a first-party, in-app friend-list gate: there is no documented OAuth,
delegated-access, or API grant flow through which a third-party application could read one
consenting trader's structured activity, and no published field-level schema for it.
Kalshi's Social Community Guidelines further state: "Do not access, or try to access, any
account other than your own."

### Automated public-page reads
Loading `kalshi.com/social/leaderboard` from an automated browser returns a Vercel Security
Checkpoint ("Failed to verify your browser", code 21) instead of page content, so no
XHR/network payload could be captured. Treat this as an explicit signal that automated reads
of the public social pages are not a supported interface, independent of the guidelines
above.

### Consequence
No transport implemented. No persistence added. No worker paper route wired. The
`KalshiTraderActivitySource` interface stays the single unimplemented plug point.
The five evidence requirements listed earlier in this document remain unmet — specifically
requirements 1 and 2 (a documented cross-account endpoint and a stable public trader id).

### Next smallest step
Ask Kalshi directly (support / developer contact) two questions: (a) is there any supported
interface — current or planned — that returns a consenting user's positions or trade history
to a third party; (b) does Inner Circle have or plan an API surface with a field-level
schema. A written yes with a field schema is the only thing that unblocks the transport.
Until then the same-venue copy path cannot be fed from a public Kalshi trader.
