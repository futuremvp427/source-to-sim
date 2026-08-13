# Phase 1 — per-experiment source event consumption (plan only)

Note: commit `29891b2f` is not present in this sandbox; the working tree here is at `3532ecb` ("Work in progress"). The plan below is written against the code as it exists in this tree — `src/lib/shadow.server.ts` still reads pending work with `.is("processed_at", null)` (line ~489) and per-wallet source shares from `source_position_state` (line ~501), and commits through `process_source_event_atomic` (line ~465).

## Goal

Switch the follower pass from wallet-global consumption (`source_events.processed_at`) to per-experiment consumption via the new `get_pending_experiment_source_events` and `get_experiment_source_positions`, keeping `process_source_event_atomic` as the single atomic commit boundary. No behaviour change to sizing, bankrolls, safety rules, settlement or copyability.

## Open question that shapes the code (answer before implementing)

How does `get_pending_experiment_source_events` decide an event is already consumed for an experiment?
- (a) Derived from an existing `paper_trades` row for `(experiment_id, event_key)`, or
- (b) A new per-experiment consumption/cursor table the RPC (or the migration's updated `process_source_event_atomic`) writes.

This matters because the current pre-go-live backfill branch commits with `trade: null` (only `source_state` + `processed_at`). Under (a) those events produce no `paper_trades` row and would be re-selected forever — an infinite reprocess loop per cycle. Under (a) the app must therefore write a per-experiment marker (e.g. a `SKIP`/`BACKFILL` paper_trades row or explicit cursor advance) for pre-go-live events; under (b) the commit payload must carry whatever field advances that marker.

## Application-side changes (minimal)

1. `processPendingEvents` — pending selection (`src/lib/shadow.server.ts` ~486-495)
   - Replace the `source_events` select/filter/order/limit with a single `supabaseAdmin.rpc("get_pending_experiment_source_events", { p_experiment_id, p_wallet, p_limit: PROCESS_BATCH })` call.
   - Keep the returned row shape mapped onto the existing `SourceEventRow` type (`id, event_key, asset, market_title, outcome, side, shares, price, source_ts, first_seen_at`); add a small adapter if the function returns extra/renamed columns rather than changing downstream logic.
   - Ordering (`source_ts`, then `event_key`) must come from the function; the app no longer sorts.

2. `processPendingEvents` — source position seed (~499-505)
   - Replace the `source_position_state` read with `supabaseAdmin.rpc("get_experiment_source_positions", { p_experiment_id, p_assets })` (or filter client-side if the function takes no asset list) and build the same `sourceShares` map.
   - Preserve the current distinction between "asset unknown" (`null`) and "zero shares" — `decideProportionalSell` depends on it, so only set map entries the function actually returns.

3. Commit boundary — unchanged
   - Keep `commitEventAtomically` / `process_source_event_atomic` exactly as-is, including the lease-fence `stale_fence` handling and the `applied === false` rollback of local `cash`/`realizedPnl`.
   - Only extend the `buildEventCommit` payload if answer (b) requires an extra per-experiment consumption field.

4. Pre-go-live backfill branch (~544-572)
   - Keep it commit-only (no trade, no cash movement) but ensure the commit marks the event consumed *for this experiment* per the answer above. Add a regression test asserting the same event is not returned by the pending function on the next cycle.

5. Reconciliation (`reconcile`, ~774-860) — leave wallet-global
   - It replays every persisted fill for a wallet into `source_position_state`; that stays the wallet-level truth. Verify the new `get_experiment_source_positions` reads from the same wallet-level state (or a per-experiment view over it) so reconciliation repairs cannot silently diverge from what the follower reads. If it reads a *different* per-experiment table, reconciliation must be extended to that table — flag it rather than half-fixing.

6. Generated types
   - `src/integrations/supabase/types.ts` has no entries for the two new functions, so `.rpc(...)` will need the existing `as never` cast pattern until types are regenerated after the migration is applied. Prefer regenerating post-migration over permanent casts.

7. Tests
   - Extend the existing shadow unit tests (`src/lib/shadow-source.test.ts`, `shadow-lease.test.ts` style) with: pending events come from the RPC; two experiments on the same wallet each consume the same event independently; a backfilled pre-go-live event is not re-served; stale fence still aborts the batch.

## Read-model / dashboard places that become misleading

These all still treat `source_events.processed_at` (or wallet-global event counts) as if consumption were global:

- `src/lib/shadow.server.ts` ~1502: `processed: e.processed_at !== null` in `loadDashboard`. With per-experiment consumption this flag means "some experiment consumed it", not "this dashboard's experiment consumed it". Should be recomputed per the dashboard's experiment (via the same per-experiment source, or a `paper_trades`/audit join), or dropped.
- `src/routes/index.tsx` ~390: renders `· pending` from that flag in Recent Source Trades — same fix or relabel to make the scope explicit ("pending (any experiment)").
- `supabase/schema-contract.json` entries pinning `wallet, processed_at, source_ts` (index) and the `set processed_at = v_now` fragment of `process_source_event_atomic` will need updating in lockstep with the migration, otherwise the schema-drift CI check fails.
- Wallet-global event counts that are *not* wrong but read as progress indicators and should be reviewed for labelling only: `src/lib/health.server.ts` (total fills, source freshness), `src/lib/v2-status.server.ts` ~68, `src/lib/comparison.server.ts` ~165, `src/lib/general-shadow.server.ts` ~224-266 (`total` / `postGoLive`), `src/lib/pmus/previews.server.ts` ~354.

## Explicitly out of scope

No migration authoring, no deploy, no changes to main, no sizing/bankroll/safety/settlement changes, and no live-order path.
