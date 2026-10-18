# Isolated US market-data reliability diagnostic

Authorized October 18, 2026 after the two frozen wallet studies developed
incomplete executable-mark coverage. This directory is **data-only**, not a new
follower, wallet cohort, trading strategy, or replay of either study.

## What is implemented

1. Every distinct matched US market is queried independently. A stale first
   position cannot prevent collection of later markets. Every watched source
   condition remains in the report, including failed/unmatched conditions.
2. Pure REST-versus-stream snapshot comparison is prepared in `quality.py`.
   **Actual official stream connection/validation is blocked**: no approved
   read-only credentials are configured. This code does not read environment
   secrets, open authenticated sockets, create accounts, or place orders.
3. Source contracts are joined against the **actual paginated US catalog** by
   verified event time, league, teams, binary full-game structure, rules, fees,
   orientation and quantity step. No US slug is constructed from a foreign slug.
   Zero matches, ambiguous matches, stale metadata, pagination failures and
   mapping drift fail closed. The existing pinned association validator is
   reused byte-for-byte; associations are never labeled EXACT.
4. A 24-hour public data-only soak harness and conservative 95% gate are
   implemented. A short smoke run **cannot pass**. Missed slots stay in the
   denominator; pre/post-scheduled-start coverage is reported separately.
   Each market must also have at least 30 valid book observations; a run made
   entirely of already-settled values cannot pass the public observation gate.

## Safety and isolation

- Base code: `130c37763b2d8d7766ea181e398056a50e4a6c66`.
- New files only under `experiments/pmus-data-reliability-20261018/`.
- Existing five/four-wallet code, checkpoints, ledgers, holdings, reports,
  automation reviews, rules, thresholds and deadlines are NOT modified.
- No change to default/production, database, application, PR 62 or old tasks.
- No GitHub workflow or scheduled automation is created; no existing workflow
  is dispatched, rerun, cancelled or restarted.
- Only allowlisted public HTTPS **GET** market-data endpoints are reachable.
  Redirects, userinfo, explicit ports, authentication and order URLs are blocked.
  An explicit HTTP 401/403 stops the probe; it does not try another access route.
- Live public queries are disabled by default. A selected market set can reveal
  non-public research intent even when every individual identifier is public.
  Explicit user approval for the named API destinations is required before
  enabling live requests. Never treat the CLI flag as a replacement for approval.
- No real derived research watchlist or its live evidence is committed here.
- Independent output must be a new nonexistent directory. No overwrite/resume
  of old evidence. Raw bodies are saved with SHA-256 and a sequence/hash chain.
- Rate limit: three requests/second, bounded response size, eight-second
  request timeout and 429 cooldown. Evidence is capped at 512 MiB uncompressed.
- Bootstrap is bounded to 180 seconds; the requested measurement window starts
  only after bootstrap. Exceeding the bound is reported as a failure, never a
  successful empty observation interval.
- No source-wallet trade feed is collected and no paper fills/P&L are created.

## What this does NOT fix or claim

A successful HTTP response is not proof of an executable price. We retain the
20-second HTTP cache limit and 60-second book timestamp limit; a fresh HTTP
`Date` never overrides a stale `Age`. The response receipt time, HTTP Date/Age,
book transaction time, rejection reason(s), state and depth are separated.
Absent Age is explicitly reported, not called proof of origin freshness.

`inspect_book` conservatively tests selling **ten contracts on both sides** for
data-readiness purposes, not the actual inventory of any running account.
No complete account liquidation value is invented from partial market prices.
No BBO/last-trade/international price substitutes for full US executable depth.

An old `transactTime` may represent delayed delivery OR an unchanged book. We
do not infer which from REST alone and do not relax the gate to improve scores.
The `compare_stream` helper compares normalized full books near the same book
time; a heartbeat does not refresh the book. Matching offline fixtures does
not prove live authenticated access, continuity, or reliable real-time data.

Catalog pagination must reach an empty page and cannot repeat identities. A
short first page is not taken as proof of complete pagination. Missing detail
fields are fetched only by a slug actually observed in that catalog, never by
a constructed foreign slug. Metadata is refreshed every five minutes. A mapping change is rejected. If an
initially matched market retires, only a verified final response from the
**official US settlement endpoint** can count as terminal data; settlement
ticks are separate from valid tradable-book ticks. Foreign resolutions are
never used. Tick phases are based on scheduled start, not proof of live play.

The overall `ready_for_new_paper_study` remains **false** until approved
official-stream comparison and actual in-play validation are separately
implemented and completed. Even a future public gate pass would only establish
data availability, not a profitable wallet or a strategy edge.

## Run offline tests

From this directory:

```sh
python3 -m unittest -v test_quality.py
```

## Bounded public smoke / full public soak

The committed `watchlist.example.json` is **synthetic and offline-only**. No
actual research-selection list is published. After explicit authorization,
prepare a private watchlist with `source_condition_ids` (1–50 unique hex
condition IDs). The probe obtains fresh source metadata and the real US catalog.
Do not enable either example command until that disclosure is approved.

```sh
python3 probe.py --watchlist /private/approved-watchlist.json --output /absolute/new/scratch/probe-smoke --run-seconds 60 --approved-public-watchlist-queries
python3 probe.py --watchlist /private/approved-watchlist.json --output /absolute/new/scratch/probe-24h --run-seconds 86400 --approved-public-watchlist-queries
```

The default is a **60-second smoke**, not a 24-hour run. A 24-hour process must
be explicitly started in an approved durable runtime; creating this harness
does not mean that long-running test has started or passed. Early stops retain
the full planned 4,320-tick denominator. `summary.json` records blocked stages,
actual duration/cycles and evidence hashes. Do not attach this output to either
existing study as replacement or repaired historical data.

## Official data-access prerequisite

The documented retail US Markets WebSocket requires API-key authentication.
The official read-only Data Guide has an onboarding/agreement route with
`read:marketdata`, `read:l2marketdata` and `read:instruments` scopes. Neither
credential provisioning, the agreement, external contact nor a paid feed is
performed by this diagnostic. Do not paste secrets into chat or commit them.
Do not use a trading-enabled key as a shortcut to data-only access.

Official references checked October 18, 2026:

- https://docs.polymarket.us/api-reference/markets/get-markets
- https://docs.polymarket.us/api-reference/markets/get-market-book
- https://docs.polymarket.us/api-reference/websocket/markets
- https://docs.polymarket.us/data-guide/onboarding

Future fixes must live in new commits/new protocols. These files do not grant
permission to modify a frozen study, start another follower trial, or fund it.
