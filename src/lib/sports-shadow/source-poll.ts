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
 * Bootstrap/historical-replay safety gate. During a wallet's FIRST-EVER poll
 * (`isBootstrap`), a fill is only allowed to reach the episode engine (and therefore
 * possibly trigger a NEW_EPISODE) when its source time is at or after the caller-
 * supplied go-live boundary. Fills strictly before it may still be persisted as raw
 * evidence, but must never be fed to decideFill.
 *
 * A missing `goLiveAtMs` during a genuine bootstrap poll fails CLOSED — every fill is
 * treated as pre-go-live (never triggers) rather than guessing a boundary. Once a
 * wallet has ANY durable fill history (`isBootstrap = false`, i.e. a resumption poll),
 * this always returns true: durable database overlap has already established that
 * bootstrap is behind us, so the go-live boundary no longer applies at all — this is
 * what makes "a restart after prior successful polling resumes from durable history,
 * not bootstrap again" true by construction, without needing a separate flag.
 *
 * `sourceTs` is Unix SECONDS (matches EligibleFill.sourceTs / shadow-core.ts
 * convention); `goLiveAtMs` is epoch MILLISECONDS (ordinary JS convention) — the unit
 * conversion happens once, here, so callers never have to reconcile it themselves.
 */
export function isEligibleForEpisodeTrigger(sourceTs: number, isBootstrap: boolean, goLiveAtMs: number | null): boolean {
  if (!isBootstrap) return true;
  if (goLiveAtMs === null || !Number.isFinite(goLiveAtMs)) return false;
  return sourceTs * 1000 >= goLiveAtMs;
}
