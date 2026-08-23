/**
 * FINAL BUILD Part 15: settlement orchestration — persists settlement.server.ts's
 * exchange-authoritative check results into sports_shadow_settlements, computing
 * realized paper P&L from the matching ENTRY paper fill's own recorded cost.
 *
 * Never infers resolution from sports scores (settlement.server.ts's own rule) --
 * this module is purely the persistence/PnL-math layer on top of that authoritative
 * check. A position with no ENTRY fill at all (never actually executable) is never
 * settled -- there is nothing to compute P&L against.
 *
 * ============ CODEX P1-4: SETTLEMENT PROVENANCE + TERMINAL-ROW EXCLUSION ============
 * PROVEN root cause #1: findOpenPositions recovered target_market_id/selected_side via
 * `sports_market_matches!inner(...)` joined on signal_id ALONE, with no venue filter. A
 * signal EXACT-matched on BOTH venues has TWO rows in sports_market_matches (one per
 * venue, its own UNIQUE(signal_id, venue)) -- this join could bind whichever row
 * PostgREST happened to return, independent of which venue was actually chosen_venue.
 *
 * FIX: paper.server.ts's routing decision now persists target_market_id/selected_side
 * DIRECTLY on sports_shadow_paper_fills at decision time, from the CHOSEN venue's own
 * match row (paper.server.ts's own P1-4 doc comment). Settlement reads these two columns
 * straight off the fill row it is already selecting -- no join to sports_market_matches
 * at all, so there is no venue-ambiguous path left to take.
 *
 * PROVEN root cause #2: findOpenPositions selected every FULL/PARTIAL ENTRY fill with a
 * chosen_venue, with no exclusion for a position that ALREADY has a terminal
 * sports_shadow_settlements row. A bounded batch (`limit`) could be entirely consumed by
 * already-settled positions on every single call, starving genuinely unsettled ones
 * indefinitely.
 *
 * FIX: a `NOT EXISTS` against sports_shadow_settlements excludes any position whose
 * settlement is already in a TERMINAL state (anything other than PENDING) -- a row with
 * no settlement yet, or one still PENDING, remains selectable (re-checked, exactly as
 * before); ordering is oldest-decided-first so a persistent backlog still drains in
 * order rather than resampling the same page.
 * ================================================================================
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { checkKalshiSettlement, checkPmusSettlement, type SettlementStatus } from "./settlement.server";
import type { Venue } from "./types";

export type OpenPaperPosition = {
  signalId: string;
  venue: Venue;
  notionalTierUsd: number;
  targetMarketId: string; // fetch key: PM-US slug or Kalshi ticker
  selectedSide: string; // "TEAM:...:LONG" / "TEAM:...:SHORT" / "YES" / "NO"
  entryContracts: number;
  entryAllInCostUsd: number;
  /** CODEX P2-3: how many times this position has already been checked and found still-PENDING -- 0 for a position with no settlement row yet. Feeds computeNextSettlementCheckAtMs's exponential backoff. */
  checkAttemptCount: number;
};

export type SettlementRow = {
  signalId: string;
  venue: Venue;
  notionalTierUsd: number;
  settlementStatus: SettlementStatus;
  settlementTimestampMs: number | null;
  settlementValue: number | null;
  settlementSource: string;
  grossPnlUsd: number | null;
  totalFeesUsd: number;
  netPnlUsd: number | null;
  /** CODEX P2-3: when this position becomes eligible for another check -- null once terminal (no further checks needed). Set by runSettlementBatch, not settlePosition itself (settlePosition has no opinion on backoff timing). */
  nextCheckAtMs: number | null;
  /** CODEX P2-3: total times checked so far, INCLUDING this one -- persisted so the next call's backoff calculation has the correct count even after a process restart. */
  checkAttemptCount: number;
};

export type SettlementRepository = {
  /** Every OPEN position (a FULL/PARTIAL ENTRY paper fill with no terminal settlement row yet) across every venue/tier. */
  findOpenPositions(limit: number): Promise<OpenPaperPosition[]>;
  upsertSettlement(row: SettlementRow): Promise<void>;
};

function parsePmusOrientation(selectedSide: string): "LONG" | "SHORT" | null {
  if (selectedSide.endsWith(":LONG")) return "LONG";
  if (selectedSide.endsWith(":SHORT")) return "SHORT";
  return null;
}

export const supabaseSettlementRepository: SettlementRepository = {
  async findOpenPositions(limit) {
    // CODEX P1-4: a single indexed RPC that (a) excludes any position whose settlement
    // is already TERMINAL and (b) reads target_market_id/selected_side DIRECTLY off the
    // paper_fill row itself (persisted at routing-decision time from the CHOSEN venue's
    // own match, never re-derived here via an ambiguous signal_id-only join) -- see this
    // module's own doc comment and the migration's.
    const { data, error } = await supabaseAdmin.rpc("find_open_sports_shadow_paper_positions" as never, { p_limit: limit } as never);
    if (error) throw new Error(error.message);
    type Row = {
      signal_id: string;
      chosen_venue: Venue;
      notional_tier_usd: number;
      contracts: number;
      all_in_cost_usd: number | null;
      target_market_id: string | null;
      selected_side: string | null;
      check_attempt_count: number;
    };
    const rows = (data ?? []) as unknown as Row[];
    const out: OpenPaperPosition[] = [];
    for (const r of rows) {
      // The RPC's own WHERE clause already requires these to be non-null -- this is a
      // defensive re-check, never a silent fabrication.
      if (!r.target_market_id || !r.selected_side || r.all_in_cost_usd === null) continue;
      out.push({
        signalId: r.signal_id,
        venue: r.chosen_venue,
        notionalTierUsd: r.notional_tier_usd,
        targetMarketId: r.target_market_id,
        selectedSide: r.selected_side,
        entryContracts: r.contracts,
        entryAllInCostUsd: r.all_in_cost_usd,
        checkAttemptCount: r.check_attempt_count,
      });
    }
    return out;
  },

  async upsertSettlement(row) {
    const { error } = await supabaseAdmin.from("sports_shadow_settlements" as never).upsert(
      {
        signal_id: row.signalId,
        venue: row.venue,
        notional_tier_usd: row.notionalTierUsd,
        settlement_status: row.settlementStatus,
        settlement_timestamp: row.settlementTimestampMs ? new Date(row.settlementTimestampMs).toISOString() : null,
        settlement_value: row.settlementValue,
        settlement_source: row.settlementSource,
        gross_pnl_usd: row.grossPnlUsd,
        total_fees_usd: row.totalFeesUsd,
        net_pnl_usd: row.netPnlUsd,
        next_check_at: row.nextCheckAtMs ? new Date(row.nextCheckAtMs).toISOString() : null,
        check_attempt_count: row.checkAttemptCount,
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: "signal_id,venue,notional_tier_usd" },
    );
    if (error) throw new Error(error.message);
  },
};

/**
 * Settles ONE open position: checks the venue's authoritative resolution state, and
 * if resolved, computes gross/net P&L from the position's own recorded entry cost.
 * `feesAlreadyPaid` is the entry fee only (exit is a full settlement payout, not a
 * simulated sell -- Phase 1 holds every EXACT-matched entry to resolution).
 */
export async function settlePosition(position: OpenPaperPosition, fetchImpl?: typeof fetch): Promise<SettlementRow> {
  const orientation = position.venue === "PMUS" ? parsePmusOrientation(position.selectedSide) : null;
  const kalshiSide = position.venue === "KALSHI" ? (position.selectedSide === "YES" ? "YES" : position.selectedSide === "NO" ? "NO" : null) : null;

  if (position.venue === "PMUS" && orientation === null) {
    return unresolvableRow(position, "PM-US position has no resolvable LONG/SHORT orientation in selected_side");
  }
  if (position.venue === "KALSHI" && kalshiSide === null) {
    return unresolvableRow(position, "Kalshi position has no resolvable YES/NO side in selected_side");
  }

  const check =
    position.venue === "PMUS"
      ? await checkPmusSettlement(position.targetMarketId, orientation!, fetchImpl)
      : await checkKalshiSettlement(position.targetMarketId, kalshiSide!, fetchImpl);

  if (check.status === "PENDING") {
    return {
      signalId: position.signalId,
      venue: position.venue,
      notionalTierUsd: position.notionalTierUsd,
      settlementStatus: "PENDING",
      settlementTimestampMs: null,
      settlementValue: null,
      settlementSource: check.settlementSource,
      grossPnlUsd: null,
      totalFeesUsd: 0,
      netPnlUsd: null,
      // CODEX P2-3: placeholder -- runSettlementBatch overrides both fields with the
      // real computed backoff before persisting. settlePosition itself has no opinion
      // on recheck timing (it doesn't know `now`, and testing its own PENDING/resolved
      // classification shouldn't require reasoning about backoff too).
      nextCheckAtMs: null,
      checkAttemptCount: position.checkAttemptCount,
    };
  }

  // Gross payoff: contracts * settlementValue (1.0 win, 0.0 loss) for WIN/LOSS; for
  // PUSH/VOID/CANCELED, the entry cost itself is returned (no gain, no further loss) --
  // never fabricates a payoff beyond what the venue's own resolution states.
  const grossPnlUsd =
    check.status === "SETTLED_WIN" || check.status === "SETTLED_LOSS"
      ? position.entryContracts * (check.settlementValue ?? 0) - position.entryAllInCostUsd
      : check.status === "SETTLED_PUSH" || check.status === "VOID" || check.status === "CANCELED"
        ? 0
        : null;

  return {
    signalId: position.signalId,
    venue: position.venue,
    notionalTierUsd: position.notionalTierUsd,
    settlementStatus: check.status,
    settlementTimestampMs: check.settlementTimestampMs,
    settlementValue: check.settlementValue,
    settlementSource: check.settlementSource,
    grossPnlUsd,
    totalFeesUsd: 0, // entry fee is already netted into entryAllInCostUsd; no exit fee for a held-to-resolution position
    netPnlUsd: grossPnlUsd,
    nextCheckAtMs: null, // terminal -- runSettlementBatch confirms and persists null; no further checks needed
    checkAttemptCount: position.checkAttemptCount,
  };
}

function unresolvableRow(position: OpenPaperPosition, reason: string): SettlementRow {
  return {
    signalId: position.signalId,
    venue: position.venue,
    notionalTierUsd: position.notionalTierUsd,
    settlementStatus: "VOID",
    settlementTimestampMs: Date.now(),
    settlementValue: null,
    settlementSource: reason,
    grossPnlUsd: null,
    totalFeesUsd: 0,
    netPnlUsd: null,
    nextCheckAtMs: null, // terminal
    checkAttemptCount: position.checkAttemptCount,
  };
}

/** 10-minute base, doubling per attempt, capped at 6 hours -- see computeNextSettlementCheckAtMs's own doc comment. */
export const SETTLEMENT_RECHECK_BASE_MS = 10 * 60 * 1000;
export const SETTLEMENT_RECHECK_MAX_MS = 6 * 60 * 60 * 1000;
/** 10min * 2^6 = 640min already exceeds the 6h cap -- higher attempt counts are clamped here so the exponent itself never grows unbounded. */
const SETTLEMENT_RECHECK_MAX_BACKOFF_EXPONENT = 6;

/**
 * CODEX P2-3: pure exponential backoff for a position still PENDING after a REAL venue
 * check. A persistently-PENDING position (a future game, genuinely nothing wrong) is
 * rechecked less and less often instead of consuming a bounded batch slot every single
 * cycle -- but a position new to the queue (attemptCountAfterThisCheck=1, its first-ever
 * check) is still rechecked within the 10-minute base window, never starved by an
 * aggressive ceiling. Reasonable backoff based on known game/market lifecycle: capped at
 * 6 hours so a genuinely-settled market is never delayed excessively even after many
 * PENDING attempts.
 */
export function computeNextSettlementCheckAtMs(nowMs: number, attemptCountAfterThisCheck: number): number {
  const exponent = Math.min(Math.max(0, attemptCountAfterThisCheck - 1), SETTLEMENT_RECHECK_MAX_BACKOFF_EXPONENT);
  const backoffMs = SETTLEMENT_RECHECK_BASE_MS * 2 ** exponent;
  return nowMs + Math.min(SETTLEMENT_RECHECK_MAX_MS, backoffMs);
}

/** Bounded batch: settles up to `limit` open positions in one call. Errors on one position never abort the batch for the rest. */
export async function runSettlementBatch(
  limit = 50,
  repo: SettlementRepository = supabaseSettlementRepository,
  fetchImpl?: typeof fetch,
  now: () => number = Date.now,
): Promise<{ checked: number; settled: number; errors: number }> {
  const positions = await repo.findOpenPositions(limit);
  let settled = 0;
  let errors = 0;
  for (const position of positions) {
    try {
      const row = await settlePosition(position, fetchImpl);
      const checkAttemptCount = position.checkAttemptCount + 1;
      const finalRow: SettlementRow =
        row.settlementStatus === "PENDING"
          ? { ...row, checkAttemptCount, nextCheckAtMs: computeNextSettlementCheckAtMs(now(), checkAttemptCount) }
          : { ...row, checkAttemptCount, nextCheckAtMs: null };
      await repo.upsertSettlement(finalRow);
      if (finalRow.settlementStatus !== "PENDING") settled += 1;
    } catch {
      errors += 1;
    }
  }
  return { checked: positions.length, settled, errors };
}
