# Project State

## Agent Rule

Read PROJECT_STATE.md before beginning substantive work. Do not reopen a CLOSED finding unless a regression test fails or new production evidence directly contradicts it. Update PROJECT_STATE.md before finishing the task.

## Current Production State

- Existing Sports Shadow production/cross-venue path remains authoritative and unchanged by the isolated Kalshi same-venue research branch.
- Live execution is disabled. `LIVE_EXECUTION_IMPLEMENTED=false`.
- Historical `EXACT/NEAR/NONE/UNVERIFIED` metrics must be preserved.

## Closed Findings

- Existing cross-venue lifecycle, matching, settlement, persistence, source-continuity, rate-limit, and deployment-safety findings remain closed unless a regression test or new production evidence directly contradicts them.

## Current Blockers

### KALSHI SAME-VENUE SOURCE PATH (2026-09-18)

- Status: SAFE PAPER/RESEARCH SCAFFOLD IMPLEMENTED; EXTERNAL SOURCE CONTRACT BLOCKED; PRODUCTION PATH UNCHANGED.
- Branch: `feature/kalshi-same-venue-copy-source`.
- Draft PR: #61 `feat: start Kalshi same-venue copy source path`.
- Base commit: `aafe7a5f0966abb4a30de07b96bd1932ad8d356f`.
- Head inspected on 2026-09-18: `4b05a223f4d1c420aecb83d89348eadac12cd856` before this documentation-only update.
- Goal: paper/research Kalshi-to-Kalshi copying using the exact source Kalshi ticker and YES/NO side, bypassing cross-venue economic-equivalence resolution only when supported by exact same-venue source evidence.
- Implemented on the feature branch: fail-closed source normalization, stable `KALSHI_SRC:<traderId>:<sourceTradeId>` dedupe, explicit trader qualification/watchlist gate, exact ticker/side routing, existing episode lifecycle reuse, persistence migrations/hardening/source cursor scaffolding, settlement support, and tests. No undocumented public per-trader transport has been added.
- Fresh official-product evidence (verified 2026-09-18): Kalshi Social has Feed, Following, and Leaderboard views; users can share a position in a Social post; public profile pages exist; and Inner Circle can expose non-public social trading activity including positions, trade history, and P&L to accepted members.
- Critical distinction: those product/UI capabilities do NOT establish a documented public machine-readable interface that exposes another arbitrary trader's complete trade stream with stable per-trade identity and all required execution fields.
- Source-contract verdict: BLOCKED. Current official/help documentation reviewed still does not establish a supported public per-trader activity endpoint satisfying the adapter contract. Do not scrape/private-reverse-engineer or hard-code an undocumented endpoint.
- Required evidence before a production `KalshiTraderActivitySource` transport can be implemented: stable public trader/profile id; stable per-trade id; exact ticker; YES/NO side; BUY/SELL action; quantity; execution price; execution timestamp; and documented/officially supported access semantics/rate limits/terms permitting automated read use.
- CI observation on 2026-09-18: GitHub returned no pull-request workflow runs associated with inspected head `4b05a223f4d1c420aecb83d89348eadac12cd856`; therefore independent GitHub CI is not yet confirmed for that head.
- Lovable credits used in this run: 0. No generation credit was justified because the blocker is an external Kalshi source contract, not an implementation/debugging deficiency Lovable can resolve.
- Next safe step: wait for/verify an official supported source contract (or user-authorized supported source access if Kalshi exposes one); once verified, implement only that adapter, then run branch CI and forward paper validation. Until then, do not invent transport behavior and do not make further source-adapter implementation changes.
- Validation-answer status: NOT REACHED. Forward paper validation cannot answer whether copying a selected Kalshi trader is viable until a supported source feed can provide complete, attributable trade events.
- Safety: no merge to `main`; no live trading; no order-placement path; `LIVE_EXECUTION_IMPLEMENTED=false`; existing cross-venue path and historical metrics preserved.
