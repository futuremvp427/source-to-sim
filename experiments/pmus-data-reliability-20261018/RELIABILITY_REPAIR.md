# Isolated data reliability repair — October 20, 2026

The original wallet trials remain frozen. This version collects market data
only and does not import a collector, copy a source trade, make a paper fill,
access a private account, or submit an order. It does not repair missing history
in an earlier trial or establish that a wallet is profitable.

## Observed problems

The five-wallet job stopped when GitHub returned HTTP 500 during checkpoint
publication. Its exception path then attempted to append to a closed LZMA
journal. The separately reviewed publication correction is draft PR 63.

A fresh public-only diagnostic on October 20, 2026, 11:38:28–11:39:34 UTC
captured six full-book responses for three already known sports markets.
Three were rejected solely because HTTP Age was 26–27 seconds while the
frozen maximum was 20 seconds. Their responses advertised
`Cache-Control: public, max-age=30`; the client had requested `no-cache`.
The other three full-book responses passed that cache-age gate. This establishes
one measured reason for rejection, not the cause of every historical missing
mark. An old book timestamp alone does not distinguish an unchanged book from
an upstream feed delay. Neither HTTP receipt nor a heartbeat substitutes for
the venue book timestamp.

## Changes

- Every acknowledged evidence row is fsynced to an append-only journal.
- Sealing a checkpoint leaves the active journal open. A sealed checkpoint
  appears atomically, and its contents cannot be overwritten with other bytes.
- Restart recovery verifies the complete sequence, hashes, raw HTTP bodies,
  checkpoint chain, plan, code pin and run identity before collecting.
- A missing prior plan, conflicting evidence, or partial journal tail stops
  recovery explicitly. There is no automatic reset, rewind, truncation, or
  replacement of missing time with fabricated observations.
- GitHub publication runs in a background worker. Transient errors retry with
  bounds; pending bytes and ambiguous commit identities are retained for
  reconciliation. A slow publication does not block market sampling.
- Each diagnostic run has a dedicated research state branch. Original study
  branches, ledgers and reports are not used for writes.
- The market stream reconnects with bounded backoff. A new session clears
  previous-session books. Heartbeats do not refresh book time. Known camelCase
  and snake_case market-message spellings are normalized; conflicting aliases
  are rejected.
- Public metadata is refreshed independently of book state. An old OPEN book
  cannot hide a resolved market. Settlement requires official US final metadata,
  matching market/side/rules identity, and agreement with the official payout
  endpoint. Foreign resolution does not qualify.
- Failures are isolated by market. Every planned observation slot remains in
  the elapsed and full-window denominators, including downtime between jobs.
- Configuration failures produce a saved, sanitized summary. Keys, signatures,
  request authentication headers, private messages and account data are not
  exported. Authentication signs only the fixed market-data GET handshake.
- Each job has a pinned, unconditional artifact backup of its evidence.

## Validation and launch gates

The three offline suites currently contain 104 passing tests. They include an
abrupt subprocess exit after an acknowledged write, restart with skipped time,
corrupt/partial evidence, exact remote reconstruction, transient HTTP 500,
permission denial, pending publication, ambiguous ref update, continued
observations during a slow save, changed market rules and conflicting US payout.

The isolated workflow first runs those tests, then a 120-second public check
and a 120-second authenticated market-data-only check against the same public
market plan. A present but malformed secret is a configuration failure and is
never treated as a successful connection. Public endpoints do not need a key.
The full-day check is skipped unless both preflight gates pass.

If preflight passes, six bounded segments cover one fixed 24-hour window.
The initial segment alone may establish its epoch. Later segments restore the
verified local backup and/or published checkpoints; absence of both is an
explicit failure. Publication occurs approximately every ten minutes, and each
segment also saves its complete local backup as an Actions artifact.

The data gate requires at least 95% full planned usable coverage per selected
market, at least one matching fresh REST/stream pair per market, and at least
30 fresh stream observation ticks per market. Tradable book observations and
official settlement observations are reported separately. A short check cannot
pass the full-day gate. This diagnostic does not certify source-wallet coverage
or actual game-in-progress phase coverage, and does not automatically authorize
a new wallet trial.

## Remaining limits

This is not proof that a live stream will pass or stay available. Abrupt loss of
the whole runner can lose evidence after the last remote save; no local fsync
can repair destruction of the host. GitHub branches and Actions artifacts use
different save paths but share GitHub as a provider. A sufficiently long outage
still creates visible coverage gaps. Fully independent remote storage requires
a separately selected and authorized service; none is provisioned here.

Future games cannot be settled early. Current quotes are not historical fills.
Missing executable depth cannot be recovered from display-only price history.
Existing trial code pins, time windows and evaluation gates remain unchanged.

Official references:

- https://docs.polymarket.us/api-reference/markets/get-market-book
- https://docs.polymarket.us/api-reference/websocket/markets
- https://docs.polymarket.us/api-reference/websocket/overview
- https://docs.polymarket.us/api-reference/authentication
- https://docs.polymarket.us/api-reference/markets/get-market-settlement
- https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts
