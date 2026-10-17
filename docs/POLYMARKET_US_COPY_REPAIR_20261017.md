# International source-reader repair — October 17, 2026

The existing normalizer reads v1 camelCase fields. On a captured 2,000-row
international Data API v2 slice, it retains none of the token, condition and
transaction identifiers required together for a usable source event. The
patched normalizer retains all three on 2,000/2,000 rows, with 2,000 distinct
normalized event keys. Converting those same rows to their v1 aliases produces
identical event keys, preserving replay/deduplication continuity.

The shared shadow reader and Sports Shadow reader now request `/v2/trades`
with `taker_only=false`, follow the provider's opaque cursor, and preserve the
existing checkpoint, time-window, lease and incomplete-coverage behavior.
`offset` remains an internal page ordinal only; it is never sent to v2. A short
page with `has_more=true` continues. Malformed pagination and repeated cursors
fail closed. Parent `event_id` is never treated as a unique fill ID.

## Validation

- Frozen `bun.lock` dependency installation; no dependency or lockfile changes.
- Full unit/regression suite: 2,065 passed, nine existing opt-in PostgREST
  integration checks skipped; none failed. Full TypeScript check and production
  Vite/Nitro build passed.
- Captured read-only replay: 2,000 real source fills across 389 conditions and
  391 assets, including buys and sells; v1/v2 key parity verified.
- The capture remains a bounded history slice. Its last page has more history;
  the replay did not book retrospective follower trades or claim full coverage.

## Scope and acceptance still outstanding

This repairs source ingestion compatibility. It does not establish an EXACT
US contract mapping, a new source strategy, source profitability, US follower
profitability, a healthy deployed worker, or a completed natural US copy.
The existing EXACT/NO_TRADE matching gates and execution controls are unchanged.
No account authentication, order, preview, live activation, new study, scheduler
change, production schema change or historical ledger rewrite is part of this
patch. Legacy General Shadow activity consumers are outside this trade-reader
patch and must not be mistaken for a completed app-wide v2 migration.

Current matching evidence matters separately: sampled Miami and Los Angeles
temperature brackets can have the same airport and bounds but different hourly
versus climate-report measurements. The sampled San Francisco US top bracket
also cannot isolate the foreign 86–87°F interval. The October Fed +25 bps
pair has a rounding mismatch; baskets of the reviewed October decision legs
cannot remove it. Brazil/Sweden political listings have deadline/fallback
differences or unresolved interpretation. The LA mayor candidate is unverified,
and was not a new trigger in the captured 2,000-fill slice. No mapping was
promoted by this repair.

Before claiming COPY TRADE VERIFIED, independently inspect the deployed SHA,
the running database/worker and an actual naturally occurring eligible source
trade through an approved EXACT mapping, US observation, paper fill, persisted
position/dashboard and exit or settlement. The read-only project database
inspection still returned a timeout during this review. Do not treat passing
unit tests or an editor SHA as that runtime proof.
