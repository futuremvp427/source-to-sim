# Multi-coin 15-minute screen: data feasibility (2026-11-07)

Status: SCREEN ONLY. No backtest has been run, no strategy has been scored and no orders were placed.

Evidence: GitHub Actions run 42410771360 (`probe.py`). It made 627 public, unauthenticated requests, and every one returned HTTP 200. Run 42410388177 came first, but its historical spread figures are wrong: it divided `/historical` candle prices, which are dollar strings, by 100. Do not use them.

## What free data exists

| | BTC | ETH | SOL | XRP | DOGE | BNB | HYPE | NEAR | ZEC |
|---|---|---|---|---|---|---|---|---|---|
| Settled markets listed | ≥20,770 | ≥20,770 | ≥20,770 | ≥20,770 | ≥20,770 | ≥20,770 | ≥20,770 | 12,332 | 12,332 |
| Earliest market reached | ≤ Apr 1 (page cap) | ≤ Apr 2 | ≤ Apr 1 | ≤ Apr 1 | ≤ Apr 1 | ≤ Apr 1 | ≤ Apr 1 | Jun 30 | Jun 30 |
| Median spread, 24-market survey | 1¢ | 1¢ | 1¢ | 1¢ | 2¢ | 2¢ | 1¢ | 3¢ | 2.5¢ |
| Survey markets with median spread ≤1¢ | 100% | 75% | 54% | 58% | 46% | 42% | 58% | 17% | 21% |
| Median volume per market (contracts) | 1.49M | 53k | 19k | 29k | 16k | 10k | 14k | 8k | 9k |

- **Kalshi, free and public:** settled-market lists from `/markets` (from Sep 1) and `/historical/markets` (before the Sep 8 cutoff). 1-minute candlesticks give YES bid and ask OHLC, the trade price, volume and open interest. Trade prints include `taker_side`. Each market also carries `floor_strike` (the start-window RTI average) and `expiration_value` (the end-window RTI average).
- **Not available:** historical orderbook depth. Candles are minute-level top of book only, so fill size and queue position cannot be modeled.
- **Settlement:** every series settles on a CF Benchmarks `<COIN>USDRTI` 60-second average. That feed requires credentials. `floor_strike` and `expiration_value` are free official anchors at each market's open and close, so proxy basis can be measured at both points.
- **Underlying, 1-minute:** Binance.US klines (USD and USDT pairs) returned complete 300/300-minute windows for all nine coins at 7, 30 and 90 days back. Coinbase has every product, but DOGE, BNB, HYPE and NEAR have gaps: BNB returned 189–239 of 299 minutes. Hyperliquid returns only recent candles, nothing 7 or more days back. Binance.US is the usable spot proxy.
- **Liquidity regime break:** alt-coin spreads were 2–13¢ from April to July. They tightened to about 1¢ from August on. A backtest that pools April–July with August–November mixes two different markets. For the altcoins, the period that is realistically tradeable is about 3 months, roughly 8,500 markets per coin.

Verdict: a historical backtest is **feasible at no cost for all nine coins**, with one hard limit. Decisions can only be made on 1-minute bars, fills must be priced conservatively at a later minute's quote, and capacity cannot be measured.

## The five candidates

| # | Candidate | Data | Main problem |
|---|---|---|---|
| 1 | ETH, BTC and SOL triple confirmation | Feasible: Binance.US ETH/BTC/SOL plus KXETH15M | "100 profitable variants in one 30-day period" is evidence of overfitting, not robustness: correlated variants on one sample count as one result. BTC, ETH and SOL 5-minute returns are highly correlated, so this reduces mostly to ETH momentum, close to the `momentum` rule in the October BTC study. No contract-price band is specified. |
| 2 | SOL 15-minute breakout | Feasible | SOL spread ≤1¢ in only 54% of surveyed markets, so the spread gate removes much of the sample. "Preceding 15-minute high" must be frozen as the prior window's spot high. |
| 3 | DOGE EMA breakdown, buy NO | Feasible: NO ask = 1 − YES bid; NO bid = 1 − YES ask | The rule only buys NO, so a profitable result could just reflect a DOGE downtrend in the sample period. A ≥70¢ entry with a 25¢ stop is close to holding to settlement, which overlaps the `late80_hold` family. "+$98, one variant" is noise-sized. |
| 4 | BNB three-indicator momentum | Feasible on Binance.US only | Thinnest of the five (10k contracts per market, ≤1¢ spread in 42% of markets). "Confirming momentum and velocity" is not defined. Five listed variants means choosing a winner after the fact. |
| 5 | HYPE buffered strike plus VWAP | Feasible: `floor_strike` is exact | A $0.40 buffer is about 0.5% at roughly $77, a moving target as price changes. Without an entry price cap, YES may already be priced near fair. |

Four of the five (1, 2, 4, 5) are versions of one hypothesis: "Kalshi under-reacts to short-horizon spot trend." If that lag exists, it most likely plays out in seconds. 1-minute bars cannot observe that, so a null result here would not rule it out, and a positive result is at risk of stale-quote artifacts. Any backtest must fill at the next minute's quote or later, never the signal minute's close.

## Rules a backtest must freeze before looking at results

1. Window: 2026-08-01 to the run date, with a chronological 60/40 split. April–July is reported separately and never pooled.
2. Fill: signal on spot minute t; buy at the YES (or NO) ask **high** of Kalshi minute t+1. Skip if the spread exceeds the rule's limit. Use the quadratic taker fee rounded up per fill, plus a 1¢-per-contract stress case.
3. Size: 10 contracts. No capacity claims.
4. Settlement: Kalshi `result` only.
5. One frozen variant per candidate, corrected for 5 tests, using the same block-bootstrap lower-bound gate as the October BTC protocol.
