# Live-book qualification, authorized October 22, 2026

This is a new read-only data gate, not a restart of either frozen wallet study.
No real orders, account requests, funding, production writes or paid runners.
Only standard public-repository GitHub-hosted runners are allowed by the workflow.
The configured API credentials are used solely by the existing market-data WebSocket.

The initial launch is a 120-second connection/source/save preflight. It cannot
certify in-play data. The two frozen US NHL events are scheduled for October 22
at 7:00 PM America/New_York. No pregame or finished-game sample earns live coverage.
An explicitly authorized follow-up may change only launch.json to mode=live once
the official US event endpoint reports live=true for both exact event identities.

## Frozen live gate

- 30 minutes, 20-second scheduled samples, 90 planned ticks, two US event markets.
- At least 95% full-planned live-and-fresh-stream-quote coverage for EACH market.
- At least 95% full-planned complete paginated source-poll coverage for EACH of the
  original four wallets from protocol SHA-256
  1be659edf8286da821eacd314f81fee3c46f8a5ff52a16c4bb5d56cfb02f108f.
- Explicit fresh official `live=true`, no `ended=true`, active/open event, unchanged
  event ID, slug, schedule, US rules hash and side IDs/orientation. A scheduled
  start, a score, or a running job never supplies in-play proof.
- Fresh full tradable WebSocket books, venue timestamp <=60s old, enough actual
  displayed depth to model liquidation of ten contracts on either side.
- At least three distinct venue timestamps with matching fresh REST/previously
  received stream books per market. Historical matching does not supply current marks.
- Missing ticks and failed polls remain in the full 90-tick denominator. Stop as
  soon as reaching 95% becomes impossible. No retries of a failed study epoch.
- No settlement payouts, heartbeats, receipt-only records, stale quotes or empty
  source polls are interpreted as fills or zero P&L. Successful polls and latest
  returned executions are reported separately.
- Evidence is fsynced, checkpointed about every five minutes, mirrored to the
  new run-specific `research/pmus-data-quality-state-RUN_ID` branch, then independently
  downloaded/replayed from the acknowledged immutable generation before success.
  A separate always artifact preserves the WAL after a failure.

## After this gate

Passing only permits preparation/start of a separate prospective paper study;
it is not a profitability finding and does not itself execute paper trades.
Keep the same four wallets, independent fictional $1,000 accounts, ten-contract
cap, fresh executed-BUY/net-side/reduction/flip rules, modeled fees/stress,
verified US settlements, and original final-screen precedence. Freeze any new
study's full protocol, exact code/run, planned collection interval and bounded
drain BEFORE the first entry. Use fresh stream transport with preserved quote
references and repaired durable publication, not the known failing collector
unchanged. Do not auto-start paper entries until the gate's published evidence
and remote round-trip verification both pass independent review.

Do not select winners from the recovered small-sample P&L or replace wallets.
An evaluation needs 30 completed distinct US markets and 95% full-planned source
and complete-mark coverage per account; below either, remain insufficient.
Never extend a test until it becomes positive or imply that reaching 30 is guaranteed.
Original studies, reports and paused reviews stay preserved and paused.

Official phase fields: https://docs.polymarket.us/api-reference/events/overview
Public market-data and WebSocket roles: https://docs.polymarket.us/api-reference/introduction
