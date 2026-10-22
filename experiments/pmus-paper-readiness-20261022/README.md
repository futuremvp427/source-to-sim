# Before the next profitability study

This is a separate, fail-closed **pre-entry readiness audit**, not a collector,
not a live qualification and not a profitability result. Original studies,
the frozen live gate and default/production code remain unchanged.

`requirements.json` preserves the currently authorized 48-hour collection and
at most 48-hour settlement drain. It adds no trades or wallets and lowers no
screen gate. Its digest must be frozen before running `readiness.py`.

The full repaired paper collector and its workflow must be implemented and
verified against this contract before any paper entries. The workflow must
run this check before initializing accounts/entry collection, pin its required
digest, and refuse a nonzero result. Future orchestration must also verify the
same exact published evidence. This directory alone does **not** implement that
workflow or make a launch ready.

For every required check, a reviewer must provide a local proof file with its
SHA-256/length, inspected immutable code/run identities and verification results.
The tool checks file integrity, identities and hard numeric gates; it cannot
establish the truth of a reviewer-authored claim by itself. Synthetic unit-test
fixtures are never launch evidence. Do not pass a fixture packet to a collector.

Required demonstrations include causal source/quote-to-fill replay; fees,
stress, cash and inventory; reductions/flips; US-only settlement orientation;
fixed planned source/mark denominators including missed scheduled samples;
held-inventory marks reported separately so long flat/settled periods cannot
hide missing live exposure; crash/resume without rewind; idempotent publication
and independently restored summaries; and a complete final evaluator exercised
on win, loss, insufficient-coverage and unresolved-position fixtures.

Every final report must distinguish realized/completed returns from open exposure
and preserve all unresolved holdings. Exact rule association is never claimed.
Each entry and later mark still needs current valid identity and executable
depth; passing two NHL games does not qualify all future markets.

## Sample feasibility is a separate gate

Earlier reconciled recorded fills completed 0, 3, 8 and 4 distinct markets for
ic4cream, alwaysfade, monkeymashingkeyboard and para-Vision respectively. Those
are observations under the earlier faulty collection, not a forecast of new
throughput or proof that a reliable feed will produce 30 markets in 48 hours.

Before the first new entry, review eligible executed-signal/event throughput
and US settlement dates for **each** wallet. Preserve the supporting raw reads
and rejected-event reasons. Do not count repeated fills, source poll successes
or several wallets on one game as additional independent markets.

Unknown or below-30 conservative per-wallet estimates block a claim that this
48-hour design is adequately sampled. If the sample plan fails, explain before
launch and obtain a new explicit, outcome-independent design decision. Do not
silently extend this horizon, stop when P&L becomes positive, replace wallets or
pool four accounts to manufacture the count. Forecasts never guarantee realized
activity; an honest inconclusive result remains possible.

## Continuous evaluability, not end-of-run surprises

The collector must expose source coverage (elapsed and full planned), scheduled
complete/held-inventory mark coverage, skip/fill reasons, latency, actual distinct
completed and pending event counts, earliest settlement dates and remaining
sample requirement at every published checkpoint. Alert on missing observations,
stale publication, an irrecoverable 95% denominator failure, or a known schedule/
activity shortfall before the endpoint. Preserve the fixed epoch and holdings;
do not restart to erase missing time. Routine healthy waiting stays quiet.

Thirty completed markets and good coverage allow a minimum short screen. They
do not guarantee a positive bootstrap lower bound, statistical power or lasting
real-money profitability. Costs, game/day dependence, recent-winner selection
and four simultaneous comparisons remain limitations even in a valid result.
