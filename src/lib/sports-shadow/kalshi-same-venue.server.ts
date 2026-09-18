/**
 * SAME-VENUE (Kalshi -> Kalshi) PAPER pipeline — SERVER (DB + read-only book) driver.
 *
 * Thin adapter only: every decision lives in the pure module (kalshi-same-venue.ts) and
 * in the existing episode/depth-walk/fee modules. This file supplies
 *   - the Supabase repository (durable admission, atomic claim, position replay,
 *     fill finalization) over the additive `sports_shadow_kalshi_*` tables and RPCs, and
 *   - a read-only exact-ticker Kalshi book reader built on the EXISTING fetchKalshiBook.
 *
 * PAPER/RESEARCH ONLY: no order construction, no order endpoint, no live-execution
 * switch. LIVE_EXECUTION_IMPLEMENTED stays false.
 *
 * PRODUCTION IS INERT: `getConfiguredKalshiTraderActivitySource()` returns null because no
 * VERIFIED Kalshi trader-activity feed exists (see docs/KALSHI_SAME_VENUE_SOURCE.md), so
 * `runSameVenueIngestCycle` admits nothing and no cron is registered for it. A fake
 * transport is never substituted.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { fetchKalshiBook } from "./kalshi.server";
import type { KalshiContractSide, KalshiTraderActivitySource, KalshiTraderQualification } from "./kalshi-source";
import {
  runKalshiSourceIngestCycle,
  type AdmittedSameVenueEvent,
  type IngestCycleResult,
  type SameVenueBook,
  type SameVenueRepository,
} from "./kalshi-same-venue";

const SOURCE_EVENT_COLUMNS =
  "id, route, event_key, trader_id, source_trade_id, market_ticker, contract_side, action, quantity, source_price, source_ts, detected_at";

type SourceEventRow = {
  id: string;
  route: string;
  event_key: string;
  trader_id: string;
  source_trade_id: string;
  market_ticker: string;
  contract_side: string;
  action: string;
  quantity: number | string;
  source_price: number | string;
  source_ts: number | string;
  detected_at: string;
};

function num(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

function mapRow(row: SourceEventRow): AdmittedSameVenueEvent {
  return {
    id: row.id,
    route: row.route,
    eventKey: row.event_key,
    traderId: row.trader_id,
    sourceTradeId: row.source_trade_id,
    marketTicker: row.market_ticker,
    contractSide: row.contract_side as KalshiContractSide,
    action: row.action as "BUY" | "SELL",
    quantity: num(row.quantity),
    sourcePrice: num(row.source_price),
    sourceTs: num(row.source_ts),
    detectedAtMs: Date.parse(row.detected_at),
  };
}

type RpcArgs = Record<string, unknown>;

/**
 * The generated RPC arg types model every SQL parameter as non-nullable, while these
 * functions legitimately accept NULL for optional/absent values (no fee, no reject reason,
 * no episode key). This is a typing-only shim over the SAME typed client -- it changes no
 * runtime behaviour and grants no extra privilege.
 */
async function callRpc<T>(name: string, args: RpcArgs): Promise<T> {
  const rpc = supabaseAdmin.rpc as unknown as (n: string, a: RpcArgs) => Promise<{ data: unknown; error: { message: string } | null }>;
  const { data, error } = await rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const supabaseSameVenueRepository: SameVenueRepository = {
  async getQualification(traderId): Promise<KalshiTraderQualification | null> {
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_kalshi_trader_qualification")
      .select("trader_id, approved_for_paper_copy, evidence")
      .eq("trader_id", traderId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data === null) return null;
    return {
      traderId: data.trader_id as string,
      approvedForPaperCopy: data.approved_for_paper_copy === true,
      ...(data.evidence ? { evidence: data.evidence as Record<string, unknown> } : {}),
    };
  },

  async admitEvent(trade, detectedAtMs, sourceName) {
    const result = await callRpc<{ admitted?: boolean; duplicate?: boolean; id?: string | null } | null>("admit_sports_shadow_kalshi_source_event", {
      p_event_key: trade.eventKey,
      p_trader_id: trade.traderId,
      p_source_trade_id: trade.sourceTradeId,
      p_market_ticker: trade.marketTicker,
      p_contract_side: trade.contractSide,
      p_action: trade.action,
      p_quantity: trade.quantity,
      p_source_price: trade.price,
      p_source_price_cents: trade.priceCents,
      p_source_ts: trade.sourceTs,
      p_detected_at: new Date(detectedAtMs).toISOString(),
      p_source_name: sourceName,
    });
    return { admitted: result?.admitted === true, duplicate: result?.duplicate === true, id: result?.id ?? null };
  },

  async claimPendingEvents(workerId, limit) {
    const rows = await callRpc<SourceEventRow[] | null>("claim_sports_shadow_kalshi_source_events", {
      p_worker_id: workerId,
      p_limit: limit,
    });
    return (rows ?? []).map(mapRow);
  },

  async listPositionHistory(traderId, marketTicker, contractSide) {
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_kalshi_source_events")
      .select(SOURCE_EVENT_COLUMNS)
      .eq("trader_id", traderId)
      .eq("market_ticker", marketTicker)
      .eq("contract_side", contractSide)
      .order("source_ts", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(500);
    if (error) throw new Error(error.message);
    return ((data ?? []) as SourceEventRow[]).map(mapRow);
  },

  async getOpenPosition(traderId, marketTicker, contractSide, notionalTierUsd) {
    const { data, error } = await supabaseAdmin
      .from("sports_shadow_kalshi_paper_positions")
      .select("contracts_open, avg_entry_price")
      .eq("trader_id", traderId)
      .eq("market_ticker", marketTicker)
      .eq("contract_side", contractSide)
      .eq("notional_tier_usd", notionalTierUsd)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data === null) return null;
    const avg = data.avg_entry_price as number | string | null;
    return {
      contractsOpen: num(data.contracts_open as number | string),
      avgEntryPrice: avg === null ? null : num(avg),
    };
  },

  async finalizePaperFill(input) {
    const applied = await callRpc<boolean | null>("finalize_sports_shadow_kalshi_paper_fill", {
      p_source_event_id: input.sourceEventId,
      p_trader_id: input.traderId,
      p_market_ticker: input.marketTicker,
      p_contract_side: input.contractSide,
      p_action: input.action,
      p_notional_tier_usd: input.notionalTierUsd,
      p_contracts: input.contracts,
      p_vwap: input.vwap,
      p_fee_usd: input.feeUsd,
      p_fee_model_version: input.feeModelVersion,
      p_all_in_cost_usd: input.allInCostUsd,
      p_fill_status: input.fillStatus,
      p_reject_reason: input.rejectReason,
      p_book_observed_at: input.bookObservedAtMs === null ? null : new Date(input.bookObservedAtMs).toISOString(),
      p_book_stale_reason: input.bookStaleReason,
      p_episode_key: input.episodeKey,
      p_source_ts: input.sourceTs,
      p_detected_at: new Date(input.detectedAtMs).toISOString(),
    });
    return applied === true;
  },

  async markEvent(eventId, status, statusReason, episodeKey) {
    const { error } = await supabaseAdmin
      .from("sports_shadow_kalshi_source_events")
      .update({ status, status_reason: statusReason, episode_key: episodeKey, processed_at: new Date().toISOString() })
      .eq("id", eventId);
    if (error) throw new Error(error.message);
  },
};

/**
 * Read-only exact-ticker book reader. Uses the ticker VERBATIM — no discovery, no
 * resolution, no translation — and projects the already-normalized YES/NO side.
 */
export async function fetchSameVenueBook(input: { ticker: string; side: KalshiContractSide; signal?: AbortSignal }): Promise<SameVenueBook> {
  const snapshot = await fetchKalshiBook(input.ticker);
  const side = input.side === "YES" ? snapshot.yes : snapshot.no;
  return {
    observedAtMs: snapshot.observedAt,
    staleReason: snapshot.staleReason,
    askLevels: side.askLevels,
    bidLevels: side.bidLevels,
  };
}

/**
 * THE plug point. Returns null in production today: no VERIFIED Kalshi interface exposes
 * another public trader's trades, and a fake transport must never be substituted.
 */
export function getConfiguredKalshiTraderActivitySource(): KalshiTraderActivitySource | null {
  return null;
}

/** Inert while no verified feed is configured. Never fabricates events. */
export async function runSameVenueIngestCycle(signal?: AbortSignal): Promise<IngestCycleResult> {
  return runKalshiSourceIngestCycle({
    source: getConfiguredKalshiTraderActivitySource(),
    repo: supabaseSameVenueRepository,
    now: () => Date.now(),
    traders: [],
    ...(signal ? { signal } : {}),
  });
}
