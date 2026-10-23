# Event-status cache repair, October 23, 2026

The failed live gate is preserved as run 39871608024, code
`c5992e8318ac8188a7f0a35843a2c3905f995e41`, published state
`4861a335e69d1cff9e74fac9340fc902a5fc0725`. The unchanged pinned code independently
verified all 39 published blobs (707235 bytes), three checkpoints, 2286 raw rows,
HTTP digests, captured stream receipt references, phase decisions and summary.
The actual interval was 2026-10-22 23:25:22.826667Z–23:30:24.009540Z.

Each game had 16/16 fresh stream books, and all four wallets had 16/16 valid polls.
Each game's slug endpoint produced five HTTP `Age` values of 22–25 seconds while
advertising `Cache-Control: public, max-age=30`. The frozen check requires age
at most 20 seconds. Five misses made 86/90 good ticks impossible. Request
`Cache-Control: no-cache` alone did not force the serving cache to revalidate.

## Repair

The existing EventClient now attempts the normal slug route, then the documented
exact event-ID route only on a stale-cache response with the expected identity.
If both are cached, one final request may wait for the advertised cache expiry,
but only within 16 seconds of the original scheduled tick. There are at most
three requests, no changed denominator or timestamp, and no query nonce.
All raw attempts and the selected evidence reference are retained.

The age limit remains 20 seconds. Missing/invalid/future dates, malformed or
changed event identities, redirects, 401/403 and 429 do not earn coverage or
trigger route hopping. Live/open/ended and market-rule/side checks still apply
after selecting fresh HTTP evidence. Completed games cannot certify live data.

This branch changes neither the original live-gate branch/run nor the prepared
paper branch or protocol. The isolated workflow only runs regressions and has
no market-data credentials, capture job, paper epoch, or order path.

Official event-ID route: https://docs.polymarket.us/api-reference/events/get-event-by-id
Official event fields: https://docs.polymarket.us/api-reference/events/overview

## Actual public check

The repaired EventClient was exercised for four fixed 20-second ticks on each
of the two exact recorded games. All eight selected responses passed the same
20-second transport and exact identity checks. Two stale first attempts were
successfully recovered through the ID route. The measured interval lasted
64.4898405075 seconds. Both games were already ended: live samples were zero,
and no live gate or paper epoch was initialized. Hash-linked raw evidence and
the summary are under `cache-repair-evidence/phase-diagnostic/` in this branch.

## Reproduce

Install `experiments/pmus-data-reliability-20261018/requirements-stream.txt` in a
private virtual environment. Run the five test groups in the isolated workflow.
The new diagnostic command is:

```sh
python3 experiments/pmus-live-gate-20261022/diagnose_phase_cache.py --output NEW_EMPTY_DIAGNOSTIC_DIRECTORY
```

That command is four public HTTP ticks only. It never initializes accounts,
submits orders, obtains credentials, restarts the failed gate, or certifies live
readiness. It refuses an existing output directory.

## Remaining decision before a profitability test

This fixes the measured cache-transport failure in a bounded diagnostic. It does
not establish future live coverage or a sufficient market sample. The unchanged
48-hour design still has no credible conservative path to 30 completed distinct
US markets per original wallet. Preparation's historical associations were
10/8/8/4, not follower fills or predicted future completions. A fixed longer
collection/drain design would need to be selected before new outcomes and
qualified against schedules; lowering the 30-market or 95% gates is not a repair.
No paper epoch may start merely because these regressions or this diagnostic pass.
