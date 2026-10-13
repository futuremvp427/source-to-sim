# Bitcoin 15-minute forward paper experiment

This is a new, independent 48-hour experiment. Six frozen hypotheses are tested at 10, 25 and 50 requested contracts per trade. Each of the 18 accounts starts with $1,000 of fictional cash. These balances, orders, positions, fees and returns are simulations. No venue order endpoint or credentials are implemented.

The first 24 hours are a screen; the following 24 hours are an untouched confirmation window. There is no automatic parameter tuning or live promotion. Ten-contract accounts are the primary comparisons. The 25- and 50-contract accounts test capacity; they do not supply additional independent outcomes.

## Frozen candidates

| ID | Trigger | Exit |
|---|---|---|
| late80_hold | Favorite costs 80–95 cents with 30–150 seconds remaining | Official settlement |
| late90_exit | Favorite costs 90–97 cents with 20–90 seconds remaining | +2-cent bid target; -4-cent bid stop; otherwise settlement |
| momentum | Coinbase 60-second move at least 5 basis points, aligned 180-second move, and contract midpoint 30-second move at least 3 cents; 120–480 seconds remaining; entry 20–80 cents | +8-cent target; -5-cent stop |
| panic_fade | Contract midpoint moves at least 12 cents in 30 seconds while Coinbase moves no more than 3 basis points; take opposite side; 120–480 seconds remaining; entry 10–75 cents | +6-cent target; -4-cent stop |
| book_pressure | Top-three-level bid depth skew at least 0.65 for three observations, aligned 15-second midpoint move at least 1 cent; 120–480 seconds remaining; entry 20–80 cents | +5-cent target; -4-cent stop |
| buffered_value | Brownian proxy for the future final-minute average, using the larger 2-minute/10-minute past variance rate, variance multiplied by 1.5625, an initial Coinbase/index basis estimate, $20 adverse basis uncertainty and an 8-point probability haircut; estimated edge after modeled fees at least 5 points; 90–600 seconds remaining; entry 10–90 cents | Official settlement |

These rules are research choices, not empirically established profitable settings. The probability model is not an authenticated CF Benchmarks feed or a claim about true probabilities.

## Execution and accounting

Public Kalshi fixed-point orderbooks and Coinbase tickers are polled at a target cadence of five seconds. Network latency and errors can reduce coverage. Requests are logged with their send/receive times and relevant cache headers. Coinbase trade age over ten seconds, book request latency over three seconds, and HTTP cache staleness disable decisions. Books wider than three cents, missing quotes and crossed or duplicate levels are rejected.

YES asks are the complements of NO bids, and vice versa. The simulator never buys at a displayed bid or assumes an immediate paired arbitrage. An entry signal cannot fill on its signal snapshot: a later book at least five seconds later is required. The entry is limited to the smaller of its strategy price ceiling and its original ask plus one cent, expires after twenty seconds, and can fill partially. Only half of the displayed whole-contract depth is available in the simulation. Unfilled entry quantity is canceled. There is one entry attempt per strategy per market.

Entries pay the current series/event quadratic taker fee multiplier. The model rounds the fee upward to a whole cent for each price-level fill. This is deliberately conservative: the July 7 fee PDF's prose describes centicent rounding while its tables round to cents. The model is an upper-bound convention, not a claim that the account's fee receipt would match it exactly. Unknown fee types or stale fee metadata disable new entries. Early sales pay another taker fee; official settlement has no fee.

Profit and stop triggers use executable bids, then wait for another observed book before selling. A trigger does not guarantee its quoted exit price. Partial exits, exhausted depth and gaps are handled without invented fills. No cash is borrowed and open acquisition cost cannot exceed $100 per account. At a $200 marked drawdown, that account stops new entries. Partial-exit cost allocation and settlement are idempotent.

Settlement uses only a final Kalshi API result, with settled/finalized status and ordinary binary payout. Coinbase does not determine the result. Nonbinary or provisional settlement stays unresolved. Entry collection stops at 48 hours, then the runner can drain settlements for up to thirty minutes.

The eighteen accounts are independent counterfactual executions of candidate rules. Their profits must not be added as a realizable portfolio: they can compete for the same liquidity in reality. Quantity tiers may also have identical fills when the visible book is deep. Ten, twenty-five or fifty contracts in one interval remain one market outcome.

## Evaluation

Report completed distinct markets, actual simulated quantity, net P&L, all modeled fees, return on starting capital, return on acquisition cost, open positions, missing coverage, skips and marked drawdown. Apply another one cent per contract per executed leg in the stress comparison. Frozen primary screening rules require at least thirty completed markets in each day, positive net in both days, positive stressed holdout net, no drawdown halt, adequate observed market coverage, and a positive one-sided lower bound from a one-hour block bootstrap adjusted for six hypotheses. This is a demanding exploratory screen, not proof of long-term profitability. Untouched future data over additional regimes would still be necessary.

The raw public responses form a SHA-256 hash chain. Checkpoints preserve the chain head, cash, open positions and prior trades between runner segments. Protocol/code hash changes are rejected on resume. Each segment exports compressed observations, a manifest, ledger, CSV scoreboard and JSON evaluation.

## Research sources inspected on October 13, 2026

- [Kalshi public orderbook mechanics](https://docs.kalshi.com/getting_started/orderbook_responses): source of the reciprocal bid/ask relationships and fixed-point depth representation.
- [Kalshi series API](https://docs.kalshi.com/api-reference/market/get-series): live fee multiplier and settlement metadata. The public KXBTC15M series probe returned quadratic fees, multiplier 1, and CF Benchmarks settlement. Each market's actual rules specify averages of the sixty index observations before its start and end.
- [Kalshi fee schedule](https://kalshi.com/docs/kalshi-fee-schedule.pdf): quadratic taker formula and no settlement fee; conservative rounding convention explained above.
- [Kalshi CF Benchmarks API](https://docs.kalshi.com/cfbenchmarks/rest-passthrough): the official index passthrough requires API credentials; this study uses no credentials and explicitly marks the Coinbase proxy limitation.
- [Coinbase ticker documentation](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker): public trade timestamp, best bid and ask.
- [Turbine's September research synthesis](https://www.turbinefi.com/blog/5732-backtests-kalshi-bitcoin-15-minute-bots-2026): original vendor-reported backtests motivate hypotheses but do not verify a deployable edge. Later panic-fade tests lost across all 100 completed variants; selected momentum families differed materially in results, sizes, windows and execution. Its own synthesis identifies no-trade variants, overlapping tests, missing holdouts and unresolved ROI denominators. We are not adopting its reported winners as fact about our prospective study.
- [Portnaya, 2026, Bitcoin threshold option/prediction-market pricing](https://arxiv.org/html/2606.19517v1): empirical pricing discrepancies on different venues/contracts motivate valuation research. Its longer-duration threshold contracts and option-based benchmark do not validate this short-horizon spot-volatility model.
- [Cardozo and Rivero-Wildemauwe, 2026, favorite–longshot bias](https://arxiv.org/html/2609.12878v1): findings on Polymarket depend on grouping and category; they do not prove that late Kalshi favorites yield profit after costs.
- [Cont, Kukanov and Stoikov, orderbook events](https://arxiv.org/html/1011.6402v3): foundational equity-market evidence motivates a pressure hypothesis. Static top-three-level depth skew is not the paper's event-based order-flow measure and its transfer to Kalshi is unvalidated.
- [AstroTick repository](https://github.com/Razzleberryss/AstroTick): inspected as an example of momentum/skew/exits. Its README describes functionality; it is not independently audited performance evidence. Its code and AI dependencies are not executed by this experiment.
- [KalshiMarketMaker repository](https://github.com/rodlaf/KalshiMarketMaker): market-making architecture inspected. Maker strategies are excluded from profit scoring because simple public snapshots cannot establish our queue position or actual fills.
- [Reflex](https://reflexbot.io/user-guide.html): timed favorites and exits are baseline inspirations. We neither install the extension nor provide it account keys.

## Ideas excluded from an apparent-profit leaderboard

Same-market YES+NO arbitrage from summing bid prices is not executable ask-price arbitrage. Cross-venue Bitcoin contracts can differ in index, threshold, averaging and deadlines; their settlement payoffs cannot be assumed identical. Maker profits based merely on a quote touching a limit are not credible without a queue-aware fill model. Millisecond latency-arbitrage claims cannot be reproduced by a five-second public REST collector. Martingale sizing and increasing size after losses do not establish an edge.

## Run

```bash
python -m unittest -v test_runner.py
python runner.py --state paper-state/state.json --output paper-output --duration-seconds 120
python analyze.py --state paper-state/state.json --output paper-output/evaluation.json --raw paper-output/observations.jsonl.gz
```

The GitHub workflow runs these tests and a data smoke test, then hands a checkpoint through nine sequential runner segments. Only this experiment's separate branch is used; no default-branch merge or production deployment is required. Standard public-repository runners are free under GitHub's published billing rules. Each export is bounded and retained for seven days; no paid runner or subscription is selected.
