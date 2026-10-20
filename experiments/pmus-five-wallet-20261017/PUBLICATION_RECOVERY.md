# Publication reliability proposal — 20 October 2026

This change is staged for review on a separate research branch. The failed run
39065098271, its frozen code commit, its published checkpoint branch and both
existing studies remain unchanged. Do not dispatch, bootstrap, rerun or merge
this proposal into the frozen study to resume it. Future adoption requires a
separately authorized study identity, code pin and preflight.

## Measured failure and reproduced defect

The exact job 118334236548 failed at 2026-10-19T23:29:08.3265226Z when the GitHub
Git database returned HTTP 500 during POST /git/blobs. The original request
method had no retry. Its checkpoint had already closed the compressed journal
and written sealed files to the runner's local output directory. The exception
handler then attempted Journal.add on that closed file. An offline reproduction
returns ValueError: I/O operation on closed file, matching the logged fallback
exception type. The workflow contained no artifact backup. Its artifact list is
empty; the unpublished runner tail cannot be claimed as recovered data.

## Resulting behavior

* Transient 408/429/500/502/503/504 responses and transport failures receive at
  most five attempts. Short Retry-After values are honored. Authentication and
  ordinary permission failures stop immediately; waits beyond the retry bound
  preserve evidence rather than hammering the service. Uncertain branch
  creation is not blindly repeated.
* Sealed checkpoint files and their publication intent are written atomically
  and fsynced before network publication. An immutable path cannot be replaced
  with different bytes. Retrying uses the exact existing checkpoint, without
  adding a new checkpoint or ledger row. State changes while pending are
  rejected.
* Ambiguous ref-update responses are reconciled against the exact proposed
  commit. Repeated publication of those bytes is idempotent; concurrent branch
  changes are rejected with no forced update. Content reads use the observed
  immutable head.
* Exhausted publication failures keep the sealed checkpoint and original error.
  They do not write into a closed journal, invent a terminal observation or
  rewind. The job still reports failure when publication cannot be confirmed.
* Every bootstrap/collection job uploads paper-work/output as a separate Actions
  artifact even when the collection step fails. Artifact names include run,
  attempt and job identity; retention is 14 days. The action is pinned to the
  observed official v4 commit ea165f8d65b6e75b540449e92b4886f43607fa02.

This handles a temporary Git-save failure and adds a second recovery route.
It cannot promise uninterrupted collection during a long outage or abrupt
runner loss. Retry time can create measured observation gaps, which must remain
visible in coverage. Artifact upload is also a GitHub service and can fail.
A durable worker with an append-only log on persistent storage is the next
infrastructure step if continuous collection is required; no new service,
expense, credential configuration or deployment is part of this proposal.

## Offline validation

Run from this directory:

    python3 -m unittest -v test_study.py test_publication_reliability.py

The suite covers accounting and mapping, transient and persistent failures,
permission rejection, rate limits, timeouts, immutable bytes, pending-state
mutation, exact retries, closed-journal recovery, ambiguous ref updates and
concurrent writers. It makes no venue or GitHub calls. Inspect each artifact's
manifest/state/raw hashes and chain before any separately authorized recovery;
never automatically resume from an older published checkpoint.

No trading rule, wallet, fee, capital cap, evaluation gate, protocol identity,
production file, application database or existing review automation is changed.
