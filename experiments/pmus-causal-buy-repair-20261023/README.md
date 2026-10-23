# Causal BUY observation repair and published lifecycle fixture

The original four-wallet strategy, source wallets, supported leagues, capital,
ten-contract cap, five-second minimum observation delay, fees/stress, 48-hour
entry window, maximum 48-hour settlement drain and evaluation gates are kept.
The original protocol bytes are unchanged. This branch is an isolated repair
candidate, not a paper launch, a live-gate pass or a profitability result.

## Confirmed defects

1. A SELL could create a pending condition before a later BUY. The collector
   checked the BUY against that older condition-level first-observed time.
   A full reduction/addition/flip fixture reproduced an immediate later BUY
   that failed causal replay. The repair binds the delay to the actual BUY's
   saved HTTP receipt, never earlier than the condition-level observation.
2. For distinct BUY executions with the same timestamp, execution used the
   first maximum timestamp while saved evidence selected the last match.
   Different prices could make independent replay reject the saved fill.
   Evidence selection now matches the price-gated execution's stable choice.

Both new regressions fail on the unmodified parent core and pass after the fix.
The full local suite passes 240 tests: 30 frozen, 122 reliability, 28 readiness,
33 integration, 27 live/cache. No fixture failure was a live account incident.

## Fixture proof

`lifecycle_fixture.py` drives the existing IntegratedCollector with explicitly
synthetic source executions and stream books. It captures BUY, half reduction,
fresh addition after the original delay, close-and-flip, restart restoration,
US settlement despite foreign position-fetch failure, and terminal evaluation.
It does not call any public network, acquire credentials or start a study.

The resulting six sealed checkpoints contain five simulated BUY/SELL fills
and one simulated US settlement. The existing independent verifier recomputes
the cash, inventory, raw ledgers, fees/stress and summaries. Missing scheduled
samples remain missing; the fixture correctly reports insufficient coverage.
No simulated fixture result may be reported as a wallet's forward return.

After publishing the immutable code, run the fixture with that exact code SHA.
Publish its archive, per-file digest manifest, result and test logs separately.
Download only connector-observed immutable commit/file identities and verify
Git SHA-1/length plus SHA-256 before running `verify_fixture.py` on those bytes.

The fixture proof does not replace live data qualification, all required final
status scenarios, resource feasibility, or the still-unqualified conservative
30-completed-distinct-market-per-wallet sample plan. No old study is restarted.
No new collector, paper clock, venue order path, paid resource or automation is
introduced. The previously repaired event-ID cache recovery is inherited from
parent 0f2793749ce3bc069476f7e2ad80b18c07bf2384; its old live gate remains failed.
