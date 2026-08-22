/**
 * FINAL BUILD Part 15: settlement orchestration — persists settlement.server.ts's
 * exchange-authoritative check results into sports_shadow_settlements, computing
 * realized paper P&L from the matching ENTRY paper fill's own recorded cost.
 *
 * Never infers resolution from sports scores (settlement.server.ts's own rule) --
 * this module is purely the persistence/PnL-math layer on top of that authoritative
 * check. A position with no ENTRY fill at all (never actually executable) is never
 * settled -- there is nothing to compute P&L against.
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
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_paper_fills" as never)
      .select(
        "signal_id, chosen_venue, notional_tier_usd, contracts, all_in_cost_usd, side, fill_status, sports_market_matches!inner(target_market_id, selected_side)",
      )
      .eq("side", "ENTRY")
      .in("fill_status", ["FULL", "PARTIAL"])
      .not("chosen_venue", "is", null)
      .limit(limit);
    if (error) throw new Error(error.message);
    type Row = {
      signal_id: string;
      chosen_venue: Venue;
      notional_tier_usd: number;
      contracts: number;
      all_in_cost_usd: number | null;
      sports_market_matches: { target_market_id: string | null; selected_side: string | null } | null;
    };
    const rows = (data ?? []) as unknown as Row[];
    const out: OpenPaperPosition[] = [];
    for (const r of rows) {
      const targetMarketId = r.sports_market_matches?.target_market_id;
      const selectedSide = r.sports_market_matches?.selected_side;
      if (!targetMarketId || !selectedSide || r.all_in_cost_usd === null) continue; // incomplete provenance -- never settle against a fabricated key
      out.push({
        signalId: r.signal_id,
        venue: r.chosen_venue,
        notionalTierUsd: r.notional_tier_usd,
        targetMarketId,
        selectedSide,
        entryContracts: r.contracts,
        entryAllInCostUsd: r.all_in_cost_usd,
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
  };
}

/** Bounded batch: settles up to `limit` open positions in one call. Errors on one position never abort the batch for the rest. */
export async function runSettlementBatch(limit = 50, repo: SettlementRepository = supabaseSettlementRepository, fetchImpl?: typeof fetch): Promise<{ checked: number; settled: number; errors: number }> {
  const positions = await repo.findOpenPositions(limit);
  let settled = 0;
  let errors = 0;
  for (const position of positions) {
    try {
      const row = await settlePosition(position, fetchImpl);
      await repo.upsertSettlement(row);
      if (row.settlementStatus !== "PENDING") settled += 1;
    } catch {
      errors += 1;
    }
  }
  return { checked: positions.length, settled, errors };
}
