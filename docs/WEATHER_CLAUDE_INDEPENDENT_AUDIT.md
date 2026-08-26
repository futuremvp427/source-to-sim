# Independent Audit of the Weather Strategy Candidates

Independent falsification pass by Claude Code on branch `weather-us-translation-research`.
Research/paper only. No production deployment, no Lovable, no Supabase change, no orders,
no live trading. `LIVE_EXECUTION_IMPLEMENTED=false` is unchanged. `main` is untouched.

The purpose of this pass was to attack the existing candidate ranking, not to confirm it.

## Headline result

The leading candidate was ranked on a measurement that does not survive audit.

`sum(/closed-positions.realizedPnl)` was used to rank all wallet archetypes. That endpoint
can only report a position that actually **closed**. A wallet that abandons worthless losing
tokens instead of redeeming them never files those events as closed positions, so the endpoint
returns a survivorship-filtered view of that wallet.

The prior research already discovered this failure once — `badatmath` was quarantined because
its endpoint total could not be reconciled against the public leaderboard. The conclusion was
not generalised. The same test applied to the leading candidate breaks it.

## Method

For each wallet the public `/activity` ledger was rebuilt as a literal cash ledger over the
same 240-day window:

- `TRADE` `BUY` — cash out
- `TRADE` `SELL`, `REDEEM`, `MERGE`, `CONVERSION`, rebates/rewards — cash in
- `SPLIT` — cash out
- terminal unredeemed inventory valued separately from `/positions`

The whole-wallet net cash figure is a binding constraint: no per-event reconstruction of that
wallet may exceed it. Script: `scripts/research-weather-wallet-cashflow-audit.mjs`.

## Maskache2 — the prior #1 candidate — REJECTED

Wallet `0x1f66796b45581868376365aef54b51eb84184c8d`, public alias `ShyGuy1`.

Lifetime history is complete and bounded: 47,028 activity rows, first activity 2026-01-08,
independently verified that no activity exists before that timestamp.

| Measure | Endpoint reconstruction | Independent cash ledger |
|---|---:|---:|
| Weather events | 760 | 1,325 |
| Event-positive rate | 72.2% | **32.6%** (95% bootstrap 30.0–35.2%) |
| P/L | +$199,479 | **+$62,168** |
| Profit factor | 4.13x (reported earlier) | **1.43x** |

**565 of 1,325 weather events (42.6%) never appear in `/closed-positions` at all. Those events
are 98.6% losers and carry -$61,665.** They are missing because the wallet abandons worthless
tokens: it holds **3,013 worthless unredeemed positions representing $518,955 of gross buy cost**,
against $87.10 of recoverable value. `/closed-positions` was verified exhausted at 1,926 rows
(offset 1,926 returns zero), so this is not a pagination artifact.

Whole-wallet tie-out over the complete lifetime:

```
BUY        -$709,546.65
SELL       +$541,823.95
REDEEM     +$174,434.72
MERGE       +$14,515.51
SPLIT        -$3,500.00
incentives   +$2,511.58
CONVERSION  +$23,878.91
inventory       +$87.10
------------------------
NET         +$44,205.12
```

The wallet's entire lifetime net cash is roughly **+$44k**, of which +$62.2k is weather and
-$18.0k is non-weather. The endpoint method attributes **+$175k–199k to weather alone**. The
figure is impossible against the wallet's own ledger.

### Worked counterexample

NYC, 2026-08-25 (`highest-temperature-in-nyc-on-august-25-2026`), every row reconciled:

- true cash flow: **-$78.49**
- endpoint-summed `realizedPnl`: **+$147.91**, "proxy ROI" +46.8%

The event resolved with `78-79F` YES (verified against Gamma), the wallet sold rather than
redeemed, and no `REDEEM` row exists — so the -$78.49 is complete. A real loss is reported as
a gain. The `80-81F` leg alone was bought for $148 cash, resolved **NO**, and is reported at
**+$121.09**. Positions acquired by `CONVERSION` are assigned a synthetic 1/N cost basis
(0.0909 on an 11-outcome event), so `avgPrice × totalBought` is fictitious for those legs and
the "proxy ROI" denominator is not a cost.

### The specific headline cohorts do not survive

| Cohort | Claimed | Independent cash ledger |
|---|---|---|
| NYC 20–55c | 52 events, 78.8% positive, +$15,723, 44.0% ROI, 4.07x PF | **36 events, 50.0% positive, +$3,125, 7.8% ROI** |
| Maskache2 55–90c | 99.4% event-positive, +$80,401 | **62.2% positive, +$6,530** |
| Maskache2 ≥90c | 97.8% positive, -$5,228 | 55.0% positive, **-$5,971** |

Chronological stability of the headline cell is also absent: NYC 20–55c is **+$3,175 in the
first half and -$50 in the second**. The claim that both halves are positive is an artifact of
the same filtered measurement. Every surviving cell is below the preregistered 50-independent-event
minimum.

## BeefSlayer — PROMISING, and the measurement is sound

Wallet `0x331bf91c132af9d921e1908ca0979363fc47193f`.

BeefSlayer redeems its positions: only **13 events** are missing from `/closed-positions`
(-$615), and only 27 worthless unredeemed rows ($692 sunk). The survivorship hole that destroys
Maskache2 is absent here.

| Measure | Endpoint reconstruction | Independent cash ledger |
|---|---:|---:|
| Weather events | 672 | 692 |
| Event-positive rate | 56.0% | **58.2%** (95% bootstrap 54.6–62.0%) |
| P/L | +$51,832 | **+$63,242** |
| Profit factor | — | **5.13x** |
| Max drawdown | — | **-$2,234** |

The endpoint reconstruction **understates** BeefSlayer by ~18% — the opposite direction to
Maskache2. Whole-wallet 240-day net cash +$69,976 (weather +$64,687) ties out, and is consistent
with BeefSlayer's public weather-leaderboard standing.

### Mechanism (reconstructed, not assumed)

7,900 BUY / 3,218 SELL / 808 REDEEM weather trades, **zero conversions**, $135 of incentive
income. This is a clean directional book, not a market-making or conversion-accounting artifact.

Entry timing relative to 00Z of the target weather date (n=574 first entries):

- **6.1% before the weather date**
- 23.5% on-day 0–12h
- **68.6% on-day 12–24h**
- median first-BUY price **8.2c**

This is **intraday information reaction on cheap tails**, not day-ahead forecasting. That
distinction matters, because every forecast-first hypothesis this project has tested and failed
(previous-day NBM, late-day stagnation) tested a different mechanism than the one BeefSlayer
actually runs.

Best surviving cells, on the true ledger, with chronological halves:

| Cell | n | TRUE win | TRUE P/L | ROI | H1 → H2 |
|---|---:|---:|---:|---:|---|
| NYC 55–90c | 21 | 81.0% | +$3,346 | 8.8% | 80% → 82% |
| NYC 20–55c | 25 | 72.0% | +$3,543 | 28.6% | 67% → 77% |
| Chicago 55–90c | 14 | 92.9% | +$2,128 | 17.7% | — |
| Miami 20–55c | 10 | 70.0% | +$1,842 | 61.7% | — |

These are stable but **all are far below the 50-event minimum**. They are hypotheses, not
validated edges.

## ColdMath — the demotion was based on wrong numbers

Wallet `0x594edb9112f526fa6a80b8f858a6379c8a2c1c11`. 237,089 activity rows.

ColdMath cleans up its positions (6,741 merges, 4,883 redeems, 1 split), so its endpoint
numbers are close to truth on totals — but the prior **stability** decomposition is wrong:

| Measure | Claimed | Independent cash ledger |
|---|---|---|
| Event-positive | 81.7% | **80.2%** (agrees) |
| Positive months | **2/8** | **8/9** |
| Max drawdown | **-$94,334** | **-$3,912** |
| Second half | **-$31,928** | **+$23,021** |
| After removing top 5% winners | **-$52,230** | **+$29,923** |

Profit factor 3.44x, 2,370 events, +$105,718 — consistent with ColdMath's public
weather-leaderboard standing. The "tail-dependent and unstable" characterisation is an artifact
of `realizedPnl` noise, not a property of the wallet.

**However**, the decisive fact about ColdMath is different and was not reported: **the wallet
has essentially stopped trading.** Monthly event counts collapse from 707 (April) to 284 (May),
102 (June), **2 (July), 14 (August)**. Last activity 2026-08-19. Whatever it was doing, it is
not doing it now. That is a stronger reason for caution than the (incorrect) instability claim.

## Structural NO basket — REJECTED, with a structural reason

Two independent live scans, 60 seconds apart, across 10 open events (NYC/Chicago/LA/SF/Miami,
2026-08-26 and 2026-08-27), full `orderbook_fp` depth ladders.

First, a correction in the prior work's favour: the basket **structure** assumption is right.
Each event is exactly 6 mutually exclusive and exhaustive legs (four `between` buckets plus
`or below` / `or above` tails), and the API confirms `mutually_exclusive: true` and
`collateral_return_type: MECNET`. An initial concern that overlapping threshold markets
contaminated the basket was checked and is **not** correct.

**Result: zero profitable complete baskets, at every size, in both passes.** The best observed
case was Chicago 2026-08-27 where the six best NO asks summed to exactly **$5.0000** against a
$5.00 guaranteed payout — still **-$0.08** after fees at 1 contract/leg.

The important addition is *why* this is structural rather than unlucky. Kalshi's taker fee is
`ceil(0.07 × P × (1−P) × C) / 100`. Near the ~83c average price of a six-leg NO basket, that is
roughly **$4.92 per 100-contract basket**. So a complete basket only profits if the six best NO
asks sum to **≤ $4.9508** — a ~1% discount to fair value that must exist on all six legs
*simultaneously*. Observed sums were $5.00–$5.13. The book is enforcing the no-arbitrage bound
tightly enough that the fee alone forecloses the trade.

The "missing legs" the prior work reported are also real and reproduced here: extreme tail
buckets frequently have no resting YES bid at all, therefore no NO ask.

The maker alternative is not a rescue: resting six NO bids converts a deterministic-payout trade
into an inventory-risk trade with no completion guarantee — which is precisely the failure mode
already independently established for `paired_maker_shadow_v1` in this project's history
(0 completed pairs across 51,906 cycles).

## Kalshi fee asymmetry against cheap tails

The same fee formula is quantitatively hostile to the cheap-tail family, which is not reflected
in the earlier cheap-tail work. Because the fee is rounded **up** to the cent, at P=0.05 the fee
is $0.01 per contract — **20% of premium**. At BeefSlayer's median 8.2c entry it is ~12%.
BeefSlayer's edge was earned on international Polymarket contracts where that charge did not
apply. Any translation of the cheap-tail regime to Kalshi must clear this hurdle before anything
else, and no prior test modelled it.

## Settlement-source change

Live market rules now read: *"the maximum temperature recorded at New York City (CLINYC) ...
according to **The Weather Company**"*. The US venue settlement source is no longer the NWS CLI
product the earlier equivalence work assumed. The existing `DIVERGENCE_OBSERVED` finding stands
and is if anything now understated: the international source (Wunderground), the historical US
source (NWS CLI) and the *current* US source (The Weather Company) are three distinct sources.
Any historical US settlement replay built against NWS CLI is measuring a rule that is no longer
in force.

## Selection bias — applies to every wallet candidate

All of these wallets were selected *because* they were already known to be profitable. Their
historical economics are conditioned on success and are not an unbiased estimate of forward
expectancy. No wallet-derived candidate can be promoted on backward-looking wallet economics
alone, however well reconciled. This is orthogonal to the measurement errors above and is not
fixed by fixing them.

## Reproducibility

- `scripts/research-weather-wallet-cashflow-audit.mjs` — cash-ledger audit, writes
  `research-output/weather-wallet-cashflow-audit.{md,json}`
- `scripts/research-weather-basket-live-fee-floor.mjs` — live basket scan with the explicit
  fee-floor computation
