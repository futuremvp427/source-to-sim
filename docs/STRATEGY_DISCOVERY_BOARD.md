# Strategy Discovery Board — Polymarket 3.0, Non-Weather

Research-only. No orders, no Lovable, no live trading. `LIVE_EXECUTION_IMPLEMENTED=false`. `main` untouched. Weather-directional family is CLOSED (see `weather-us-translation-research` / `weather-hybrid-preflight` PROJECT_STATE.md) and not reopened here.

## Sources searched

- Official docs: `docs.polymarket.com/trading/fees` (live fetch, real formula: `fee = C x feeRate x p x (1-p)`, category rates 0.04-0.07, geopolitics fee-free), Gamma API live `feeType`/`makerBaseFee`/`takerBaseFee` fields (maker=0, confirmed on real markets).
- Kalshi: `api.elections.kalshi.com` series/markets/orderbook/candlesticks (live probes across Sports, Financials categories).
- GitHub: `kachence/polymm` (cloned and read, not just README — see audit below).
- ESPN hidden APIs: `sports.core.api.espn.com` odds endpoint (live, keyless, confirmed working), `site.api.espn.com` scoreboard/summary.
- The Odds API, Pinnacle public API status, GitHub historical odds datasets (`pwu97/bettingtools`, `slieb74/NFL-Betting-Data`).
- De-vig methodology: multiplicative/power/Shin, via industry writeups (`help.outlier.bet`, `betherosports.com`).
- Polymarket public leaderboards (sports, all-time profit).
- Existing Sports Shadow code (`src/lib/sports-shadow/kalshi.ts`, `source-poll.server.ts`) inspected read-only for confirmed Kalshi API mechanics (orderbook works unauthenticated; bids-only both sides, asks derived via complement; MLB series structure) — not modified, not imported.
- General web search for cross-venue arbitrage claims (mostly SEO/marketing content, treated as hypothesis-only per the task's own discipline, not evidence).

## Candidates discovered (all families A-J considered)

| # | Candidate | Mechanism | Data available? | Historical test possible? | Execution difficulty | Expected frequency | Expected capacity | Biggest risk | Confidence | Decision |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | A. Sportsbook fair-value vs prediction market | Sharp book aggregates info faster than thin PM | ESPN odds API is free/keyless but **snapshot-only, no historical time series** | **NO** (no free historical tick odds) | High (needs live polling) | Unknown, untestable now | Unknown | No backtest possible; only forward | Low | REJECT BEFORE TEST (backtest); live-only if ever pursued |
| 2 | B. Passive value / market making | Earn spread instead of paying it, filter by external fair value margin | Kalshi/Polymarket order-book + candle history available | Partial (candle-approximated fill simulation, not true queue position) | Medium | Continuous | Modest (thin books) | Adverse selection, fill model is approximate | Medium | TEST (bounded, PRICE-BACKTEST only) |
| 3 | C. Cross-venue price dislocation (Kalshi vs Polymarket US, same settlement) | Two distinct trader bases price the same low-ambiguity public fact differently | Both venues' live/recent quotes available; matched historical pairs are sparse | Partial (live/recent snapshot test; historical matched-pair depth is the limiting factor) | Medium-high (two-leg, must fill both) | Low-moderate, event-driven (Fed, macro, politics) | Modest, thin on both sides | Settlement-equivalence risk (learned from weather); leg risk | Medium | TEST (live-snapshot bounded test) |
| 4 | D. Sports info latency (score/state changes) | PM lags real-time game state vs Kalshi's own live markets | ESPN scoreboard is live-only; play-by-play history not confirmed timestamped at wall-clock resolution | Unclear/likely NO for historical | High | Unknown | Unknown | Same historical-reconstruction problem as A | Low | REJECT BEFORE TEST (for backtest); overlaps A's data gap |
| 5 | E. Sportsbook line-movement lead/lag | Sharp-book repricing precedes Kalshi/PMUS repricing | Same ESPN snapshot-only limitation as A | NO | High | Unknown | Unknown | No historical time series | Low | REJECT BEFORE TEST |
| 6 | F. Mutually exclusive/exhaustive-set arb (non-weather) | N-way exhaustive Kalshi ladder, buy-all-NO style | Full Kalshi orderbook access | Yes, but strong structural prior already established | Low (mechanical) | Low | N/A pending | Same quadratic-fee floor that killed the weather basket applies to ANY Kalshi ladder of similar width | High (that it fails) | REJECT BEFORE TEST (verified prior generalizes, see below) |
| 7 | G. Resolution/rule mispricing | Traders misread explicit settlement rules | Requires a concrete known case; systematic search is labor-intensive | Only case-by-case | Low per-case | Very low, structural | Case-dependent | No discovered concrete current case within session scope | Low (not because the idea is bad, but nothing concrete surfaced) | INCONCLUSIVE (flagged for a future targeted pass, not tested here) |
| 8 | H. Liquidity-shock mean reversion (single-venue microstructure) | Large sudden price move on thin order book temporarily overshoots, then reverts | Kalshi 1-minute candles across many non-weather markets | **YES** — genuine historical backtest, no forward-only limitation | Medium | Depends on shock-frequency, to be measured | Modest-meaningful, to be measured | Confusing genuine info (news) with pure liquidity noise | Medium-high | TEST (primary/most rigorous candidate) |
| 9 | I. Public-wallet mechanism mining (cash-ledger correct) | Identify a real mechanism from a genuinely profitable wallet | polymm's linked wallet `@b00k13` could not be resolved to an address via public unauthenticated endpoints within this session; Polymarket's public sports leaderboard tops out at $7-23M lifetime profit, too large-scale for a legible, copyable mechanism | Partial / inconclusive | N/A | N/A | N/A | Address resolution and mechanism legibility at that scale | Low (documented limitation, not a negative finding about the category) | INCONCLUSIVE (see write-up below; not a full test) |
| 10 | J. polymm mechanism itself (sportsbook devig -> passive quote -> hedge-or-residual) | As A/B combined, specifically as previously (claimed) implemented | Requires the SAME sportsbook historical time series as A -- not available free | NO for backtest | High | Unknown | Unknown | Repo author's own README: "mostly stopped being profitable," scraping pipeline not included, verification tool uses the already-proven-broken `/closed-positions` endpoint | Low | REJECT BEFORE TEST (fully audited, see below) |

## Kill-screen detail

**A, D, E killed together** on the same root cause: no free, keyless, historically-queryable sportsbook odds or play-by-play time series exists. ESPN's hidden odds API is real and works (confirmed live, no key, ~150ms latency, open/close/current fields) but is a snapshot of the CURRENT state only — there is no endpoint for "odds as of arbitrary past timestamp T." The Odds API's free tier requires signup and a key (500 credits/month, historical calls cost 10x); Pinnacle's public API has been closed since July 2025. GitHub datasets exist but are season-level open/close, not the fine time series a latency test needs. This is a genuine, verified data-availability kill, not a judgment call — reconstructing decision timestamps without lookahead is explicitly required by this mission and is not possible here for free.

**F killed on a verified structural prior, checked (not assumed) before rejecting.** The weather all-NO-basket work already established, with a real formula, that Kalshi's quadratic taker fee (`ceil(0.07 x P x (1-P) x N x 100)/100`, rounded up per fill) costs roughly $4.92-5.00 per $500 notional on a six-leg basket -- i.e., the fee alone consumes essentially the entire theoretical arb margin on any N-way exhaustive Kalshi ladder priced near fair value, regardless of category. This is a property of the fee schedule and the ladder structure, not of weather specifically. Spot-checked against a live non-weather multi-leg Kalshi ladder (Fed rate threshold series) before rejecting: displayed sum-of-asks was within the same tight band relative to the fee floor as the weather case. Not re-run as a full new backtest given the already-decisive prior evidence and the mission's own instruction to prefer minimal tests.

**J (polymm) killed after a full code audit, not from the README alone.** Cloned and read the actual source (commit `f598cf8`). Findings: de-vig is the crudest standard method (multiplicative/proportional only; a `method="shin"` parameter is documented in the code's own comments as having silently done nothing, i.e. fallen through to proportional); the odds source (`the-odds-api.com`) requires a paid key; no fee model exists anywhere in the code; execution logic targets Polymarket only (no Kalshi anywhere in the codebase); and -- most importantly -- the repo's own analytics/verification tool computes P&L from Polymarket's `/positions` and `/closed-positions` endpoints, the exact survivorship-filtered endpoint independently proven broken in the weather wallet-cashflow audit earlier this project. The author's own README states the bot "mostly stopped being profitable" once it "got too slow to defend its edge," and explicitly says the private scraping pipeline that was "half the edge" is not included in the public repo. The claimed Jan-Apr 2026 figures (net ~+$4,973) cannot be reproduced from anything committed to the repo and must be treated as unverified marketing, not evidence -- consistent with a README figure of "about $5k net" for the linked wallet, which is at least internally consistent with the task's cited number, but still unverified via cash-ledger.

**I (wallet mining) is a documented incomplete lead, not a rejection of the category.** `@b00k13` (the polymm-linked handle) could not be resolved to a `0x...` address via any public, unauthenticated Polymarket API tried in this session (profile search, public-search, direct profile-page scrape). The public sports leaderboard's top entries are $7M-$23M lifetime profit -- almost certainly large funds/teams, not a legible, retail-scale, copyable mechanism, and using them would repeat the exact "wallet profitability is not evidence copying works" mistake this project has already been warned against twice. This is reported as an honest gap, not papered over.

**G (resolution/rule mispricing) deprioritized, not rejected.** No concrete current case surfaced during this session's research pass. The category is plausible (the mission brief itself flags it as potentially "lower frequency but large edge") but testing it requires a specific discovered instance, which needs either a dedicated news/dispute-tracking search pass or waiting for a live occurrence. Recorded as `INCONCLUSIVE` rather than force-fit into a test.

## Shortlist (3 candidates, preregistered before any result was viewed)

### Shortlist 1 — H. Liquidity-shock mean reversion

- **HYPOTHESIS:** A sudden large 1-minute price move on a thin Kalshi order book overshoots fair value and partially reverts over the following minutes, because the move was driven by a liquidity-taking trade rather than new information.
- **ENTRY RULE:** A 1-minute candle whose |close-to-close price change| exceeds a fixed, preregistered threshold (>=8 cents) with the move NOT continuing in the same direction on the immediately following candle close (a simple, mechanical "no immediate continuation" filter, not curve-fit). Enter counter to the shock's direction (fade it) at the next available quote.
- **EXIT RULE:** Fixed horizons after entry: 5/15/30/45/60 minutes, priced against the real historical bid.
- **DATA:** Kalshi 1-minute candlesticks (`orderbook`-consistent `yes_bid`/`yes_ask` closes), across a broad non-weather sample: Politics, Financials, Sports, Economics series with sufficient historical volume.
- **TIME WINDOW:** Most recent 45 days of settled/closed markets across the sampled series (bounded by candle-fetch volume for a minimal test).
- **INDEPENDENT SAMPLE UNIT:** One shock event per market-ticker per calendar day (not per candle) -- multiple qualifying shocks on the same ticker/day are NOT counted as independent.
- **PRIMARY METRIC:** Net P/L and profit factor at the pre-registered key stress cell.
- **STRESS TEST:** 0/1/5/15-minute detection delay x BASE/+1c/+2c/+3c adverse execution, fees both legs (Kalshi quadratic model, verified formula, not the previously-corrected wrong cheap-tail assumption).
- **PASS GATE:** >=50 independent shock events, positive P/L and PF>=1.3 at +5m delay/+1c adverse, survives top-5% winner removal, not dominated by one market/category.
- **FAIL GATE:** Negative at +5m/+1c, PF<1.3, or outlier-dependent => REJECTED. <50 events => DATA_INSUFFICIENT.

### Shortlist 2 — B. Passive maker value (PRICE-BACKTEST only, explicitly not an execution proof)

- **HYPOTHESIS:** Resting one tick inside the historical best bid/ask, only when an internally-consistent fair-value proxy (the volume-weighted mid over the prior N minutes) implies a margin above the fee-adjusted breakeven, would have realized a positive markout on average.
- **ENTRY RULE:** Simulated resting order at best-bid+1 tick (buying) whenever the trailing fair-value proxy exceeds the resting price by a fixed preregistered margin (>=3 cents). "Filled" is approximated as: the next candle's low/close crosses the resting price (a conservative, explicitly-labeled proxy, not a queue-position-aware fill model).
- **EXIT RULE:** Markout measured at fixed horizons (5/15/30/60 minutes) against the real subsequent mid.
- **DATA:** Same Kalshi candle sample as H.
- **TIME WINDOW:** Same 45-day window.
- **INDEPENDENT SAMPLE UNIT:** One simulated resting-order opportunity per market-ticker per day.
- **PRIMARY METRIC:** Realized markout net of maker fee (Kalshi makers pay a reduced/negotiated rate; Polymarket makers pay zero per official docs -- use the correct, currently-documented rate, not an assumption).
- **STRESS TEST:** Same delay/adverse grid, PLUS an explicit fill-probability sensitivity (fill assumed at 100%, then 50%, then 25% of the naive-touch rate) since the true queue-aware fill rate cannot be reconstructed from candle data alone.
- **PASS GATE:** Same as H, but ADDITIONALLY: must remain plausible (not obviously wrong) under the 50% fill-probability haircut. This strategy is capped at PRICE-BACKTEST evidence and can be promoted at most to `PROMISING_FOR_FURTHER_BACKTEST` (never `PROMISING_FOR_FORWARD_PAPER`) without a real execution-proof pass first.
- **FAIL GATE:** Same as H.

### Shortlist 3 — C. Cross-venue price dislocation (Kalshi vs Polymarket US)

- **HYPOTHESIS:** For the same low-settlement-ambiguity public fact (Fed rate decisions, confirmed macro/political events), Kalshi and Polymarket US price it differently often enough, and by enough, to survive fees and realistic execution on both legs.
- **ENTRY RULE:** A live/recent snapshot scan finds a matched event pair (verified same underlying fact, NOT same title alone -- learned from the weather settlement-divergence lesson) where the implied probabilities differ by more than the combined round-trip fee+spread cost on both legs.
- **EXIT RULE:** N/A for the locked-arb case (hold both legs to settlement); for the directional-residual case (one leg only fills), same short-horizon exit grid as H.
- **DATA:** Live Kalshi and Polymarket-US order books/quotes; matched historical pairs are explicitly expected to be sparse.
- **TIME WINDOW:** This is declared a LIVE-SNAPSHOT test, not a historical backtest, because sufficient matched-pair historical quote depth across both venues was not established as available within this session -- stated explicitly rather than silently assumed away.
- **INDEPENDENT SAMPLE UNIT:** One matched event pair.
- **PRIMARY METRIC:** Number of genuinely matched pairs found, and whether any surviving gap clears round-trip cost after fees on both venues.
- **STRESS TEST:** Fee+spread on both legs, using each venue's own current, verified fee schedule.
- **PASS GATE:** At least one genuinely matched, fee-surviving, both-legs-executable pair found in the live scan => `PROMISING_FOR_FURTHER_BACKTEST` (a live snapshot alone cannot support a stronger classification). Zero => `REJECTED` or `DATA_INSUFFICIENT` depending on whether matched pairs existed at all.
- **FAIL GATE:** No genuinely matched pairs found, or all found gaps are smaller than round-trip cost.

None of these were tuned after being written. Results follow in a separate section once the scripts have run.
