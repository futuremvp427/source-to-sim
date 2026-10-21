# Restart repair: bounded decision evidence and artifact recovery

The user authorized resuming repair and testing on October 20, 2026. This is a
new data-only reliability run. It does not resume, replace, or stitch additional
observations into either frozen wallet study. The original journals, balances,
holdings, source-wallet selection, trade rules and evaluation gates are preserved.

## Observed failure evidence

The preceding data-only run was
[39426694961](https://github.com/futuremvp427/source-to-sim/actions/runs/39426694961),
code `e4c8b6d6a2e9ff84ef5522ccc4bb20415c626fc6`. Its `soak_02` job ended with
`RuntimeError` after 40,941.05658650398 seconds (11.3725157185 hours) of elapsed
collection. This was not a complete 24-hour reliability pass.

Its [saved artifact](https://github.com/futuremvp427/source-to-sim/actions/runs/39426694961/artifacts/12310909398)
has 59,881,762 bytes and verified SHA-256
`ae0b136395d8bfca7d7ac38df29e15ae3ab72958b7764ff3cda03a45232a6013`.
The extracted WAL contains 1,073,740,035 bytes against a 1,073,741,824-byte
limit: only 1,789 bytes of remaining capacity. Its 210,642 `stream_book` rows
account for 1,055,304,840 bytes. Subsequent full-book rows of the observed size
cannot fit. This identifies the storage bottleneck and reproduces the limit
condition; the historical log did not retain the exact RuntimeError message or
identify the particular append that raised it.

`soak_03` subsequently received a runner shutdown signal. Its log does not
establish why the runner shut down. No artifact for that segment was uploaded.
The remaining jobs requested only the immediately preceding artifact, then
attempted a full Git restore when it was unavailable. They ended with
`PublicationError`; the old publisher did not preserve HTTP diagnostics, so its
historical underlying HTTP reason is not established.

The machine-readable profiles in `restart-evidence/` are derived from the
SHA-verified artifact. They are offline storage diagnostics, not new market
observations, quality coverage, fills, settlement results or follower returns.

## Resulting behavior

* Every accepted full-book receipt is durably recorded in arrival order with
  receipt time, venue time, market identity and the canonical full-book hash.
  Full normalized book data is additionally persisted whenever a current
  snapshot or historical timestamp-aligned comparison selects it for evaluation.
  That full book must match the earlier receipt hash and timestamp. Repeated
  reads of the same selected receipt reuse its existing evidence reference.
* Unused incoming books retain receipt hashes rather than a complete raw body.
  Consequently those unused bodies cannot all be reconstructed after process
  loss. Every book actually selected for evaluation is retained in full. This
  capture policy is explicit and does not certify a complete all-message raw feed.
* Freshness, executable depth, same-event/team mapping, exact venue-timestamp
  comparison and coverage denominators are unchanged. The 1 GiB WAL bound is
  retained. A capacity failure is reported as a safe specific error code rather
  than being relabeled a successful interval.
* A same-run artifact with the WAL, plan and pending-publication record is
  verified locally before collection resumes. It is no longer needlessly
  replaced by thousands of authenticated Git blob downloads. Pending exact
  publication state and branch-head checks remain in force.
* Each later job downloads available same-run backups and selects the newest
  available segment. A missing intermediate artifact does not hide an earlier
  available backup. An incomplete or identity-mismatched newest artifact stops
  recovery rather than silently selecting older evidence. An absent local
  backup requires verified remote recovery or an explicit failure; it cannot
  initialize another collection clock.
* Rate-limit responses retain safe status/path/header diagnostics and a response
  digest, without exception bodies or credentials. Long Retry-After/reset waits
  defer background publication while market sampling continues. Persistent
  non-rate-limit authorization errors remain distinct. Provider-wide runner
  failure can still interrupt collection; the workflow does not guarantee uptime.

## Validation before publication

122 offline tests pass, including the prior 112 checks and ten new checks for
compact evidence, exact receipt/body binding, resume, historical timestamp
alignment, missing intermediate backups, corrupt newest backups, local-first
recovery and nonblocking long rate-limit waits. Workflow structure checks cover
all five recovery jobs and retain the fixed duration, authorization gates,
non-cancelling concurrency and independent artifact uploads.

An offline profile of the first 10,000 full-book messages from the verified old
artifact measured 32,851,960 old WAL bytes versus 4,621,610 bytes with hashed
receipts and 178 selected full books, using one selection per market per
20-second interval. Reduction is `1 - 4,621,610 / 32,851,960`, or 85.93201136%.
This is a storage profile, not a guarantee that a future 24-hour run will fit,
maintain coverage, or pass its data-quality gate.

The push starts the existing isolated workflow. Verification, save/restore,
public data and authenticated market-data preflights must pass before the
24-hour window begins. No new wallet-following test or real orders start
automatically. A running job is not proof of fresh valid observations; live
evidence must be checked after publication.
