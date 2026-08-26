# Claude Strategy Handoff — Polymarket 3.0 Weather Research

This is the current research handoff for an independent Claude Code review. Treat all conclusions as hypotheses to challenge, not instructions to agree.

## Scope and hard rules

Repository: `futuremvp427/source-to-sim`

Research branch: `weather-us-translation-research`

Production/main is intentionally untouched by this research. Do not merge or deploy while auditing strategy evidence.

Hard constraints:

- research/paper only;
- no real-money orders;
- keep `LIVE_EXECUTION_IMPLEMENTED=false`;
- do not modify Sports Shadow production behavior;
- do not use the already-consumed OOS periods to retune failed strategies;
- do not treat international Polymarket contracts as settlement-equivalent to U.S. contracts;
- do not treat public endpoint `realizedPnl` reconstruction as audited cash accounting;
- do not optimize win rate without expected-value/execution analysis.

Read before doing new work:

1. `PROJECT_STATE.md`
2. `docs/WEATHER_CANDIDATE_BACKEND_STRESS.md`
3. `docs/OVERNIGHT_STRATEGY_RESEARCH.md`
4. `docs/WEATHER_STRATEGY_FALSIFICATION.md`
5. `docs/WEATHER_TRANSLATION_HISTORICAL_EVIDENCE.md`

## Strategies already falsified/frozen

### Exact international-weather -> U.S. copy

Failed settlement-equivalence test. Real KSFO counterexample: source 68-69 F contract resolved YES while NWS CLISFO max was 70 F, which would make a U.S.-style 68-69 bucket NO. Do not restore blind copy logic.

### Dead-bucket same-day lag

180/180 candidate dead buckets were directionally correct, but inferred executable NO asks were already 96-100c. Correctness did not create useful edge. Frozen.

### Late-day max-stagnation

No preregistered training rule achieved the requested combination of trade count, >=75% wins, and positive after-fee P/L. OOS not entered. Frozen.

### Simple previous-day NBM-vs-Kalshi

TRAIN: 20 trades, 18 wins, 90%, +$325.27, +22.1% ROI.

Untouched OOS: 10 trades, 7 wins, 70%, -$39.83, -5.4% ROI.

Failed OOS. Do not retune against the same OOS.

## Deep backend pass — strongest current evidence

Full report: `docs/WEATHER_CANDIDATE_BACKEND_STRESS.md`.

### Candidate A — Maskache2-inspired U.S.-specific 20-90c value model

**Current classification: PROMISING RESEARCH PRIOR, NOT A COPY STRATEGY.**

240-day public closed-position stress:

- 760 high-temperature events;
- 76.1% event-positive;
- +$175,574.88 diagnostic endpoint P/L;
- 39.2% proxy ROI;
- PF 4.13x;
- max DD -$8,808.27;
- 6/8 positive months;
- 95% bootstrap event-positive interval 73.0%-79.1%;
- first half 76.3% / +$43,244.65 / PF 4.19x;
- second half 75.8% / +$132,330.23 / PF 4.11x;
- after deleting largest 5% winning events, +$39,405.71 remains.

Most useful price regimes:

- 20-55c: 322 events, 75.5% event-positive, +$87,480.78 diagnostic P/L;
- 55-90c: 155 events, 99.4% event-positive, +$80,400.87;
- >=90c: 91 events, 97.8% event-positive but **-$5,227.95**.

This >=90c failure is important. A very high win rate can still be economically bad.

Five-U.S.-city source subset:

- 166 events, 72.3% event-positive;
- +$27,160.51 diagnostic P/L;
- 23.6% proxy ROI;
- PF 2.49x.

By city:

- NYC: 120 events, 71.7%, +$24,215.12, 28.6% proxy ROI, PF 2.74x;
- SF: 13 events, 84.6%, positive but too small;
- Miami: 11 events, 54.5%, **negative**;
- Chicago: 12 events, 66.7%, small positive;
- LA: 10 events, 90%, positive but too small.

**Primary hypothesis to challenge:** the transferable mechanism may be a two-regime U.S.-specific probability/value strategy — 20-55c value and 55-90c high-confidence — rather than copying Maskache2. Use source-wallet behavior only as a covariate/trigger. Independently price the exact U.S. settlement contract.

Questions Claude must answer:

1. Is the apparent edge forecast skill, DCA/exit management, correlated multi-bucket portfolio construction, liquidity provision, or an endpoint-accounting artifact?
2. Does 20-55c remain strong after exact lifecycle cash-flow reconstruction?
3. Does 55-90c retain its unusually high hit rate after correcting for event correlation, exits, selection timing, and target execution?
4. Why does >=90c lose money despite ~98% event-positive? Is this tiny-win/rare-large-loss structure, exit accounting, or another mechanism?
5. Does NYC remain the strongest station-specific prior when exact entry-state/weather features are reconstructed?

### Candidate B — BeefSlayer-inspired segmented/barbell value

**Classification: PROMISING FALLBACK.**

240-day stability slice:

- 466 events;
- 54.7% event-positive;
- +$38,999.46 diagnostic P/L;
- 27.7% proxy ROI;
- PF 2.37x;
- max DD -$13,461.21;
- 6/8 positive months;
- after removing largest 5% winners: +$5,551.57;
- first half 61.3%, +$31,285.70, PF 5.63x;
- second half 47.9%, +$7,713.76, PF 1.36x.

Price clues:

- <5c positive but low hit rate;
- 5-10c negative;
- 10-20c positive;
- 20-55c positive;
- **55-90c: 94.5% event-positive, about +$25.4k diagnostic P/L, PF 11.26x**;
- >=90c high hit rate but weak economics.

Five-U.S.-city source subset:

- 376 of 809 all events = 46.5%;
- 63.3% event-positive;
- +$27,975.14 diagnostic P/L;
- 14.0% proxy ROI;
- PF 2.70x.

This is the most U.S.-city-heavy leading wallet prior, but recent weakening is a real warning.

Claude should separate at least two mechanisms: high-confidence 55-90c and cheap-tail asymmetry. Do not mix them into one score.

### Candidate C — Exhaustive mutually-exclusive NO basket

**Classification: INCONCLUSIVE / MICROSTRUCTURE WATCH, NOT CURRENT TAKER STRATEGY.**

Historical five-city test:

- 125 events, 25/city;
- 120/125 had some positive displayed 1-minute BBO basket;
- 106/125 remained positive with +1c on every leg;
- 80/125 with +2c/leg;
- 67/125 with +3c/leg;
- best displayed +$3.69 per 100-contract/leg basket;
- best +2c +$1.44;
- best +3c +$0.38.

But repeated prospective live-depth testing is materially negative:

- five read-only scans 30 seconds apart;
- only five complete-depth snapshots across one current event;
- zero profitable complete baskets at every tested size;
- best 1/leg -$0.14;
- best 10/leg -$1.16;
- best 25/leg -$3.12;
- best 100/leg -$16.76;
- other events frequently lacked one required leg.

Current sequential leg-risk scan:

- only SF complete at that instant;
- `collateral_return_type=MECNET`;
- full basket negative at every size;
- 100/leg full guaranteed P/L -$20.54;
- minimum optimized worst prefix risk $77.12.

Conclusion to independently challenge: historical one-minute BBO appears to contain transient/intra-minute or non-depth-backed apparent arb. Collateral return improves capital efficiency but does not create positive economics. A passive-maker version may still be worth a small research test, but no taker execution engine should be built from current evidence.

### Candidate D — <=10c cheap-tail asymmetric probability strategy

**Classification: INCONCLUSIVE / SAMPLE FAIL.**

Corrected Kalshi historical routing produced 640 forecast+quote rows across 240 station-days, May 1-July 19.

Frozen TRAIN rule:

- NBM probability >=20%;
- model edge >=15 points;
- YES ask <=10c.

TRAIN:

- 21 trades;
- 14.3% wins;
- +$154.01;
- 105.5% research ROI;
- max DD -$45.81.

OOS Jul 1-19:

- +0c: 6 trades, 16.7% wins, +$56.31;
- +1c: 6 trades, +$49.94;
- +2c: 3 trades, 33.3% wins, +$73.38;
- +3c: 2 trades, +$81.90.

Gate required >=10 OOS trades and positive +2c P/L. **FAIL due sample count.** This is not a high-win-rate strategy and cannot be promoted. If revisited, use a richer ensemble and a new untouched holdout.

### ColdMath — important negative control

Do not recommend wholesale copying merely because its event-positive rate is high.

240-day stress:

- 2,197 events;
- 81.7% event-positive;
- +$111,782.67 diagnostic P/L;
- only 2/8 positive months;
- max DD -$94,334.16;
- first half +$143,710.45;
- second half **-$31,927.78**;
- after deleting top 5% winners: **-$52,230.51**.

This is a strong demonstration that high hit rate can conceal an unstable or tail-dependent strategy.

## Exact reproducibility artifacts

Scripts:

- `scripts/research-weather-wallet-stability.mjs`
- `scripts/research-weather-wallet-us-transfer.mjs`
- `scripts/research-weather-basket-stress.mjs`
- `scripts/research-weather-basket-prospective.mjs`
- `scripts/research-weather-basket-leg-risk.mjs`
- `scripts/research-weather-cheap-value.mjs`
- prior scripts: `research-weather-wallets.mjs`, `research-weather-nbm.mjs`, `research-weather-lag.mjs`, `research-weather-late-day.mjs`, `research-weather-basket-arb.mjs`, `research-weather-closed-positions.mjs`.

Workflows:

- `.github/workflows/weather-candidate-backend.yml`
- `.github/workflows/weather-wallet-transfer.yml`
- `.github/workflows/weather-basket-leg-risk.yml`
- `.github/workflows/weather-lag-research.yml`
- `.github/workflows/weather-fast-research.yml`

Key workflow runs:

- **32959085859** — comprehensive backend candidate pass; all four candidate jobs SUCCESS.
- **32959222539** — five-U.S.-city wallet subset, SUCCESS.
- **32959356012** — current basket sequential leg-risk, SUCCESS.
- **32927555964** — earlier NBM strategy OOS failure.
- **32928556191** — initial public-wallet archetype reverse engineering.

## What Claude should do next

Do not begin by building a bot. Begin by trying to disprove Candidate A.

Recommended order:

1. **Full lifecycle reconstruction for Maskache2 and BeefSlayer.** Reconcile BUY, DCA, SELL, redemption/settlement and all same-event bucket exposures. Determine whether endpoint event P/L survives actual cash-flow reconstruction.
2. **Entry-state reconstruction.** At each qualifying first entry, rebuild weather/model state available at that timestamp, market spread/depth, and whether the wallet was maker/taker where observable.
3. **Separate price regimes before modeling.** Maskache2 20-55c and 55-90c are separate hypotheses. BeefSlayer cheap-tail and 55-90c are separate hypotheses. Do not combine them and then optimize a single threshold.
4. **Build an exact U.S.-settlement probability engine.** It should use the target venue's exact station/source/window. Consider NBM, HRRR, GFS/GEFS, station-specific bias, METAR/current max, temperature trend, dew point, cloud/wind/precipitation and model revisions. Use only information available at decision time.
5. **Use wallet behavior as a feature, not a blind order.** Test whether a wallet signal adds incremental predictive value beyond the U.S.-specific model and market price.
6. **Fresh OOS / forward paper only.** Any materially new strategy gets a genuinely unused holdout. Do not reuse the failed NBM OOS to tune it.
7. **Execution realism.** Require actual target bid/ask, depth, fees, slippage, partial-fill behavior, latency, capacity and rule/source verification.
8. **Keep the NO-basket scanner separate.** Investigate passive maker quotes or repeated prospective anomalies only if the data supports them. Current taker evidence is negative.

## Required independent verdict

Claude should return, for each candidate:

- `REJECTED`, `INCONCLUSIVE`, `PROMISING`, or `READY_FOR_FORWARD_PAPER_TEST`;
- exact mechanism;
- independent sample count;
- TRAIN/validation/OOS split;
- win rate with confidence interval;
- P/L, ROI, PF, drawdown, worst event;
- concentration and regime dependence;
- target-market execution assumptions;
- settlement/rule risks;
- capacity/opportunity frequency;
- every material way the apparent edge could disappear.

Explicitly state where Claude disagrees with this handoff. The purpose is falsification, not consensus.

No strategy in this document is approved for live trading.

---

# Claude's independent verdict (appended, does not edit the record above)

Full evidence: `docs/WEATHER_CLAUDE_INDEPENDENT_AUDIT.md`.

The handoff above asked for falsification rather than consensus. The measurement
underpinning its own ranking did not survive.

## The decisive objection

Every wallet ranking above rests on `sum(/closed-positions.realizedPnl)`. That endpoint
only reports positions that actually **closed**. A wallet that abandons worthless losing
tokens rather than redeeming them never files those events, so the endpoint returns a
survivorship-filtered view.

This document already contains the evidence that the method is unsafe — `badatmath` was
quarantined precisely because its endpoint total would not reconcile against public
leaderboard profit. The conclusion was applied to one wallet and not to the others.

Rebuilding the same wallets from the `/activity` cash ledger:

| Wallet | Reported events | Reported P/L | Reported win | TRUE events | TRUE P/L | TRUE win | Missing events | Hidden P/L |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Maskache2 | 760 | +$199,479 | 72.2% | 1,325 | **+$62,168** | **32.6%** | 565 (42.6%) | -$61,665 |
| BeefSlayer | 809 | +$56,784 | 58.7% | 692 | **+$63,242** | **58.2%** | 13 (1.9%) | -$615 |
| ColdMath | 2,433 | +$103,028 | 75.9% | 2,370 | **+$105,718** | **80.2%** | 79 (3.3%) | -$2,004 |

## Where Claude disagrees

1. **Candidate A is rejected, not promising.** Maskache2's whole lifetime net cash is
   +$44,205. The claim of +$175,574.88 on weather alone is impossible against its own
   ledger. Its NYC 20–55c headline cell is 36 events / 50.0% / +$3,125 / 7.8% ROI, not
   52 / 78.8% / +$15,723 / 44.0%, and its halves run +$3,175 then -$50.
2. **Candidate B is the strongest candidate, not the fallback.** BeefSlayer redeems, so
   its ledger reconciles, and the endpoint *understates* it by ~18%.
3. **The ColdMath demotion is wrong on the numbers.** True ledger: 8/9 positive months
   (not 2/8), max DD -$3,619 (not -$94,334), second half +$23,021 (not -$31,928),
   +$29,923 after removing top 5% winners (not -$52,230). The instability was
   `realizedPnl` noise. The real objection is different: the wallet stopped trading
   (707 → 284 → 102 → 2 → 14 monthly events; last activity 2026-08-19).

## Where Claude agrees

- The NO basket is not executable, and the basket *structure* assumption was correct
  (6 exhaustive legs, `mutually_exclusive: true`, MECNET verified live). An initial
  suspicion that overlapping threshold markets contaminated it was checked and is wrong.
- Every previously frozen strategy stays frozen. None were retuned.
- High win rate is not edge; `>=90c` remains economically bad on the true ledger too.
- International contracts are not settlement-equivalent to US contracts.

## What the handoff missed

- **The fee floor.** Kalshi taker fee `ceil(0.07·P·(1−P)·C·100)/100` costs ~$4.92 per
  100-contract six-leg basket, so the basket profits only if the six best NO asks sum to
  ≤ $4.9508. Observed sums were $5.00–$5.13. The basket is foreclosed structurally, not
  merely unobserved.
- **The same fee crushes cheap tails.** Rounded up per contract, it is $0.01 at P=0.05 —
  20% of premium, ~12% at BeefSlayer's median 8.2c entry. BeefSlayer earned its edge on
  international contracts with no such charge. No prior cheap-tail test modelled this.
- **BeefSlayer's actual mechanism.** 68.6% of first entries land 12–24h after 00Z of the
  target date; only 6.1% precede the weather date. It is intraday information reaction on
  cheap tails — a different mechanism from every forecast-first hypothesis this project
  has tested and failed.
- **Settlement source changed again.** Live rules now cite *The Weather Company*, not NWS
  CLI. Three distinct sources are now in play, so any US replay built on NWS CLI measures
  a rule no longer in force.
- **Selection bias survives the fix.** These wallets were chosen because they were already
  profitable. Correcting the measurement does not make backward-looking wallet economics
  an unbiased forward estimate.
