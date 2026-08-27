# Pre-Build GO/NO-GO Feasibility Audit — Automated Day-Trading Bot

**Audit date:** 2026-08-27
**Jurisdiction assumed:** New York State retail individual
**Scope:** Pre-implementation feasibility only. No code was written. No orders were placed. No account was opened. No paid data or service was purchased or recommended.
**Status of this document:** Independent audit for second-pass comparison against a prior ChatGPT assessment.

---

## 0. RESEARCH INTEGRITY DISCLOSURE — READ FIRST

This audit was conducted from a sandboxed environment with an outbound network egress allowlist. The following domains were **blocked and could not be read directly**:

`docs.cdp.coinbase.com` · `www.coinbase.com` · `help.coinbase.com` · `api.coinbase.com` · `api.exchange.coinbase.com` · `docs.alpaca.markets` · `nautilustrader.io` · `developer.schwab.com` · `www.schwab.com` · `schwab-py.readthedocs.io` · `www.finra.org` · `www.sec.gov` · `www.okx.com` · `reddit.com` · `web.archive.org`

**What I did instead, and why it is in most cases *stronger* evidence:**

| Need | Substitute primary source used |
| --- | --- |
| Coinbase Advanced Trade API behavior | NautilusTrader's Coinbase adapter **source code and integration guide**, read from the repository at commit `f2b2add` (2026-08-27) |
| Alpaca paper-trading semantics | Alpaca's **own docs repository** on GitHub (`alpacahq/alpaca-docs`) |
| Schwab OAuth token lifetimes | `schwab-py` **library documentation source** (`docs/auth.rst`) |
| LEAN/QuantConnect gating | QuantConnect's **own documentation repository** (`QuantConnect/Documentation`, cloned 2026-08-27) |
| Freqtrade exchange support | Freqtrade **README on `develop`** |
| Framework maintenance | **PyPI release metadata** queried directly |

**What I could NOT do, and you must not assume I did:**

1. **Reddit and community forums were inaccessible.** The task asked for Reddit-sourced anecdotal evidence of undocumented operational problems. I could not retrieve any. I have substituted GitHub issues (which serve the same "undocumented operational problems" function) and labeled them accordingly. **I have not invented community reports.** Where this audit says "community evidence," it means GitHub issues or vendor forums reached via search-result summaries, not Reddit.
2. **Two legal/contractual questions could not be verified against primary text** (Coinbase Market Data Terms; Coinbase futures NY eligibility). Both are listed as UNKNOWNS with explicit user action items. One of them is potentially project-ending. See §5.
3. **Regulatory claims rest on secondary sources** (law-firm client alerts, broker knowledge bases) because `finra.org` and `sec.gov` were blocked. These are flagged.

Search-engine result *summaries* are treated throughout as weaker than fetched documents, and weaker still than source code. Where a search summary conflicted with source code, **the source code wins** — this happened at least once and is documented in §7.

---

## 1. EXECUTIVE CONCLUSION

**The infrastructure question and the economic question have opposite answers, and the economic one is the one that matters.**

A New York resident can, at genuinely $0 marginal cost, build a technically sound, deterministic, reproducible crypto research and shadow-execution environment on **Coinbase Advanced Trade + NautilusTrader**. Free public real-time L2 order book, trades, and ticker data are available over an unauthenticated WebSocket. NautilusTrader ships a *stable-labelled* Coinbase Advanced Trade adapter and a sandbox environment that runs **live market data through the same simulated matching engine used in backtesting** — which is precisely the shadow-execution architecture required. Queue-position tracking, latency modeling, fee models, partial fills, and deterministic replay all exist and are documented. This part checks out. Several of ChatGPT's claims in this area are correct.

**However, three findings materially change the picture, and two of them appear to have been missed entirely:**

**(1) The fee structure is the dominant risk, and it is not a technical problem you can engineer around.** Coinbase Advanced Trade's base tier is **0.60% taker / 0.40% maker**. A maker-in/maker-out round trip costs ~0.80%; a taker/taker round trip costs ~1.20%. Tier improvement requires $50,000+ in trailing 30-day volume. For an intraday strategy, the required gross edge per round trip to break even is roughly **3–10× a plausible retail intraday edge**. No amount of infrastructure quality fixes this. This is the number that should govern the go/no-go decision, and it must be established *before* a single line of strategy code is written.

**(2) Free Coinbase history is bar-only, and the NautilusTrader adapter cannot request historical trades at all.** I read the adapter's `request_trades` implementation directly: it calls the venue's *snapshot* market-trades endpoint and **silently ignores the `start` and `end` parameters** — they are echoed back in the response envelope but never sent to the venue. There is no historical trade pagination, no historical quote archive, and no historical order-book archive on the free path. What remains is 1-minute OHLCV, capped at 350 candles per request, and Coinbase's own documentation states this data **"may be incomplete"** with **no candle published for intervals containing no ticks**. NautilusTrader's own backtesting documentation states plainly that bar data *"cannot establish intrabar price order, spread, depth, or queue position, so execution-sensitive strategies need more granular validation."* **The engine's queue-position and spread machinery therefore cannot be fed from free Coinbase history — only from data you record forward yourself.** That is free in dollars but expensive in calendar time (weeks-to-months before a usable dataset exists). ChatGPT's claim that free Coinbase history is sufficient for meaningful intraday testing is **half true at best** and needs the qualification above.

**(3) A silent zero-fee trap exists in the exact tool being proposed.** NautilusTrader's default backtest fee model is `MakerTakerFeeModel`, which multiplies notional by `instrument.maker_fee()` / `instrument.taker_fee()`. The Coinbase adapter **does not populate those fields** — the instrument parser contains the literal comment `// maker_fee (loaded separately via transaction_summary)`, and the `get_transaction_summary()` REST method, while it exists on the HTTP client, is never called by the instrument provider. Both fields therefore default to `Decimal::default()` = **0**. A first-run Coinbase backtest or sandbox session in NautilusTrader **applies exactly zero commission unless the user explicitly overrides the instrument fees.** Given the 0.60%/0.40% reality, a naive first backtest would be wildly optimistic in precisely the way this project was chartered to avoid. This is fixable in configuration, but it is a silent trap and it directly threatens the stated requirement "fees from the FIRST backtest."

**On the equities routes:** all three fail the constraints for different reasons. **Schwab** is not viable for unattended operation — its refresh token is hard-capped at seven days with no programmatic renewal path, forcing a manual browser OAuth login every week, and there is no API paper-trading environment. **IBKR** requires paid market-data subscriptions for real-time API data; free delayed data is L1-only with no tick-by-tick and no depth. **Alpaca** offers free real-time data from IEX only (~2.5% of consolidated volume) with the consolidated SIP feed behind $99/month — and Alpaca **crypto** is unavailable to New York residents specifically.

**Freqtrade fails outright for a New York resident.** Not one of its twelve officially supported spot exchanges is lawfully available to a NY retail customer. Coinbase is not on Freqtrade's officially supported list at all.

**LEAN fails the cost constraint** in its supported form: QuantConnect's own documentation states that using the LEAN CLI — **including local backtesting** — requires membership in an organization on a **paid tier**.

**Recommendation: (B) PROCEED ONLY TO PHASE 0 FEASIBILITY TESTS**, restricted to Coinbase Advanced Trade + NautilusTrader, and **gated on an economic viability calculation performed before any Phase 0 engineering begins** (Test P0-0, §10). If that gate fails — and it plausibly will at retail account size — the correct answer becomes **(A) NO BUILD**, and it will have cost nothing to find out.

---

## 2. CANDIDATE COMPARISON TABLE

| | **A. Coinbase Advanced + NautilusTrader** | **B. Schwab Trader API** | **C. Alpaca (control)** | **D. IBKR (control)** | **E. Freqtrade** |
| --- | --- | --- | --- | --- | --- |
| **NY retail eligible** | ✅ Yes — Coinbase holds NYDFS BitLicense + trust charter | ✅ Yes | ✅ Equities yes / ❌ **crypto not offered in NY** | ✅ Yes | ❌ **No supported exchange serves NY** |
| **Free real-time data** | ✅ Public unauthenticated WS: L2, trades, ticker | ⚠️ Bundled w/ brokerage acct; agreement terms unverified | ⚠️ IEX only (~2.5% volume); SIP = $99/mo | ❌ Paid subscriptions required | ❌ N/A (no usable venue) |
| **Free historical depth** | ⚠️ 1m OHLCV only, 350/req, documented incomplete. **No historical trades/quotes/book** | ⚠️ Candles + price history; unverified limits | ⚠️ 6+ yrs, but 15-min delayed on free tier | ❌ Requires subscription | ❌ N/A |
| **L2 order book** | ✅ Free, `level2` channel, no auth | ❌ Not for equities via this API | ❌ Not on free tier | ❌ Not on delayed data | ❌ N/A |
| **Order API** | ✅ Market/Limit/Stop-Limit, post-only, GTC/GTD/IOC/FOK, batch cancel | ✅ Equities + options | ✅ Full incl. bracket/OCO | ✅ Full | ❌ N/A |
| **True paper env** | ❌ Sandbox is static mock | ❌ **None** | ✅ Real-time simulated | ✅ Paper account | ❌ N/A |
| **Live-data + sim-execution shadow** | ✅ **NautilusTrader sandbox adapter** | ❌ Would be custom | ⚠️ Alpaca paper (limited fidelity) | ⚠️ IB paper | ❌ N/A |
| **Unattended auth** | ✅ ES256 JWT, 120s, auto-regenerated, no manual step | ❌ **7-day refresh token, manual browser OAuth** | ✅ Static API keys | ⚠️ Gateway/TWS session mgmt | ❌ N/A |
| **Mature engine adapter** | ✅ Stable-labelled, but **only ~4 months old** (first shipped 1.226.0, 2026-04-29) | ❌ **No NautilusTrader adapter** | ❌ **No NautilusTrader adapter** | ✅ Stable IB adapter | ⚠️ CCXT, but no venue |
| **Round-trip cost** | ❌ **~0.80% maker/maker, ~1.20% taker/taker at base tier** | ✅ $0 commission equities | ✅ $0 commission equities | ✅ Low, tiered | — |
| **Marginal $ cost to research** | ✅ **$0** | ✅ $0 | ✅ $0 (degraded data) | ❌ >$0 | — |
| **VERDICT** | **PASS (Phase 0 only, economically gated)** | **FAIL** (unattended) | **FAIL** (free data inadequate; NY crypto) | **FAIL** (paid data mandatory) | **FAIL** (NY jurisdiction) |

---

## 3. HARD BLOCKERS

Each of these is, on current evidence, disqualifying for the route named.

### HB-1 — Freqtrade: no officially supported exchange is lawfully available to a New York resident. *(Route E — FAIL)*

Freqtrade's `README.md` on `develop` lists its officially supported **spot** exchanges as: Binance, BingX, Bitget, Bybit EU, Bybit, Gate EU, Gate, HTX, Hyperliquid, Kraken, MyOKX (OKX EEA), OKX. Community-tested: Bitvavo, Kucoin.

**Coinbase does not appear on the list at all.** Checking each against NY:

| Exchange | NY retail availability |
| --- | --- |
| Binance / Binance.US | ❌ Binance.com blocks US persons. Binance.US does not operate in New York — no BitLicense/NYDFS approval. |
| Bybit / Bybit EU | ❌ Bybit restricts the **entire United States** at country level. |
| OKX / MyOKX | ❌ **OKX Inc. explicitly does not provide services to residents of New York** (also TX, American Samoa, Guam, N. Mariana Islands, USVI) — restriction updated 2026-02-24. |
| Kraken | ❌ Withdrew from NY in Aug 2015 rather than apply for a BitLicense; still holds no BitLicense or NY trust charter as of 2026. |
| Bitget, HTX, Gate, BingX | ❌ Not NYDFS-licensed; do not serve US/NY retail. |
| Hyperliquid | ❌ DEX; geoblocks US persons. |

The `README` footnote *"potentially many others (we cannot guarantee they will work)"* — i.e. running Coinbase through raw CCXT under Freqtrade — is explicitly unsupported by the maintainers and would place the project on an untested integration path with no guarantee of correctness. That is the opposite of the stated preference for a mature engine.

**Freqtrade is a dead end for this user. Do not spend further time on it.**
Sources: [Freqtrade README](https://github.com/freqtrade/freqtrade/blob/develop/README.md) · [OKX US licenses](https://www.okx.com/en-us/help/us-licenses) · [Binance.US supported states](https://support.binance.us/en/articles/9842798-list-of-supported-and-unsupported-states-and-regions) · [Bybit restricted countries](https://www.bybit.com/en/help-center/article/Service-Restricted-Countries) · [Kraken NY history](https://bitcoinmagazine.com/business/kraken-joins-exchanges-refusing-apply-bitlicense-suspends-service-new-york-1439245937)

### HB-2 — Schwab Trader API: 7-day refresh token with no programmatic renewal. *(Route B — FAIL for unattended operation)*

From `schwab-py`'s authentication documentation:

> *"Tokens are only good for seven days. Once seven days have passed since the token was originally created, you'll see failures and will need to delete your old token file and create a new one."*

> *"requests for a new access token using a refresh token older than seven days are rejected with an invalid_client error. **There is currently no way to make a refresh token last longer than seven days.** Once you start seeing this error, you have no choice but to delete your old token file and create a new one."*

Access tokens expire at 30 minutes and refresh automatically; the **refresh token** is the hard wall. Recreating it requires the interactive browser OAuth flow — a human, a browser, and Schwab credentials, every week, forever.

Compounding factors:
- **No API paper-trading environment.** The Trader API connects to live accounts only. A sandbox exists for validating authentication and response shapes against synthetic data; it is not a paper account.
- **One streamer connection per user at a time.** Deploying a second algorithm silently stops the first — confirmed by QuantConnect's own brokerage documentation: *"Charles Schwab only supports authenticating one account at a time per user. If you have an algorithm running with Charles Schwab and then deploy a second one, the first algorithm stops running."*
- **App approval is not instant** — reported as days to ~one month.
- **The leading community Python client is dormant.** `schwab-py` 1.5.1 was published **2025-06-30**; last repository commit **2025-08-04**. That is ~14 months stale as of this audit. There is no official Schwab Python SDK.

**Note:** this is a *harder* finding than ChatGPT's hedge ("may be complicated by authentication renewal"). It is not a maybe. It is a documented, unworkaroundable weekly manual step for an explicitly unattended system.
Sources: [schwab-py auth docs](https://github.com/alexgolec/schwab-py/blob/main/docs/auth.rst) · [PyPI schwab-py](https://pypi.org/project/schwab-py/) · [QuantConnect Schwab brokerage doc](https://github.com/QuantConnect/Documentation/blob/master/05%20Lean%20CLI/09%20Live%20Trading/01%20Brokerages/07%20Charles%20Schwab/01%20Introduction.php) · [Charles Schwab Developer Portal](https://developer.schwab.com/)

### HB-3 — IBKR: real-time API market data requires paid subscriptions. *(Route D — FAIL against constraint #1)*

IBKR documentation states that for all data other than delayed watchlist data, **a paid data subscription is required to receive market data through the API**, and that subscribing generally requires an account funded with at least **$500 USD**. Free delayed data (10–20 min lag) is available but is **Level 1 top-of-book and historical only — explicitly not available for tick-by-tick requests nor Level 2 market depth**. Clients receive ~100 free snapshot quotes per month.

Delayed L1 with no depth and no tick data cannot support intraday research. Paying for data violates the non-negotiable constraint. **IBKR fails as a free-data research route.** ChatGPT's claim here is confirmed.
Sources: [IBKR Live Data Limitations](https://www.interactivebrokers.com/docs/tws-api/doc/market-data-live/live-data-limitations) · [IBKR Market Data Pricing](https://www.interactivebrokers.com/en/pricing/market-data-pricing.php) · [TWS API delayed data](https://interactivebrokers.github.io/tws-api/delayed_data.html)

### HB-4 — Alpaca: free real-time equities data is IEX-only; crypto is unavailable in New York. *(Route C — FAIL)*

Alpaca's Basic (free) plan provides real-time equities data from **IEX only — approximately 2.5% of US equity volume**. Full consolidated coverage (CTA + UTP SIPs = 100% of volume) requires the **Algo Trader Plus plan at $99/month**. Alpaca's own (now-deprecated) docs repository additionally documented the free tier as capped at **30 WebSocket symbols**, **15-minute historical data delay**, and **200 historical API calls/min**.

A single-venue feed carrying 2.5% of volume is not a consolidated NBBO. Any spread, quote, or microstructure conclusion drawn from IEX-only data is unsound for US equities, and the fix costs $99/month — a direct constraint violation.

Separately: **Alpaca crypto trading is available in 49 states, excluding New York.** So the free-crypto workaround inside Alpaca is closed for this user specifically.

ChatGPT's claim is **confirmed**, with the added NY-specific finding it did not surface.
Sources: [Alpaca market data plans](https://alpaca.markets/data) · [Alpaca docs repo — subscription plans](https://github.com/alpacahq/alpaca-docs/blob/master/content/market-data/_index.md) · [Alpaca crypto state availability](https://tradersunion.com/brokers/fond/view/alpaca/)

### HB-5 — LEAN via lean-cli requires a paid QuantConnect tier, even for local backtesting. *(Framework — FAIL against constraint #3/#4)*

The LEAN **engine** is Apache-2.0 and free. The supported way to use it locally — `lean-cli` — is not. QuantConnect's own documentation repository contains the line *"To use the CLI, you must be a member in an organization on a paid tier"* in:

- `05 Lean CLI/08 Backtesting/01 Deployment/01 Introduction.html` ← **local backtesting**
- `05 Lean CLI/08 Backtesting/02 Debugging/01 Introduction.html`
- Every brokerage under `05 Lean CLI/09 Live Trading/01 Brokerages/` — Coinbase and Charles Schwab included
- Every dataset connector under `05 Lean CLI/05 Datasets/`, **including `04 Custom Data`**

So even feeding LEAN your own free Coinbase data through the CLI is gated.

The escape hatch — building and running the Apache-2.0 `QuantConnect/Lean` C# engine directly, bypassing the CLI, and hand-writing a LEAN-format data converter for Coinbase — is legally fine and technically possible, but it is a large, unsupported infrastructure project. That is exactly the "writing infrastructure ourselves" outcome the charter says to avoid.

For completeness: LEAN's Coinbase brokerage **is** genuinely on Advanced Trade (verified in source: `api/v3/brokerage/*` REST paths and `wss://advanced-trade-ws.coinbase.com`), last committed 2026-06-19 — despite its README still saying "Coinbase Pro" throughout. The integration is real; the licensing gate is the blocker.
Sources: [QuantConnect Documentation repo](https://github.com/QuantConnect/Documentation) · [Lean.Brokerages.Coinbase](https://github.com/QuantConnect/Lean.Brokerages.Coinbase) · [Lean engine](https://github.com/QuantConnect/Lean)

### HB-6 — Backtrader is unmaintained. *(Framework — FAIL)*

Last PyPI release: **1.9.78.123, 2023-04-19** — over three years stale. Development from the original author has been frozen since April 2023 and the official community forum no longer accepts new posts. Any Coinbase Advanced Trade integration would be entirely self-written against a dead framework.
Sources: [PyPI backtrader](https://pypi.org/project/backtrader/) · ["Is Backtrader dead?" community thread](https://community.backtrader.com/topic/3702/is-backtrader-dead)

### HB-7 — ECONOMIC BLOCKER: Coinbase Advanced Trade base-tier fees vs. plausible intraday edge. *(Route A — conditional; this is the decisive gate)*

Coinbase Advanced Trade base tier (< $10k trailing 30-day volume): **0.60% taker / 0.40% maker**. Nine volume bands; the second tier (~0.25% maker / 0.40% taker) requires roughly **$50,000** monthly volume. The 0.00%/0.05% headline rates require institutional-scale volume. **Stablecoin-pair volume does not count toward tier progression**, and USDC/USD zero-fee pairs carry no volatility worth trading.

Round-trip cost at base tier:

| Execution style | Round-trip cost | Required gross edge to break even |
| --- | --- | --- |
| Maker in / maker out | **~0.80%** | > 0.80% per trade |
| Maker in / taker out | **~1.00%** | > 1.00% per trade |
| Taker in / taker out | **~1.20%** | > 1.20% per trade |

A retail intraday crypto strategy plausibly targets tens of basis points of gross edge per round trip. The fee is **3–10× that**. Increasing trade frequency makes this worse, not better. Reaching a better tier requires the volume that the fees make unprofitable to generate — a circular trap.

This is not fixable by better infrastructure, a better engine, or a better strategy search. **It should be quantified before any engineering.** See Test P0-0.

I am flagging this as the single most important finding in the audit, and I did not see it given proportionate weight in the claims attributed to ChatGPT.
Sources: [Coinbase fee tier analyses, 2026](https://www.datawallet.com/crypto/coinbase-fees) · [TokenEcho Advanced Trade fee breakdown](https://tokenecho.io/guides/coinbase-advanced-trade-fees/) · [Coinbase high-volume fee upgrade program](https://www.coinbase.com/blog/coinbase-advanced-now-offers-a-fee-upgrade-program-for-high-volume-traders)

---

## 4. SOFT RISKS

### SR-1 — Silent zero-fee default in NautilusTrader + Coinbase. **HIGH severity, easy fix, easy to miss.**

Verified by reading source at commit `f2b2add`:

- `crates/execution/src/models/fee.rs:233-237` — `impl Default for FeeModelAny { fn default() -> Self { Self::MakerTaker(MakerTakerFeeModel) } }`
- `crates/execution/src/models/fee.rs:398-416` — `MakerTakerFeeModel::get_commission()` computes `notional × instrument.maker_fee()` or `× instrument.taker_fee()`
- `crates/adapters/coinbase/src/http/parse.rs:175-190` — `CurrencyPair::builder()` is constructed **without** `.maker_fee()` or `.taker_fee()`, carrying only the comment `// maker_fee (loaded separately via transaction_summary)`
- `crates/model/src/instruments/currency_pair.rs:174-175` — unset fees resolve via `maker_fee.unwrap_or_default()` → **0**
- `get_transaction_summary()` exists at `crates/adapters/coinbase/src/http/client.rs:536` and `:1009` but is **never called by `provider.rs`**

**Consequence:** an out-of-the-box Coinbase backtest or sandbox run in NautilusTrader charges **zero commission**. Against a real 0.40–0.60% per side, this inverts the sign of most intraday results.

**Mitigation:** override `maker_fee` / `taker_fee` on every Coinbase instrument before any run, and make a zero-fee configuration a hard test failure. This must be the *first* assertion in the test suite, not an afterthought. It is written into the Phase 0 matrix as **P0-11**.

### SR-2 — The Coinbase Advanced Trade adapter is ~4 months old. **MEDIUM.**

Release history from `RELEASES.md`:

| Version | Date | Coinbase event |
| --- | --- | --- |
| 1.214.0 | — | Coinbase **International (INTX)** adapter added |
| 1.224.0 | — | **INTX adapter removed** (RFC #3555) |
| **1.226.0** | **2026-04-29** | **"Added Coinbase initial integration adapter (Rust)"** ← Advanced Trade begins here |
| 1.227.0 | 2026-05-18 | Liquidation/ADL warnings, CFM margin buffer warning |
| 1.228.0 | 2026-06-08 | `status` channel; **Python v2 factory bindings**; fixed missing `F_SNAPSHOT` flag on book snapshots; `avg_price` parsing fix |
| 1.231.0 | 2026-08-02 | current stable line |
| 2.0.0rc3 | 2026-08-20 | Coinbase heartbeat counter gap warnings |

The README marks it `stable`, but it is four months old and has received substantive bug fixes in **every** release since introduction, including a book-snapshot flag bug that would corrupt order-book reconstruction. Tracking issue [#3816](https://github.com/nautechsystems/nautilus_trader/issues/3816) (opened 2026-04-07) is closed/Done.

ChatGPT's claim that the adapter exists and supports market data and execution is **correct**. The maturity qualifier is mine.

### SR-3 — The adapter is v2-only, and v2 is still a release candidate. **MEDIUM-HIGH.**

The Coinbase examples (`examples/live/coinbase/data_tester.py`) import `from nautilus_trader.live import LiveNode` — the **v2** API. `MIGRATION_V2.md` confirms `TradingNode` → `LiveNode` and that adapter configs move to Rust/PyO3 classes. The README states: *"During the v2 transition, v1 receives only critical security backports on the `develop_v1` branch."*

So: to use Coinbase you must be on the v2 surface, and v2 is at **2.0.0rc3**, whose release notes list **40+ breaking changes** including removal of the entire legacy Cython package, removal of `LiveNode.poll()` and Python `LiveNode.start()`, removal of `nautilus_trader.network` generic clients, and enum renames (`AggressorSide::Buyer` → `Buy`). More breaking changes are likely before 2.0.0 final.

**Practical effect:** expect to absorb breaking upgrades during the research period. Pin the version, and treat every upgrade as a re-validation event.

### SR-4 — Live WebSocket bars are five-minute buckets only, and the adapter does not reject other requests.

From the adapter guide: *"the WebSocket `candles` channel takes no granularity parameter and publishes five-minute buckets only. The adapter stamps each received candle with the `BarType` registered for that product, so subscribing at any other bar specification yields five-minute bars labelled with the requested type."* Listed explicitly under Known limitations: *"`subscribe_bars` does not reject other bar specifications."*

**This is a silent-wrong-data hazard.** Subscribe to 1-minute bars live and you receive 5-minute bars *labelled* 1-minute. A strategy validated on 1m historical bars and run live on this subscription is silently trading different data. Historical requests do support 1m/5m/15m/30m/1h/2h/6h/1d.

**Mitigation:** for live work, subscribe only to `5-MINUTE-LAST-EXTERNAL`, or build bars locally from the trades stream. Assert this in tests (**P0-12**).

### SR-5 — Fill identity differs between the live path and REST reconciliation.

Documented adapter-side limitation: the `user` channel does not carry Coinbase's per-fill `trade_id`, so live `FillReport`s use IDs **synthesized** from `(venue_order_id, cumulative_quantity)`, while REST reconciliation uses the venue's real `trade_id`. **The same fill therefore has two different identities depending on which path observed it.** Any P&L ledger or duplicate-detection logic keyed on `trade_id` must handle this explicitly or it will double-count.

Related: fill deduplication is a **10,000-entry FIFO** keyed on `(venue_order_id, trade_id)`. The docs state that *"after very long disconnections (beyond the in-memory dedup window) replayed fills may emit duplicate `FillReport` values."* Duplicate-fill risk is real, bounded, and documented.

### SR-6 — Coinbase venue-side execution gaps.

From the adapter guide's Known limitations (venue-side):
- **No `STOP_MARKET`**, no `MARKET_IF_TOUCHED`, no `LIMIT_IF_TOUCHED`, no trailing stops, no iceberg.
- **No OCO** as a distinct order type.
- **No `reduce_only`** on the create-order schema.
- **No batch submit / batch modify** — only batch cancel.
- Order **modification restricted to open GTC orders**; futures edits rejected with `CANNOT_EDIT_FUTURES_ORDER`. Everything else is cancel-replace.
- **`MARKET` orders default to IOC.** A `MarketOrder` built with the Nautilus default `TimeInForce::Gtc` is mapped to `market_market_ioc` at the venue. The docs warn: *"strategies that require strict backtest/live parity should construct `MarketOrder` with `Ioc` explicitly."* **This is a backtest/live divergence vector.**
- **Newly listed products require a reconnect to be tradeable** — the instrument cache is populated on connect only.
- **Bracket orders not implemented** by the adapter (venue exposes `trigger_bracket_gtc`/`_gtd`).

Practical consequence: risk management must be implemented **in-strategy** (Nautilus-side), not delegated to venue-native stop or OCO orders. That is a meaningful additional correctness burden and a real failure mode if the process dies holding a position.

### SR-7 — Coinbase operational stability.

Third-party incident aggregation reports **95 Coinbase incidents in a trailing 90-day window (1 major, 94 minor), median duration ~1h38m**, and a *"Degraded Performance — Advanced Trade API"* incident on **2026-03-18**. Coinbase runs several distinct status surfaces: `status.coinbase.com`, `cdpstatus.coinbase.com`, `status.cde.coinbase.com` (Derivatives). Any operational design must assume the API is unavailable or degraded on a recurring basis, and must fail safe (flat / no new orders) rather than fail open.
Sources: [IsDown Coinbase API status history](https://isdown.app/status/coinbase/coinbase-api) · [Coinbase Status](https://status.coinbase.com/) · [CDP Status](https://cdpstatus.coinbase.com/)

### SR-8 — Rate limits are asymmetric and partly undocumented.

Published: WebSocket **8 connections/sec/IP**, **8 unauthenticated messages/sec/IP**, **first subscribe within 5 seconds of connect or the server disconnects**, authenticated **JWT valid 120s with a fresh JWT required per authenticated subscribe**, REST **10,000 requests/hour/API key** (Coinbase App general policy). NautilusTrader additionally throttles client-side to 30 REST req/s and 8 sub/unsub per second.

The adapter guide itself notes: *"Coinbase's current Advanced Trade documentation publishes WebSocket limits but no Advanced Trade-specific REST quota (per-second ceilings, per-portfolio limits)."* **The binding REST limit is therefore inferred, not documented.** Historical backfill volume planning rests on an unconfirmed number.

429 responses return `{"errors":[{"id":"rate_limit_exceeded","message":"Too many requests"}]}`. Execution client retries default to 3 attempts, 100ms initial / 5,000ms max backoff.

### SR-9 — Ambiguous-outcome submits are left in flight by design.

From the adapter guide: *"Because any submit attempt may have reached Coinbase, a transport error, timeout, rate-limit response, decode failure, or HTTP 5xx does not prove rejection. The adapter leaves the order in flight and retains its submit metadata until the user channel or reconciliation resolves it."*

This is the **correct** design — but it means the system can hold orders in indeterminate state, and correctness depends on reconciliation actually running. `cancel_all_orders`/`batch_cancel` REST list failures are **logged only**; no per-order `OrderCancelRejected` is emitted and orders sit in `PendingCancel` until reconciliation recovers them. A kill switch built naively on `cancel_all_orders` can therefore **silently fail to cancel**. This must be tested (**P0-13**).

### SR-10 — Coinbase NY asset restrictions constrain the tradable universe.

New York's NYDFS greenlist/self-certification regime means Coinbase's NY asset list is a **subset** of its US list. XRP notably remains restricted for New York residents. Coinbase Assets has progressively added assets under NYDFS licence (KSM, ILV, ROSE, GNO, METIS) and received NY approval for ETH/SOL staking in late 2025.

**Action:** the tradable universe must be enumerated from the user's **own logged-in NY account**, not from Coinbase's general documentation. Any research on an asset the account cannot actually trade is wasted.

### SR-11 — Free candle data is documented as incomplete.

Coinbase's own candles documentation states that historical rate data **may be incomplete**, with **no data published for intervals containing no ticks**, and recommends the trade and book endpoints plus the WebSocket feed for real-time information. Gaps are therefore semantically ambiguous — "no trades" and "we lost the data" are indistinguishable in the response. Any bar pipeline needs explicit gap detection and an explicit policy (**P0-4**).

---

## 5. UNKNOWNS

Ranked by how badly they could change the verdict.

### UK-1 — **Coinbase Market Data Terms of Use: possible prohibition on algorithmic/AI use.** ⚠️ **CRITICAL — resolve before any Phase 0 work.**

Search-result summaries of Coinbase's Market Data Terms of Use (`coinbase.com/legal/market_data`) indicate clauses that prohibit users from:

- redistributing, displaying or disseminating Market Data or derived works to third parties outside their organization;
- using Market Data or derived works to create indexes, fixings, benchmarks, or valuations;
- using **"any Market Data to develop, train, fine-tune, teach, validate, benchmark, or otherwise improve any artificial intelligence or machine learning model, algorithm, chatbot, agent, or other automated system."**

**I could not read the primary document** — `coinbase.com` is blocked in this environment, and the Internet Archive was also unreachable. I am therefore reporting an unverified paraphrase, not a finding.

**Why this matters enormously:** if that clause exists in that form and applies to Advanced Trade market data, then "record Coinbase's free feed and use it to validate/benchmark an automated trading algorithm" — the literal Phase 0 plan — may be contractually prohibited. The words *"validate, benchmark"* and *"algorithm... or other automated system"* map uncomfortably precisely onto this project.

**Competing reading (also unverified):** these terms may be scoped to the institutional **Exchange** Market Data API rather than the retail Advanced Trade API, and a personal-internal-use licence may be granted elsewhere in the same document. Exchanges commonly permit internal personal use while forbidding redistribution. That would make this a non-issue.

**I cannot tell you which reading is correct, and I will not guess.** This is the single highest-value thing the user can resolve, it takes about ten minutes, and it should be resolved **before** engineering.

**User action:** open `https://www.coinbase.com/legal/market_data` and the CDP Terms of Service, and extract verbatim (a) the scope clause naming which APIs/entities are covered, (b) the permitted-use/licence grant, (c) any AI/ML/algorithm/automated-system clause. Paste them back. If the restrictive reading holds for Advanced Trade, **Route A becomes FAIL and the whole project is NO BUILD** — which would be exactly the kind of late-discovered blocker this audit exists to prevent.

### UK-2 — Coinbase futures (CFM) eligibility for New York residents.

Coinbase Financial Markets offers CFTC-regulated futures and, since 2025-07-21, US perpetual-style futures. **State-level eligibility was not published in any source I could reach.** Separately, New York has been pursuing enforcement against Coinbase Financial Markets over event-based contracts, arguing federal CFTC registration does not preempt state consumer-protection/gambling law — evidence of active NY/CFM regulatory friction, though on a different product line.

**Why it matters:** CFM perpetual futures would sidestep HB-7 entirely — futures fee structures are far cheaper than the 0.60%/0.40% spot schedule, which would materially improve the economics. But leverage introduces liquidation risk, and the adapter's derivatives path has its own gaps (no `reduce_only`, no futures order edits, position reports only via REST polling).

**User action:** log into the Coinbase account and check whether the Futures/Derivatives product is offered and enabled for the NY-resident account. Report yes/no. **Do not enable it as part of this audit.**

### UK-3 — Whether Coinbase publishes WebSocket sequence numbers usable for gap detection.

NautilusTrader 2.0.0rc3 added *"Coinbase heartbeat counter gap warnings, resetting after reconnect"* — implying gap detection exists via **heartbeat counters**. Whether the `level2` channel carries a monotonic per-product sequence number sufficient to prove no book delta was dropped is **not established** by any source I could read. The `docs.cdp.coinbase.com` WebSocket channel reference was blocked.

**Why it matters:** without a per-message sequence, you cannot *prove* order-book integrity; you can only infer it from heartbeat continuity. That weakens any queue-position claim built on recorded L2 data. This is directly answerable by Phase 0 test **P0-2** at zero cost.

### UK-4 — Coinbase's actual per-second REST rate ceiling.

Only the 10,000/hour Coinbase App general quota is documented; NautilusTrader's own guide states no Advanced Trade-specific REST quota is published. Historical backfill planning (≈1,500 requests for one year of 1-minute candles) fits comfortably under 10,000/hour **if** that figure applies. Confirm empirically via **P0-5**.

### UK-5 — Schwab market-data agreement terms for API-delivered data.

`developer.schwab.com` was unreachable. Whether Schwab's API market data may be stored locally for personal algorithmic research, and under what non-professional-subscriber terms, is unverified. Moot if HB-2 stands, but relevant if Schwab is ever reconsidered.

### UK-6 — PDT elimination: precise effect at each broker today.

The change is real but the implementation window is long, so **per-broker behavior in August 2026 varies**. Moot for the crypto route (PDT never applied to crypto). Relevant only if equities are revisited. See §6.

---

## 6. REGULATORY UPDATE THAT CHANGES A STANDING ASSUMPTION

**The FINRA pattern-day-trader rule and the $25,000 minimum equity requirement have been eliminated.**

This post-dates my own training data and is very likely absent from ChatGPT's assessment too, so I flag it explicitly rather than assuming either of us knew it.

- The SEC approved amendments to FINRA Rule 4210 (File No. SR-FINRA-2025-017) on **2026-04-14**.
- The amendments **became effective 2026-06-04**.
- They eliminate **all** day-trading concepts from Rule 4210 — the "pattern day trader" definition, the day-trade count thresholds, the **$25,000 minimum equity requirement**, and "day trading buying power" calculations.
- They are replaced by a **modernized intraday margin standard**: firms must monitor intraday margin exposure based on a customer's actual market exposure and margin deficiency through the trading day.
- Firms have an **18-month phase-in ending 2027-10-20**, so individual brokers are transitioning at different rates.
- Reported practical effect: a margin account below $2,000 in equity may day-trade **unleveraged** — cash-available only.

**Why this matters here:** the $25,000 PDT floor has historically been the standard reason to route retail day trading to crypto rather than equities. That reason is now substantially weakened. It does **not** rescue routes B/C/D — those fail on authentication (HB-2), free-data adequacy (HB-4), and paid data (HB-3), none of which PDT touched. But it does mean that if the Coinbase fee gate (HB-7) fails, **equities become worth a second look on economics** ($0 commission, no $25k floor) — the blocker there becomes *data*, not *capital*, and data is a cheaper problem to think about than capital.

**Source caveat:** `finra.org` and `sec.gov` were both blocked. This rests on a WilmerHale client alert, Charles Schwab's and E*TRADE's own customer education pages, and secondary trade press — professional but secondary. **Verify against FINRA Regulatory Notice 26-10 and SEC Release 34-105226 before relying on it.**
Sources: [WilmerHale client alert, 2026-04-23](https://www.wilmerhale.com/en/insights/client-alerts/20260423-sec-approves-amendments-to-finra-rule-4210-replacing-day-trading-margin-requirements-with-a-modernized-intraday-margin-standard) · [FINRA Regulatory Notice 26-10](https://www.finra.org/rules-guidance/notices/26-10) · [SEC Release 34-105226](https://www.sec.gov/files/rules/sro/finra/2026/34-105226.pdf) · [Schwab explainer](https://www.schwab.com/learn/story/sec-approves-scrapping-25000-day-trader-minimum) · [E*TRADE explainer](https://us.etrade.com/knowledge/library/margin/pattern-day-trading-rule-change)

---

## 7. CONTRADICTIONS FOUND

**C-1 — Search summaries vs. source code: does the Coinbase `level2` channel require authentication?**
A web search summary asserted *"the Level2 channel requires authentication according to Coinbase's documentation."* **This is wrong.** NautilusTrader's adapter source contains explicit unit tests:
```
assert!(CoinbaseWsChannel::User.requires_auth());
assert!(!CoinbaseWsChannel::Level2.requires_auth());
assert!(!CoinbaseWsChannel::MarketTrades.requires_auth());
assert!(!CoinbaseWsChannel::Ticker.requires_auth());
```
(`crates/adapters/coinbase/src/common/enums.rs:465-469`; `requires_auth()` at `:422` matches only `User | FuturesBalanceSummary`.) **Source code wins.** Public market data — including L2 depth — needs no credentials. ChatGPT's claim is confirmed; the search summary was wrong. This is a good illustration of why search summaries were not treated as evidence in this audit.

**C-2 — NautilusTrader README vs. reality on adapter maturity.** The README labels Coinbase `stable` — defined in that same README as *"Stabilized feature set and API, tested by both developers and users to a reasonable level."* The release history shows the adapter is four months old with substantive bug fixes in every subsequent release, including a corrupted book-snapshot flag. The label is optimistic relative to the changelog. Not a contradiction in bad faith; a maturity-vs-label gap worth knowing.

**C-3 — LEAN's Coinbase README vs. its code.** The README describes "Coinbase Pro" throughout, a product Coinbase retired. The code targets Advanced Trade (`api/v3/brokerage/*`, `wss://advanced-trade-ws.coinbase.com`). **Documentation is stale; the integration is current.** Anyone evaluating LEAN from its README alone would draw the wrong conclusion.

**C-4 — "Free/low Coinbase fees" marketing vs. the retail tier.** Coinbase materials and third-party reviews foreground *"as low as 0bps maker and 5bps taker"* and *"free trading on 22 stable pairs."* The rate a sub-$10k-volume retail account actually pays is **0.40% maker / 0.60% taker** — 8–12× the headline. The zero-fee pairs are stablecoin pairs with no tradable volatility, and stablecoin volume **does not count** toward tier progression. The headline numbers are unreachable at this account size.

**C-5 — Nautilus documents live-bar granularity as unsupported *and* unrejected.** The guide says non-5-minute live bar subscriptions are silently served 5-minute data under the requested label. Documented honestly, but it is a documented silent-wrong-data path — the venue limitation and the adapter's failure to reject it are two separate problems stated in one sentence.

---

## 8. FRAMEWORK COMPARISON

| | **NautilusTrader** | **Freqtrade** | **Backtrader** | **LEAN (local)** | **Custom Python/CCXT** |
| --- | --- | --- | --- | --- | --- |
| **Latest release** | 1.231.0 (2026-08-02); 2.0.0rc3 (2026-08-20) | 2026.7 (2026-07-31) | **1.9.78.123 (2023-04-19)** | lean-cli 1.0.228 (2026-08-12) | ccxt 4.5.76 (2026-08-26) |
| **Maintenance** | ✅ Very active | ✅ Very active | ❌ **Frozen since Apr 2023** | ✅ Active | ✅ Very active |
| **License** | LGPL-3.0-or-later | GPL-3.0 | GPL-3.0+ | Apache-2.0 (engine) | MIT (ccxt) |
| **Coinbase Advanced** | ✅ Native Rust adapter, `stable`, v2 API | ❌ **Not officially supported** | ❌ None | ✅ Verified Advanced Trade in source | ✅ CCXT supports it |
| **Schwab** | ❌ **No adapter** | ❌ N/A | ❌ None | ✅ Supported (paid tier) | ⚠️ Fully self-built |
| **Alpaca** | ❌ **No adapter** | ❌ N/A | ⚠️ Community | ✅ Supported (paid tier) | ✅ `alpaca-py` |
| **IBKR** | ✅ Stable adapter | ❌ N/A | ⚠️ Community | ✅ Supported (paid tier) | ⚠️ `ib_async`; `ib-insync` dead since 2023-07 |
| **Backtest ≡ live semantics** | ✅ **Explicit design goal** — same Rust matching engine across backtest / sandbox / live | ⚠️ Dry-run ≠ backtester | ⚠️ Weak | ✅ Strong | ❌ Whatever you build |
| **Deterministic execution** | ✅ Nanosecond event-driven; seeded fill models; canonical results w/ content digests | ⚠️ Partial | ❌ | ✅ | ❌ |
| **Queue position** | ✅ `queue_position=True` — L2 aggregate + true per-order L3 MBO | ❌ | ❌ | ⚠️ Limited | ❌ |
| **Latency modeling** | ✅ `StaticLatencyModel`, inflight command queue | ❌ | ❌ | ⚠️ | ❌ |
| **Fill models** | ✅ 11 built-in incl. tiered/size-aware/competition-aware; `liquidity_consumption` | ⚠️ Basic | ❌ | ✅ | ❌ |
| **Fee model** | ✅ `MakerTaker`/`Fixed`/`PerContract` — ⚠️ **but Coinbase fees default to 0** (SR-1) | ✅ Configured | ⚠️ | ✅ | ❌ |
| **Live-data + sim-execution** | ✅ **Sandbox adapter, same matching engine, same flags** | ✅ Dry-run | ❌ | ⚠️ QC paper (paid) | ❌ |
| **Custom code required** | **Low** | N/A (no venue) | Very high | High (data conversion) | **Very high** |
| **Operational complexity** | Medium-high (Rust/PyO3, v2 RC churn) | Low | Low | High | High |
| **Hidden integration work** | Medium — v2 breaking changes, fee wiring, bar-granularity trap | N/A | Very high | High — LEAN-format converter | Very high |
| **Blocking issue** | v2 is RC; adapter 4 months old | **HB-1 jurisdiction** | **HB-6 unmaintained** | **HB-5 paid tier** | Violates "prefer mature engine" |
| **VERDICT** | ✅ **Recommended** | ❌ FAIL | ❌ FAIL | ❌ FAIL (as CLI); high-effort escape hatch | ❌ Not recommended |

### On the two NautilusTrader simulation claims

**"Can model latency, fees/fills, liquidity and queue position" — CONFIRMED, with one caveat.** Verified in source and docs:
- **Latency** — `StaticLatencyModel(base_latency_nanos=...)`; commands enter the venue's inflight queue with a future release time.
- **Fees** — `MakerTakerFeeModel` (default), `FixedFeeModel`, `PerContractFeeModel`. *(But see SR-1 — Coinbase feeds it zeros.)*
- **Fills** — 11 models; `prob_fill_on_limit`, `prob_slippage`, `random_seed` for reproducibility; `liquidity_consumption=True` tracks consumed size per level (without it, *"the same displayed size can support more than one simulated order in an iteration"* — a documented over-optimism trap).
- **Queue position** — `queue_position=True` with `trade_execution=True` snapshots same-side displayed size at the order's price and decrements it with correct-side trades; distinct documented lifecycles for L1, L2, and L3 MBO books.

**The caveat:** Coinbase supplies **`L2_MBP` only** — the adapter explicitly rejects other book types. So queue position on Coinbase is the **aggregate-size approximation**, not the exact per-order L3 tracking Nautilus supports with MBO venues. It is a defensible estimate. It is not ground truth, and it should never be described as ground truth in a research writeup.

**"Sandbox = live data + simulated execution" — CONFIRMED and it is the single strongest argument for this stack.** From `docs/concepts/overview.md`: *"Simulate trading systems with real-time data and virtual execution (`sandbox`). The sandbox adapter supplies simulated execution for a `sandbox` environment."* From `docs/concepts/backtesting/trade-execution.md`: *"Sandbox paper trading uses the same matching-engine flags"* — `SandboxExecutionClientConfig` accepts `book_type`, `trade_execution`, `queue_position`, `liquidity_consumption`. Backtest, sandbox, and live all share the `NautilusKernel`. This is a genuine $0 shadow-execution environment with backtest-identical semantics, and it exists today.

---

## 9. COMPLETE COST AUDIT

### Phase 0 (research / feasibility) — target $0

| Item | Cost | Notes |
| --- | --- | --- |
| Coinbase Advanced Trade access | **$0** | No subscription or platform fee; no minimum portfolio size |
| Coinbase One membership | **$0** | Optional; **not required** |
| Public WebSocket market data (L2, trades, ticker, candles, status, heartbeats) | **$0** | Unauthenticated; verified in adapter source |
| REST historical candles | **$0** | 350/request cap; 10,000 req/hr/key |
| Coinbase CDP API key (View + Trade, ECDSA) | **$0** | No withdrawal permission needed |
| NautilusTrader | **$0** | LGPL-3.0-or-later |
| Python / Rust toolchain, Postgres/Redis if used | **$0** | Open source |
| Local compute & storage | **$0** | Runs on existing hardware |
| Account funding | **$0** | Not required for public data, sandbox, or shadow-execution |
| **PHASE 0 TOTAL** | **$0** | **No paid component required.** |

### Costs that would appear only if live trading were later authorized (NOT authorized)

| Item | Cost |
| --- | --- |
| Coinbase Advanced spot maker fee (base tier) | **0.40%** of notional |
| Coinbase Advanced spot taker fee (base tier) | **0.60%** of notional |
| Implied round trip (maker/maker → taker/taker) | **0.80% → 1.20%** |
| Tier 2 threshold | ~**$50,000** trailing 30-day volume (stablecoin volume excluded) |
| Spread cost | Additional, beyond fees |
| Slippage / market impact | Additional |
| ACH deposit / withdrawal | Generally $0; wire and crypto-network fees apply |
| Regulatory fees | None on crypto spot (unlike equities) |
| Account funding | User's decision; **not required for Phase 0** |

### Paid components identified and avoided

| Component | Cost | Status |
| --- | --- | --- |
| Alpaca Algo Trader Plus (SIP) | $99/mo | **Avoided — route rejected (HB-4)** |
| IBKR market data subscriptions | Varies + $500 funded acct | **Avoided — route rejected (HB-3)** |
| QuantConnect paid tier (required even for local `lean` backtests) | Varies | **Avoided — route rejected (HB-5)** |
| Polygon / Databento / Tardis / TradingView | Varies | **Not used, not recommended** |
| VPS / cloud hosting | Varies | **Not required.** Runs locally at $0. Hosting is a *later* operational choice, not a research prerequisite. |

**Can the bot run locally for $0 initially? Yes.** Nothing in the Phase 0 plan requires paid infrastructure, and the recommended stack has no paid tier gating any needed feature.

**Any mandatory component hiding behind a paid tier?** For the recommended route: **no**. For rejected routes: **yes** — Alpaca SIP, IBKR real-time API data, and LEAN CLI (including local backtesting), which is precisely why those routes are marked FAIL.

---

## 10. PHASE 0 NO-MONEY TEST MATRIX

Every test below is diagnostic, read-only or simulation-only, and costs $0. **None places a live order. None risks real money.** Tests P0-1 through P0-8 require **no API key at all**.

Run **P0-0 first.** If it fails, stop — do not build.

---

### P0-0 — Economic viability gate *(analysis, not engineering)*
- **WHY IT MATTERS:** HB-7. If required edge exceeds achievable edge, every downstream test is wasted effort. This is the cheapest possible kill test.
- **METHOD:** From the user's actual Coinbase fee tier, compute break-even gross edge per round trip for maker/maker, maker/taker, taker/taker. Add median observed spread for the candidate pair. Compare against published/realistic intraday edge for retail crypto strategies. State a required-edge number.
- **PASS:** A documented, defensible hypothesis exists under which gross edge plausibly exceeds round-trip cost **with margin**, at the user's actual fee tier and account size.
- **FAIL:** Required edge exceeds any plausible retail intraday edge. → **Recommendation converts to NO BUILD.**
- **COST:** $0 · **RISKS REAL MONEY: NO**

### P0-1 — Public WebSocket connection, unauthenticated
- **WHY:** Validates the central free-data premise. Adapter source says `level2`/`market_trades`/`ticker` need no auth (C-1); prove it against the live endpoint.
- **PASS:** Connection established, `subscribe` sent within the 5s deadline, `heartbeats` subscribed, and `level2` + `market_trades` + `ticker` messages flow **with no credentials configured**.
- **FAIL:** Any market-data channel demands a JWT, or the server disconnects.
- **COST:** $0 · **RISKS REAL MONEY: NO**

### P0-2 — Sequence-number / gap-detection capability *(resolves UK-3)*
- **WHY:** Determines whether order-book integrity can be **proved** or only inferred. Governs how much trust any queue-position result deserves.
- **METHOD:** Record raw `level2` frames for ≥2 hours. Inventory every monotonic field (sequence numbers, heartbeat counters). Check continuity across a forced reconnect.
- **PASS:** A per-product monotonic sequence exists AND gaps are detectable, **or** heartbeat counters are proven sufficient for gap detection.
- **FAIL:** No usable ordering guarantee → **all downstream L2 and queue-position work must be labelled INSUFFICIENT_DATA**.
- **COST:** $0 · **RISKS REAL MONEY: NO**

### P0-3 — Feed-gap and latency measurement
- **WHY:** Establishes baseline data quality before any strategy claim rests on it.
- **METHOD:** 24h continuous capture. Record exchange timestamp, local receipt timestamp, inter-message deltas, disconnect count, reconnect duration, messages lost per reconnect.
- **PASS:** Gap and disconnect rates quantified with distributions; reconnect+resubscribe recovers within a stated bound.
- **FAIL:** Unrecoverable gaps, or clock skew large enough to make event ordering ambiguous.
- **COST:** $0 · **RISKS REAL MONEY: NO**

### P0-4 — Historical candle completeness and pagination
- **WHY:** SR-11 / HB-2 of the data story. Coinbase documents its own history as possibly incomplete.
- **METHOD:** Page 1-minute candles across ≥30 days (350/request). Count missing minutes. Cross-check a sample against independently recorded trades. Distinguish "no trades" from "data lost" wherever possible.
- **PASS:** Missing-minute rate quantified, pagination is stable and reproducible, gap semantics documented, and a written gap policy exists.
- **FAIL:** Gaps are unquantifiable, non-reproducible, or so extensive that intraday bars are unusable.
- **COST:** $0 · **RISKS REAL MONEY: NO**

### P0-5 — Rate-limit and 429/5xx handling *(resolves UK-4)*
- **WHY:** SR-8. The binding REST quota is inferred, not documented.
- **METHOD:** Ramp REST request rate under controlled backoff until 429. Record the actual ceiling, `rate_limit_exceeded` body shape, any `Retry-After`, and recovery behavior. Verify the client's 3-retry / 100ms→5,000ms backoff.
- **PASS:** Ceiling measured; 429 and 5xx handled with backoff; **no unbounded retry loop**; backfill plan fits inside the measured limit.
- **FAIL:** Undocumented throttling, key restriction, or a retry storm.
- **COST:** $0 · **RISKS REAL MONEY: NO**

### P0-6 — WebSocket aggregation vs. REST candle reconciliation
- **WHY:** Detects the class of silent inconsistency that ruins backtest/live parity — and specifically tests SR-4.
- **METHOD:** Build 1m and 5m bars locally from the recorded `market_trades` stream. Compare OHLCV against REST candles for the same windows. **Separately**, subscribe live to a 1-minute bar type and assert the received bars are 5-minute (SR-4 is expected to reproduce).
- **PASS:** Discrepancies quantified and explained; SR-4 reproduced and documented; a live-bar policy chosen (subscribe 5m only, or aggregate locally from trades).
- **FAIL:** Unexplained OHLCV divergence, or granularity mislabeling that cannot be worked around.
- **COST:** $0 · **RISKS REAL MONEY: NO**

### P0-7 — Forced disconnect / reconnect / resubscribe recovery
- **WHY:** SR-9 plus the documented dedup window. Reconnect correctness is where duplicate and dropped events originate.
- **METHOD:** Kill the socket at intervals (seconds → tens of minutes). Verify exponential backoff (250ms base, 30s cap), automatic subscription replay including `heartbeats`, and REST re-fetch of account state on reconnect. Measure data lost per outage.
- **PASS:** Every disconnect recovers automatically with subscriptions replayed; loss window bounded and measured.
- **FAIL:** Silent non-recovery, subscription loss, or unbounded reconnect flapping.
- **COST:** $0 · **RISKS REAL MONEY: NO**

### P0-8 — Deterministic replay
- **WHY:** Non-negotiable for the strategy-research requirements in §11. Without bit-identical reruns, no result is falsifiable.
- **METHOD:** Replay one recorded session through the NautilusTrader backtest engine **three times** with a fixed `random_seed`. Diff all outputs.
- **PASS:** **Byte-identical** results across all three runs.
- **FAIL:** Any nondeterminism. → **Blocks all strategy research until resolved.**
- **COST:** $0 · **RISKS REAL MONEY: NO**

---
*Tests below require a CDP API key with **View + Trade only, ECDSA algorithm, NO withdrawal permission**, on an **unfunded or minimally funded** account.*

---

### P0-9 — Authentication and JWT lifecycle
- **WHY:** Validates the unattended-operation premise (the thing Schwab fails at).
- **METHOD:** Authenticate REST and the `user` WebSocket channel. Run ≥24h continuously. Confirm a fresh ES256 JWT is generated per signed REST request and per authenticated subscribe, and that the 120s expiry never surfaces as an error. Confirm **zero manual intervention**.
- **PASS:** 24h+ unattended with no manual re-auth and no auth-related errors.
- **FAIL:** Any manual step, or unexplained auth failure.
- **COST:** $0 · **RISKS REAL MONEY: NO**

### P0-10 — Order schema validation against sandbox and `/orders/preview`
- **WHY:** Proves order construction without ever reaching the live matching engine.
- **METHOD:** Point the exec client at `CoinbaseEnvironment.SANDBOX` (static mock; Accounts and Orders endpoints only). Validate request/response shapes for MARKET/LIMIT/STOP_LIMIT, post-only, GTC/GTD/IOC/FOK, batch cancel. Exercise the `X-Sandbox` header's predefined error scenarios. Optionally use the read-only `/orders/preview` endpoint on live for schema validation. Confirm the documented rejections: MARKET FOK on spot, `Day`/`Gtd` MARKET, STOP_MARKET.
- **PASS:** All schemas validate; documented rejections reproduce; error paths handled.
- **FAIL:** Schema mismatch, or an unexpected acceptance suggesting the adapter is out of sync with the venue.
- **COST:** $0 · **RISKS REAL MONEY: NO — sandbox is static mock; preview does not place orders. No live order is submitted.**

### P0-11 — **Fee-wiring assertion** *(mitigates SR-1 — highest-value single test)*
- **WHY:** SR-1. A zero-fee backtest is worse than no backtest, because it produces confident wrong answers.
- **METHOD:** Load Coinbase instruments through the adapter. **Assert `maker_fee` and `taker_fee` are non-zero.** Expect this to FAIL initially (both default to 0). Then explicitly set fees from the account's real tier, and verify `MakerTakerFeeModel` produces the arithmetically expected commission on a known simulated fill.
- **PASS:** Fees are non-zero, match the account's real tier, and commission is arithmetically verified. A zero-fee configuration raises a hard error, not a warning.
- **FAIL:** Fees silently remain 0, or the test can be bypassed. → **Blocks all backtesting.**
- **COST:** $0 · **RISKS REAL MONEY: NO**

### P0-12 — Duplicate, dropped, and out-of-order event injection
- **WHY:** SR-5. Fill identity differs between live and REST paths; the dedup FIFO is bounded at 10,000 entries.
- **METHOD:** Replay recorded user-channel and market-data events with injected duplicates, drops, and reordering. Overflow the dedup window deliberately. Verify no double-counted fills or positions.
- **PASS:** Duplicates rejected; out-of-order handled or explicitly quarantined; dedup-window overflow is **detected and logged**, not silently mis-accounted.
- **FAIL:** Silent double-count, or a position/balance divergence that reconciliation cannot repair.
- **COST:** $0 · **RISKS REAL MONEY: NO**

### P0-13 — Kill switch and live-routing lockout *(safety-critical)*
- **WHY:** SR-9 — `cancel_all_orders` REST list failures are **logged only**; a naive kill switch can silently fail. And nothing else in Phase 0 matters if live routing can be reached accidentally.
- **METHOD:** In sandbox/simulation only: (a) verify `cancel_all_orders` behavior when the list-open-orders REST call fails — confirm orders land in `PendingCancel` and reconciliation recovers them; (b) verify a kill switch that halts new submissions independently of venue cancel success; (c) verify the live execution client is **configurationally impossible** to instantiate in the Phase 0 environment — no live credentials present, environment pinned to SANDBOX, and a startup assertion that aborts the process if `CoinbaseEnvironment.LIVE` is ever constructed.
- **PASS:** Kill switch halts new orders unconditionally; cancel failures are surfaced not swallowed; **the process refuses to start if live execution is configured.**
- **FAIL:** Any path reaches live order submission, or a cancel failure is silent.
- **COST:** $0 · **RISKS REAL MONEY: NO**

### P0-14 — Adapter startup and instrument bootstrap
- **WHY:** Confirms the 4-month-old adapter (SR-2) actually starts against the current venue API, and that the NY account's tradable universe is what research assumes (SR-10).
- **METHOD:** Run the adapter's own read-only diagnostic binary `coinbase-http-public` (spot instruments, product book, recent trades — no credentials). Then `coinbase-http-private` (portfolios, balances, per-product gating flags). Cross-check the returned tradable product list against what the NY account can actually trade.
- **PASS:** Adapter starts cleanly; instrument bootstrap succeeds; the NY-tradable universe is enumerated and documented.
- **FAIL:** Bootstrap failure, or the target pair is not tradable on the NY account.
- **COST:** $0 · **RISKS REAL MONEY: NO — `coinbase-http-private` runs `/orders/preview`, which does not place orders.**

### P0-15 — Forward L2 + trades capture *(the long pole)*
- **WHY:** Directly addresses the finding that free Coinbase history is bar-only. This is the **only** free path to a dataset supporting spread, depth, and queue-position research.
- **METHOD:** Continuous immutable capture of `level2` deltas + `market_trades` for the candidate pair(s), write-once with checksums, sequence/heartbeat continuity logged per §11.
- **PASS:** ≥30 days of continuous capture with quantified gap rate and verified integrity, replayable deterministically (P0-8).
- **FAIL:** Capture cannot be sustained, or gap rate makes book reconstruction unsound.
- **COST:** $0 (storage only) · **RISKS REAL MONEY: NO**
- **Note:** this is a **calendar-time cost, not a dollar cost** — weeks before microstructure research can begin. Start it early; it runs in parallel with everything else.

---

## 11. STRATEGY-RESEARCH READINESS ASSESSMENT

Not selecting a strategy. Assessing whether the environment can **later** support scientifically valid research.

| Requirement | Supported? | Evidence / caveat |
| --- | --- | --- |
| Explicit hypothesis before optimization | ✅ Process | Enforce by convention; gate at P0-0 |
| No look-ahead / repainting | ✅ Engine | Nanosecond event-driven; strategies see only released events |
| Immutable raw market data | ✅ Achievable | Write-once capture + checksums (P0-15) |
| Deterministic runs | ✅ Engine | Seeded fill models; canonical Rust backtest results w/ content digests and stable ordering — **verify via P0-8** |
| Train/test separation | ✅ Process | Standard |
| Untouched holdout | ✅ Process | Requires discipline, not tooling |
| Walk-forward validation | ✅ Engine | Supported |
| Parameter-stability testing | ✅ Engine | Supported |
| Regime partitions | ⚠️ Data-limited | Needs long history; free path is 1m bars only |
| **Fees from the FIRST backtest** | ⚠️ **AT RISK** | **SR-1: Coinbase instruments default to zero fees.** Mitigated only by P0-11 |
| Bid/ask spread | ⚠️ **Forward-only** | Free Coinbase history has **no quote archive**. Spread research requires P0-15 capture |
| Realistic slippage | ✅ / ⚠️ | `prob_slippage`, tiered fill models, `liquidity_consumption=True`. Quality bounded by data granularity |
| Execution latency | ✅ Engine | `StaticLatencyModel` + inflight command queue |
| Partial fills / liquidity | ✅ Engine | `LimitOrderPartialFillModel`, tiered models, per-level consumption tracking |
| **Queue position** | ⚠️ **Approximate** | `queue_position=True` works, but Coinbase gives **L2_MBP only** — aggregate estimate, never L3 ground truth |
| Comparison vs. simple baselines | ✅ Process | Buy-and-hold, random-entry, always-flat |
| Sensitivity tests | ✅ Engine | Fill/latency/fee model sweeps |
| No selection on in-sample Sharpe alone | ✅ Process | Discipline |
| PASS / FAIL / INSUFFICIENT_DATA outcomes | ✅ Process | Adopt as the standard verdict vocabulary |

**Overall: the environment can support scientifically valid research, with two structural qualifications.**

1. **Historical microstructure research is not possible on free Coinbase data.** Only bar-level research is possible on history. Spread, depth, and queue-position research requires forward capture (P0-15) and a waiting period. Any claim about spread or queue behavior derived from historical bars must be reported **INSUFFICIENT_DATA**, not PASS.
2. **Queue position on Coinbase is an approximation.** Report it as such. Never present an L2-derived queue estimate as if it were L3 ground truth.

---

## 12. INFORMATION AND ACCESS STILL REQUIRED FROM THE USER

Ordered by decision impact. Items 1–3 should be resolved **before** any Phase 0 engineering.

1. ⚠️ **Coinbase Market Data Terms of Use — verbatim text.** *(UK-1 — potentially project-ending.)* Open `https://www.coinbase.com/legal/market_data` and the CDP Terms of Service. Paste back: (a) the scope clause naming which APIs/entities are covered; (b) the permitted-use / licence grant, specifically whether personal internal use is allowed; (c) any clause mentioning AI, machine learning, model training, validation, benchmarking, algorithms, or automated systems. **I could not read this page and I will not guess at it.**
2. **Confirmed Coinbase fee tier.** From the account's Advanced Trade fee page: current maker %, taker %, and trailing 30-day volume. Required for P0-0.
3. **NY-tradable asset list.** From the logged-in NY-resident account: which pairs are actually tradable. Confirms the research universe (SR-10).
4. **Coinbase futures / CFM eligibility.** *(UK-2.)* Is the Futures/Derivatives product offered to this NY account? Yes/no only — **do not enable it.**
5. **Account funding intent.** Target trading capital *if* live trading were ever authorized. Determines whether the P0-0 economics are even in a plausible range. Not needed for Phase 0 itself.
6. **CDP API key, when Phase 0 reaches P0-9.** Created with **View + Trade only**, **ECDSA** signature algorithm (Ed25519 does **not** work with Advanced Trade), **no withdrawal permission**, on an unfunded or minimally funded portfolio. Not needed for P0-1 through P0-8.
7. **Local environment specs.** OS, CPU/RAM, available disk. P0-15 continuous L2 capture is storage-hungry, and NautilusTrader v2 requires a current toolchain.
8. **Confirmation that live trading remains unauthorized** and that Phase 0 output is research artifacts only.
9. **Whether independent verification of §6 (PDT elimination) is wanted** against FINRA Notice 26-10 / SEC Release 34-105226 — both primary sources were blocked to me.

---

## 13. FINAL VERDICT PER ROUTE

| Route | Verdict | Determining reason |
| --- | --- | --- |
| **A. Coinbase Advanced + NautilusTrader (spot)** | **PASS — Phase 0 only, economically gated** | Free real-time L2/trades/ticker confirmed in source; stable-labelled adapter; sandbox = live data + simulated execution with backtest-identical matching engine; $0 throughout. **Gated on P0-0 (HB-7 fees) and UK-1 (terms of use).** Not a judgment on profitability. |
| **A′. Coinbase CFM futures/perps** | **INSUFFICIENT_DATA** | NY eligibility unverified (UK-2). Better fee economics, but leverage risk plus adapter derivatives gaps (no `reduce_only`, no futures edits, REST-only position reports). |
| **B. Charles Schwab Trader API** | **FAIL** | 7-day refresh token, no programmatic renewal, weekly manual browser OAuth (HB-2). No API paper environment. One streamer per user. Leading community library dormant since mid-2025. Disqualifying for unattended operation. |
| **C. Alpaca (equities)** | **FAIL** | Free real-time = IEX only (~2.5% of volume); consolidated SIP = $99/mo (HB-4). Free tier historically capped at 30 WS symbols / 15-min historical delay / 200 calls-per-min. |
| **C′. Alpaca (crypto)** | **FAIL** | **Not offered to New York residents.** |
| **D. Interactive Brokers** | **FAIL** | Paid subscriptions required for real-time API data; free delayed data is L1-only with no tick-by-tick and no depth; ~$500 funded account to subscribe (HB-3). |
| **E. Freqtrade** | **FAIL** | **Zero** officially supported exchanges lawfully available to a NY resident. Coinbase not on the supported list (HB-1). |
| **F. LEAN / QuantConnect local** | **FAIL** | QuantConnect's own docs require a **paid tier** to use the CLI — including local backtesting and custom data (HB-5). Apache-2.0 engine-direct escape hatch exists but is a large unsupported build. |
| **G. Backtrader** | **FAIL** | Unmaintained since April 2023 (HB-6). |
| **H. Custom Python/CCXT** | **FAIL against stated preference** | Technically viable, but contradicts the explicit preference for a mature engine and maximizes hidden-integration risk — the exact failure mode of the previous project. |

---

## 14. OVERALL RECOMMENDATION

# ▶ B. PROCEED ONLY TO PHASE 0 FEASIBILITY TESTS

**Scope:** Coinbase Advanced Trade + NautilusTrader, spot only, tests P0-0 through P0-15 in §10. Zero dollars. Zero live orders. No strategy implementation.

**Hard preconditions before any engineering:**

1. **Resolve UK-1** (Coinbase Market Data Terms). If the restrictive reading applies to Advanced Trade, this becomes **A. NO BUILD** immediately.
2. **Pass P0-0** (economic gate). If required edge exceeds plausible edge at the user's real fee tier, this becomes **A. NO BUILD** — and that is a *good* outcome discovered for $0 in a day rather than after months of work.

**Sequencing:** Start P0-15 (forward L2/trade capture) on day one — it is the long pole and everything microstructure-related waits on it. Run P0-1→P0-8 (no credentials needed) in parallel. Only then introduce a View+Trade API key for P0-9→P0-14.

**Explicitly NOT recommended:** live trading; funding an account for research; any paid data, SaaS, or VPS; and — critically — **any inference about profitability from the fact that the infrastructure works.** The infrastructure working is a *necessary* condition and tells you nothing about edge. The fee arithmetic in HB-7 is the finding that should drive the decision, and it points toward difficulty.

**Recommendation C (research/paper-shadow validation) is withheld** until Phase 0 completes and P0-0, P0-8, and P0-11 pass. Shadow validation on a stack whose fees silently default to zero (SR-1) and whose determinism is unproven would manufacture exactly the false confidence this audit exists to prevent.

---

## 15. CLAIMS I DISAGREE WITH CHATGPT ABOUT

Eleven of the thirteen claims are correct or substantially correct. Two are materially wrong or incomplete. Three important issues were absent altogether.

### ✅ Confirmed (11)

| Claim | Finding |
| --- | --- |
| Alpaca Basic = free real-time IEX only; SIP = $99/mo | **CONFIRMED** — Alpaca's own materials |
| Alpaca paper does not simulate market impact, latency slippage, or queue position | **CONFIRMED VERBATIM** — Alpaca's docs also add *information leakage, price improvement, regulatory fees, and dividends* |
| IBKR requires market-data subscriptions for most API-accessed securities | **CONFIRMED** — plus: delayed data is L1-only, no tick-by-tick, no L2; ~$500 funded account |
| Kraken does not serve New York residents | **CONFIRMED** — exited Aug 2015; still no BitLicense or NY trust charter |
| Coinbase operates in NY; Advanced Trade requires no subscription | **CONFIRMED** — BitLicense + trust charter; no subscription, no minimum portfolio |
| Coinbase Advanced provides free real-time public WebSocket data | **CONFIRMED IN SOURCE** — `level2`, `market_trades`, `ticker` all `requires_auth() == false` |
| Coinbase Advanced has programmatic order-management APIs | **CONFIRMED** — with documented gaps (SR-6) |
| Coinbase sandbox is primarily static/mock, not a realistic paper exchange | **CONFIRMED** — *"All responses are static and pre-defined; there is no live market or dynamic pricing. Only Accounts and Orders endpoints are available."* |
| NautilusTrader has a Coinbase Advanced adapter supporting market data and execution | **CONFIRMED** — with the maturity caveat (SR-2) and the v2-only caveat (SR-3) |
| NautilusTrader can model latency, fees/fills, liquidity and queue position sufficiently for a realistic shadow environment | **CONFIRMED** — all four verified in source; the sandbox adapter delivers live-data + simulated-execution on the backtest matching engine. Caveat: Coinbase supplies L2 only, so queue position is approximate |
| Schwab API suitability for unattended algo trading "may be complicated" | **CONFIRMED, AND UNDERSTATED** — see disagreement #1 |

### ❌ Disagreement 1 — "Schwab's suitability for unattended algo trading **may be** complicated by authentication renewal."

**This is too soft. It is not a "may." It is a documented hard blocker.**

The refresh token is capped at seven days with, in the library maintainer's words, *"currently no way to make a refresh token last longer than seven days"* and *"no choice but to delete your old token file and create a new one"* — which requires an interactive browser OAuth login. For a system whose defining requirement is unattended operation, that is disqualifying, not complicating. Add: no API paper environment at all, one streamer connection per user (a second algorithm silently stops the first), app approval measured in days-to-a-month, and the leading community Python client dormant since mid-2025 with no official Schwab SDK.

**Hedged language here is the exact failure mode described in the project background** — a limitation that reads as a caveat in planning and becomes a wall in implementation. **Schwab is FAIL, not "complicated."**

### ❌ Disagreement 2 — "Free Coinbase historical data can be gathered in sufficient quantity for meaningful intraday strategy testing."

**Half true, and the missing half is the part that matters.**

True: 1-minute OHLCV is retrievable at scale for free (350 candles/request, ~1,500 requests for a year, comfortably inside the 10,000/hour quota).

**But "sufficient for meaningful intraday testing" does not follow, for three reasons:**

1. **There is no historical trade, quote, or order-book archive on the free path.** I read NautilusTrader's `request_trades` implementation directly (`crates/adapters/coinbase/src/data/mod.rs:915-987`): it calls the venue's *snapshot* market-trades endpoint with only a `limit`, and the `start`/`end` parameters are **computed and then never sent** — they are echoed into the response envelope only. Recent trades only. No pagination. No history.
2. **Coinbase documents its own candle history as incomplete** — *"no data published for intervals where there are no ticks."*
3. **NautilusTrader's own backtesting docs contradict the sufficiency claim directly:** bar data *"cannot establish intrabar price order, spread, depth, or queue position, so execution-sensitive strategies need more granular validation,"* with the explicit instruction to *"move to quotes, trades, or depth data before relying on results that depend on spread, exact intrabar order, tight exits, or queue position."*

So the queue-position and spread machinery ChatGPT correctly credits NautilusTrader with **cannot be fed from free Coinbase history at all.** The only free path to that data is recording it forward yourself (P0-15) — free in dollars, expensive in weeks.

**Corrected claim:** *free Coinbase history supports bar-level research only; any spread-, depth-, or queue-sensitive intraday research requires forward-recorded data and a multi-week waiting period.*

### ➕ Omission 1 — The fee structure is the project's dominant risk and it was not weighted as such.

0.60% taker / 0.40% maker at base tier = **0.80%–1.20% round trip**, needing $50k/month volume to improve, with stablecoin volume excluded from tier progression. This plausibly exceeds achievable retail intraday edge by 3–10×. No infrastructure decision changes it. Any assessment that concludes "technically feasible" without foregrounding this is answering the easy question. **This is the number the go/no-go should turn on** (HB-7, P0-0).

### ➕ Omission 2 — NautilusTrader's Coinbase instruments default to **zero fees**.

Default fee model is `MakerTakerFeeModel`; it multiplies notional by the instrument's `maker_fee`/`taker_fee`; the Coinbase adapter never populates them (`// maker_fee (loaded separately via transaction_summary)`), and `get_transaction_summary()` — though present on the HTTP client — is never called by the instrument provider. Both fields default to 0. **A first-run Coinbase backtest charges zero commission.** Directly undermines "fees from the FIRST backtest." Fixable, but silent, and it lives inside the exact recommended stack (SR-1, P0-11).

### ➕ Omission 3 — The Coinbase adapter is v2-only, and v2 is a release candidate.

The adapter is reachable only through the v2 `LiveNode`/PyO3 surface; v1 is on critical-security-backports-only. v2 is at **2.0.0rc3** with 40+ breaking changes in that release alone, and more expected before final. Committing here means absorbing breaking upgrades mid-research (SR-3).

### ➕ Context worth adding — the PDT rule is gone.

Not a disagreement (it was outside the listed claims), but it changes a standard assumption: the $25,000 pattern-day-trader minimum was **eliminated effective 2026-06-04**. It does not rescue the equities routes — they fail on authentication and data, not capital — but if the crypto fee gate fails, equities deserve a fresh look on economics rather than being dismissed on the old $25k floor (§6).

---

## APPENDIX A — PRIMARY SOURCES CONSULTED

**Source code and repositories read directly (strongest evidence):**
- [nautechsystems/nautilus_trader](https://github.com/nautechsystems/nautilus_trader) @ `f2b2addb99527e3c9465573a596284f47b9edf10` (2026-08-27) — `docs/integrations/coinbase.md`; `docs/concepts/backtesting/{fill-models,trade-execution,data-and-venues,execution-flow,fill-prices-and-matching}.md`; `docs/concepts/overview.md`; `crates/adapters/coinbase/src/{data/mod.rs,execution.rs,provider.rs,http/{parse.rs,client.rs},websocket/client.rs,common/enums.rs}`; `crates/execution/src/models/{fee.rs,latency.rs,fill.rs}`; `crates/execution/src/matching_engine/mod.rs`; `crates/model/src/instruments/currency_pair.rs`; `RELEASES.md`; `MIGRATION_V2.md`; `README.md`; `examples/live/coinbase/`
- [QuantConnect/Documentation](https://github.com/QuantConnect/Documentation) (cloned 2026-08-27) — LEAN CLI backtesting, datasets, and brokerage gating
- [QuantConnect/Lean.Brokerages.Coinbase](https://github.com/QuantConnect/Lean.Brokerages.Coinbase) (last commit 2026-06-19)
- [alexgolec/schwab-py](https://github.com/alexgolec/schwab-py) — `docs/auth.rst`
- [alpacahq/alpaca-docs](https://github.com/alpacahq/alpaca-docs) — `content/trading/paper-trading.md`, `content/market-data/_index.md`
- [freqtrade/freqtrade](https://github.com/freqtrade/freqtrade) — `README.md` @ `develop`
- PyPI release metadata (queried 2026-08-27): backtrader, nautilus_trader, freqtrade, lean, ccxt, alpaca-py, schwab-py, ib-insync, ibapi

**Vendor / regulator documentation (via search where blocked):**
- [Coinbase Advanced Trade WebSocket guide](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/guides/websocket) · [Get Product Candles](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/products/get-product-candles) · [Create Order](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/create-order) · [Rate limiting](https://docs.cdp.coinbase.com/coinbase-app/api-architecture/rate-limiting) · [Market Data Terms of Use](https://www.coinbase.com/legal/market_data) ⚠️ *unverified — blocked*
- [Alpaca Market Data](https://alpaca.markets/data) · [Alpaca paper trading](https://docs.alpaca.markets/us/docs/paper-trading)
- [IBKR Live Data Limitations](https://www.interactivebrokers.com/docs/tws-api/doc/market-data-live/live-data-limitations) · [IBKR Market Data Pricing](https://www.interactivebrokers.com/en/pricing/market-data-pricing.php)
- [Charles Schwab Developer Portal](https://developer.schwab.com/)
- [OKX US licenses](https://www.okx.com/en-us/help/us-licenses) · [Binance.US supported states](https://support.binance.us/en/articles/9842798-list-of-supported-and-unsupported-states-and-regions) · [Bybit service-restricted countries](https://www.bybit.com/en/help-center/article/Service-Restricted-Countries)
- [NYDFS virtual currency businesses](https://www.dfs.ny.gov/virtual_currency_businesses)
- [FINRA Regulatory Notice 26-10](https://www.finra.org/rules-guidance/notices/26-10) ⚠️ *blocked* · [SEC Release 34-105226](https://www.sec.gov/files/rules/sro/finra/2026/34-105226.pdf) ⚠️ *blocked* · [WilmerHale client alert](https://www.wilmerhale.com/en/insights/client-alerts/20260423-sec-approves-amendments-to-finra-rule-4210-replacing-day-trading-margin-requirements-with-a-modernized-intraday-margin-standard)

**Community / operational evidence (labeled as such):**
- [nautilus_trader issue #3816](https://github.com/nautechsystems/nautilus_trader/issues/3816) — Coinbase Advanced Trade adapter tracking issue (closed/Done)
- [nautilus_trader open bug issues](https://github.com/nautechsystems/nautilus_trader/issues?q=is%3Aissue+is%3Aopen+label%3Abug) — as of Aug 2026: 7 Binance issues (#4733–4739), IB duplicate-order-after-modify (#4564), cross-strategy cancel scoping (#4470), Feather→Parquet silent no-write (#4607), OptionSpread combo fills breaking backtest position accounting (#4329). **No open Coinbase-specific bugs at audit time.**
- [hummingbot #7207](https://github.com/hummingbot/hummingbot/issues/7207) — Coinbase Advanced Trade WebSocket failure with orders placed but untracked (Sept 2024, closed via PR #7220). *Different codebase; illustrative of the failure class only.*
- [Backtrader "Is Backtrader dead?"](https://community.backtrader.com/topic/3702/is-backtrader-dead)
- [IsDown Coinbase API incident history](https://isdown.app/status/coinbase/coinbase-api) · [Coinbase Status](https://status.coinbase.com/) · [CDP Status](https://cdpstatus.coinbase.com/)
- ⚠️ **Reddit (r/algotrading and exchange communities) was inaccessible from this environment. No Reddit evidence is cited or implied anywhere in this audit.**

---

*End of audit. Nothing was built. No repository was created. No order was placed. No paid service was purchased or recommended.*
