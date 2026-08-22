/**
 * Sports Forward Shadow worker orchestration — PURE logic only.
 *
 * Builds the Task 7 SourceSignal a pending signal row needs, and small pure helpers used
 * by the orchestrator. No network, no Supabase, no timers.
 *
 * ============================== TASK 11B: PENDING-SIGNAL STARVATION FIX ==============================
 * This module used to also derive "which signals are pending" client-side, by filtering a
 * fixed-size ORDER BY created_at ASC LIMIT <scanWindow> prefix of ALL signals down to the
 * ones missing a match. That is a confirmed correctness bug, not a low-volume edge case:
 * once cumulative signal count exceeds the scan window and the oldest rows in that window
 * happen to all be fully resolved, the window is permanently saturated with resolved
 * rows — any signal created after that point is never fetched at all, regardless of how
 * much real pending work exists. The fix pushes "missing a venue match" into SQL itself
 * (see supabase/migrations/20260820230000_sports_shadow_pending_signals_rpc.sql's
 * find_pending_sports_shadow_signals, an explicit LEFT JOIN anti-join, ORDER BY
 * created_at ASC, id ASC, LIMIT <batchSize>), so the returned rows are always the
 * globally oldest genuinely-pending signals — boundedness now applies to pending rows,
 * never to a fixed historical prefix. worker.server.ts's WorkerRepository maps the RPC
 * result straight into PendingSignal; there is no client-side re-derivation of "missing"
 * left to do or test here.
 * ================================================================================
 */

import type { SourceSignal } from "./resolver";
import type { BetType } from "./types";

/** Bounded per-cycle processing batch — the actual cap on how much pending work one cycle attempts. Passed directly as the RPC's p_limit; the RPC itself additionally clamps to a sane ceiling. */
export const PENDING_BATCH_SIZE = 20;

export type SignalRow = {
  id: string;
  createdAtIso: string;
  sourceFirstFillAtIso: string;
  wallet: string;
  conditionId: string | null;
  asset: string;
  betType: BetType;
  awayTeam: string | null;
  homeTeam: string | null;
  scheduledStartAt: string | null;
  line: number | null;
  selectedOutcomeRaw: string;
  eventSlug: string | null;
  marketSlug: string | null;
  /** CODEX P1-6: the source market's own Gamma-provided resolution-rules text, durably persisted at signal creation -- see resolver.ts's cross-venue settlement-rule equivalence check. */
  sourceRulesDescription: string | null;
};

export type PendingSignal = SignalRow & { missingPmus: boolean; missingKalshi: boolean };

/**
 * Builds the Task 7 SourceSignal for one pending signal row. Returns null when a required
 * field is missing (conditionId) — never fabricated, per the resolver's own fail-closed
 * contract. `sourceGameId` is intentionally always null: sports_shadow_signals has no
 * source_game_id column, and the resolver never actually reads that field for matching
 * (diagnostic passthrough only).
 */
export function toSourceSignal(row: SignalRow): SourceSignal | null {
  if (!row.conditionId) return null;
  return {
    betType: row.betType,
    awayTeam: row.awayTeam ?? "",
    homeTeam: row.homeTeam ?? "",
    gameStartTime: row.scheduledStartAt,
    line: row.line,
    selectedOutcomeRaw: row.selectedOutcomeRaw,
    conditionId: row.conditionId,
    sourceGameId: null,
    eventSlug: row.eventSlug,
    marketSlug: row.marketSlug,
    sourceRulesDescription: row.sourceRulesDescription,
  };
}

/** Epoch-ms detection anchor for observation scheduling: the signal's own durable created_at, NEVER "now" at resolution time and NEVER the source's historical trade timestamp (source_first_fill_at) — see worker.server.ts's doc comment for why conflating these would silently make late-recovered signals schedule their +0/+5/+10/+30/+60 burst at the wrong real-world moment. */
export function detectedAtMsFromSignal(row: SignalRow): number {
  return new Date(row.createdAtIso).getTime();
}

/** True once `elapsedMs` has consumed `budgetMs` — used between wallets/signals to stop starting new bounded work once a lane's stage budget is spent, leaving the remainder durable for the next cycle. */
export function budgetExceeded(elapsedMs: number, budgetMs: number): boolean {
  return elapsedMs >= budgetMs;
}

/**
 * ============================== TASK 12D / P1-B: WALLET FAIRNESS ==============================
 * ROOT CAUSE (Codex P1 finding): runSourceLane iterated `config.wallets` in the same fixed
 * (alphabetically sorted) order every cycle. If an early wallet consistently consumed the
 * entire SOURCE_LANE_BUDGET_MS, budgetExceeded() broke the loop before later wallets were
 * ever attempted — not delayed, permanently skipped, cycle after cycle, forever.
 *
 * FIX: a durable rotation cursor (see worker.server.ts's WorkerRepository — one row,
 * matching the smallest-possible-table philosophy already used for http_rate_limits/
 * worker_status). `rotateWallets` is the pure array-rotation this cursor drives: each
 * cycle starts iterating from `startIndex` (already read fresh from the DB, never an
 * in-memory value carried across invocations), wrapped modulo the CURRENT cohort size so
 * a cohort add/remove/reorder between cycles can never index out of bounds or crash — it
 * just means the rotation's exact wallet alignment may shift when the cohort size
 * changes, which is an accepted, documented limitation (fairness is approximately
 * maintained across a resize, not wallet-identity-tracked through one). `nextRotationIndex`
 * durably advances the cursor by however many wallets were ACTUALLY attempted this cycle
 * — specifically including a cycle that only got partway through before hitting its
 * budget, since that is exactly the scenario a fixed start index would otherwise repeat
 * forever. Over a bounded number of cycles, every configured wallet is therefore
 * guaranteed to eventually become the FIRST wallet attempted, so no wallet can be
 * permanently starved merely because an earlier one in cohort order is slow/busy.
 * ================================================================================
 */

/** Pure array rotation, wrapped modulo `wallets.length` so any startIndex (including one stale from a since-resized cohort) is always safely in range. Returns [] for an empty cohort. */
export function rotateWallets(wallets: readonly string[], startIndex: number): string[] {
  if (wallets.length === 0) return [];
  const offset = ((startIndex % wallets.length) + wallets.length) % wallets.length;
  return [...wallets.slice(offset), ...wallets.slice(0, offset)];
}

/** The durable cursor value to persist for the NEXT cycle: advances by exactly how many wallets this cycle actually attempted (even a partial, budget-truncated cycle), wrapped modulo the current cohort size. */
export function nextRotationIndex(startIndex: number, walletsAttempted: number, totalWallets: number): number {
  if (totalWallets <= 0) return 0;
  return (((startIndex + walletsAttempted) % totalWallets) + totalWallets) % totalWallets;
}
