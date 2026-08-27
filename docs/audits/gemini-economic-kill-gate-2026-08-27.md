# FINAL PRE-PHASE-0 ECONOMIC / DATA-COST GATE — Gemini

**Date:** 2026-08-27 · **Scope:** Verification and arithmetic only. Nothing built. No repository. No strategy. No API secrets. No paid data. No live trading. No real-money orders.
**Supersedes:** the second-pass audit's Gemini fee figures, which were wrong. See §2.

---

## VERDICT SUMMARY

| Question | Answer |
| --- | --- |
| **1. Mandatory market-data fee?** | **UNRESOLVED** — and materially worse than a simple unknown (§1) |
| **2. Is ChatGPT's fee correction right?** | **YES. My prior "~0.40–0.80% round trip" was wrong. Corrected in §2.** |
| **3. Material BTC/ETH fee promotions?** | **None found** (§4) |
| **4. FINAL VERDICT** | **A — NO BUILD** (§5) |

---

## 1. GEMINI MARKET DATA FEE SCHEDULE — EXHAUSTIVE RETRIEVAL

### 1.1 Routes attempted

| Route | Result |
| --- | --- |
| `https://gemini.com/market-data-fee-schedule/` (direct) | ❌ EGRESS_BLOCKED |
| `https://www.gemini.com/market-data-fee-schedule` (direct) | ❌ EGRESS_BLOCKED |
| `https://www.gemini.com/legal/market-data-agreement` | ❌ EGRESS_BLOCKED |
| `https://www.gemini.com/fees/*` (all schedules) | ❌ EGRESS_BLOCKED |
| `https://developer.gemini.com/*` | ❌ EGRESS_BLOCKED |
| `https://docs.gemini.com/*`, `https://docs.sandbox.gemini.com/*` | ❌ EGRESS_BLOCKED |
| `https://support.gemini.com/*` | ❌ EGRESS_BLOCKED |
| `https://api.gemini.com/v1/feepromos` | ❌ EGRESS_BLOCKED |
| Internet Archive (`archive.org`, Wayback availability API) | ❌ EGRESS_BLOCKED |
| Gemini-owned GitHub repos (`gemini/gemini-api-docs`, `gemini/docs`) | ❌ 404 — no such public repos |
| CCXT `ts/src/gemini.ts` (read in full) | ✅ Retrieved — trading fees only, no market-data fee data |
| Indexed / search-engine retrieval, 6 distinct queries | ✅ Partial — see below |

Every gemini.com host is blocked to this session. I have **no primary-document access** to any Gemini page.

### 1.2 What indexed retrieval did establish

**The Market Data Fee Schedule exists, is contractually binding, and is incorporated by reference into the Market Data Agreement.** Retrieved from indexed copy of `gemini.com/legal/market-data-agreement`:

> *"By accessing or using Gemini Market Data, users agree to accept the Market Data Fee Schedule."*
>
> *"Gemini reserves the right to change or modify its Market Data Fee Schedule at any time, with any change posted for at least three calendar days before it takes effect and no change being in effect for less than 30 calendar days."*

**I could not retrieve the schedule's contents.** No indexed copy surfaced the actual fee amounts across six queries. Notably, an enumeration of Gemini's fee schedules retrieved from their own index listed *"Gemini mode Fee Schedule, ActiveTrader Fee Schedule, Derivatives Fee Schedule, Custody Fee Schedule, and Transfer Fee Schedule"* — **the Market Data Fee Schedule did not appear in that enumeration**, yet the Market Data Agreement plainly incorporates it. That inconsistency is itself unresolved.

### 1.3 What ChatGPT verified, and what it does not establish

ChatGPT's reported verification of the **Market Data Agreement** is corroborated by my retrieval. Indexed text of that agreement gives:

> *"Permitted Use means your use of Gemini Market Data solely for: (i) personal and/or internal use; (ii) general informational purposes; or (iii) analysis of prices and markets and financial products relating thereto."*
>
> *"You may receive, download, store, and copy Gemini Market Data to further any Permitted Use."*

That is favorable and materially unlike Coinbase: personal/internal use ✅, price/market analysis ✅, download and store ✅, and **no algorithm/automated-system prohibition surfaced**. On the *licensing* question ChatGPT appears correct.

**But permission and price are different questions, and ChatGPT answered only the first.** The Market Data Agreement is a licence; the Market Data Fee Schedule is a price list. The agreement's own text says users accept the fee schedule by using the data and that Gemini may change it **on three calendar days' notice**. Nothing I retrieved states the current amounts.

### 1.4 Answer

> ## **UNRESOLVED**

Per your instruction, I am **not** inferring $0 from the endpoints being public and unauthenticated. Absence of a retrievable fee amount is not evidence of a zero fee.

**And the finding is worse than a neutral unknown.** Even if the schedule currently reads $0, Gemini has an **express contractual right to introduce a market-data fee on three days' notice**, with any such change binding on continued use. Your constraint #1 is *"market data must be free"* — not "free today." A venue that reserves the right to price market data at will, under a schedule I cannot read, does not satisfy a non-negotiable free-data constraint. This is a standing risk that no amount of engineering removes.

---

## 2. FEE CORRECTION — ChatGPT IS RIGHT, I WAS WRONG

### 2.1 Explicit correction

**My second-pass statement — "Gemini ActiveTrader ~0.20% maker / ~0.40% taker, round trip ~0.40–0.80%" — was wrong, and I withdraw it.** I flagged it as low-confidence with conflicting sources, but I selected the wrong figure from the conflict and then propagated it into the comparison table and the recommendation. That is a material arithmetic error in a section that fed the verdict, and it is mine.

### 2.2 The evidence that settles it

Two independent indexed retrievals confirm ChatGPT:

1. **Scope** — from `gemini.com/fees/activetrader-fee-schedule`: *"The ActiveTrader Fee Schedule was updated on July 9, 2026, and applies to all orders placed via the ActiveTrader and exchange API interfaces."*
   → **The ActiveTrader schedule governs exchange API orders.** ChatGPT's premise is correct. My second-pass speculation that a separate "API Fee Schedule" governs bot orders is not supported: the ActiveTrader page's own scope statement expressly covers the exchange API.
2. **Rates** — *"The ActiveTrader fee schedule starts at 0.60% maker and 1.20% taker. This is the base tier."*

### 2.3 Why I got it wrong — the failure mode, named

My 0.20/0.40 figure came from three sources that all **predate the 2026-07-09 schedule**:
- **CCXT's hardcoded constant** (`ts/src/gemini.ts:230-235`: `'taker': 0.004, 'maker': 0.002`). I now note CCXT sets `'fetchTradingFee': false` and reads real rates only from the **private** `/v1/notionalvolume` endpoint — so its hardcoded pair is a stale fallback, never a live figure. Treating it as corroboration was an error of exactly the kind this audit series exists to catch: **a constant in source code is not a fact about the world.**
- Secondary reviews reflecting the pre-July-2026 ladder (0.20/0.40 base → 0.15/0.30 at $10K → 0.00/0.03 at $500M).

Those figures are internally coherent, which is why they looked convincing. They are simply obsolete.

**Residual honesty:** the 0.20/0.40 figure still appears in searches dated 2026 — sources have not uniformly updated. I could not read the primary page to close this. **I therefore compute §3 under BOTH scenarios and show the verdict does not depend on which is correct.**

### 2.4 Corrected fee-only round trips

**Scenario A — ChatGPT / 2026-07-09 ActiveTrader (treated as governing):**

| Tier | Maker | Taker | mm RT | mt RT | tt RT |
| --- | --- | --- | --- | --- | --- |
| **$0 base** | 0.60% | 1.20% | **1.20%** | **1.80%** | **2.40%** |
| **$10K** | 0.40% | 0.80% | **0.80%** | **1.20%** | **1.60%** |

Arithmetic: mm = 0.60+0.60 = 1.20 · mt = 0.60+1.20 = 1.80 · tt = 1.20+1.20 = 2.40 · and 0.40+0.40 = 0.80 · 0.40+0.80 = 1.20 · 0.80+0.80 = 1.60. **ChatGPT's six figures are arithmetically correct.**

---

## 3. ECONOMIC KILL GATE

No strategy developed or optimized. This computes only the **minimum gross move required to break even**.

### 3.1 Cost model

```
maker/maker :  fee_m + fee_m                        + AS        (posts both sides; pays no spread)
maker/taker :  fee_m + fee_t + (S/2) + σ                        (one crossing side)
taker/taker :  fee_t + fee_t +  S    + 2σ                       (two crossing sides)
```
`S` = full quoted spread · `σ` = slippage beyond BBO per crossing side · `AS` = adverse-selection haircut on resting orders.

**ASSUMPTIONS — NOT MEASURED** (Gemini is a smaller venue than Coinbase/Binance; spreads are wider):

| Pair | S (spread) | σ (slippage/side) | AS (adverse selection) |
| --- | --- | --- | --- |
| BTC/USD | 0.03% | 0.01% | 0.02% |
| ETH/USD | 0.05% | 0.02% | 0.03% |

Note these are **deliberately generous to the project**. They are small enough that they barely matter — which is itself the finding (§3.4).

### 3.2 Scenario A — ChatGPT / July 9 2026 schedule

**BTC/USD** — required gross move per round trip to break even:

| Tier | Fee m/t | mm all-in | mt all-in | tt all-in |
| --- | --- | --- | --- | --- |
| **$0 base** | 0.60/1.20% | **1.22%** | **1.82%** | **2.45%** |
| **$10K** | 0.40/0.80% | **0.82%** | **1.23%** | **1.65%** |
| **$25K** ⚠️ | 0.30/0.60% | 0.62% | 0.92% | 1.25% |
| **$75K** ⚠️ | 0.25/0.50% | 0.52% | 0.78% | 1.05% |

**ETH/USD:**

| Tier | Fee m/t | mm all-in | mt all-in | tt all-in |
| --- | --- | --- | --- | --- |
| **$0 base** | 0.60/1.20% | **1.23%** | **1.84%** | **2.49%** |
| **$10K** | 0.40/0.80% | **0.83%** | **1.25%** | **1.69%** |
| **$25K** ⚠️ | 0.30/0.60% | 0.63% | 0.94% | 1.29% |
| **$75K** ⚠️ | 0.25/0.50% | 0.53% | 0.80% | 1.09% |

⚠️ **$25K and $75K rows are UNVERIFIED interpolations.** ChatGPT supplied only the base and $10K tiers; I could not retrieve the intermediate ladder. They are monotone-plausible placeholders, marked so you do not mistake them for verified data. **The verdict does not rest on them.**

### 3.3 Scenario B — legacy figures (if the pre-July schedule somehow still governs)

**BTC/USD:**

| Tier | Fee m/t | mm all-in | mt all-in | tt all-in |
| --- | --- | --- | --- | --- |
| $0 base | 0.20/0.40% | 0.42% | 0.63% | 0.85% |
| $10K | 0.15/0.30% | 0.32% | 0.47% | 0.65% |
| $25K ⚠️ | 0.12/0.25% | 0.26% | 0.40% | 0.55% |
| $75K ⚠️ | 0.10/0.20% | 0.22% | 0.33% | 0.45% |

**ETH/USD** is 0.01–0.04 pp higher per row on the wider assumed spread.

### 3.4 Why the spread and slippage assumptions barely matter

At Scenario A base, BTC taker/taker: fees contribute **2.40%** of a **2.45%** all-in cost. **Fees are 98% of the friction.** Even multiplying the assumed spread and slippage by **ten** would move the total from 2.45% to ~2.90% — it would not change any conclusion.

**This is the single most important structural fact in this gate**, and it is what makes §5 decidable now rather than after an experiment: the dominant cost term is *already known* and is *not measurable-away*. Measuring spreads more precisely cannot rescue the case.

### 3.5 Context 1 — required capture vs. a whole day's range

Assuming BTC average daily true range ≈ **2.5%** (assumption):

| Case | All-in RT | Must capture, per round trip |
| --- | --- | --- |
| **A base, maker/maker** | 1.22% | **48.8% of an entire average day's range** |
| **A base, taker/taker** | 2.45% | **98.0% of an entire average day's range** |
| **A $10K, maker/maker** | 0.82% | **32.8%** |
| **A $10K, taker/taker** | 1.65% | **66.0%** |
| A $75K ⚠️, maker/maker | 0.52% | 20.8% |
| **B base, maker/maker** | 0.42% | **16.8%** |
| **B base, taker/taker** | 0.85% | **34.0%** |
| B $75K ⚠️, maker/maker | 0.22% | 8.8% |

Under Scenario A at the base tier, a taker/taker round trip must capture **essentially the entire average daily range** just to break even — repeatedly, net of losing trades. That is not a demanding strategy requirement; it is a structurally impossible one for an intraday system.

### 3.6 Context 2 — annual friction as a share of deployed notional

Fees only, 252 trading days:

| Case | 1 trade/day | 2/day | 5/day | 10/day |
| --- | --- | --- | --- | --- |
| **A base, mm** | **307%** | 615% | 1,537% | 3,074% |
| **A base, tt** | **617%** | 1,235% | 3,087% | 6,174% |
| **A $10K, mm** | **207%** | 413% | 1,033% | 2,066% |
| **B base, mm** | **106%** | 212% | 529% | 1,058% |
| **B base, tt** | **214%** | 428% | 1,071% | 2,142% |

Read as: percentage of deployed notional consumed per year in round-trip friction alone.

**Even under the most favourable scenario in the entire analysis — Scenario B, base tier, maker/maker, at a mere one trade per day — friction consumes 106% of deployed notional per year.** A "day-trading bot" that trades once a day is not a day-trading bot. At a realistic 5–10 trades/day the figures are between 5× and 60× the notional.

### 3.7 Context 3 — the volume-tier trap

Climbing the ladder is not free; you pay the *current* tier's fees to generate the volume. On a **$5,000** account under Scenario A base (0.60% maker):

| Target 30-day volume | Fees paid to generate it | As % of a $5,000 account, **every month** |
| --- | --- | --- |
| $10,000 | $60 | **1.2%** |
| $25,000 | $150 | **3.0%** |
| $75,000 | $450 | **9.0%** |

Reaching and *holding* the $75K tier costs **9% of a $5,000 account per month — 108% per year** — before a single dollar of profit or loss from the strategy itself. The tier discount cannot repay that at retail size.

---

## 4. CURRENT FEE PROMOTIONS

**Method:** `api.gemini.com/v1/feepromos` is a **public GET endpoint** — verified in CCXT source (`ts/src/gemini.ts:145`, inside the `'public': { 'get': {` block, distinct from the `'private'` block beginning at :52). **I could not query it — `api.gemini.com` is EGRESS_BLOCKED.** I did not assume any promotion from CCXT's illustrative sample response, per your instruction.

**Indexed retrieval found no promotion materially altering BTC/USD or ETH/USD per-trade economics.** The only current offers located are one-time new-user sign-up bonuses — *$15 in BTC after trading $100*, and *$7 in ETH on registration*. These are fixed one-off credits, not fee reductions; they do not change round-trip cost on any subsequent trade. Retrieval also reconfirmed that 0.00% maker / 0.03% taker is reachable only above **$500 million** in 30-day volume, i.e. not a promotion and not reachable here.

**Conclusion: no material promotion. Unqueried endpoint noted honestly — this should be re-checked from your account, but no plausible promotion changes §3 by the order of magnitude required.**

---

## 5. FINAL VERDICT

> # **A — NO BUILD**

Both prongs of criterion A are independently satisfied.

### 5.1 Data cost fails the constraint

The market-data fee question is **UNRESOLVED**, and structurally so: a Market Data Fee Schedule **exists**, is **incorporated by reference** into the Market Data Agreement, its contents are **unretrievable** from this session, and Gemini **expressly reserves the right to change it on three calendar days' notice**. Your constraint #1 is absolute. A schedule you cannot read, which the venue may reprice at will, does not satisfy it — regardless of what it says today.

ChatGPT's licensing verification is genuinely good news and I have corroborated it: personal/internal use, price/market analysis, and local download/storage are all expressly permitted, with no Coinbase-style algorithm clause. **But that resolves permission, not price**, and price is the constraint.

### 5.2 Economics fail under every scenario tested

The gate does not depend on the unresolved fee dispute, because **both scenarios fail**:

- **Scenario A (verified, ChatGPT correct):** base-tier round trips of **1.22%–2.45%** all-in. Taker/taker must capture **98% of an average daily range** per trade. One trade/day consumes **307–617% of notional per year**.
- **Scenario B (obsolete, most generous reading):** base-tier round trips of **0.42%–0.85%**. Even here, one trade/day at the *cheapest possible* configuration burns **106% of notional per year**.

At **$25K and $75K** tiers the picture improves but never becomes attractive, and reaching those tiers costs **3%–9% of a $5,000 account per month** in fees alone (§3.7) — a circular trap in which the volume needed for cheaper fees is generated at the expensive fees.

### 5.3 Why A and not B — Phase 0 cannot change the answer

This is the decisive reasoning, and it is why I am not taking the softer option.

A falsification experiment is worth running only if a plausible outcome would change the decision. Here, **no Phase 0 outcome can**:

1. **Fees are 98% of the friction (§3.4).** Phase 0's measurable quantities — spread, slippage, latency, book depth — are the remaining 2%. Measuring them perfectly moves the all-in cost by hundredths of a percentage point against a fee wall of 1.20%–2.40%.
2. **The fee number is already known.** It is published, not discoverable-by-experiment. Phase 0 would not learn it; it would just re-read the same page.
3. **The data-cost blocker is contractual, not empirical.** No connection test, capture run, or replay resolves what a fee schedule says or whether Gemini repricing it in three days' time.

Running Phase 0 here would mean spending real engineering time to measure variables that cannot overturn a conclusion already determined by variables we have. That is precisely the pattern — effort expended after the answer is knowable — that this audit series was commissioned to prevent.

### 5.4 What would reopen this

Not a Phase 0 experiment. Only new facts:

1. **The Market Data Fee Schedule reads $0 for individual non-commercial API use** — and you accept the three-day-notice repricing risk as a live operational risk.
2. **The 2026-07-09 ActiveTrader base tier is materially lower than 0.60%/1.20%** — read directly from your logged-in account's fee page, not from a review site or from me.
3. **A different NY-legal venue emerges with both viable fees and mature framework support** — the combination neither pass has found. Across both audits: Coinbase fails on terms and fees; bitFlyer has the best fees (~0.20% RT) but a Category-D integration burden; Robinhood is worse on every axis; Kraken, Binance.US, OKX, Bybit and every Freqtrade-supported venue are unavailable in New York.

If you want to spend ten more minutes before closing this: read your own account's ActiveTrader fee page and the Market Data Fee Schedule. Those two pages are the entire remaining decision. If the base tier really is 0.60%/1.20%, the arithmetic in §3 closes the question.

### 5.5 The finding, stated plainly

Across three audits, no New-York-legal crypto venue has been found that simultaneously offers **free-and-contractually-stable market data**, **fees low enough for intraday round trips**, and **mature framework support**. Each candidate fails at least one, and the failures are structural rather than incidental. The infrastructure was always buildable; the economics never were.

**A FAIL here is the useful outcome.** It cost three audits and no money, instead of months of implementation followed by the same discovery in production.

---

*End of gate. Nothing was built. No repository was created. No strategy was implemented. No API secrets were requested or used. No paid data was purchased or recommended. No live trading occurred. No real-money order was submitted.*
