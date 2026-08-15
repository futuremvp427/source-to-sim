/**
 * Read-only accessor for `live_order_intents`, strictly scoped to the
 * Poligarch V2 live pilot (`pilot_id = 'poligarch_v2_live_pilot'`).
 *
 * This module is SELECT-only: it never inserts or updates a row. The only
 * writers of this table are `createOrGetLivePilotIntent` /
 * `updateLivePilotIntentStatus` in `poligarch-preview.server.ts`, via the
 * Task 3 RPCs. Deliberately kept out of `poligarch-safety.server.ts`, whose
 * own docstring (and its regression test) asserts that module never touches
 * anything but the `live_pilot_state` row — adding a `live_order_intents`
 * read there would break that invariant.
 *
 * Every query below filters on `pilot_id = POLIGARCH_LIVE_PILOT_ID`, so no
 * other pilot's or wallet's intent rows can ever be returned from here.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";

import { POLIGARCH_LIVE_PILOT_ID } from "./poligarch-config";

export type PoligarchLiveIntent = {
  id: string;
  sourceEventKey: string;
  sourceWallet: string;
  sourceSide: string;
  sourcePrice: number;
  sourceTs: number;
  usMarketSlug: string | null;
  status: string;
  statusHistory: Json;
  failReason: string | null;
  requestedShares: number | null;
  requestedNotionalUsd: number | null;
  submittedOrderId: string | null;
  filledShares: number | null;
  avgFillPrice: number | null;
  detectedAt: string;
  decisionAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const SELECT_COLUMNS =
  "id, source_event_key, source_wallet, source_side, source_price, source_ts, us_market_slug, status, status_history, fail_reason, requested_shares, requested_notional_usd, submitted_order_id, filled_shares, avg_fill_price, detected_at, decision_at, created_at, updated_at";

type IntentRow = {
  id: string;
  source_event_key: string;
  source_wallet: string;
  source_side: string;
  source_price: number | string;
  source_ts: number | string;
  us_market_slug: string | null;
  status: string;
  status_history: Json;
  fail_reason: string | null;
  requested_shares: number | string | null;
  requested_notional_usd: number | string | null;
  submitted_order_id: string | null;
  filled_shares: number | string | null;
  avg_fill_price: number | string | null;
  detected_at: string;
  decision_at: string | null;
  created_at: string;
  updated_at: string;
};

function toNumberOrNull(v: number | string | null): number | null {
  return v === null ? null : Number(v);
}

function toIntent(row: IntentRow): PoligarchLiveIntent {
  return {
    id: row.id,
    sourceEventKey: row.source_event_key,
    sourceWallet: row.source_wallet,
    sourceSide: row.source_side,
    sourcePrice: Number(row.source_price),
    sourceTs: Number(row.source_ts),
    usMarketSlug: row.us_market_slug,
    status: row.status,
    statusHistory: row.status_history,
    failReason: row.fail_reason,
    requestedShares: toNumberOrNull(row.requested_shares),
    requestedNotionalUsd: toNumberOrNull(row.requested_notional_usd),
    submittedOrderId: row.submitted_order_id,
    filledShares: toNumberOrNull(row.filled_shares),
    avgFillPrice: toNumberOrNull(row.avg_fill_price),
    detectedAt: row.detected_at,
    decisionAt: row.decision_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const DEFAULT_LIMIT = 20;

/**
 * Most recent `limit` (default 20) live-pilot intent rows for the Poligarch
 * V2 pilot only, newest first. Returns an empty array (never throws) when
 * no intents exist yet — expected in production today, since no caller in
 * this plan yet invokes the preview pipeline against live signals.
 */
export async function loadRecentPoligarchIntents(
  limit: number = DEFAULT_LIMIT,
): Promise<PoligarchLiveIntent[]> {
  const { data, error } = await supabaseAdmin
    .from("live_order_intents")
    .select(SELECT_COLUMNS)
    .eq("pilot_id", POLIGARCH_LIVE_PILOT_ID)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data as IntentRow[] | null) ?? []).map(toIntent);
}
