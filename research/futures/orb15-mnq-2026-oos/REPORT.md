# 15-min ORB on MNQ (NQ proxy): 2026 out-of-sample validation report

**Decision: FAIL → NO BUILD.**

Under the frozen rules and the primary conservative cost scenario (S2), the strategy failed in
both periods. P1 (Jan–May 2026) made a small profit, but it was not statistically distinguishable
from zero, came from one month, and turned negative once the top 3 trades were removed.
P2 (Jun–Oct 8 2026) lost money even **before** costs, and its 95% bootstrap CI for the mean
trade lies entirely below zero.

Rules were frozen and committed (`RULES_FROZEN.md`, commit `cfab0f6`) before any 2026 bar was
loaded. No parameter was changed after results were seen. No deviations from the frozen rules.

## 1. What was and was not verified

| Item | Status |
|---|---|
| Publisher page (backtestingmax.com) | **NOT RETRIEVED.** The host is outside this session's network allowlist, and an archive fallback was refused. The rules tested are the ones in the task statement. Their fidelity to the publisher's page is **unverified**. |
| Publisher's 2020–2025 stats and **risk-gate failures** | **NOT READ.** They are not reproduced here. They stay in force as published, and nothing in this report overrides or reclassifies them. Anyone acting on this report should read them at the source. |
| Broker fees | **Not verified.** All fee levels are hypothetical scenarios. |
| Instrument | NQ 1-min prices used as an **explicit proxy** for 1 MNQ ($2/pt, 0.25 tick = $0.50). MNQ has its own order book with thinner depth. Real MNQ fills, especially stops in fast markets, may be worse than modeled. |

## 2. Data provenance and audit

- Source: public GitHub repo `kfccolonel1/BARS`, commit `b8f2d8ab36e44c289036ce093bf7c9f04073a7d9` (2026-10-15).
- File: `NQ/1min/NQ_1min_2026-01-01_2026-10-08_stitched.csv`, 24,317,314 bytes,
  sha256 `6a0aaa144118160da036409310df4e57cf41f7d23d9a07ce04671da50a154d65`.
- The repo's own description: unadjusted front-month NQ, America/New_York, never gap-filled, stitched per
  minute from several sources. The upstream origins (alfordlabs, TradingView NQ1!, IBKR, Yahoo NQ=F) are third-party
  redistributions, not exchange-licensed data. **Provenance beyond the repo's README cannot be independently confirmed.**
- **RTH source mix:** 100% of 2026 RTH bars (09:30–15:59) come from the single `alfordlabs` source, so no RTH session mixes sources.
- **Timestamps:** bars are stamped at bar open. Verified by aggregating 1-min bars to 5-min and comparing with the repo's Yahoo 5-min file
  (Aug 3–Sep 9 2026): 79.5% of closes match exactly at 0 shift, versus about 1% at ±1 bar. The residual mismatches are source differences.
  RTH spans 09:30–15:59, with no duplicate timestamps.
- **Gaps:** 199 RTH dates are in the file. 193 have all 390 bars. The 6 others are CME abbreviated holiday sessions
  (Jan 19, Feb 16, May 25, Jun 19, Jul 3, Sep 7; 210 bars each), excluded as holidays. Jan 1 and Apr 3 (Good Friday) are absent.
  No incomplete normal sessions. `results/session_audit.csv` lists every date.
- **Quarterly rolls:** the series switches contract at 00:00 ET on Mar 20, Jun 18 and Sep 18 (expiry day), visible as
  +214, +321 and +296 pt jumps. **No roll falls inside RTH.** The largest intra-RTH open-vs-prior-close jump is 22.25 pts.
  Limitation: in each roll week the series stays on the expiring contract after volume has migrated to the next.
  Price movement is nearly identical, but liquidity in the expiring contract is lower.
- **Cross-source check (sensitivity only, not used for the decision):** the same frozen code was run on the independent
  TradingView NQ1! raw file over 145 common sessions (2026-01-02 → 07-31). Side and exit reason agreed on
  144/145 sessions. S2 net was −$4,410.50 on primary data and −$4,555.50 on TradingView. The result does not depend on the data vendor.

## 3. Entry/exit completeness

193 trades over 193 usable sessions: every session signaled. With a 15:55 last signal bar, price almost always
closes outside a 15-minute range at some point. There are 0 missing entry prices and 0 missing exit prices. Every trade session has all 390 bars.
0 trades had a 1-min bar touching both stop and target (the conservative stop-first rule never had to be applied).
0 entry-bar opens were already past the stop or target.

## 4. Results — primary scenario S2 (2 adverse ticks/side + $4.00 RT = $6.00/trade)

| Metric | P1 Jan–May 2026 | P2 Jun–Oct 8 2026 |
|---|---|---|
| Scheduled / usable sessions | 102 / 102 | 91 / 91 |
| Trades | 102 | 91 |
| Net P&L | **+$2,059.00** | **−$7,588.00** |
| Expectancy / trade | +$20.19 | −$83.38 |
| Median trade | −$7.20 | −$199.00 |
| Profit factor | 1.164 | 0.549 |
| Win rate | 49.0% (50W / 52L) | 38.5% (35W / 56L) |
| Avg win / avg loss | $292.66 / −$241.81 | $264.37 / −$300.73 |
| Best / worst trade | +$921.00 / −$574.00 | +$964.50 / −$749.00 |
| Max drawdown (closed-trade) | −$2,182.00 | −$8,211.00 |
| Max consecutive losses | 5 | 6 |
| t-stat of mean | 0.65 | −2.40 |
| Bootstrap 95% CI of mean trade (10k, seed 20261107) | [−$37.88, +$81.40] | [−$148.86, −$13.70] |
| P(mean ≤ 0), bootstrap | 0.257 | 0.991 |
| Net ex best trade (= ex best day; 1 trade/day) | +$1,138.00 | −$8,552.50 |
| Net ex top 3 trades | **−$301.00** | −$10,147.00 |
| Exit mix (time / stop / target) | 53 / 36 / 13 | 46 / 41 / 4 |
| Long net (n, PF) | +$2,133.50 (57, 1.37) | −$2,801.00 (47, 0.65) |
| Short net (n, PF) | −$74.50 (45, 0.99) | −$4,787.00 (44, 0.46) |

Win/loss distribution (S2 per-trade quantiles 5/25/50/75/95%):
P1 [−366, −239, −7, +229, +539]; P2 [−501, −308, −199, +133, +549].

### By month (S2 net, trades)
| Month | Trades | Net | Mean |
|---|---|---|---|
| 2026-01 | 20 | +$157.00 | +$7.85 |
| 2026-02 | 19 | **+$3,291.50** | +$173.24 |
| 2026-03 | 22 | −$904.00 | −$41.09 |
| 2026-04 | 21 | −$395.00 | −$18.81 |
| 2026-05 | 20 | −$90.50 | −$4.53 |
| 2026-06 | 21 | −$3,720.50 | −$177.17 |
| 2026-07 | 22 | −$2,749.00 | −$124.95 |
| 2026-08 | 21 | −$343.50 | −$16.36 |
| 2026-09 | 21 | −$216.50 | −$10.31 |
| 2026-10 (1–8) | 6 | −$558.50 | −$93.08 |

Only 2 of 10 months were positive. P1's entire profit is February: P1 excluding February is −$1,232.50.
February's top two trades (Feb 3 and Feb 4 shorts, +$921 and +$777) supply 82% of P1's net.

### Cost / fill sensitivity (net P&L; PF)
| Scenario | Cost/trade | P1 | P2 |
|---|---|---|---|
| S0 gross | $0 | +$2,671.00; 1.218 | −$7,042.00; 0.573 |
| S1 1 tick/side + $1.50 | $3.50 | +$2,416.00; 1.195 | −$7,269.50; 0.563 |
| **S2 2 ticks/side + $4.00** | **$6.00** | **+$2,059.00; 1.164** | **−$7,588.00; 0.549** |
| S3 3 ticks/side + $6.00 | $9.00 | +$1,753.00; 1.138 | −$7,861.00; 0.538 |

Costs are not the deciding factor. The median stop distance is about 158 pts ($315 per MNQ), so $6–9 per trade is small.
The failure is in the gross edge: P1 gross PF is only 1.22, and P2 is negative gross.

### Comparisons
| Benchmark | P1 | P2 |
|---|---|---|
| No trade | $0 | $0 |
| Passive: long 1 MNQ 09:30 open → 15:59 close every session, S2 costs | +$7,025.00 (max DD −$4,648) | −$4,594.00 (max DD −$8,433) |
| ORB S2 | +$2,059.00 | −$7,588.00 |

ORB underperformed both passive intraday exposure and no trade in each period.

## 5. Decision against the frozen criteria (S2)

| Criterion | P1 | P2 |
|---|---|---|
| n ≥ 50 | ✅ 102 | ✅ 91 |
| ≥ 90% sessions usable | ✅ 100% | ✅ 100% |
| Net > 0 | ✅ | ❌ |
| PF ≥ 1.20 | ❌ 1.164 | ❌ 0.549 |
| Bootstrap CI lower bound > 0 | ❌ −37.88 | ❌ −148.86 |
| Net > 0 ex best trade / ex best day | ✅ | ❌ |
| Net > 0 ex top 3 trades | ❌ | ❌ |

Data was sufficient (so not INSUFFICIENT DATA), and the criteria failed in both periods. **Verdict: FAIL. Recommendation: NO BUILD.**

Caveats that do not change the verdict: about 9 months is a short window, and a single regime (the summer 2026 drawdown) dominates P2.
That cuts both ways, though. The frozen rules gave no evidence of an edge that survives out of sample, so the burden stays on the strategy.

## 6. Publisher risk gates

The publisher's own risk-gate failures from its 2020–2025 backtest **remain in force and visible**. They could not be read from
this environment, so they are neither restated nor reinterpreted here. This 2026 test adds an independent out-of-sample FAIL.
It does not offset or resolve any publisher gate.

## 7. Reproduce

```
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/kfccolonel1/bars BARS && git -C BARS checkout b8f2d8ab36e44c289036ce093bf7c9f04073a7d9
sha256sum BARS/NQ/1min/NQ_1min_2026-01-01_2026-10-08_stitched.csv   # expect 6a0aaa14…4d65
python3 -I orb_backtest.py BARS results     # Python 3.13.18, pandas 3.0.5, numpy 2.5.3
```
Outputs: `results/trades.csv` (every trade, with OR, signal, entry, stop, target, exit, reason, MFE/MAE and P&L for all 4 scenarios),
`results/session_audit.csv`, `results/no_signal_sessions.csv` (empty: every usable session signaled), `results/results.json` (all statistics + decision).
