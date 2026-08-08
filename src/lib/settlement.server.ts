/**
 * Settlement / resolution automation for the SHADOW paper book.
 *
 * Only a VERIFIED public resolution (market closed + exactly one declared
 * winning outcome on Polymarket's public CLOB market record) may close a paper
 * position. Settlement accounting is applied by one PostgreSQL RPC transaction
 * so a crash can never strand an idempotency row between payout/cash/position
 * updates.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { decideResolution, type PublicMarketResolution } from "./settlement-core";
import { raiseAlert } from "./shadow.server";

const CLOB_API = "https://clob.polymarket.com";
const MAX_POSITIONS_PER_PASS = 25;
const RESOLUTION_TIMEOUT_MS = 10_000;

export type SettlementPassResult = {
  settled: number;
  unresolved: number;
  failed: number;
  details: { asset: string; marketTitle: string | null; status: string }[];
};

async function fetchMarketResolution(conditionId: string): Promise<PublicMarketResolution | null> {
  const res = await fetch(`${CLOB_API}/markets/${conditionId}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(RESOLUTION_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    closed?: boolean;
    tokens?: { token_id?: string; outcome?: string; winner?: boolean }[];
  };
  if (typeof body.closed !== "boolean" || !Array.isArray(body.tokens)) return null;
  return {
    closed: body.closed,
    tokens: body.tokens.map((t) => ({
      tokenId: String(t.token_id ?? ""),
      outcome: t.outcome ?? null,
      winner: t.winner === true,
    })),
  };
}

type SettlementRpcRow = {
  applied: boolean;
  payout: number | string;
  realized_pnl: number | string;
};

type RpcResult = { data: unknown; error: { message: string } | null };

async function applyVerifiedSettlementRpc(args: Record<string, unknown>): Promise<RpcResult> {
  // The migration and this code land together; Lovable regenerates Database
  // types only after the migration is applied, so keep this one new RPC behind
  // a narrow typed adapter instead of weakening the whole Supabase client type.
  const rpc = supabaseAdmin.rpc as unknown as (
    name: string,
    params: Record<string, unknown>,
  ) => Promise<RpcResult>;
  return rpc("apply_verified_paper_settlement", args);
}

export async function runSettlementPass(experimentId: string): Promise<SettlementPassResult> {
  const result: SettlementPassResult = { settled: 0, unresolved: 0, failed: 0, details: [] };

  const { data: positions, error: positionsError } = await supabaseAdmin
    .from("paper_positions")
    .select("asset, market_title, outcome, shares, cost_basis, realized_pnl")
    .eq("experiment_id", experimentId)
    .eq("settlement_status", "open")
    .gt("shares", 0)
    .limit(MAX_POSITIONS_PER_PASS);
  if (positionsError) throw new Error(positionsError.message);
  if (!positions || positions.length === 0) return result;

  const assets = positions.map((p) => p.asset);
  const { data: eventRows, error: eventsError } = await supabaseAdmin
    .from("source_events")
    .select("asset, condition_id")
    .in("asset", assets);
  if (eventsError) throw new Error(eventsError.message);
  const conditionByAsset = new Map<string, string>();
  for (const row of eventRows ?? []) {
    if (row.condition_id && !conditionByAsset.has(row.asset)) {
      conditionByAsset.set(row.asset, row.condition_id);
    }
  }

  for (const position of positions) {
    const conditionId = conditionByAsset.get(position.asset);
    if (!conditionId) {
      result.unresolved += 1;
      result.details.push({
        asset: position.asset,
        marketTitle: position.market_title,
        status: "No condition id on record — left OPEN",
      });
      continue;
    }

    let market: PublicMarketResolution | null = null;
    try {
      market = await fetchMarketResolution(conditionId);
    } catch {
      market = null;
    }
    if (!market) {
      result.failed += 1;
      result.details.push({
        asset: position.asset,
        marketTitle: position.market_title,
        status: "Public resolution lookup failed — left OPEN",
      });
      continue;
    }

    const decision = decideResolution(position.asset, market);
    if (!decision.verified) {
      result.unresolved += 1;
      result.details.push({
        asset: position.asset,
        marketTitle: position.market_title,
        status: decision.reason,
      });
      continue;
    }

    const resolutionTs = new Date().toISOString();
    const { data: rpcData, error: rpcError } = await applyVerifiedSettlementRpc({
      p_experiment_id: experimentId,
      p_asset: position.asset,
      p_condition_id: conditionId,
      p_resolution_outcome: decision.won ? "WON" : "LOST",
      p_resolution_source: "polymarket_public_clob_market",
      p_resolution_ts: resolutionTs,
      p_payout_per_share: decision.payoutPerShare,
      p_evidence: {
        condition_id: conditionId,
        closed: market.closed,
        tokens: market.tokens,
      },
    });

    if (rpcError) {
      result.failed += 1;
      result.details.push({
        asset: position.asset,
        marketTitle: position.market_title,
        status: `Atomic settlement failed — left OPEN (${rpcError.message})`,
      });
      continue;
    }

    const rpcRow = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as SettlementRpcRow | null;
    if (!rpcRow?.applied) {
      result.unresolved += 1;
      result.details.push({
        asset: position.asset,
        marketTitle: position.market_title,
        status: "Already settled or position no longer open",
      });
      continue;
    }

    const payout = Number(rpcRow.payout ?? 0);
    const realized = Number(rpcRow.realized_pnl ?? 0);
    result.settled += 1;
    result.details.push({
      asset: position.asset,
      marketTitle: position.market_title,
      status: `${decision.won ? "WON" : "LOST"} — simulated payout $${payout.toFixed(2)}`,
    });

    await raiseAlert(
      "info",
      "position_settled",
      `Simulated settlement: ${position.market_title ?? position.asset} ${decision.won ? "WON" : "LOST"} (payout $${payout.toFixed(2)}, realized ${realized >= 0 ? "+" : ""}$${realized.toFixed(2)}).`,
      { asset: position.asset as never, condition_id: conditionId as never },
      `position_settled:${experimentId}:${position.asset}`,
    );
  }

  return result;
}
