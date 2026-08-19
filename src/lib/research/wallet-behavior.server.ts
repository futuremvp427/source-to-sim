/**
 * SERVER-ONLY: fetches one wallet's source_events + general_activity and
 * runs the pure Part 1/5 analysis (wallet-behavior.ts,
 * non-trade-activity-signal.ts) over them.
 *
 * ****************************************************************
 * NOT EXECUTED IN THIS ENVIRONMENT.
 * ****************************************************************
 * This session has neither SUPABASE_SERVICE_ROLE_KEY nor outbound network
 * access to supabase.co (confirmed 403 via the egress proxy, same pattern
 * as every other external host checked in this and the prior phase). This
 * file is therefore unexecuted and untested beyond type-checking. Read-only
 * queries only; nothing here writes to any table.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { fetchAllRowsAfterId } from "../db-pagination";
import {
  evaluateNonTradeActivityHypotheses,
  type ActivityHypothesisResult,
} from "./non-trade-activity-signal";
import {
  classifyWalletBehavior,
  computeWalletBehaviorMetrics,
  type ClassificationResult,
  type NonTradeActivityRow,
  type SourceEventRow,
  type WalletBehaviorMetrics,
} from "./wallet-behavior";

type SourceEventDbRow = {
  id: string;
  condition_id: string | null;
  market_title: string;
  asset: string;
  outcome: string | null;
  side: string;
  price: number;
  shares: number;
  source_ts: number;
};

type GeneralActivityDbRow = {
  id: string;
  condition_id: string | null;
  asset: string | null;
  activity_type: string;
  source_ts: number;
};

async function fetchWalletSourceEvents(wallet: string): Promise<SourceEventRow[]> {
  const { rows } = await fetchAllRowsAfterId<SourceEventDbRow>(async (afterId, limit) => {
    let query = supabaseAdmin
      .from("source_events")
      .select("id, condition_id, market_title, asset, outcome, side, price, shares, source_ts")
      .eq("wallet", wallet.toLowerCase());
    if (afterId !== null) query = query.gt("id", afterId);
    const { data, error } = await query.order("id", { ascending: true }).limit(limit);
    if (error) throw new Error(error.message);
    return (data ?? []) as SourceEventDbRow[];
  });
  return rows
    .filter((r) => r.side === "BUY" || r.side === "SELL")
    .map((r) => ({
      conditionId: r.condition_id,
      marketTitle: r.market_title,
      asset: r.asset,
      outcome: r.outcome,
      side: r.side as "BUY" | "SELL",
      price: Number(r.price),
      shares: Number(r.shares),
      sourceTs: Number(r.source_ts),
    }));
}

async function fetchWalletActivity(wallet: string): Promise<NonTradeActivityRow[]> {
  const { rows } = await fetchAllRowsAfterId<GeneralActivityDbRow>(async (afterId, limit) => {
    let query = supabaseAdmin
      .from("general_activity")
      .select("id, condition_id, asset, activity_type, source_ts")
      .eq("wallet", wallet.toLowerCase());
    if (afterId !== null) query = query.gt("id", afterId);
    const { data, error } = await query.order("id", { ascending: true }).limit(limit);
    if (error) throw new Error(error.message);
    return (data ?? []) as GeneralActivityDbRow[];
  });
  return rows.map((r) => ({
    conditionId: r.condition_id,
    asset: r.asset,
    activityType: r.activity_type,
    sourceTs: Number(r.source_ts),
  }));
}

export type WalletAnalysis = {
  wallet: string;
  metrics: WalletBehaviorMetrics;
  classification: ClassificationResult;
  activityHypotheses: ActivityHypothesisResult[];
  /** Raw counts, so a report can show data completeness alongside the verdict. */
  rawCounts: { sourceEvents: number; activityEvents: number };
};

/** Read-only. Fetches everything needed and returns the full Part 1 + Part 5 analysis for one wallet. */
export async function analyzeWallet(wallet: string): Promise<WalletAnalysis> {
  const [events, activity] = await Promise.all([
    fetchWalletSourceEvents(wallet),
    fetchWalletActivity(wallet),
  ]);
  const metrics = computeWalletBehaviorMetrics(events, activity);
  const classification = classifyWalletBehavior(metrics);
  const activityHypotheses = evaluateNonTradeActivityHypotheses(metrics);
  return {
    wallet: wallet.toLowerCase(),
    metrics,
    classification,
    activityHypotheses,
    rawCounts: { sourceEvents: events.length, activityEvents: activity.length },
  };
}
