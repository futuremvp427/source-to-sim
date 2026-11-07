# FROZEN RULES — MES closing-half-hour momentum (ES proxy)

Trial ID: `MES-CLOSE30-MOM-01`. Frozen 2026-11-07, before any ES bar was loaded for this trial
and before any result was computed. Committed on its own, ahead of the code and results.
This is a separate trial. The prior trial `research/futures/orb15-mnq-2026-oos/` (15-min ORB MNQ: FAIL / NO BUILD)
is preserved unchanged and is not retuned.

## Research basis
- Cited: https://doi.org/10.1016/j.jfineco.2021.04.029 (Journal of Financial Economics, 2021). The rules below are
  the user's specification. The paper could not be checked from this environment: the previous trial showed that
  external research hosts are outside this session's network allowlist. Fidelity to the paper's exact signal
  definition is **unverified**.

## Instrument and data
- Traded: 1 MES contract, $5.00/pt, tick 0.25 = $1.25. ES 1-min prices are an **explicit proxy** (same index,
  same tick size; ES = $50/pt). No MES bars are available in the data repo.
- Primary data: `kfccolonel1/BARS` @ `b8f2d8ab36e44c289036ce093bf7c9f04073a7d9`,
  `ES/1min/ES_1min_2025-06-20_2026-10-09_stitched.csv` (unadjusted front month, America/New_York).
- Bar timestamp convention: the BARS repo stamps bars at bar OPEN. This was verified for its NQ series in the prior trial
  and is re-verified for ES in DATA_AUDIT before results are inspected. Bar `HH:MM` covers [HH:MM:00, HH:MM+1:00).
- RTH = bars 09:30 … 15:59 (390 bars).

## Timing decision (made BEFORE testing — documented adjustment)
- "At 15:30, the latest fully completed 1-min bar" = the **15:29 bar**, which completes at 15:30:00.
- The 15:30 bar's open is the first trade at/after 15:30:00, the same instant the signal becomes known. It is not
  provably *after* the signal is known: zero latency would be required, and a bar's open print can occur in the
  first millisecond. Under the rule "enter at 15:30 open only if the signal was known before entry", that condition is
  **not established**.
- **Therefore PRIMARY ENTRY = open of the 15:31 bar** (the next executable bar open, a full minute after the signal).
- Signal reference and exit are unchanged: signal = close(15:29 bar) vs reference close; exit = open of 15:59 bar.
- Pre-declared, NON-DECISIONAL disclosure only: the same trades entered at the 15:30 bar open are also reported,
  so the effect of the timing adjustment is visible. It cannot change the verdict.

## Signal and trade
- Reference = close of the 15:59 bar of the **previous eligible session** (most recent prior session that passes
  every eligibility rule below), which must be on the **same contract** as today's signal bar.
- close(15:29) > reference → LONG; < reference → SHORT; == → no trade.
- Enter at 15:31 bar open; exit at 15:59 bar open. No stops, targets, filters or overnight holding. 1 contract, ≤1 trade/session.

## Eligibility / exclusions (data-determined, applied independently of outcome)
A session is eligible only if all of the following hold:
1. Not an exchange holiday or early close. In-window early closes: 2025-07-03, 2025-11-28, 2025-12-24. Holidays:
   2025-07-04, 2025-09-01, 2025-11-27, 2025-12-25, 2026-01-01, 2026-01-19, 2026-02-16, 2026-04-03, 2026-05-25,
   2026-06-19, 2026-07-03, 2026-09-07. Any session not having all 390 RTH bars is also excluded as incomplete.
2. All 390 RTH bars 09:30–15:59 present.
3. Every RTH bar valid: all prices finite and > 0, low ≤ min(open, close), high ≥ max(open, close), low ≤ high.
4. No intra-RTH discontinuity: |open(t) − close(t−1)| ≤ 20.0 pts for every consecutive RTH minute
   (normal ES values are ≤ ~2 pts; a larger jump indicates a contract switch or bad print).
5. RTH bars come from one source label (no mixed-source session).
6. **Roll transitions:** quarterly roll points are identified from the data as the contract switch (an overnight
   jump at/near the expected roll consistent with the calendar spread, cross-checked against the IBKR
   per-contract files where available). A session is excluded if its reference close and its signal bar lie on
   different contracts (i.e., the first eligible session after each roll), or if the roll falls inside its RTH.
   Roll points are listed in DATA_AUDIT before results are viewed.

## Costs (hypothetical, NOT confirmed broker charges)
| Scenario | Adverse ticks per side | RT fees | Cost/trade | Role |
|---|---|---|---|---|
| C0 gross | 0 | $0 | $0.00 | reference |
| C1 light | 1 | $2.00 | $4.50 | sensitivity |
| **C2 primary** | **2** | **$4.00** | **$9.00** | **DECISION** |
| C3 adverse | 3 | $6.00 | $13.50 | sensitivity |
| C4 severe | 4 | $8.00 | $18.00 | sensitivity |

## Periods (never pooled for the decision)
- P1: 2025-06-01 … 2025-12-31 (data begins 2025-06-20; the first tradable session needs a prior eligible session)
- P2: 2026-01-01 … 2026-10-31 (data ends 2026-10-09; sessions without full RTH are excluded by rule 2)

## Decision rule (frozen; same structure as trial ORB15-MNQ)
PASS only if ALL hold in BOTH periods under C2:
1. Trades n ≥ 50.
2. Net P&L > 0 and profit factor ≥ 1.20.
3. Bootstrap 95% CI (10,000 resamples, seed 20261107) of mean trade P&L has lower bound > 0.
4. Net > 0 after removing the best trade, after removing the best day, and after removing the top 3 trades.
5. ≥ 90% of scheduled (non-holiday weekday) sessions eligible.
INSUFFICIENT DATA if 1 or 5 fails in either period; any other failure → FAIL.
C3/C4 and the 15:30-entry disclosure are reported but are not decision inputs.

## Benchmarks
- No trade: $0.
- Passive: always LONG 1 MES, 15:31 open → 15:59 open on every eligible session, C2 costs.
