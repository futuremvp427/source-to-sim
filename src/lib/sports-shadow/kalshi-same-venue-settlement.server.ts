/**
 * SAME-VENUE (Kalshi -> Kalshi) PAPER settlement runner.
 *
 * Reuses Kalshi's existing exchange-authoritative settlement check. It never infers
 * outcomes from sports scores and never places an order. Open same-venue paper positions
 * are checked at resolution, terminal P&L is combined with any gross P&L already realized
 * by proportional exits, and fees are subtracted exactly once.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import type { KalshiContractSide } from "./kalshi-source";
import { computeNextSettlementCheckAtMs } from "./settlement.orchestrator.server";
import { checkKalshiSettlement, type SettlementCheckResult, type SettlementStatus } from "./settlement.server";

export type SameVenueSettlementPosition = {
  traderId: string;
  marketTicker: string;
  contractSide: KalshiContractSide;
  notionalTierUsd: number;
  contractsOpen: number;
  avgEntryPrice: number | null;
  /** Gross P&L already realized by paper EXIT fills; fees are tracked separately. */
  realizedPnlUsd: number;
  /** Entry + exit fees accumulated by the paper position. */
  feesUsd: number;
  checkAttemptCount: number;
};

export type SameVenueSettlementRow = {
  traderId: string;
  marketTicker: string;
  contractSide: KalshiContractSide;
  notionalTierUsd: number;
  settlementStatus: SettlementStatus;
  settlementTimestampMs: number | null;
  settlementValue: number | null;
  settlementSource: string;
  grossPnlUsd: number | null;
  totalFeesUsd: number;
  netPnlUsd: number | null;
  nextCheckAtMs: number | null;
  checkAttemptCount: number;
};

export type SameVenueSettlementRepository = {
  findOpenPositions(limit: number): Promise<SameVenueSettlementPosition[]>;
  finalizeSettlement(row: SameVenueSettlementRow): Promise<void>;
};

type RpcArgs = Record<string, unknown>;

async function callRpc<T>(name: string, args: RpcArgs): Promise<T> {
  const rpc = supabaseAdmin.rpc as unknown as (n: string, a: RpcArgs) => Promise<{ data: unknown; error: { message: string } | null }>;
  const { data, error } = await rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}

function num(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

export const supabaseSameVenueSettlementRepository: SameVenueSettlementRepository = {
  async findOpenPositions(limit) {
    type Row = {
      trader_id: string;
      market_ticker: string;
      contract_side: KalshiContractSide;
      notional_tier_usd: number | string;
      contracts_open: number | string;
      avg_entry_price: number | string | null;
      realized_pnl_usd: number | string;
      fees_usd: number | string;
      check_attempt_count: number;
    };
    const rows = await callRpc<Row[] | null>("find_open_sports_shadow_kalshi_positions", { p_limit: limit });
    return (rows ?? []).map((r) => ({
      traderId: r.trader_id,
      marketTicker: r.market_ticker,
      contractSide: r.contract_side,
      notionalTierUsd: num(r.notional_tier_usd),
      contractsOpen: num(r.contracts_open),
      avgEntryPrice: r.avg_entry_price === null ? null : num(r.avg_entry_price),
      realizedPnlUsd: num(r.realized_pnl_usd),
      feesUsd: num(r.fees_usd),
      checkAttemptCount: r.check_attempt_count,
    }));
  },

  async finalizeSettlement(row) {
    await callRpc<void>("finalize_sports_shadow_kalshi_settlement", {
      p_trader_id: row.traderId,
      p_market_ticker: row.marketTicker,
      p_contract_side: row.contractSide,
      p_notional_tier_usd: row.notionalTierUsd,
      p_settlement_status: row.settlementStatus,
      p_settlement_timestamp: row.settlementTimestampMs === null ? null : new Date(row.settlementTimestampMs).toISOString(),
      p_settlement_value: row.settlementValue,
      p_settlement_source: row.settlementSource,
      p_gross_pnl_usd: row.grossPnlUsd,
      p_total_fees_usd: row.totalFeesUsd,
      p_net_pnl_usd: row.netPnlUsd,
      p_next_check_at: row.nextCheckAtMs === null ? null : new Date(row.nextCheckAtMs).toISOString(),
      p_check_attempt_count: row.checkAttemptCount,
    });
  },
};

export type SameVenueSettlementChecker = (
  ticker: string,
  side: KalshiContractSide,
) => Promise<SettlementCheckResult>;

/**
 * Settle one currently-open follower position.
 *
 * For WIN/LOSS, the remaining contracts are marked to the terminal binary payout while
 * prior proportional exits remain in realizedPnlUsd. feesUsd is then subtracted ONCE.
 * PUSH/VOID/CANCELED add no further gross gain/loss to the still-open inventory.
 */
export async function settleSameVenuePosition(
  position: SameVenueSettlementPosition,
  checker: SameVenueSettlementChecker = checkKalshiSettlement,
): Promise<SameVenueSettlementRow> {
  if (!(position.contractsOpen > 0)) {
    return {
      ...positionIdentity(position),
      settlementStatus: "VOID",
      settlementTimestampMs: Date.now(),
      settlementValue: null,
      settlementSource: "same-venue position has no open contracts",
      grossPnlUsd: null,
      totalFeesUsd: position.feesUsd,
      netPnlUsd: null,
      nextCheckAtMs: null,
      checkAttemptCount: position.checkAttemptCount,
    };
  }
  if (position.avgEntryPrice === null || !Number.isFinite(position.avgEntryPrice)) {
    return {
      ...positionIdentity(position),
      settlementStatus: "VOID",
      settlementTimestampMs: Date.now(),
      settlementValue: null,
      settlementSource: "same-venue position has no valid average entry price",
      grossPnlUsd: null,
      totalFeesUsd: position.feesUsd,
      netPnlUsd: null,
      nextCheckAtMs: null,
      checkAttemptCount: position.checkAttemptCount,
    };
  }

  const check = await checker(position.marketTicker, position.contractSide);
  if (check.status === "PENDING") {
    return {
      ...positionIdentity(position),
      settlementStatus: "PENDING",
      settlementTimestampMs: null,
      settlementValue: null,
      settlementSource: check.settlementSource,
      grossPnlUsd: null,
      totalFeesUsd: position.feesUsd,
      netPnlUsd: null,
      nextCheckAtMs: null,
      checkAttemptCount: position.checkAttemptCount,
    };
  }

  let remainingGross = 0;
  if (check.status === "SETTLED_WIN") {
    remainingGross = position.contractsOpen * (1 - position.avgEntryPrice);
  } else if (check.status === "SETTLED_LOSS") {
    remainingGross = position.contractsOpen * (0 - position.avgEntryPrice);
  }

  const grossPnlUsd = position.realizedPnlUsd + remainingGross;
  const netPnlUsd = grossPnlUsd - position.feesUsd;

  return {
    ...positionIdentity(position),
    settlementStatus: check.status,
    settlementTimestampMs: check.settlementTimestampMs,
    settlementValue: check.settlementValue,
    settlementSource: check.settlementSource,
    grossPnlUsd,
    totalFeesUsd: position.feesUsd,
    netPnlUsd,
    nextCheckAtMs: null,
    checkAttemptCount: position.checkAttemptCount,
  };
}

function positionIdentity(position: SameVenueSettlementPosition) {
  return {
    traderId: position.traderId,
    marketTicker: position.marketTicker,
    contractSide: position.contractSide,
    notionalTierUsd: position.notionalTierUsd,
  };
}

/**
 * Bounded same-venue settlement batch. Pending markets use the same exponential backoff
 * policy as the established Sports Shadow settlement lane. No cron is registered here.
 */
export async function runSameVenueSettlementBatch(
  limit = 50,
  repo: SameVenueSettlementRepository = supabaseSameVenueSettlementRepository,
  checker: SameVenueSettlementChecker = checkKalshiSettlement,
  now: () => number = Date.now,
  deadlineAtMs = Infinity,
): Promise<{ checked: number; settled: number; errors: number; deadlineReached: boolean }> {
  const positions = await repo.findOpenPositions(limit);
  let checked = 0;
  let settled = 0;
  let errors = 0;
  let deadlineReached = false;

  for (const position of positions) {
    if (now() >= deadlineAtMs) {
      deadlineReached = true;
      break;
    }
    checked += 1;
    try {
      const row = await settleSameVenuePosition(position, checker);
      const checkAttemptCount = position.checkAttemptCount + 1;
      const finalRow: SameVenueSettlementRow =
        row.settlementStatus === "PENDING"
          ? { ...row, checkAttemptCount, nextCheckAtMs: computeNextSettlementCheckAtMs(now(), checkAttemptCount) }
          : { ...row, checkAttemptCount, nextCheckAtMs: null };
      await repo.finalizeSettlement(finalRow);
      if (finalRow.settlementStatus !== "PENDING") settled += 1;
    } catch {
      errors += 1;
    }
  }

  return { checked, settled, errors, deadlineReached };
}
