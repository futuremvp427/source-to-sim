# SECOND-PASS ADVERSARIAL FEASIBILITY AUDIT — Automated Day-Trading Bot

**Audit date:** 2026-08-27 · **Pass:** 2 (adversarial re-examination) · **Jurisdiction:** New York State retail individual
**Scope:** Verification only. Nothing built. No repository created. No strategy written. No order submitted. No API secrets requested. No paid data recommended.
**Supersedes:** the first-pass audit dated 2026-08-27 on the points explicitly corrected below.

---

## 0. EVIDENCE-ACCESS DISCLOSURE

Egress restrictions from the first pass persist and **expanded** to cover the new candidates. Blocked this pass:

`coinbase.com` · `docs.cdp.coinbase.com` · `lightning.bitflyer.com` · `bf-lightning-api.readme.io` · `bitflyer.com` · `api.bitflyer.com` · `gemini.com` · `developer.gemini.com` · `docs.gemini.com` · `docs.sandbox.gemini.com` · `docs.robinhood.com` · `okx.com` · `finra.org` · `sec.gov` · `reddit.com` · `web.archive.org`

**Method used instead — and why it is stronger for the questions that actually decide this audit.** Every framework/capability question in §2 and §5 was answered by **reading the implementing source code directly** from `raw.githubusercontent.com`, which was reachable. Source code is not a summary of behavior; it *is* the behavior. Where a search summary and source code disagreed, source code won — and it did disagree, twice (documented in §11).

**Method: HTTP status as existence proof.** For "does framework X support venue Y," I fetched the connector file path and treated 200/404 as the answer, **with a control set** of known-supported venues fetched in the same call to prove the path convention was right. Every such test in this document ran with controls. No control failed.

**What remains unverifiable and is labelled as such:** the *scope clause* and *section numbering* of the Coinbase Market Data Terms; Gemini's Market Data Fee Schedule; Gemini's exact base ActiveTrader tier; Robinhood's order-book depth availability. These are carried as UNKNOWNS with user action items, not resolved by inference.

---

## 1. COINBASE — MARKET DATA TERMS §3.5

### 1.1 What I could and could not verify

`coinbase.com/legal/market_data` is blocked to me. I could not read the document, could not confirm the clause is numbered **3.5**, and could not confirm the **August 7, 2026** date from the page itself.

What I *can* report: **two independent search retrievals of that exact URL returned the same clause text verbatim**, and one retrieval independently noted the page was *"updated approximately 3 weeks ago"* — which, from an audit date of 2026-08-27, back-calculates to roughly **2026-08-06/07**. That is consistent with ChatGPT's stated date. It is corroboration, not proof.

The clause text, returned identically on both retrievals:

> *"...develop, train, fine-tune, teach, validate, benchmark, or otherwise improve any artificial intelligence or machine learning model, algorithm, chatbot, agent, or other automated system, whether generative or non-generative, or for any other purpose related to the research, development, or operation of artificial intelligence technologies."*

### 1.2 Does our intended use fall within it?

This turns on a genuine grammatical ambiguity, and I will state both readings rather than pick the convenient one.

**Reading A — BROAD (plain-text reading).** The enumerated objects are *"any artificial intelligence or machine learning model, **algorithm**, chatbot, agent, or **other automated system**."* Read naturally, `algorithm` and `other automated system` are independent list members, not sub-species of AI/ML. An automated trading bot is unambiguously an *algorithm* and an *automated system*. Backtesting and shadow-testing it against recorded Coinbase data is unambiguously *"validate"* and *"benchmark."* **Under Reading A, the entire Phase 0 plan is prohibited absent written Coinbase consent.**

**Reading B — NARROW.** The trailing catch-all — *"or for any other purpose related to the research, development, or operation of artificial intelligence technologies"* — signals that the drafter's target is AI technology. On this reading `artificial intelligence or machine learning` distributes across the whole list, and a purely rule-based (non-ML) trading algorithm falls outside.

**Assessment.** Reading A is the plain-text reading and is what a court construing the words as written would most likely reach; the *ejusdem generis* argument for Reading B has to work against the fact that "algorithm" and "automated system" are separately enumerated rather than appearing only in the trailing clause. And Reading B collapses entirely the moment any ML touches the project — parameter fitting, a classifier, a regime detector, hyperparameter search. Realistic quantitative research does not stay non-ML for long.

Three further points make this worse, not better:

1. **The retrieved text contains no personal-use or internal-use carve-out.** I could not read the full document, so one may exist elsewhere in it — but nothing in the operative clause suggests the prohibition softens for individuals.
2. **The verbs are precisely our verbs.** "Validate" and "benchmark" are not incidental; they are the literal names of the Phase 0 activities.
3. **The burden of proof runs the wrong way.** You do not build a system on an unresolved contractual prohibition and hope for the narrow reading. A venue whose terms *arguably* forbid the use case is strictly worse than an otherwise-comparable venue whose terms do not.

### 1.3 Verdict on Coinbase

**COINBASE ADVANCED TRADE — FAIL. Presumptively eliminated, and I concur with that framing.**

Note what this does *not* rest on: I am not claiming to have proved the prohibition applies. I am concluding that an unresolved, plausibly-applicable contractual bar on the exact intended activity is disqualifying **on its own**, before the fee problem (0.80–1.20% round trip, first-pass §HB-7) is even considered. Coinbase now fails on two independent grounds.

This can be reopened only by the user obtaining either (a) the full terms text showing a scope limitation or personal-use carve-out that excludes this activity, or (b) written Coinbase consent. Absent one of those, Coinbase is closed.

### 1.4 NautilusTrader Coinbase fill-ID warning — INDEPENDENTLY VERIFIED

Confirmed verbatim from `docs/integrations/coinbase.md` at commit `f2b2add`, lines 825–829:

> **"Stable fill identity differs across live and REST paths.** The user channel does not provide Coinbase's per-fill `trade_id`, so live `FillReport` values use IDs synthesized from the venue order ID and cumulative quantity. REST reconciliation uses the venue `trade_id`, so the identifiers can differ across live processing and reconciliation."

And lines 654–664:

> *"The execution client maintains a 10,000-entry FIFO dedup keyed on `(venue_order_id, trade_id)`... After very long disconnections (beyond the in-memory dedup window) replayed fills may emit duplicate `FillReport` values; strategies should rely on REST reconciliation to recover canonical state in that case."*

**Confirmed, and the stated consequence is correct:** because the live-path identifier is *synthesized* from `(venue_order_id, cumulative_quantity)` while the reconciliation-path identifier is the venue's own `trade_id`, the same economic fill carries two different identities depending on which path observed it. **Fill idempotence across a restart therefore cannot be proven from identifiers alone** — it can only be re-derived by trusting REST reconciliation as canonical and discarding live-path identity. That is a design decision the adapter documents honestly, but it is a real limitation, and ChatGPT characterized it correctly. Moot for the go/no-go given §1.3, but the claim stands.

---

## 2. VERIFICATION OF PRIOR NAUTILUS FINDINGS

All checks against `nautechsystems/nautilus_trader` @ `f2b2addb99527e3c9465573a596284f47b9edf10` (2026-08-27 22:24 +1000). No speculation below; every claim is a file and line number.

### 2.1 `request_trades` ignores the requested interval — **CONFIRMED**

`crates/adapters/coinbase/src/data/mod.rs`:

```rust
915:  fn request_trades(&self, request: RequestTrades) -> anyhow::Result<()> {
932:      let limit = request.limit.map_or(100, |n| n.get() as u32);
933:      let start_nanos = datetime_to_unix_nanos(request.start);
934:      let end_nanos   = datetime_to_unix_nanos(request.end);
...
939:      match http.get_market_trades(&product_id, limit).await {
```

**Exhaustive usage audit of `start_nanos` / `end_nanos` inside `request_trades`** (grep over the function body, all occurrences):

| Line | Use |
| --- | --- |
| 933 | assignment |
| 934 | assignment |
| ~974 | passed to `TradesResponse::new(...)` |
| ~975 | passed to `TradesResponse::new(...)` |

**There is no fifth occurrence.** They are computed, then handed to the *response constructor*. They never reach the HTTP layer.

The HTTP layer, `crates/adapters/coinbase/src/http/client.rs:465-470`:

```rust
pub async fn get_market_trades(&self, product_id: &str, limit: u32) -> Result<Value> {
    let query = format!("limit={limit}");
    self.get_public_with_query(&format!("/market/products/{product_id}/ticker"), &query).await
}
```

The query string is **literally `limit={limit}`** and the endpoint is **`/ticker`**.

**The decisive contrast is in the adjacent function.** `get_candles` at line ~460 *does* build a time range:

```rust
let query = format!("start={start}&end={end}&granularity={granularity}");
self.get_public_with_query(&format!("/market/products/{product_id}/candles"), &query).await
```

So the adapter demonstrably knows how to pass a time window — it simply does not do so for trades.

**CONFIRMED, both parts:** the interval is computed and discarded; the returned trades are a **recent snapshot** from `/ticker`; and the response metadata nonetheless carries `start`/`end`, so a caller inspecting the response envelope would be **actively misled** into believing it received the range it asked for. There is no historical trade pagination on this path.

### 2.2 Coinbase instrument parsing leaves maker/taker fees unset — **CONFIRMED**

`crates/adapters/coinbase/src/http/parse.rs:175-190`:

```rust
let instrument = CurrencyPair::builder()
    .instrument_id(instrument_id)
    .raw_symbol(raw_symbol)
    .base_currency(base_currency)
    .quote_currency(quote_currency)
    .price_precision(price_precision)
    .size_precision(size_precision)
    .price_increment(price_increment)
    .size_increment(size_increment)
    .maybe_max_quantity(max_quantity)
    .maybe_min_quantity(min_quantity)
    // maker_fee (loaded separately via transaction_summary)
    .ts_event(ts_init)
    .ts_init(ts_init)
    .build()
    .unwrap();
```

No `.maker_fee(...)`, no `.taker_fee(...)`. The only trace is a comment.

### 2.3 `/transaction_summary` exists — **CONFIRMED**

`crates/adapters/coinbase/src/http/client.rs`:
```rust
536:  pub async fn get_transaction_summary(&self) -> Result<Value> {
537:      self.get("/transaction_summary").await
1009: pub async fn get_transaction_summary(&self) -> Result<Value> {   // outer wrapper
1010:     self.inner.get_transaction_summary().await
```

### 2.4 THE EXACT CALL GRAPH — does any production code inject those fees? **NO.**

Repository-wide exhaustive grep, `--include=*.rs --include=*.py --include=*.pyi`, entire tree:

```
$ grep -rn "transaction_summary" .
./crates/adapters/coinbase/src/http/client.rs:536:  pub async fn get_transaction_summary(&self) -> Result<Value> {
./crates/adapters/coinbase/src/http/client.rs:537:      self.get("/transaction_summary").await
./crates/adapters/coinbase/src/http/client.rs:1009: pub async fn get_transaction_summary(&self) -> Result<Value> {
./crates/adapters/coinbase/src/http/client.rs:1010:     self.inner.get_transaction_summary().await
./crates/adapters/coinbase/src/http/parse.rs:186:      // maker_fee (loaded separately via transaction_summary)
```

**Four occurrences: two definitions and one comment. Zero call sites** — not in `provider.rs`, not in `data/`, not in `execution.rs`, not in the Python bindings, **not even in tests**.

```
$ grep -rn "maker_fee\|taker_fee" crates/adapters/coinbase/
crates/adapters/coinbase/src/http/parse.rs:186:      // maker_fee (loaded separately via transaction_summary)
```

**In the entire Coinbase adapter, the strings `maker_fee` and `taker_fee` occur exactly once — inside a comment.**

**Call graph — proven NO:**

```
CoinbaseInstrumentProvider (provider.rs)
      │
      ├─► parse_spot_instrument      (parse.rs:160-193)  ─► CurrencyPair::builder()      ─► NO fee setter
      ├─► parse_perpetual_instrument (parse.rs:195-238)  ─► CryptoPerpetual::builder()   ─► NO fee setter
      └─► parse_future_instrument    (parse.rs:~240-305) ─► CryptoFuture::builder()      ─► NO fee setter

CoinbaseRawHttpClient::get_transaction_summary  (client.rs:536)   ◄── 0 callers  [DEAD CODE]
CoinbaseHttpClient::get_transaction_summary     (client.rs:1009)  ◄── 0 callers  [DEAD CODE]
```

The fee-bearing endpoint is wired to nothing. **Definitive answer: NO production code injects transaction-summary fee rates into Coinbase instruments.**

### 2.5 Would the default backtest commission model actually charge zero? **YES — proven end to end.**

Five links, each a file and line:

**① Unset builder fields default to zero.** `crates/model/src/instruments/currency_pair.rs` (a `#[bon::bon]` builder, line 102) — `new_checked`:
```rust
174:  maker_fee: maker_fee.unwrap_or_default(),
175:  taker_fee: taker_fee.unwrap_or_default(),
```
`Option::None` → `Decimal::default()` → **`0`**.

**② The accessors return that zero.** Same file:
```rust
370:  fn taker_fee(&self) -> Decimal { self.taker_fee }
374:  fn maker_fee(&self) -> Decimal { self.maker_fee }
```

**③ The default fee model is MakerTaker.** `crates/execution/src/models/fee.rs:233-237`:
```rust
impl Default for FeeModelAny {
    fn default() -> Self { Self::MakerTaker(MakerTakerFeeModel) }
}
```

**④ MakerTaker multiplies notional by the instrument's rate.** `crates/execution/src/models/fee.rs:398-416`:
```rust
let rate = match order.liquidity_side() {
    Some(LiquiditySide::Maker) => instrument.maker_fee(),
    Some(LiquiditySide::Taker) => instrument.taker_fee(),
    ...
};
let commission = mul_checked(notional.as_decimal(), rate)?;
```

**⑤ An unset fee model resolves to that default — in BOTH environments.**

*Backtest*, `crates/backtest/src/node.rs:243`:
```rust
let fee_model = venue_config.fee_model().cloned().unwrap_or_default().into();
```

*Sandbox (live-data shadow execution)*, `crates/adapters/sandbox/src/execution.rs:182-187`:
```rust
let fee_model = self.config.fee_model.clone()
    .map(FeeModelHandle::from)
    .unwrap_or_default();
```
(`FeeModelHandle::default()` → `FeeModelAny::default().into()`, fee.rs:116-119 → MakerTaker.)

**Conclusion, no speculation:** with no explicit fee model supplied, `commission = notional × 0 = 0`. **A default NautilusTrader backtest *or sandbox shadow run* on Coinbase instruments charges exactly zero commission.** The trap applies to the shadow environment as well as the backtester — which is worse than the first pass stated, because the shadow environment was the component most likely to be trusted as "realistic."

Moot for Coinbase given §1.3. **Not moot as a general lesson:** the same class of silent-zero-fee defaulting must be explicitly tested on whichever venue is eventually chosen (Test P0-F, §12).

---

## 3. PDT CLAIM — CORRECTION

**Yes, my prior framing was too broad, and I withdraw it as phrased.**

What I wrote in the first pass — *"The FINRA pattern-day-trader rule and the $25,000 minimum equity requirement have been eliminated"* — states a conclusion about the world that does not follow from the rule change alone.

**What is accurate:**
- FINRA Rule 4210's amendments **became effective 2026-06-04**, and they do remove the "pattern day trader" definition, the day-trade count thresholds, and the $25,000 minimum equity requirement **from the rule text**.
- Firms have a **transition period through 2027-10-20** to implement the replacement intraday-margin standard.

**What was wrong with my framing:** "eliminated" describes the *rule*, but a retail trader experiences the *broker's* policy, not the rule text. During the transition window a broker may lawfully continue to enforce the old $25,000 PDT regime. Separately and permanently, brokers may impose **house margin requirements stricter than FINRA's** — that has always been true and the amendments do not change it. So a New York retail customer in August 2026 may well still face a $25,000 day-trading gate at their specific broker, entirely lawfully.

**Correct statement:** *As of 2026-06-04 FINRA Rule 4210 no longer imposes the pattern-day-trader designation or the $25,000 minimum equity requirement; however, firms may continue applying the prior regime through the 2027-10-20 transition period, and may impose stricter house requirements indefinitely. Whether any $25,000 gate applies is a per-broker question that must be confirmed with the specific broker.*

In fairness to the record, the first pass did carry the phase-in caveat and did note brokers were "transitioning at different rates" — but the section heading and lead sentence asserted flat elimination, and a reader taking the headline would be misled. That is my error and the correction stands regardless.

Secondary, as you note: crypto spot is unaffected — PDT has never applied to crypto.

---

## 4. BITFLYER USA — RED-TEAM AUDIT

### 4.1 Legal / account

| Item | Finding | Confidence |
| --- | --- | --- |
| **NY availability** | ✅ **bitFlyer USA holds a NYDFS BitLicense** (granted Nov 2017, the 4th ever issued). Operates as a registered MSB across ~40+ states. | High |
| **Regulatory history — RED FLAG** | ⚠️ **NYDFS Consent Order, 2023-05-01: $1,200,000 civil penalty** for cybersecurity-program failures. NYDFS found bitFlyer **failed to conduct periodic risk assessments** ("the core essential component of a Covered Entity's cybersecurity program") and that its information security policy contained *"several material errors, including omission of governance and the organization's structure,"* and was *"poorly translated from the Japanese originals."* Remediation was due 2023-12-31. | High — [DFS consent order PDF](https://www.dfs.ny.gov/system/files/documents/2024/10/ea20230501_bitflyer_usa_inc.pdf) |
| Retail Lightning/API access | ✅ Retail users get Lightning; bitFlyer publishes an HTTP API and a Realtime API | High |
| Automated/programmatic personal trading | ⚠️ **Not verified against the API Terms of Use** — `bitflyer.com` and `lightning.bitflyer.com` are blocked to me. The existence of a documented public API and an official API landing page is strong circumstantial evidence, not a permission grant. **UNKNOWN — see §10.** | — |
| Market-data fee | ✅ No market-data fee found; public HTTP + Realtime endpoints are unauthenticated | Medium |
| **Local storage of market data for personal research** | ⚠️ **UNVERIFIED.** This is the exact question that killed Coinbase. It must be answered from bitFlyer's API Terms before any capture begins. **UNKNOWN — see §10.** | — |
| Account minimum | No documented minimum funding | Medium |
| Minimum order size | **0.001 BTC** on Lightning | High |
| API key permissions | Permissions are scoped; `getpermissions` endpoint exists; `withdraw` / `sendcoin` are **separate POST endpoints**, so a trade-only key excluding withdrawal is structurally supported | Medium-High |

The 2023 consent order does not disqualify bitFlyer — it is resolved and remediated — but for an operator entrusting API credentials to a venue, a regulator finding that the venue never performed risk assessments and shipped a badly-translated security policy is a governance signal worth pricing in.

### 4.2 Fees — **the strongest finding in bitFlyer's favor**

**bitFlyer USA Lightning BTC/USD and ETH/USD: fees start at 0.10%, and taker fees match maker fees** on the US/EU markets, tiering down by 30-day volume.

**Round-trip fee friction ≈ 0.20%** regardless of maker/taker mix.

That is **4× to 6× cheaper than Coinbase Advanced Trade base tier** (0.80–1.20%) and roughly **2× cheaper than Gemini ActiveTrader base** (0.40–0.80%). On fee economics alone bitFlyer is the best New-York-legal venue found in either pass. *(Confidence: medium-high — multiple secondary sources agree on "starts at 0.10%" and maker=taker for US; bitFlyer's own fee page is blocked to me. Must be confirmed from the account.)*

### 4.3 Market data and API mechanics

Derived from CCXT's bitFlyer implementation (`ccxt/ts/src/bitflyer.ts`, master) and pybotters' bitFlyer DataStore (`pybotters/models/bitflyer.py`, main) — both read directly.

**Public HTTP endpoints:** `getmarkets`, `getmarkets/usa`, `getmarkets/eu`, `getboard`, `getticker`, `getexecutions`, `getboardstate`, `gethealth`, `getchats`, `getfundingrate`
**Private HTTP GET:** `getpermissions`, `getbalance`, `getcollateral`, `getchildorders`, `getparentorders`, `getparentorder`, `getexecutions`, `getpositions`, `gettradingcommission`, plus deposit/withdrawal history
**Private HTTP POST:** `sendchildorder`, `cancelchildorder`, `cancelallchildorders`, `sendparentorder`, `cancelparentorder`, `sendcoin`, `withdraw`

| Capability | Finding |
| --- | --- |
| **Market health / status** | ✅ **`gethealth` and `getboardstate` both exist** — better than most venues. Real maintenance/health signalling. |
| Order book depth | ✅ `getboard` (REST) + `lightning_board_*` (WS) |
| Trades | ✅ `getexecutions` (REST) + `lightning_executions_*` (WS) |
| Ticker / bid-ask | ✅ `getticker` + `lightning_ticker_*` |
| **OHLCV / candles** | ❌ **The venue exposes no candle endpoint.** Bars must be built from executions. |
| **Historical execution retention** | ⚠️ **~31 days.** bitFlyer's docs state that as of 2018-12-19, execution history obtainable via the `before` parameter is **limited to the most recent 31 days**. **ChatGPT's claim CONFIRMED.** |
| Pagination | ✅ `count`, `before`, `after` |
| **Execution sequence IDs** | ✅ Executions carry a **monotonic integer `id`** (e.g. `"id": 37233`) → trade-stream gap detection is possible |
| **Order-book sequence IDs** | ❌ **None found.** Board messages are `{mid_price, asks, bids}` with no sequence field. **pybotters' `Board._onmessage` performs zero sequence validation** and instead prunes levels heuristically against `mid_price` — a workaround characteristic of an unsequenced feed. Resync is via the separate `lightning_board_snapshot_*` channel. **You cannot prove no book delta was dropped; you can only periodically re-snapshot and reconcile.** |
| Realtime endpoint | `wss://ws.lightstream.bitflyer.com/json-rpc`, JSON-RPC 2.0; `auth`/`subscribe`/`unsubscribe`/`channelMessage` |
| **Reconnect** | ❌ **bitFlyer's own docs state the sample code omits reconnection and "you need to implement it."** No library-provided reconnect semantics. |
| Order-rate limit | Orders ≤ 0.1 BTC: **100 placements/minute**; breach → punitive **10/minute for one hour** |

### 4.4 Execution and idempotency — **the disqualifying technical finding**

**bitFlyer provides no client-supplied order ID.** Verified in CCXT source:

`createOrder` (`bitflyer.ts:685-703`) builds the request with exactly five fields:
```ts
const request: Dict = {
    'product_code':     this.marketId (symbol),
    'child_order_type': type.toUpperCase (),
    'side':             (side as string).toUpperCase (),
    'price':            price,
    'size':             amount,
};
const result = await this.privatePostSendchildorder (this.extend (request, params));
const id = this.safeString (result, 'child_order_acceptance_id');
```

And the order parser, `bitflyer.ts:769`:
```ts
'clientOrderId': undefined,
```

The only identifier — `child_order_acceptance_id` — is **assigned by the exchange on acceptance**. The client cannot choose it in advance.

**Why this is severe.** If `sendchildorder` returns a timeout, a 5xx, or a dropped connection, the outcome is unknown *and unrecoverable by identifier*, because no identifier was ever agreed with the venue. You cannot ask "did order X land?" — X did not exist until the venue answered. Recovery collapses to polling `getchildorders` and heuristically matching on (product, side, price, size, timestamp). Two identical orders placed seconds apart are **indistinguishable**.

Consequences, all of which fall directly on the requirements list:
- **Duplicate-order protection:** must be built entirely client-side, and can only ever be heuristic.
- **Restart reconciliation:** cannot be made deterministic. After a crash you cannot prove which of your intended orders reached the venue.
- **Safe retry:** impossible. Any retry of an ambiguous submit risks a genuine duplicate position.

This is *worse* than Coinbase, where NautilusTrader at least caches submit metadata under a `client_order_id` and can reason about in-flight orders. It is the single most important technical fact about bitFlyer for this project.

| Order feature | Support |
| --- | --- |
| Market / Limit | ✅ via `child_order_type` |
| **Stop, Stop-Limit, Trailing, OCO/IFD** | ✅ **at the venue**, via `sendparentorder` (parent/special orders) — but ❌ **CCXT does not implement `sendparentorder`'s order types** |
| Cancel | ✅ `cancelchildorder` |
| **Cancel-all** | ✅ endpoint exists (`cancelallchildorders`) — ❌ **CCXT does not implement it** (`'cancelAllOrders': undefined`, with a comment linking to the very endpoint) |
| Partial fills | ✅ reflected in child-order state |
| Order status / fill lookup | ✅ `getchildorders`, private `getexecutions` |
| **Client order ID / idempotency** | ❌ **None** |

### 4.5 Sandbox — playground only, **ChatGPT's characterization is correct**

bitFlyer publishes an **API Playground** (`lightning.bitflyer.com/docs/playground`) and a **Realtime API Playground**. These are **interactive request-builder consoles that issue real calls against the real venue**, not an isolated exchange with test funds. **There is no bitFlyer sandbox.**

**Can a zero-money shadow environment be built safely on bitFlyer?** Yes in principle — public feeds need no credentials, so market-data capture and simulated execution can run with *no API key at all*, which is the safest possible configuration (a key that does not exist cannot place an order). But this requires you to supply the entire simulated matching engine yourself, because — see §5 — no framework will supply one for bitFlyer.

---

## 5. BITFLYER FRAMEWORK AUDIT — **THE DECISIVE SECTION**

Every result below is a direct source-code or file-existence check with controls.

### 5.1 Framework coverage — file-existence tests with control sets

**CCXT Pro (unified WebSocket):**
```
ts/src/pro/binance.ts   → 200   (control)
ts/src/pro/kraken.ts    → 200   (control)
ts/src/pro/coinbase.ts  → 200   (control)
ts/src/pro/bitmex.ts    → 200   (control)
ts/src/pro/bitflyer.ts  → 404   ◄── ABSENT
python/ccxt/pro/bitflyer.py → 404
js/src/pro/bitflyer.js      → 404
```
**CCXT Pro does not support bitFlyer, in any language binding.**

**Hummingbot:**
```
connector/exchange/binance/__init__.py                  → 200  (control)
connector/exchange/kraken/__init__.py                   → 200  (control)
connector/exchange/coinbase_advanced_trade/__init__.py  → 200  (control)
connector/exchange/gate_io/__init__.py                  → 200  (control)
connector/exchange/bitstamp/__init__.py                 → 200  (control)
connector/exchange/bitflyer/__init__.py                 → 404  ◄── ABSENT
```
**No Hummingbot bitFlyer connector.**

**NautilusTrader** (local clone, full-tree grep): the only `bitflyer` matches in the entire repository are `crates/adapters/tardis/src/common/enums.rs` and `docs/integrations/tardis.md` — i.e. bitFlyer appears **only as a venue label inside the Tardis adapter**, and Tardis is a **paid** historical-data vendor. **There is no NautilusTrader bitFlyer adapter.** *(Trap warning: a keyword search for "nautilus bitflyer" will surface these hits and can be misread as support. It is not support.)*

**LEAN:** `Common/Brokerages/BrokerageName.cs` — **0** occurrences of `bitflyer`. **No LEAN brokerage.**

**pybotters 1.11.2** (released 2026-04-17, actively maintained): ✅ **genuine, complete bitFlyer support** — `bitFlyerDataStore` with `Board`, `Ticker`, `Executions`, `ChildOrderEvents`, `ParentOrderEvents`, `ChildOrders`, `ParentOrders`. But pybotters is an **async API client library**. It has **no backtester, no matching engine, no fill model, no fee model, no shadow-execution environment, no strategy runtime**. It solves connectivity, not semantics.

### 5.2 Freqtrade — ChatGPT's claim is **CORRECT BUT INCOMPLETE**

I traced Freqtrade's actual gate rather than trusting the claim.

`freqtrade/exchange/common.py:72-81`:
```python
EXCHANGE_HAS_REQUIRED: dict[str, list[str]] = {
    "fetchOrder":       ["fetchOpenOrder", "fetchClosedOrder"],
    "fetchL2OrderBook": ["fetchTicker"],
    "cancelOrder":      [],
    "createOrder":      [],
    "fetchBalance":     [],
    "fetchOHLCV":       [],
}
```

`freqtrade/exchange/exchange_utils.py:57-69`:
```python
return [ k for k, v in required.items()
         if ex_mod.has.get(k) is not True
         and (len(v) == 0 or not (all(ex_mod.has.get(x) for x in v))) ]
```

Note `is not True` — an **identity** check. A truthy string like `'emulated'` **fails** it.

bitFlyer's CCXT `has` map (`ts/src/bitflyer.ts:36-64`, mirrored in `python/ccxt/bitflyer.py`):
```
'cancelAllOrders':   undefined / None
'cancelOrder':       true
'createOrder':       true
'fetchBalance':      true
'fetchClosedOrders': 'emulated'
'fetchMyTrades':     true
'fetchOpenOrders':   'emulated'
'fetchOrder':        'emulated'     ← line 64 (TS) / 66 (PY)
'fetchOrderBook':    true
'fetchOrders':       true
'fetchTicker':       true
'fetchTrades':       true
'fetchOHLCV':        undefined / None  ← line 209 (TS) / 211 (PY)
```

Evaluating the gate, item by item:

| Required | bitFlyer value | `is not True`? | Fallbacks satisfied? | **Missing?** |
| --- | --- | --- | --- | --- |
| `fetchOrder` | `'emulated'` | ✅ yes (string ≠ `True`) | `fetchOpenOrder`/`fetchClosedOrder` (**singular** — absent) → no | ❌ **MISSING** |
| `fetchL2OrderBook` | absent | ✅ yes | `fetchTicker` = true → yes | ok |
| `cancelOrder` | `true` | no | — | ok |
| `createOrder` | `true` | no | — | ok |
| `fetchBalance` | `true` | no | — | ok |
| `fetchOHLCV` | `None` | ✅ yes | none defined | ❌ **MISSING** |

**Result: `validate_exchange('bitflyer')` returns `False` with reason `"missing: fetchOrder, fetchOHLCV"`.**

Also relevant: `validate_exchange` line 78 does `getattr(ccxt.pro, exchange.lower())()` and falls back to `ccxt.async_support` on `AttributeError` — bitFlyer takes the fallback path, independently confirming no CCXT Pro. And `watchOHLCV` (in `EXCHANGE_HAS_OPTIONAL`) is absent → also reported as a missing optional. bitFlyer is **not** in `BAD_EXCHANGES`, so the rejection is purely capability-driven.

**Verdict on ChatGPT's claim:** correct that Freqtrade marks bitFlyer invalid and correct that `fetchOrder` is a cause — but it named only half the failure. **`fetchOHLCV` is also missing, and it is the more damaging of the two**, because it means Freqtrade cannot obtain a single candle from bitFlyer for backtesting. Freqtrade's entire research workflow is candle-based.

### 5.3 Exactly what CCXT supports for bitFlyer

| Unified call | bitFlyer | Note |
| --- | --- | --- |
| `createOrder` | ✅ native | 5 fields; **no client order ID** |
| `cancelOrder` | ✅ native | |
| `fetchOrder` | ⚠️ **`'emulated'`** | client-side filter over `fetchOrders` |
| `fetchOpenOrders` | ⚠️ `'emulated'` | |
| `fetchClosedOrders` | ⚠️ `'emulated'` | |
| `fetchOrders` | ✅ native | |
| `fetchMyTrades` | ✅ native | |
| `fetchTrades` | ✅ native | **~31-day retention ceiling** |
| `fetchOrderBook` | ✅ native | REST snapshot |
| `fetchTicker` | ✅ native | |
| **`fetchOHLCV`** | ❌ **not supported** | venue has no candle endpoint |
| **`cancelAllOrders`** | ❌ **not implemented** | **venue endpoint exists** — pure CCXT gap |
| **CCXT Pro WebSocket** | ❌ **none** | no `watchTrades`/`watchOrderBook`/`watchOrders`/`watchMyTrades` |

### 5.4 Can venue-specific endpoints fill the gaps with a *small* shim?

Partly — and the parts that can't are the parts that matter.

**Genuinely small (implicit-API calls, ~10–40 LOC each):** `cancelAllOrders` → `privatePostCancelallchildorders`; `gethealth`/`getboardstate` → status gating; parent/stop orders → `privatePostSendparentorder`. CCXT exposes all of these as implicit methods already; these are thin wrappers.

**Not small:**

1. **WebSocket layer — no CCXT Pro.** A production feed handler for JSON-RPC 2.0 over WebSocket with `auth`/`subscribe`, private channels, **self-implemented reconnect** (bitFlyer's docs explicitly say sample code omits it), snapshot/delta merge for an **unsequenced** book, periodic `lightning_board_snapshot_*` resync, and gap accounting. pybotters supplies the *store*, not the trading semantics. Realistically **400–800 LOC** with tests.
2. **OHLCV construction.** No venue candles → build bars from executions, with the 31-day ceiling and gap policy. **150–300 LOC** including correctness tests.
3. **Idempotency / duplicate-order layer.** There is no client order ID, so this must be invented: a durable local intent journal written *before* submit, heuristic matching against `getchildorders` on restart, and an ambiguity-quarantine state. This is genuinely hard to get right. **300–600 LOC**.
4. **Simulated matching engine for the shadow environment.** No framework covers bitFlyer, so backtest/shadow/live semantic consistency — the explicit requirement — has to be authored. Order book replay, fill logic, partial fills, latency, fees, queue estimation. **Not a shim.** This alone is **1,000+ LOC**, and it is precisely the infrastructure the project charter says to avoid writing.

### 5.5 Custom code burden: **CATEGORY D**

| | LOC (realistic, with tests) |
| --- | --- |
| CCXT unified-call gaps (implicit-API shims) | ~100 |
| WebSocket feed handler + reconnect + unsequenced-book resync | 400–800 |
| Bar construction from executions | 150–300 |
| Idempotency / duplicate-order / restart reconciliation | 300–600 |
| Simulated matching engine for backtest↔shadow↔live parity | 1,000+ |
| **Total** | **≈ 2,000–2,800 LOC of trading infrastructure** |

**Category D — substantial custom trading infrastructure, >1000 LOC.**

Your own stated rule: *"If C or D is genuinely required to obtain safe backtest/shadow/live semantic consistency, strongly consider NO BUILD."* It is genuinely required. Category D is not an artifact of pessimistic estimating — it follows from four independent facts, each verified above: no CCXT Pro, no framework connector anywhere, no venue candles, and no client order ID.

And pybotters, while real and maintained, must not be mistaken for a way out. It is a well-built client library; it is not a trading framework. Recommending it here would be exactly the error you warned against — treating "a repository exists" as "the integration is solved."

**BITFLYER USA — FAIL on integration burden**, despite having the best fee economics of any New-York-legal venue found.

---

## 6. DATA RESEARCH FEASIBILITY (bitFlyer, hypothetical)

Recorded here because you asked, and because the storage conclusion generalizes to whichever venue is chosen.

| Question | Answer |
| --- | --- |
| Download max free historical executions immediately? | ⚠️ Yes — but **only ~31 days**, via `getexecutions` with `count`/`before`/`after` |
| Reconstruct 1m/5m bars ourselves? | ✅ Yes — and **mandatory**, the venue has no candle endpoint |
| Capture live trades? | ✅ `lightning_executions_*`, monotonic `id` enables gap detection |
| Capture live L2 updates? | ✅ `lightning_board_*` + `lightning_board_snapshot_*` |
| Periodic snapshots? | ✅ dedicated snapshot channel — and it is the **only** resync mechanism |
| **Detect dropped/reordered updates?** | ⚠️ **Trades yes** (monotonic `id`). **Book: NO per-message sequence.** Only snapshot-vs-reconstruction divergence detection. |
| Store locally? | ⚠️ Technically trivial; **legally UNVERIFIED** (§10) |
| Growing free dataset? | ✅ Forward capture is unlimited and free — but starts at zero and accrues in calendar time |

### Storage requirements — BTC/USD + ETH/USD, trades + L2

Assumptions (**must be measured, not assumed** — Test P0-D): execution record ≈ 200 B JSON; board delta ≈ 300 B JSON.

| Scenario | Raw/day | Raw 30d | Raw 90d | zstd 30d | zstd 90d | Parquet+zstd 30d | 90d |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Low** (quiet; 50k execs, 5 board msg/s) | 140 MB | 4.2 GB | 12.6 GB | 0.42 GB | 1.26 GB | 0.28 GB | 0.84 GB |
| **Base** (100k execs, 13 board msg/s) | 357 MB | 10.7 GB | 32.1 GB | 1.07 GB | 3.21 GB | 0.71 GB | 2.14 GB |
| **High** (volatile; 340k execs, 43 msg/s) | 1,183 MB | 35.5 GB | 106.4 GB | 3.55 GB | 10.64 GB | 2.37 GB | 7.10 GB |

**Storage is not a blocker at any plausible rate** — under 11 GB for 90 days compressed even in the volatile case, and under 8 GB in columnar Parquet. Local disk suffices; no cloud, no cost.

**Do not assume completeness.** Required tests: **P0-D** measure actual message rates and record sizes for 24h before sizing anything; **P0-E** reconstruct the book from deltas and diff against `lightning_board_snapshot_*` on a fixed cadence, recording divergence rate — this is the *only* available proxy for book-gap detection; **P0-G** verify execution `id` monotonicity and count gaps across forced disconnects; **P0-H** rebuild 1m bars from executions twice from the same raw capture and require byte-identical output.

---

## 7. ECONOMIC GATE — FEE-ONLY ROUND-TRIP FRICTION

Base retail tier, before spread and slippage. **This is not a profitability claim** — it is the entry cost that must be overcome before a strategy can break even.

| Venue | Base maker | Base taker | **RT maker/maker** | **RT taker/taker** | Confidence |
| --- | --- | --- | --- | --- | --- |
| **bitFlyer USA Lightning** | 0.10% | 0.10% | **0.20%** | **0.20%** | Med-high (fee page blocked) |
| **Gemini ActiveTrader** | ~0.20% | ~0.40% | **~0.40%** | **~0.80%** | ⚠️ **Sources conflict** — see below |
| **Robinhood Crypto (v2)** | 0.03%–0.85% tiered | same | **0.06%–1.70%** + spread markup + PFOF | — | Low |
| **Coinbase Advanced** *(eliminated §1)* | 0.40% | 0.60% | 0.80% | 1.20% | High |

**Gemini conflict, stated plainly rather than resolved by preference.** Three secondary sources give three different base tiers: (a) 0.20% maker / 0.40% taker; (b) 0.00% maker / 0.20% taker; (c) 0.60% maker / 1.20% taker. Reading (c) is very likely the *non*-ActiveTrader Gemini fee schedule rather than ActiveTrader. Reading (a) is the most commonly reported and is corroborated by the reported first discount tier of **0.15%/0.30% at $10,000** monthly volume, which sits sensibly below (a) and nonsensically below (b). **I use (a) as the working figure and flag it as unconfirmed.** The ActiveTrader schedule was reportedly updated **2026-07-09**; `gemini.com` is blocked to me.

**Robinhood's stated "commission-free" framing is misleading for this use case** and I want to be explicit about why. Three cost layers stack: (1) v2 fee tiers of 0.03%–0.85%; (2) a **spread markup** reported at 0.01%–0.50%; and (3) **payment for order flow embedded in the spread** — Robinhood's own disclosure reportedly states it receives **$0.95 per $100 of crypto order volume** from market makers as of 2026-06-15. If that figure is per-$100 notional it implies ~0.95% of embedded cost the trader ultimately bears. *(Low confidence — `robinhood.com` is blocked to me and this needs primary confirmation.)* Even discounting it heavily, Robinhood is not a cheap venue; it is an opaque one.

### Adding spread and slippage — conceptually

Fees are the floor, not the cost. A realistic intraday round trip also pays:
- **half-spread on entry + half-spread on exit** ≈ one full spread. On BTC/USD at these venues that is plausibly 1–5 bps in calm conditions and materially wider in stress. bitFlyer USA's BTC/USD book is **thinner** than Coinbase's or Gemini's, so its fee advantage is partly repaid in spread — a point that must be *measured*, not assumed either way.
- **slippage / queue risk**: taker orders cross; maker orders face non-fill and adverse selection.

**Rough all-in round-trip floor:** bitFlyer ~0.25–0.35%; Gemini ~0.45–0.90%; Robinhood ~1%+ and opaque.

**The question you posed — do fees alone make ordinary intraday strategies implausible before testing?**

- **Coinbase (0.80–1.20%): yes, essentially.** Already concluded in pass 1; now moot.
- **Gemini (0.40–0.80%): probably, for high-turnover.** A strategy trading several times daily must clear ~0.5%+ per round trip. That is a demanding gross edge for retail intraday crypto. Lower-turnover strategies remain arguable.
- **bitFlyer (0.20%): not implausible on fees alone.** This is the one venue where the fee arithmetic does not immediately foreclose intraday trading. Which is precisely the cruelty of this audit's result — **the venue with viable economics is the one with unviable tooling.**
- **Robinhood: implausible and, worse, unmeasurable**, because the dominant cost is embedded in spread rather than disclosed as fees.

I am not claiming any of these can be profitable. I am claiming three of the four make it very unlikely before a strategy is even specified.

---

## 8. GEMINI — CONTROL ROUTE

| Item | Finding | Confidence |
| --- | --- | --- |
| **NY available** | ✅ Gemini Trust Company is a **New York limited-purpose trust company** chartered by NYDFS — a NY-native venue, not merely licensed into NY | High |
| API trading permitted | ✅ Documented public REST + WebSocket API | High |
| **Automated/agentic trading** | ✅ Sandbox is explicitly promoted for testing trading algorithms and API integrations | Med-high |
| **Personal/internal market-data analysis** | ⚠️ **UNVERIFIED** — same class of question that eliminated Coinbase. **UNKNOWN — §10.** | — |
| **Full sandbox** | ✅ **YES — and this is Gemini's standout advantage.** `exchange.sandbox.gemini.com` is *"an instance of the Gemini Exchange that offers full exchange functionality using test funds,"* pre-funded with BTC/ETH/USD, with **automated market activity**: *"Gemini has an automated system that makes trades on the exchange to simulate normal exchange activity."* Prices run independently of production. This is a **real order-lifecycle environment with simulated funds** — categorically better than Coinbase's static mock and than bitFlyer's playground-against-production. | High |
| Public REST/WebSocket data | ✅ Both documented; separate sandbox REST/WS/UI URLs | High |
| **Historical data limits** | ⚠️ Not verified (`docs.gemini.com` blocked). **`fetchOHLCV: true` in CCXT**, so candles exist — depth unknown. **UNKNOWN.** | — |
| **Market Data Fee Schedule for personal non-commercial API use** | ⚠️ **NOT FOUND AND NOT INFERRED.** Searches surfaced Gemini's *API Fee Schedule*, *ActiveTrader Fee Schedule*, *Gemini Fee Schedule* and *Predictions Fee Schedule* — **no separate Market Data Fee Schedule was located.** Per your instruction I am **not** concluding "public API therefore $0." Its absence from search is not proof of non-existence. **UNKNOWN — §10, highest priority.** | — |
| Base ActiveTrader spot tier | ⚠️ ~0.20% maker / ~0.40% taker (conflicting sources, §7); schedule updated 2026-07-09 | Low-med |

### Gemini framework support — **the mirror image of bitFlyer**

Verified by the same source-code and file-existence method:

| | Gemini | bitFlyer |
| --- | --- | --- |
| CCXT `createOrder` / `cancelOrder` | ✅ / ✅ | ✅ / ✅ |
| CCXT **`fetchOrder`** | ✅ **`true` (native)** | ⚠️ `'emulated'` |
| CCXT `fetchOpenOrders` | ✅ `true` | ⚠️ `'emulated'` |
| CCXT `fetchClosedOrders` | ❌ `false` | ⚠️ `'emulated'` |
| CCXT `fetchMyTrades` / `fetchTrades` | ✅ / ✅ | ✅ / ✅ |
| CCXT `fetchOrderBook` / `fetchTicker` / `fetchBalance` | ✅ / ✅ / ✅ | ✅ / ✅ / ✅ |
| **CCXT `fetchOHLCV`** | ✅ **`true`** | ❌ **absent** |
| **CCXT Pro (`ts/src/pro/*.ts`)** | ✅ **200 — supported** | ❌ **404** |
| **Hummingbot connector** | ✅ **200 — exists** | ❌ **404** |
| NautilusTrader adapter | ❌ none | ❌ none |
| LEAN brokerage | ❌ none | ❌ none |
| **Freqtrade `EXCHANGE_HAS_REQUIRED` gate** | ✅ **passes** (fetchOrder ✅, fetchOHLCV ✅, cancelOrder ✅, createOrder ✅, fetchBalance ✅, fetchL2OrderBook via fetchTicker ✅; not in `BAD_EXCHANGES`) | ❌ **fails**: `missing: fetchOrder, fetchOHLCV` |

Gemini is not on Freqtrade's *officially supported* README list either — but passing `validate_exchange` versus being rejected by it is a categorical difference: Gemini is usable-but-unsupported; bitFlyer is rejected by the tool itself.

**Gemini custom-code burden: Category A–B** (configuration, plus small shims). Roughly **an order of magnitude less** than bitFlyer.

**Assessment: does the fee level alone make Gemini unattractive for high-turnover day trading?** On the working figures — **yes for high-turnover**. ~0.40–0.80% round trip before spread demands a gross edge that retail intraday crypto rarely delivers repeatedly. Gemini is attractive as the **only venue where Phase 0 can actually be executed cheaply and safely**, and unattractive as a high-frequency trading venue. Those are different claims and both are true.

---

## 9. ROBINHOOD CRYPTO API — CONTROL

| Item | Finding |
| --- | --- |
| **NY availability** | ✅ **Robinhood Crypto is licensed to engage in virtual currency business activity by NYDFS** |
| API availability | ✅ Crypto Trading API, launched 2024-05-30, US-only, documented at `docs.robinhood.com` |
| **Automated strategies explicitly permitted** | ✅ Robinhood's own launch material promotes *"advanced and automated trading strategies"* and algorithmic use |
| **v1 vs v2 routing** | v1 = no fee tiers; **v2 = fee tiers, 0.03%–0.85% with smart exchange routing**, declining with 30-day volume. All read-only actions available on both. |
| Market data | ⚠️ Quotes/market data available via API |
| **L2 / order-book depth / trade-stream history** | ⚠️ **No evidence found that the API exposes order-book depth or a historical trade stream.** Not confirmed absent — `docs.robinhood.com` is blocked — but nothing in the accessible record indicates depth data exists. **Likely a hard limitation.** |
| **Routing economics / PFOF** | ⚠️ Spread markup ~0.01%–0.50%; Robinhood reportedly receives **$0.95 per $100 of crypto order volume** from market makers, embedded in the spread (as of 2026-06-15) |
| **Paper / sandbox** | ❌ **No sandbox found.** |
| **CCXT support** | ❌ **`ts/src/robinhood.ts` → 404 and `ts/src/pro/robinhood.ts` → 404. Not in CCXT at all.** |
| Framework support | ❌ None found in CCXT, CCXT Pro, Freqtrade, Hummingbot, NautilusTrader, or LEAN |

**Is Robinhood superior or inferior to bitFlyer for this project? Clearly INFERIOR.** It shares bitFlyer's fatal property (zero framework support → full custom build) while being *worse* on every other axis that matters: no sandbox at all; no evidence of L2 depth; opaque, PFOF-laden execution economics that make honest slippage modelling impossible; and a broker-style routing model rather than a lit order book. bitFlyer at least offers a real order book, a health endpoint, and 0.20% round-trip fees. **Robinhood is eliminated.**

---

## 10. OUTSTANDING UNKNOWNS — USER ACTION REQUIRED

Ordered by decision impact. **Items 1–2 gate everything.**

1. ⚠️ **Gemini: locate the Market Data Fee Schedule, and the market-data licensing/use terms.** Two questions, one visit: (a) does a *Market Data Fee Schedule* exist for personal non-commercial API use, and what does it charge? (b) do Gemini's API/market-data terms contain any clause resembling Coinbase's — restricting use of market data to develop, validate, benchmark, or improve algorithms or automated systems? Check `gemini.com/fees`, the User Agreement's Marketplace Fee Schedules section, and the API terms. **If Gemini carries a Coinbase-style clause, Gemini is eliminated too and the answer becomes NO BUILD.** Paste the verbatim text.
2. ⚠️ **Coinbase: the full Market Data Terms text** — the scope clause naming covered APIs/entities, and any personal/internal-use carve-out. Only needed if you wish to contest §1.3. Absent this, Coinbase stays FAIL.
3. **Gemini base ActiveTrader tier**, from the 2026-07-09 schedule — exact maker/taker percentages and the entry-tier volume threshold. Resolves the §7 conflict.
4. **bitFlyer API Terms of Use** — is programmatic personal trading permitted, and may market data be stored locally for personal research? Only relevant if you reject the Category-D finding.
5. **Confirmation from your broker(s)** of any house day-trading equity requirement (§3), if equities are ever revisited.
6. **Your local environment specs** (OS, disk) — trivial given §6, requested only for completeness.
7. **Confirmation that live trading remains unauthorized** and Phase 0 output is research artifacts only.

**I am not requesting, and do not want, any API key or secret.** Every Phase 0 test named in §12 runs against public unauthenticated endpoints or an isolated sandbox account you create yourself.

---

## 11. FINAL COMPARISON TABLE

| | **bitFlyer USA** | **Gemini ActiveTrader** | **Robinhood Crypto** | **Coinbase Advanced** *(pass 1)* |
| --- | --- | --- | --- | --- |
| **NY LEGAL** | ✅ BitLicense (2017); ⚠️ $1.2M NYDFS cyber consent order 2023 | ✅ **NYDFS-chartered NY trust company** | ✅ NYDFS virtual-currency licensed | ✅ BitLicense + trust charter |
| **FREE DATA** | ✅ Public REST + JSON-RPC WS, no fee found | ✅ Public REST + WS; ⚠️ **Market Data Fee Schedule NOT located — not assumed $0** | ⚠️ Quotes only; no evidence of depth | ✅ Free public L2/trades/ticker |
| **BOT/ALGO USE PERMITTED** | ⚠️ **UNVERIFIED** (terms blocked) | ⚠️ **UNVERIFIED** (terms blocked); sandbox promoted for algo testing | ✅ Explicitly promoted | ❌ **§3.5 plausibly prohibits** |
| **HISTORICAL QUALITY** | ⚠️ **~31 days executions; NO candles** — bars self-built | ⚠️ Candles exist (`fetchOHLCV: true`); depth unverified | ❌ No evidence of trade/book history | ⚠️ 1m bars (documented incomplete); **no historical trades** |
| **LIVE L2** | ✅ `lightning_board_*` — ❌ **no sequence numbers** | ✅ WS order book (CCXT Pro `watchOrderBook`) | ❌ No evidence | ✅ `level2`, unauthenticated |
| **PAPER/SANDBOX** | ❌ **Playground only** (hits production) | ✅ **Full sandbox: test funds + automated market activity** | ❌ **None** | ❌ Static mock |
| **BASE ROUND-TRIP FEES** | ✅ **~0.20%** | ⚠️ ~0.40–0.80% | ❌ 0.06–1.70% + spread + PFOF | ❌ 0.80–1.20% |
| **MATURE FRAMEWORK** | ❌ **None.** No CCXT Pro (404), no Hummingbot (404), no Nautilus, no LEAN, **Freqtrade rejects it** | ✅ **CCXT + CCXT Pro (200) + Hummingbot (200); passes Freqtrade gate** | ❌ **Not in CCXT at all (404)** | ⚠️ Nautilus adapter (4 mo old, v2-RC-only) |
| **CUSTOM CODE BURDEN** | ❌ **D — ~2,000–2,800 LOC** | ✅ **A–B — config + small shims** | ❌ **D+ — everything from scratch** | ⚠️ B–C |
| **HARD BLOCKERS** | No client order ID → **idempotence unprovable**; no book sequence; no candles; no framework; 31-day history | Market Data Fee Schedule unverified; fee level marginal for high turnover; base tier conflicted | No sandbox, no CCXT, no depth, opaque PFOF economics | **§3.5 terms**; fee wall; zero-fee default trap |
| **VERDICT** | **FAIL** (integration burden — your Category-D rule) | **CONDITIONAL — best available; Phase 0 only** | **FAIL** | **FAIL** (confirmed this pass) |

---

## 12. RECOMMENDATION

# ▶ B — AUTHORIZE ONLY ZERO-MONEY PHASE 0 DIAGNOSTICS

**Named venue: Gemini (ActiveTrader). Named framework: CCXT + CCXT Pro, with Hummingbot evaluated as the execution engine.**

**Why B and not C.** Two unknowns are live and either can be fatal: Gemini's **Market Data Fee Schedule** is unlocated (and you correctly forbade inferring $0), and Gemini's market-data **use terms** have not been checked for a Coinbase-style algorithm clause — the precise clause that eliminated the previous front-runner *this pass*. Beginning research/shadow implementation with an unresolved contractual question of the exact type that just killed the prior candidate would repeat the mistake this audit exists to prevent. Your standard says: material unknowns → B.

**Why B and not A.** Unlike Coinbase and bitFlyer, Gemini's blockers are **unknowns, not established failures**, and they are cheap to resolve — a fee page and a terms page. Gemini uniquely combines NY-native regulatory standing, a **genuine sandbox with simulated funds and automated market activity**, and **mature framework support verified in source** (CCXT Pro present, Hummingbot connector present, native `fetchOrder`, native `fetchOHLCV`, passes Freqtrade's capability gate). Category A–B custom code. Declaring NO BUILD before spending an hour on two web pages would be premature.

**Why not bitFlyer, despite the best fees.** Your own rule decides it: Category D is genuinely required, for four independently verified reasons — no CCXT Pro, no framework connector anywhere, no venue candles, no client order ID. The last is the worst: **without a client-supplied order ID, fill and order idempotence across restart reconciliation cannot be made deterministic, only heuristic.** Building ~2,500 LOC of trading infrastructure to reach a venue whose safety properties are structurally weaker is the exact failure mode described in the project background.

**The honest shape of this result.** The venue with viable economics (bitFlyer, 0.20%) has unviable tooling. The venue with viable tooling (Gemini) has marginal economics (~0.40–0.80%). No New-York-legal venue found in either pass has both. **That tension, not any single blocker, is the strongest argument that this project may not be viable at retail scale** — and if the Gemini unknowns resolve badly, or if the economic gate below fails, the correct answer becomes **A — NO BUILD**.

### Phase 0 gate order — stop at the first failure

| # | Test | Cost | Real money? |
| --- | --- | --- | --- |
| **P0-A** | **Terms & fee-schedule resolution** (§10 items 1–3). Locate Gemini's Market Data Fee Schedule and market-data use terms; extract the base ActiveTrader tier verbatim. **If a Coinbase-style algorithm/automated-system clause exists, or market data is not free → STOP, recommendation becomes A.** | $0 | **NO** |
| **P0-B** | **Economic gate.** Compute break-even gross edge per round trip at the confirmed base tier, plus measured median spread. **If required edge exceeds plausible retail intraday edge → STOP → A.** | $0 | **NO** |
| **P0-C** | Public unauthenticated REST + WebSocket connection; confirm market data flows with **no credentials configured**. | $0 | **NO** |
| **P0-D** | 24h capture: measure actual message rates, record sizes, gap and disconnect rates. Size storage from measurement, not §6's assumptions. | $0 | **NO** |
| **P0-E** | Book integrity: reconstruct from deltas, diff against periodic snapshots, record divergence rate. | $0 | **NO** |
| **P0-F** | **Zero-fee trap assertion.** Load instruments in the chosen engine and **assert maker/taker fees are non-zero and match the confirmed tier**; verify commission arithmetically on a simulated fill. A zero-fee configuration must raise a hard error. *(Direct carry-over of §2.5 — the failure mode is generic, not Coinbase-specific.)* | $0 | **NO** |
| **P0-G** | Deterministic replay: same recorded session through the engine 3× → **byte-identical** results. | $0 | **NO** |
| **P0-H** | Sandbox order-lifecycle validation in `exchange.sandbox.gemini.com` with **simulated funds only**: submit/cancel/partial-fill/status/reconcile, duplicate and out-of-order event injection, forced disconnect. | $0 | **NO — sandbox funds are not real** |
| **P0-I** | **Kill switch & live-routing lockout:** assert the process **refuses to start** if any production endpoint or live credential is configured. | $0 | **NO** |

No live order is placed in any test. No production API key is required for P0-A through P0-G.

---

## 13. CLAIMS I DISAGREE WITH CHATGPT ABOUT

Most of ChatGPT's new evidence held up. Three items are wrong or incomplete, and two of my own prior claims needed correction.

### ✅ ChatGPT CONFIRMED

| Claim | Finding |
| --- | --- |
| Coinbase Market Data Terms restrict developing/training/validating/benchmarking algorithms and automated systems | **Corroborated** — identical clause text returned on two independent retrievals of `coinbase.com/legal/market_data`; page reported updated ~3 weeks before audit date, consistent with 2026-08-07 |
| Our personal automated-trading research plausibly falls inside that wording absent consent | **Concur** — Reading A (§1.2) is the plain-text reading; "validate" and "benchmark" are literally our verbs |
| NautilusTrader warns WS-generated fill IDs differ from REST reconciliation IDs; fill idempotence unprovable across restart | **Verified verbatim** — `docs/integrations/coinbase.md:825-829` and `:654-664` |
| bitFlyer public executions limited to ~31 days | **Confirmed** — bitFlyer docs state the `before` parameter is limited to the most recent 31 days (as of 2018-12-19) |
| Freqtrade marks bitFlyer invalid | **Confirmed** — `validate_exchange('bitflyer')` returns False; see §5.2 — **but the reason is incomplete, below** |

### ❌ Disagreement 1 — "Freqtrade marks bitFlyer invalid **because `fetchOrder` is missing**." Correct but materially incomplete.

Tracing `EXCHANGE_HAS_REQUIRED` against bitFlyer's actual `has` map yields **`missing: fetchOrder, fetchOHLCV`** — two failures, not one.

`fetchOHLCV` is the more damaging omission. `fetchOrder` is `'emulated'` (it fails Freqtrade's `is not True` identity check, but the functionality *exists* client-side, and a shim could satisfy it). **`fetchOHLCV` is genuinely absent because bitFlyer has no candle endpoint at all** — so no shim can conjure it; bars must be constructed from raw executions, bounded by the 31-day retention ceiling. Naming only `fetchOrder` makes the problem look like a CCXT metadata quirk. It is not; it is a venue capability gap that removes the entire candle-based research workflow.

### ❌ Disagreement 2 — treating bitFlyer as a viable primary candidate at all.

If ChatGPT proposed bitFlyer as the new primary route, that recommendation does not survive the framework audit, and the evidence is not close:

- `ts/src/pro/bitflyer.ts`, `python/ccxt/pro/bitflyer.py`, `js/src/pro/bitflyer.js` → **all 404** (controls: binance, kraken, coinbase, bitmex all 200). **No CCXT Pro.**
- `hummingbot/connector/exchange/bitflyer/__init__.py` → **404** (controls: binance, kraken, coinbase_advanced_trade, gate_io, bitstamp all 200). **No connector.**
- NautilusTrader full-tree grep: bitFlyer appears **only** inside the **Tardis** (paid vendor) adapter. **No adapter.**
- LEAN `BrokerageName.cs`: **0** occurrences. **No brokerage.**
- CCXT `'fetchOHLCV': undefined`; `'cancelAllOrders': undefined` **despite the venue endpoint existing**.
- `createOrder` sends five fields and **no client order ID**; the parser hard-codes `'clientOrderId': undefined`.

That last point is the one I would put in front of any decision-maker: **bitFlyer offers no client-supplied idempotency key, so safe retry after an ambiguous submit is impossible and restart reconciliation is irreducibly heuristic.** Combined, these force **Category D (~2,000–2,800 LOC)**, which your own stated rule converts into "strongly consider NO BUILD." bitFlyer's excellent 0.20% round-trip fee does not offset it.

### ❌ Disagreement 3 — the "no sequence number" problem on bitFlyer's book is under-appreciated generally.

bitFlyer's `lightning_board_*` messages carry `{mid_price, asks, bids}` and **no sequence field**. The evidence is not merely absence-from-docs: **pybotters' `Board._onmessage` performs no sequence validation at all** and instead prunes crossed levels heuristically against `mid_price` — an implementation shape that only makes sense for an unsequenced feed. Executions *do* carry a monotonic `id`, so trade gaps are detectable; **book gaps are not.** Any queue-position or depth-sensitive research on bitFlyer rests on periodic snapshot reconciliation rather than provable continuity, and must be reported as such.

### ⚠️ Correction to my own first-pass claim — PDT

My statement that the $25,000 PDT rule was "eliminated effective June 4, 2026" was **too broad**, as you correctly challenged. The *rule* no longer imposes it; the *broker* may lawfully continue to during the transition through **2027-10-20**, and may impose stricter house requirements indefinitely. Corrected statement in §3. I did carry the phase-in caveat in the body of the first pass, but the headline framing overstated it, and the correction stands.

### ⚠️ Correction to my own first-pass claim — scope of the zero-fee trap

The first pass said a default **backtest** charges zero commission. Verifying the call graph this pass shows the same defaulting occurs in `crates/adapters/sandbox/src/execution.rs:182-187`, so **the live-data shadow environment is affected too**. That is worse than I reported, because the shadow environment is the component most likely to be trusted as realistic. Corrected in §2.5, and generalized into Test **P0-F** for whichever venue is chosen.

---

*End of second-pass audit. Nothing was built. No repository was created. No strategy was written. No order was submitted. No API secrets were requested. No paid data was recommended.*
