# MES closing-half-hour momentum: evidence report (trial MES-CLOSE30-MOM-01)

## Verdict: INSUFFICIENT DATA (frozen-rule output). Practical decision: NO BUILD. The trial cannot pass.

- **What the frozen rule says.** It returns INSUFFICIENT DATA because P1 has only 129 of 149 scheduled sessions
  eligible (86.6% < 90%). The BARS ES file starts on 2025-06-20, so June 2–19 2025 are not in the data.
  This verdict is reported exactly as the rule outputs it. It was not changed after seeing results.
- **Why this is not a near-miss.** PASS requires both periods. P2 (Jan–Oct 2026) has sufficient data: 191 trades,
  91.4% of scheduled sessions eligible. It fails every performance criterion. It loses money before costs, and its
  95% CI for the mean trade is entirely below zero after costs. **No amount of additional P1 data can produce a PASS.**
- **P1 is negative too.** Its eligible-session share is 95.6% within the window the data actually covers, and it
  fails every performance criterion. The gross edge (+$1.96/trade) is smaller than the $9 hypothetical cost.
- **Lesson for later trials.** INSUFFICIENT DATA should not take precedence over a FAIL from a period with sufficient data.
  That precedence was carried over from the ORB trial's decision rule. It is recorded here as a lesson only. It is not applied to this trial.

The prior trial (`research/futures/orb15-mnq-2026-oos/`, 15-min ORB MNQ: FAIL / NO BUILD) is preserved unchanged.

## 1. Pre-registration trail (git)
| Commit | Content |
|---|---|
| `c5fc1fb` | `RULES_FROZEN.md`, committed before any ES bar was loaded for this trial |
| `dc5d38c` | Clarification 1 (reference vs trade eligibility, to stop a roll-exclusion cascade) + audited roll dates. Both were made before any signal or P&L was computed. No parameter changed. |
| (this commit) | Code, ledger, results, report |

**Timing adjustment (documented before testing).** Bars are stamped at bar open, so the latest bar completed at 15:30 is the
15:29 bar (it ends at 15:30:00). The 15:30 bar's open is the first print at/after 15:30:00, the same instant
the signal becomes known. "Known before entry" is therefore not established. **Primary entry = 15:31 bar open.**
Exit = 15:59 bar open. A 15:30-open entry is reported as a pre-declared, non-decisional disclosure. It is also negative in both periods.

## 2. Unverified items and limitations
- **Paper not checked.** The cited research (doi 10.1016/j.jfineco.2021.04.029) was not retrieved: external research hosts are outside this session's
  network allowlist (shown in the previous trial). The rules are the user's specification. Whether they match the paper's exact signal is unverified.
- **Fees are hypothetical.** No broker was contacted, and none of the fee levels are confirmed broker charges.
- **ES as a proxy for MES.** MES is the same index and tick size at 1/10 the multiplier, and it is held to ES by arbitrage.
  Price levels typically differ by ≤1 tick. **No MES bars are in the data, so this could not be measured here.**
  MES has thinner depth, so real fills could be worse than ES prices suggest. Two adverse ticks per side is well beyond a
  typical 1-tick MES spread (about a 0.5-tick half-spread) for a 1-lot, and C3/C4 test worse fills still.
- **Roll weeks.** The stitched series stays on the expiring contract until 00:00 on expiry day, after most volume has moved to the next contract.
  Signal and trade are both on that same contract, so the calculation is internally consistent. Real MES traders would usually have rolled about a week earlier.
- **Short window.** About 16 months of data.

## 3. Data provenance and audit
- Source: public GitHub `kfccolonel1/BARS` @ `b8f2d8ab36e44c289036ce093bf7c9f04073a7d9` (third-party redistribution, not exchange-licensed;
  upstream provenance cannot be independently confirmed).
- Primary: `ES/1min/ES_1min_2025-06-20_2026-10-09_stitched.csv`, sha256 `36baf1581b5a7ea2533812c101b7057cc6166162e14e089cb699650fd5c7635d`.
  Unadjusted front month, America/New_York. 464,160 rows, 0 duplicate timestamps.
- **RTH source mix:** 100% of RTH bars in every month are from the `alfordlabs` source. 0 mixed-source sessions.
- **Timestamps:** compared with independent IBKR ESM6 bars (Apr–May 2026), 99.4% of closes match exactly at 0 shift, versus 11.6% at ±1 bar.
  This confirms bars are stamped at their open.
- **Completeness:** 338 RTH dates. 326 have all 390 bars and pass the OHLC-validity and ≤20-pt intra-RTH jump checks.
  The 12 exclusions are exactly the frozen holiday and early-close list: early closes 2025-07-03, 2025-11-28, 2025-12-24;
  CME abbreviated holiday sessions 2025-07-04, 09-01, 11-27, 2026-01-19, 02-16, 05-25, 06-19, 07-03, 09-07.
  0 invalid bars, 0 discontinuities. 2026-10-09 is absent from RTH (the file ends that morning).
- **Rolls:** contract switches at 00:00 ET on 2025-09-19, 2025-12-19, 2026-03-20, 2026-06-18, 2026-09-18.
  The 2026 switches are confirmed against the IBKR per-contract files. On the day before, stitched = expiring contract
  (Mar 12 matches ESH6 exactly; Mar 19 sits 50 pts below ESM6). On expiry day, stitched = next contract exactly.
  The 2025 switches are inferred from the same-pattern overnight jumps on expiry days (+58.75, +52.75 pts), since no per-contract 2025 file exists.
  The data begins 2025-06-20, already on ESU5. The first reference close (6017.00) is consistent with that, putting the June roll before the data starts.
  Each roll excludes one trade session (5 total), where the reference close and the signal bar would be on different contracts.
- **IBKR cross-check (non-decisional):** the same contract, the same rules and IBKR vendor bars were run on the 181 trades from 2026
  that have full IBKR RTH data for both days. Side matched on 181/181. C2 net: −$2,552.75 on primary data vs −$2,544.00 on IBKR,
  with a maximum per-trade difference of $1.25. The result does not depend on the data vendor.
- **Ledger completeness:** 320 trades, each with reference date/close, 15:29 signal close, 15:31 entry, 15:59 exit, the 15:30 alternative entry,
  and P&L under every cost scenario. No missing values. Equal-signal (no-trade) days: 0.

## 4. Results — primary cost C2 ($9.00/trade: 2 ticks each side + $4 RT, hypothetical)

| Metric | P1 Jun 20–Dec 2025 | P2 Jan–Oct 8 2026 |
|---|---|---|
| Scheduled / within data coverage / trade-eligible | 149 / 135 / 129 | 209 / 194 / 191 |
| Trades | 129 | 191 |
| **Net P&L** | **−$908.50** | **−$2,902.75** |
| Expectancy / median trade | −$7.04 / −$6.50 | −$15.20 / −$12.75 |
| Profit factor | 0.670 | 0.449 |
| Win rate | 41.1% | 34.6% |
| Avg win / avg loss | $34.73 / −$36.17 | $35.91 / −$42.18 |
| Best / worst trade | +$179.75 / −$124.00 | +$274.75 / −$167.75 |
| Max drawdown | −$1,135.00 | −$2,902.75 (equity never recovered above start) |
| Max consecutive losses | 9 | 10 |
| t-stat of mean | −1.69 | −3.97 |
| Bootstrap 95% CI mean trade | [−$15.21, +$1.11] | [−$22.60, −$7.68] |
| P(mean ≤ 0) | 0.956 | 0.9999 |
| Net ex best trade (= ex best day) | −$1,088.25 | −$3,177.50 |
| Net ex top 3 trades | −$1,339.00 | −$3,462.00 |
| Long: n / net / PF | 79 / −$874.75 / 0.49 | 97 / −$1,250.50 / 0.45 |
| Short: n / net / PF | 50 / −$33.75 / 0.97 | 94 / −$1,652.25 / 0.45 |
| Per-trade quantiles 5/25/50/75/95 | −79.5 / −32.8 / −6.5 / +19.8 / +68.8 | −94.6 / −45.9 / −12.8 / +11.0 / +64.1 |

### Cost / execution sensitivity (net; PF; CI of mean)
| Scenario | Cost/trade | P1 | P2 |
|---|---|---|---|
| C0 gross | $0 | +$252.50; 1.119; [−6.16, +10.18] | **−$1,183.75**; 0.719; [−13.55, +1.55] |
| C1 1 tick + $2 | $4.50 | −$328.00; 0.865 | −$2,043.25; 0.567 |
| **C2 2 ticks + $4** | **$9.00** | **−$908.50; 0.670** | **−$2,902.75; 0.449** |
| C3 3 ticks + $6 | $13.50 | −$1,489.00; 0.519 | −$3,762.25; 0.357 |
| C4 4 ticks + $8 | $18.00 | −$2,069.50; 0.403 | −$4,621.75; 0.285 |
| Disclosure: 15:30-open entry, C2 | $9.00 | −$1,237.25; 0.591 | −$2,834.00; 0.458 |

P1's gross edge is +$1.96/trade (about 0.4 ES points), statistically zero and less than any realistic cost.
P2 is negative before costs. The entry-timing adjustment does not explain the loss: the 15:30-open entry is also negative.

### By month (C2: trades, net)
2025: Jun 6 +$182.25 · Jul 21 −$250.25 · Aug 21 +$77.25 · Sep 20 +$16.25 · Oct 23 −$449.50 · Nov 18 −$168.25 · Dec 20 −$316.25
2026: Jan 20 −$666.25 · Feb 19 +$124.00 · Mar 21 −$162.75 · Apr 21 +$99.75 · May 20 −$318.75 · Jun 20 −$570.00 · Jul 22 −$479.25 · Aug 21 −$274.00 · Sep 20 −$395.00 · Oct 7 −$260.50
Positive months: 5 of 17, the largest +$182.25. No month or isolated winner carries the result; the losses are broad-based.

### Benchmarks (C2 costs)
| | P1 | P2 |
|---|---|---|
| No trade | $0 | $0 |
| Passive long 15:31→15:59 every eligible session | −$1,741.00 (DD −$1,932) | −$1,290.25 (DD −$1,593) |
| Momentum strategy | −$908.50 | −$2,902.75 |
The strategy lost less than the passive long in P1 and more in P2. **It lost to no trade in both periods.**

## 5. Frozen criteria (C2)
| Criterion | P1 | P2 |
|---|---|---|
| n ≥ 50 | ✅ 129 | ✅ 191 |
| ≥ 90% scheduled sessions eligible (full-period denominator) | ❌ 86.6% (95.6% within data coverage) | ✅ 91.4% |
| Net > 0 | ❌ | ❌ |
| PF ≥ 1.20 | ❌ 0.67 | ❌ 0.45 |
| CI lower bound > 0 | ❌ | ❌ |
| Net > 0 ex best trade / best day / top 3 | ❌ | ❌ |

Frozen output: **INSUFFICIENT DATA** (coverage, P1). Every performance criterion fails in both periods, and P2 fails with sufficient data.
**Decision: NO BUILD.**

## 6. Reproduce
```
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/kfccolonel1/bars BARS && git -C BARS checkout b8f2d8ab36e44c289036ce093bf7c9f04073a7d9
sha256sum BARS/ES/1min/ES_1min_2025-06-20_2026-10-09_stitched.csv     # 36baf158…635d
python3 -I close30_backtest.py BARS results      # Python 3.13.18, pandas 3.0.5, numpy 2.5.3
```
Outputs in `results/`: `trade_ledger.csv` (all 320 trades), `session_decisions.csv` (every session's status, including exclusions and reasons),
`session_audit.csv` (per-date completeness/validity), `results.json` (all statistics, decision, IBKR cross-check with file hashes).
