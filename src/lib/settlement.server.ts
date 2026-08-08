/**
 * Settlement / resolution automation for the SHADOW paper book.
 *
 * Only a VERIFIED public resolution (market closed + exactly one declared
 * winning outcome on Polymarket's public CLOB market record) may close a paper
 * position. The unique (experiment_id, asset) constraint on paper_settlements
 * guarantees a simulated payout is credited EXACTLY ONCE, even across restarts.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { decideResolution, settlementCredit, type PublicMarketResolution } from "./settlement-core";
import { raiseAlert } from "./shadow.server";
import { roundUsd } from "./shadow-core";

const CLOB_API = "https://clob.polymarket.com";
const MAX_POSITIONS_PER_PASS = 25;

export type SettlementPassResult = {
  settled: number;
  unresolved: number;
  failed: number;
  details: { asset: string; marketTitle: string | null; status: string }[];
};

async function fetchMarketResolution(conditionId: string): Promise<PublicMarketResolution | null> {
  const res = await fetch(`${CLOB_API}/markets/${conditionId}`, {
    headers: { accept: "application/json" },
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

export async function runSettlementPass(experimentId: string): Promise<SettlementPassResult> {
  const result: SettlementPassResult = { settled: 0, unresolved: 0, failed: 0, details: [] };

  const { data: positions } = await supabaseAdmin
    .from("paper_positions")
    .select("asset, market_title, outcome, shares, cost_basis, realized_pnl")
    .eq("experiment_id", experimentId)
    .eq("settlement_status", "open")
    .gt("shares", 0)
    .limit(MAX_POSITIONS_PER_PASS);
  if (!positions || positions.length === 0) return result;

  const assets = positions.map((p) => p.asset);
  const { data: eventRows } = await supabaseAdmin
    .from("source_events")
    .select("asset, condition_id, slug")
    .in("asset", assets);
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

    const shares = Number(position.shares);
    const costBasis = Number(position.cost_basis);
    const credit = settlementCredit({ shares, costBasis, payoutPerShare: decision.payoutPerShare });

    // Idempotency gate: the unique (experiment_id, asset) index makes a second
    // insert fail, so a replayed pass can never credit the payout twice.
    const { error: insertError } = await supabaseAdmin.from("paper_settlements").insert({
      experiment_id: experimentId,
      asset: position.asset,
      market_title: position.market_title,
      outcome: position.outcome,
      condition_id: conditionId,
      shares,
      cost_basis: costBasis,
      resolution_outcome: decision.won ? "WON" : "LOST",
      resolution_source: "polymarket_public_clob_market",
      resolution_ts: new Date().toISOString(),
      verified: true,
      payout: credit.payout,
      realized_pnl: credit.realizedPnl,
      evidence: {
        condition_id: conditionId,
        closed: market.closed,
        tokens: market.tokens,
      } as never,
    } as never);
    if (insertError) {
      result.unresolved += 1;
      result.details.push({
        asset: position.asset,
        marketTitle: position.market_title,
        status: "Already settled",
      });
      continue;
    }

    const { data: experiment } = await supabaseAdmin
      .from("paper_experiments")
      .select("cash, realized_pnl")
      .eq("id", experimentId)
      .maybeSingle();

    await supabaseAdmin
      .from("paper_experiments")
      .update({
        cash: roundUsd(Number(experiment?.cash ?? 0) + credit.payout),
        realized_pnl: roundUsd(Number(experiment?.realized_pnl ?? 0) + credit.realizedPnl),
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id", experimentId);

    await supabaseAdmin
      .from("paper_positions")
      .update({
        shares: 0,
        cost_basis: 0,
        avg_price: 0,
        realized_pnl: roundUsd(Number(position.realized_pnl ?? 0) + credit.realizedPnl),
        mark: decision.payoutPerShare,
        mark_source: "settlement",
        mark_ts: new Date().toISOString(),
        settlement_status: decision.won ? "settled_won" : "settled_lost",
        updated_at: new Date().toISOString(),
      } as never)
      .eq("experiment_id", experimentId)
      .eq("asset", position.asset);

    result.settled += 1;
    result.details.push({
      asset: position.asset,
      marketTitle: position.market_title,
      status: `${decision.won ? "WON" : "LOST"} — simulated payout $${credit.payout.toFixed(2)}`,
    });

    await raiseAlert(
      "info",
      "position_settled",
      `Simulated settlement: ${position.market_title ?? position.asset} ${decision.won ? "WON" : "LOST"} (payout $${credit.payout.toFixed(2)}).`,
      { asset: position.asset as never, condition_id: conditionId as never },
    );
  }

  return result;
}
