/**
 * Sports Forward Shadow source wallet poller — PURE logic only.
 *
 * Turns an already-normalized source trade event (shadow-core.ts's `NormalizedEvent` —
 * REUSED directly, not reimplemented; see the module doc below for why this is safe)
 * plus its Task 3 classification into a Task 4 `EligibleFill`, and decides whether a
 * given source-time fill is allowed to trigger episode creation during a wallet's
 * first-ever (bootstrap) poll. No network, no Supabase, no timers.
 *
 * ============================== STABLE EVENT-KEY GATE — PASSED ==============================
 * Reuses `normalizeSourceEvents` from ../shadow-core.ts verbatim rather than inventing a
 * second event-identity scheme. That function is already the production event-key
 * derivation for this exact data-api.polymarket.com /trades feed (source-native id ->
 * tx_hash+logIndex -> tx_hash+economic-tuple+ordinal, chronologically sorted,
 * fail-closed on unrecognized `side`). A bounded live probe against a real Phase-1
 * cohort wallet (Talvez10) during this task confirmed the CURRENT /trades payload has
 * NO `id`/`tradeId`/`logIndex` field at all — every row resolves via the third
 * (tx_hash_ordinal) tier. This is safe: `transactionHash` was confirmed present and
 * distinct per fill across the sampled rows, and the ordinal suffix already guards the
 * remaining theoretical case (one transaction producing multiple fills at an identical
 * economic tuple) by construction. detectedAt is never part of this identity (it isn't
 * even a `normalizeSourceEvents` input) — repeated polls of the same historical window
 * always reproduce the same eventKey.
 * ================================================================================
 */

import type { NormalizedEvent } from "../shadow-core";
import type { EligibleFill, FillSide } from "./episode";

/**
 * Builds a Task 4 `EligibleFill` from an already-normalized source event. Returns null
 * when the event lacks a conditionId (source market metadata cannot be resolved without
 * one, so this fill can never be classified — the caller treats it as evidence-only,
 * never feeding it to the episode engine). `detectedAtMs` is the caller's own detection
 * timestamp (epoch ms) — NEVER derived from `event.sourceTs`.
 */
export function toEligibleFill(event: NormalizedEvent, detectedAtMs: number): EligibleFill | null {
  if (!event.conditionId) return null;
  const side: FillSide = event.side; // NormalizedEvent.side is already the fail-closed-parsed "BUY" | "SELL"
  return {
    eventKey: event.eventKey,
    wallet: event.wallet,
    conditionId: event.conditionId,
    asset: event.asset,
    side,
    shares: event.shares,
    price: event.price,
    sourceTs: event.sourceTs,
    detectedAt: detectedAtMs,
  };
}

/**
 * Forward-shadow go-live gate. A fill is only allowed to reach the episode engine (and
 * therefore possibly trigger a NEW_EPISODE) when its OWN source time is at or after the
 * fixed, durable go-live boundary. Fills strictly before it may still be persisted as
 * raw evidence, but must never be fed to decideFill.
 *
 * ============================== TASK 12E / P1-F: IMMUTABLE GO-LIVE DECISION ==============================
 * ROOT CAUSE (Codex P1 finding): the previous signature was
 * `isEligibleForEpisodeTrigger(sourceTs, isBootstrap, goLiveAtMs)`, unconditionally
 * returning `true` whenever `isBootstrap` was false. `isBootstrap` is NOT an immutable
 * fact about a fill — it is `!hasAnyFillsForWallet(wallet)`, recomputed fresh on EVERY
 * poll from current wallet-wide state. Task 12D's durable per-fill retry (fills that
 * stay `downstream_status = PENDING` across polls -- e.g. hitting
 * MAX_PENDING_FILLS_PER_POLL, or a transient markFillComplete failure) meant a
 * pre-go-live fill left PENDING during a wallet's bootstrap poll could be retried on a
 * LATER poll once the wallet had accrued ANY history (e.g. from other, unrelated fills
 * completing normally) -- at which point `isBootstrap` had flipped to `false` and the
 * SAME fill's SAME sourceTs now produced a DIFFERENT (wrongly eligible) answer. That
 * violates the forward-only experiment boundary: a historical fill could retroactively
 * trigger episode creation, purely as a side effect of unrelated wallet activity.
 *
 * FIX: drop `isBootstrap` entirely. `goLiveAtMs` is a fixed, durable config value (see
 * config.ts's own doc comment: "a fixed, durable configuration value must produce the
 * identical goLiveAtMs on every invocation, forever") and `sourceTs` is immutable once a
 * fill's raw row is persisted (see the source_ts column in
 * sports_shadow_source_fills). Comparing two immutable, durable values needs no
 * wallet-history flag at all, and by construction gives the SAME answer for the SAME
 * fill on every retry, restart, or wallet-history transition -- see source-poll.server.ts's
 * doc comment for the full truth table this was verified against.
 *
 * `sourceTs` is Unix SECONDS (matches EligibleFill.sourceTs / shadow-core.ts
 * convention); `goLiveAtMs` is epoch MILLISECONDS (ordinary JS convention) — the unit
 * conversion happens once, here, so callers never have to reconcile it themselves. A
 * missing/non-finite `goLiveAtMs` fails CLOSED (never eligible) rather than guessing a
 * boundary; in practice this never happens for an enabled config (parseSportsShadowConfig
 * guarantees a finite goLiveAtMs whenever wallets are non-empty), but the function stays
 * defensively fail-closed regardless.
 * ================================================================================
 */
export function isEligibleForEpisodeTrigger(sourceTs: number, goLiveAtMs: number | null): boolean {
  if (goLiveAtMs === null || !Number.isFinite(goLiveAtMs)) return false;
  return sourceTs * 1000 >= goLiveAtMs;
}
