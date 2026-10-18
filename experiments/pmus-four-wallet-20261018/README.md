# Four-wallet Polymarket US paper study

This separate prospective trial follows ic4cream, alwaysfade, monkeymashingkeyboard and para-Vision after the user's October 18, 2026 request to proceed. The independent five-wallet study continues under its original frozen code and protocol.

Each wallet receives its own fictional $1,000 account, with at most 10 contracts per US market and 20 open markets. Only fresh post-epoch executed BUYs corroborated by current net inventory can open or add exposure. Reductions and flips follow the observed net position. Old holdings are not imported.

New entries are collected for 48 hours after the actual verified bootstrap epoch; source exits and official US settlements may continue for up to 48 additional hours, ending sooner if all positions are closed after collection. The epoch and deadlines are published, not inferred from a queued job.

## Matching and execution

Eligible contracts are binary full-game moneylines in NFL, CFB, NBA, NHL, MLB and WNBA, before and during scheduled games. Source and US kickoff, league, team identity, outcome bijection, quantity step, fees and rules must be verified. Known contingency differences are accepted and associations always retain exact_approved=false.

The existing reviewed NBA/NHL aliases remain. This cohort additionally permits the captured NFL Rams slug alias la→lar and a bounded calendar lookup: try the source slug's date first; only an HTTP 404 permits a second candidate using the structured kickoff date in America/New_York. Schedule/identity mismatches and other network errors fail closed. Captured Panthers–Eagles, Cowboys–Packers and Cardinals–Rams fixtures are in additional_mapping_fixtures.json. No fuzzy team or arbitrary-date search is used.

The accounting model is reused unchanged from code fa7826e4325dbdeba4dd5c5e30d475f438e8488d. Entries require a signal at most 120 seconds old, at least five seconds after first observation, US book timestamp age at most 60 seconds, full requested bid/offer depth and an average price no more than $0.03 worse than the source BUY. Fees use coefficient 0.0695; stress subtracts another $0.01 per contract actually bought or sold. Missing or stale quotes cause skips, not synthetic fills.

Foreign resolution, redemption, empty uncorroborated inventory or unavailable US quotes cannot settle or sell held US contracts. Official US status, settlement identity/price and long-side resolution agreement are required. All held inventory survives checkpoints and remains unresolved if the fixed drain deadline arrives.

## Evidence and assessment

Ten-minute compressed state/raw checkpoints publish only to research/pmus-four-wallet-state-20261018 under paper-results/pmus-four-wallet-forward-20261018-v1/. Code commit and protocol SHA-256 are included in every checkpoint. Sequential jobs verify the exact preceding completed segment. Duplicate bootstrap, rewinds and concurrent branch overwrite are rejected. The publisher is restricted to this exact state branch.

The workflow uses standard Ubuntu runners in this public repository and no Actions artifacts/cache, app/database, venue credentials, orders, paid AI or Lovable generation. The automatically issued repository token only publishes checkpoints. Other branches, PR 62, experiments and automations are outside its scope.

Public source polling and latest returned executed trades remain distinct. Profit is measured on each independent fictional account with fees, stress, completed DISTINCT US markets, actually bought/sold/settled quantities and mark/coverage limitations. Source leaderboard profit is not a follower return; wallets on the same game do not create independent extra wins.

The original study exposed severe incomplete US mark coverage. These four wallets use the same public venue data; selecting different wallets does not fix that data limitation. Historical gaps will not be imputed or assigned zero return. The frozen 95% source/mark coverage and 30-completed-market gates still apply.

Terminal precedence: unresolved holdings → UNRESOLVED_SETTLEMENTS; fewer than 30 completed distinct markets or below 95% full planned source/mark coverage → INSUFFICIENT_TRADES/COVERAGE; base/stress net nonpositive or observed drawdown above $200 → FAILED_SCREEN; positive net/stress with nonpositive lower event-cluster bootstrap percentile → POSITIVE_BUT_UNCERTAIN; all gates passed and positive lower percentile → PROMISING_SCREEN_ONLY. Before terminal, status is SCREEN_PENDING. A promising result is only a short screen with game/day dependence, four simultaneous comparisons and winner-selection bias.

## Checks

Run python3 -m unittest discover -v before launch. Run readiness.py --work PATH only for bounded public GET validation; that command creates no forward account or venue order. Launch is established only by the exact workflow run plus verified published bootstrap checkpoint.

The original four captured association/accounting fixtures and 22 accounting/collector tests are retained. Eight added tests cover four-account identity/capital, captured team/time joins, date fallback, the Rams alias, 429 rejection, wrong kickoff rejection and strict publisher branch scope.

Primary evidence for selection and alias/calendar cases is the separately captured October 18 watchlist report and raw responses. New readiness captures must pass immediately before launch. protocol.json is frozen before the actual forward start.
