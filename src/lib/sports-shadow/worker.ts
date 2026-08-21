/**
 * Sports Forward Shadow worker orchestration — PURE logic only.
 *
 * Turns raw durable rows (already-fetched signals/matches) into the bounded set of
 * "still missing target-venue resolution" work items for this cycle, and builds the
 * Task 7 SourceSignal each one needs. No network, no Supabase, no timers.
 */

import type { SourceSignal } from "./resolver";
import type { BetType, Venue } from "./types";

/** Bounded scan window for the pending-signal recovery query (see worker.server.ts's findPendingSignals). Generous relative to Phase 1's expected low signal volume, but never unbounded. */
export const PENDING_SCAN_WINDOW = 200;
/** Bounded per-cycle processing batch — the actual cap on how much pending work one cycle attempts. */
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
};

export type ExistingMatchRow = { signalId: string; venue: Venue };

export type PendingSignal = SignalRow & { missingPmus: boolean; missingKalshi: boolean };

/**
 * Pure derivation of "which signals in this scan window still need at least one venue
 * resolved," oldest first, bounded to `batchSize`. Deterministic and restart-safe: given
 * the same durable `signals`/`matches` snapshot, always returns the identical batch — no
 * hidden state, no reliance on any prior cycle's in-memory result. This is what makes the
 * crash-recovery hard gate hold: a signal orphaned by a crash between persist and
 * resolution is found here on the NEXT cycle exactly the same way a same-cycle new signal
 * is, because both are read fresh from durable state every time.
 */
export function derivePendingSignals(signals: SignalRow[], matches: ExistingMatchRow[], batchSize: number = PENDING_BATCH_SIZE): PendingSignal[] {
  const venuesBySignal = new Map<string, Set<Venue>>();
  for (const m of matches) {
    const set = venuesBySignal.get(m.signalId) ?? new Set<Venue>();
    set.add(m.venue);
    venuesBySignal.set(m.signalId, set);
  }

  const sorted = [...signals].sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso) || a.id.localeCompare(b.id));

  const pending: PendingSignal[] = [];
  for (const s of sorted) {
    const venues = venuesBySignal.get(s.id) ?? new Set<Venue>();
    const missingPmus = !venues.has("PMUS");
    const missingKalshi = !venues.has("KALSHI");
    if (!missingPmus && !missingKalshi) continue;
    pending.push({ ...s, missingPmus, missingKalshi });
    if (pending.length >= batchSize) break;
  }
  return pending;
}

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
