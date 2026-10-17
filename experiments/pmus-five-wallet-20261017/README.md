# Five-wallet Polymarket US forward paper test

`pmus-five-wallet-forward-20261017-v1` is an independent experiment authorized on October 17, 2026. It follows HomeRunHazard plus four additional researched source wallets: ethanaz, gmpm2, mooseborzoii and omnibus-076daa. `selection.json` records the bounded candidate screen, including alternatives excluded for negative reported lifetime sports P&L. Reported leader profit is not follower profit or an independent cash-flow audit.

The existing default branch, production app, PR 62 and all earlier studies are preserved. This directory has no dependency on the app/database or venue account access. No venue orders, funding, private trading credentials, Lovable messages or paid AI calls are used.

## Frozen test

`protocol.json` is frozen before the actual forward epoch. Its exact byte hash and the workflow's immutable code commit are stored in every checkpoint. The five accounts each start with $1,000 fictional cash. Accounts and their profits are reported separately, with no combined-portfolio claim.

- Collection accepts new entries for 48 hours. Source reductions and US settlements can continue during a bounded additional 48-hour drain. Actual start/end times come from the published bootstrap checkpoint, not from a planned clock time.
- Follow only fresh executed source BUY signals after that epoch, corroborated by current inventory in both outcomes. Existing source holdings do not trigger entry by themselves. Additions to an existing source holding can trigger a new prospective paper decision.
- Only binary full-game moneylines in NFL, CFB, NBA, NHL, MLB and WNBA are supported. Pregame and in-play signals are allowed and tagged by scheduled start; no actual game clock is inferred. Props, spreads, totals, partial games, futures, other leagues and unverified destination matches are skipped.
- Match the same scheduled event and uniquely matching team, require a two-way token/US-side join, and use the US contract's own settlement terms. These associations deliberately accept known contingency differences and are never labeled EXACT. NBA `nyk/ny`, `sas/sa`, NHL `tbl/tb`, `utah/uta`, and Utah/Mammoth are the explicit reviewed aliases; ambiguity or a changed schedule blocks a new entry.
- This is a **10-contract capped net-side follower**, not a dollar-for-dollar replica. At each modeled opening record the leader's net quantity. Maintain a peak of its absolute net since that opening; target `10 × current absolute net / peak`, rounded down to the verified US quantity step. Fresh additions can restore the capped amount. Reductions and complementary hedges reduce the target; a direction flip first closes the old side and separately requires a fresh BUY on the new side. At most 20 markets may be open per fictional account.
- A source signal must be at most 120 seconds old and first observed at least 5 seconds before a modeled entry. The current US book must have its own transaction timestamp at most 60 seconds old. Full requested depth is required; otherwise the attempt is skipped. An entry average more than $0.03 worse than the source BUY price is skipped. This does not assume the source's price is still executable.
- Model BUYs at current US offers and SELLs at current US bids, with correct complementary prices for the opposite side. Read the current US fee coefficient and verify the frozen standard coefficient `0.0695`. Charge banker-rounded cumulative exact taker commission, a conservative model with aggregated depth that lacks resting-order fragmentation. Apply no leader maker rebates, volume tiers or assumed income.
- A stress comparison subtracts an additional $0.01 for every actually simulated contract on every BUY/SELL. This is a cost sensitivity, not a claim about actual price impact. Quantity steps are 0.01 or 1 as verified from the market metadata; unsupported values fail closed.
- A foreign resolution/redemption or a missing quote never closes or settles a US position. Empty OPEN inventory needs explicit CLOSED-position corroboration before a zero is inferred. For US settlement require the exact resolved/closed target, official settlement endpoint identity and price, and agreement with the US long-side resolution price. Nonbinary US settlement prices remain valid. Unresolved holdings survive checkpoints and remain unresolved at the hard stop.

## Data and persistence

Only public venue GET endpoints are permitted by `collector.py`. Raw exact response bytes, body hashes, request/receipt times, HTTP errors and model decisions enter a sequence-checked hash chain. LZMA compresses the raw stream across requests so repeated polls do not consume the previous rehearsal's raw-byte cap prematurely. A 500 MiB compressed-evidence bound and a 16 GiB uncompressed-evidence guard still stop the experiment explicitly if reached; no silent deletion or substitute data are permitted.

The workflow uses standard Ubuntu runners in the public repository. It does not upload Actions artifacts or use cache storage. It publishes compressed state, raw chunks, immutable checkpoint manifests and a readable summary to the separate branch:

`research/pmus-five-wallet-state-20261017`

under `paper-results/pmus-five-wallet-forward-20261017-v1/`. The automatically issued GitHub token is used only by `persistence.py` for this fixed checkpoint branch; it is never sent to a venue. This avoids relying on a production database and avoids new billed artifact storage. GitHub's [standard-runner public-repository policy](https://docs.github.com/en/billing/concepts/product-billing/github-actions) is the source for runner availability without minute charges.

The latest `SUMMARY.md` and `summary.json` distinguish successful source polls from the latest returned source-trade timestamps. A running job is not a data heartbeat. Counts and P&L come only from completed published checkpoints. Ten-minute checkpoints preserve open positions and unresolved settlements. Each five-hour segment verifies the preceding completed segment's exact state, raw chunk, code SHA and protocol hash. Segment start is also published immediately so a rerun cannot silently rewind to bootstrap. A concurrent checkpoint-head change is rejected rather than overwritten.

No automatic retry from an older checkpoint, wallet replacement, gate loosening, rule retuning, live mode or app deployment is included. A failure remains a measured limitation; an independent new epoch would require a new authorization.

## Evaluation

`summary.json` reports each account's completed distinct markets, actual bought/sold/settled quantities, completed net after modeled fees, stress net, fictional cash, complete liquidation equity, observed drawdown, mark coverage, source-poll coverage, latency fields in the ledger, and fill/skip problems. Open entry costs are not mislabeled as realized losses. Incomplete marks are unavailable, not zero; observed drawdown is limited by mark coverage.

At terminal review use this fixed precedence:

1. `UNRESOLVED_SETTLEMENTS` if held US markets remain.
2. `INSUFFICIENT_TRADES/COVERAGE` below 30 completed distinct US markets or 95% of the full planned source-poll collection window or complete-mark checks. An early stop cannot pass solely because its shorter measured interval was well polled.
3. `FAILED_SCREEN` if base or stress net is nonpositive, or observed drawdown exceeds 20% of starting capital.
4. `POSITIVE_BUT_UNCERTAIN` if base/stress are positive but the 2.5th percentile of the event-cluster stress-mean bootstrap is nonpositive.
5. `PROMISING_SCREEN_ONLY` if all preceding gates pass and that percentile is positive.

Before terminal status is `SCREEN_PENDING`. Resampling completed event markets keeps fills/additions/reductions of a game together, but does not remove cross-game/day dependence, source selection or the five simultaneous comparisons. These are screening criteria, not a calibrated guarantee or proof of lasting profitability. Different wallets trading the same game are not independent extra wins.

## Commands

From this directory:

```sh
python3 -m unittest -v test_study.py
python3 readiness.py --work /tmp/pmus-readiness
python3 verify_checkpoints.py /path/to/paper-results/pmus-five-wallet-forward-20261017-v1
```

Readiness is bounded read-only validation and does not start the forward study. The actual bootstrap runs only after the committed code is triggered on `research/pmus-five-wallet-paper-20261017`. A workflow run and a verified published bootstrap checkpoint are required before claiming collection started.

Primary technical sources: [source trade feed](https://docs.polymarket.com/api-reference/feeds/list-trades), [source positions](https://docs.polymarket.com/api-reference/wallet/list-positions-for-a-user-or-market), [US market book](https://docs.polymarket.us/api-reference/markets/get-market-book), [US settlement](https://docs.polymarket.us/api-reference/markets/get-market-settlement), [US fees](https://docs.polymarket.us/fees), [US fractional contracts](https://docs.polymarket.us/learn/trading/basics/fractional-shares). Saved public response bytes and the fixture file supply the particular event/team/fee evidence; none of the historical readiness reads is a new forward follower fill.
