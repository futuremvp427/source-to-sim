/**
 * Approval queue engine.
 *
 * For each shadow (paper) copy action the autonomous follower produces, we
 * optionally create an authenticated Polymarket US ORDER PREVIEW — but only
 * when the market compatibility gate returns EXACT_MATCH. Approving a preview
 * never submits a live order; it only marks it ready for manual execution.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { lastNewMarketsAt } from "./availability.server";
import {
  decidePreviewAction,
  shouldRecheckCompatibility,
  type CompatibilityStatus,
} from "./automation";
import { getBalances, previewOrder, type PmusDeps } from "./capabilities.server";
import { resolveCompatibility, type MarketLookup } from "./compatibility.server";
import { isPmusConfigured } from "./credentials.server";
import { safeErrorMessage } from "./redact";

export const PREVIEW_STATUS = Object.freeze({
  pending: "PENDING_APPROVAL",
  approved: "USER_APPROVED",
  readyForManual: "READY_FOR_MANUAL_EXECUTION",
  rejected: "REJECTED",
  notEligible: "NOT_ELIGIBLE",
  failed: "PREVIEW_FAILED",
} as const);

const MAX_PREVIEWS_PER_CYCLE = 5;

export type OutcomeSide = "OUTCOME_SIDE_YES" | "OUTCOME_SIDE_NO";

/** Maps a source outcome label to a Polymarket US outcome side. */
export function mapOutcomeSide(outcome: string | null): OutcomeSide | null {
  if (!outcome) return null;
  const normalized = outcome.trim().toLowerCase();
  if (normalized === "yes") return "OUTCOME_SIDE_YES";
  if (normalized === "no") return "OUTCOME_SIDE_NO";
  return null;
}

export function availableUsdBalance(
  balances: readonly { currency?: string; buyingPower?: number }[] | undefined,
): number | null {
  const usd = (balances ?? []).find((b) => (b.currency ?? "USD").toUpperCase() === "USD");
  if (!usd || typeof usd.buyingPower !== "number") return null;
  return usd.buyingPower;
}

type CandidateRow = {
  event_key: string;
  source_event_id: string | null;
  action: string;
  side: string | null;
  asset: string;
  market_title: string | null;
  outcome: string | null;
  price: number | null;
  shares: number;
  notional: number;
  source_ts: number | null;
};

export type GeneratePreviewsResult = {
  considered: number;
  created: number;
  ineligible: number;
  failed: number;
  rechecked: number;
  cached: number;
  skippedReason: string | null;
};

/**
 * Called at the end of an ingest cycle. Safe to call when credentials are
 * absent — it simply records candidates as not eligible for a preview.
 */
export async function generatePendingPreviews(
  experimentId: string,
  deps: PmusDeps = {},
  lookup?: MarketLookup,
): Promise<GeneratePreviewsResult> {
  const result: GeneratePreviewsResult = {
    considered: 0,
    created: 0,
    ineligible: 0,
    failed: 0,
    rechecked: 0,
    cached: 0,
    skippedReason: null,
  };

  const configured = deps.credentials ? true : isPmusConfigured();
  if (!configured) {
    result.skippedReason = "Polymarket US credentials are not configured.";
    return result;
  }

  const { data: trades } = await supabaseAdmin
    .from("paper_trades")
    .select(
      "event_key, source_event_id, action, side, asset, market_title, outcome, price, shares, notional, source_ts",
    )
    .eq("experiment_id", experimentId)
    .in("action", ["BUY", "SELL"])
    .order("source_ts", { ascending: false })
    .limit(40);

  const candidates = (trades ?? []) as CandidateRow[];
  if (candidates.length === 0) return result;

  const eventKeys = candidates.map((c) => c.event_key);

  const { data: existing } = await supabaseAdmin
    .from("order_previews")
    .select("event_key, status")
    .eq("experiment_id", experimentId)
    .in("event_key", eventKeys);
  const statusByKey = new Map((existing ?? []).map((r) => [r.event_key, r.status as string]));

  const { data: checkRows } = await supabaseAdmin
    .from("compatibility_checks")
    .select("*")
    .in("event_key", eventKeys);
  const checkByKey = new Map((checkRows ?? []).map((r) => [r.event_key, r]));

  // New relevant US markets since a cached NO_MATCH force an automatic recheck.
  const newMarketsAt = await lastNewMarketsAt();

  const fresh = candidates
    .filter((c) => decidePreviewAction({
      compatibility: "EXACT_MATCH",
      usMarketSlug: "x",
      outcomeSide: "OUTCOME_SIDE_YES",
      existingStatus: statusByKey.get(c.event_key) ?? null,
    }) !== "SKIP_EXISTING")
    .slice(0, MAX_PREVIEWS_PER_CYCLE);
  result.considered = fresh.length;
  if (fresh.length === 0) return result;

  // One balance read per cycle, shared across previews.
  const balancesResult = await getBalances(deps);
  const balance = balancesResult.ok
    ? availableUsdBalance(balancesResult.data.balances)
    : null;

  for (const trade of fresh) {
    const slug = await sourceSlugFor(trade.source_event_id);
    const cached = checkByKey.get(trade.event_key) ?? null;
    const mustCheck = shouldRecheckCompatibility(cached, { newMarketsAt });

    let compat: { compatibility: string; usMarketSlug: string | null; reason: string };
    if (mustCheck) {
      compat = await resolveCompatibility(
        { question: trade.market_title, slug, outcomes: trade.outcome ? [trade.outcome] : [] },
        lookup,
      );
      if (cached) result.rechecked += 1;
      await recordCompatibilityCheck({
        eventKey: trade.event_key,
        sourceEventId: trade.source_event_id,
        sourceMarket: trade.market_title,
        sourceSlug: slug,
        status: compat.compatibility as CompatibilityStatus,
        matched: compat.usMarketSlug,
        reason: compat.reason,
        previousChecks: cached?.checks ?? 0,
      });
    } else {
      result.cached += 1;
      compat = {
        compatibility: cached?.compatibility_status ?? "NO_MATCH",
        usMarketSlug: cached?.matched_us_market ?? null,
        reason: cached?.reason ?? "Reused a recent compatibility result.",
      };
    }
    const outcomeSide = mapOutcomeSide(trade.outcome);
    const action = decidePreviewAction({
      compatibility: compat.compatibility,
      usMarketSlug: compat.usMarketSlug,
      outcomeSide,
      existingStatus: statusByKey.get(trade.event_key) ?? null,
    });

    const base = {
      experiment_id: experimentId,
      source_event_id: trade.source_event_id,
      event_key: trade.event_key,
      asset: trade.asset,
      market_title: trade.market_title,
      outcome: trade.outcome,
      source_slug: slug,
      source_side: trade.side ?? trade.action,
      source_price: trade.price,
      candidate_shares: trade.shares,
      candidate_notional: trade.notional,
      us_market_slug: compat.usMarketSlug,
      compatibility: compat.compatibility,
      compatibility_reason: compat.reason,
      available_balance: balance,
      balance_currency: balance === null ? null : "USD",
      source_ts: trade.source_ts,
      updated_at: new Date().toISOString(),
    };

    if (action === "SKIP_EXISTING") continue;

    if (action !== "PREVIEW") {
      await upsertPreview({
        ...base,
        status: PREVIEW_STATUS.notEligible,
        compatibility_reason: outcomeSide
          ? compat.reason
          : "Source outcome could not be mapped to a Polymarket US YES/NO side.",
      });
      result.ineligible += 1;
      continue;
    }

    const usMarketSlug = compat.usMarketSlug as string;
    const previewSide = outcomeSide as OutcomeSide;

    const limitPrice = clampPrice(trade.price);
    if (limitPrice === null) {
      await upsertPreview({
        ...base,
        status: PREVIEW_STATUS.failed,
        error: "No usable source price for a limit preview.",
      });
      result.failed += 1;
      continue;
    }

    const preview = await previewOrder(
      {
        marketSlug: usMarketSlug,
        outcomeSide: previewSide,
        action: trade.action === "SELL" ? "ORDER_ACTION_SELL" : "ORDER_ACTION_BUY",
        quantity: Number(trade.shares.toFixed(2)),
        limitPrice,
      },
      deps,
    );

    if (!preview.ok) {
      await upsertPreview({ ...base, status: PREVIEW_STATUS.failed, error: preview.error });
      result.failed += 1;
      continue;
    }

    const order = preview.data.order ?? {};
    const previewPrice = toNumber(order.avgPx?.value ?? order.price?.value) ?? limitPrice;
    const previewQuantity = typeof order.quantity === "number" ? order.quantity : trade.shares;
    const estimatedCost =
      toNumber(order.cashOrderQty?.value) ?? Number((previewPrice * previewQuantity).toFixed(2));

    await upsertPreview({
      ...base,
      status: PREVIEW_STATUS.pending,
      preview_side: trade.action === "SELL" ? "SELL" : "BUY",
      preview_price: previewPrice,
      preview_quantity: previewQuantity,
      preview_estimated_cost: estimatedCost,
      error: null,
    });
    result.created += 1;

    await raiseExactMatchAlert({
      sourceMarket: trade.market_title,
      usMarket: usMarketSlug,
      side: trade.action === "SELL" ? "SELL" : "BUY",
      previewQuantity,
      previewEstimatedCost: estimatedCost,
      availableBalance: balance,
    });
  }

  return result;
}

async function recordCompatibilityCheck(input: {
  eventKey: string;
  sourceEventId: string | null;
  sourceMarket: string | null;
  sourceSlug: string | null;
  status: CompatibilityStatus;
  matched: string | null;
  reason: string;
  previousChecks: number;
}): Promise<void> {
  await supabaseAdmin.from("compatibility_checks").upsert(
    {
      event_key: input.eventKey,
      source_event_id: input.sourceEventId,
      source_market: input.sourceMarket,
      source_slug: input.sourceSlug,
      compatibility_status: input.status,
      matched_us_market: input.matched,
      reason: input.reason,
      checks: input.previousChecks + 1,
      checked_at: new Date().toISOString(),
    } as never,
    { onConflict: "event_key" },
  );
}

/** In-app alert. Approval is still required; nothing is submitted. */
async function raiseExactMatchAlert(info: {
  sourceMarket: string | null;
  usMarket: string;
  side: string;
  previewQuantity: number;
  previewEstimatedCost: number;
  availableBalance: number | null;
}): Promise<void> {
  await supabaseAdmin.from("alerts").insert({
    level: "info",
    kind: "pmus_exact_match",
    message: "Polymarket US exact match found — order preview added to the approval queue.",
    context: info as never,
  } as never);
}

function clampPrice(price: number | null): number | null {
  if (price === null || !Number.isFinite(price) || price <= 0 || price >= 1) return null;
  return Number(price.toFixed(3));
}

function toNumber(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

async function sourceSlugFor(sourceEventId: string | null): Promise<string | null> {
  if (!sourceEventId) return null;
  const { data } = await supabaseAdmin
    .from("source_events")
    .select("slug")
    .eq("id", sourceEventId)
    .maybeSingle();
  return data?.slug ?? null;
}

async function upsertPreview(row: Record<string, unknown>): Promise<void> {
  await supabaseAdmin
    .from("order_previews")
    .upsert(row as never, { onConflict: "experiment_id,event_key" });
}

/* --------------------------- Approval decisions --------------------------- */

export type PreviewDecision = "approve" | "reject";

/**
 * Approve = mark USER_APPROVED / READY_FOR_MANUAL_EXECUTION.
 * There is deliberately NO code path here that submits a live order.
 */
export async function decidePreview(
  previewId: string,
  decision: PreviewDecision,
): Promise<{ ok: boolean; error?: string }> {
  const status =
    decision === "approve" ? PREVIEW_STATUS.readyForManual : PREVIEW_STATUS.rejected;
  const { error } = await supabaseAdmin
    .from("order_previews")
    .update({
      status,
      decided_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", previewId)
    .eq("status", PREVIEW_STATUS.pending);
  if (error) return { ok: false, error: safeErrorMessage(error.message) };
  return { ok: true };
}