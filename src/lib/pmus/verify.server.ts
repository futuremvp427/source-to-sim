/**
 * Connection verification + read model for the Account Setup UI and the
 * Approval Queue. Nothing here returns the key ID, the secret key, a raw
 * signature, auth headers, URLs, paths or query strings.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { getBalances, getPositions, type PmusDeps } from "./capabilities.server";
import { isPmusConfigured } from "./credentials.server";
import { availableUsdBalance, PREVIEW_STATUS } from "./previews.server";
import { safeErrorMessage } from "./redact";

export const INTEGRATION_ID = "polymarket_us";

export type PmusAccountSummary = {
  currency: string;
  buyingPower: number | null;
  currentBalance: number | null;
  assetNotional: number | null;
  openPositions: number | null;
};

export type PmusConnectionStatus = {
  provider: "Polymarket US";
  configured: boolean;
  connected: boolean;
  status: string;
  detail: string | null;
  lastVerifiedAt: string | null;
  accountSummary: PmusAccountSummary | null;
};

export async function verifyPmusConnection(deps: PmusDeps = {}): Promise<PmusConnectionStatus> {
  const configured = deps.credentials ? true : isPmusConfigured();
  if (!configured) {
    const status: PmusConnectionStatus = {
      provider: "Polymarket US",
      configured: false,
      connected: false,
      status: "not_configured",
      detail: "Add POLYMARKET_KEY_ID and POLYMARKET_SECRET_KEY to verify the connection.",
      lastVerifiedAt: null,
      accountSummary: null,
    };
    await persistStatus(status);
    return status;
  }

  const [balances, positions] = await Promise.all([getBalances(deps), getPositions(deps)]);

  if (!balances.ok || !positions.ok) {
    const failure = !balances.ok ? balances.error : (positions as { error: string }).error;
    const status: PmusConnectionStatus = {
      provider: "Polymarket US",
      configured: true,
      connected: false,
      status: "verification_failed",
      detail: safeErrorMessage(failure),
      lastVerifiedAt: new Date().toISOString(),
      accountSummary: null,
    };
    await persistStatus(status);
    return status;
  }

  const usd = (balances.data.balances ?? []).find(
    (b) => (b.currency ?? "USD").toUpperCase() === "USD",
  );
  const status: PmusConnectionStatus = {
    provider: "Polymarket US",
    configured: true,
    connected: true,
    status: "connected",
    detail: "Read-only balances and positions retrieved successfully.",
    lastVerifiedAt: new Date().toISOString(),
    accountSummary: {
      currency: usd?.currency ?? "USD",
      buyingPower: availableUsdBalance(balances.data.balances),
      currentBalance: typeof usd?.currentBalance === "number" ? usd.currentBalance : null,
      assetNotional: typeof usd?.assetNotional === "number" ? usd.assetNotional : null,
      openPositions: Array.isArray(positions.data.positions)
        ? positions.data.positions.length
        : null,
    },
  };
  await persistStatus(status);
  return status;
}

async function persistStatus(status: PmusConnectionStatus): Promise<void> {
  await supabaseAdmin.from("integration_status").upsert({
    id: INTEGRATION_ID,
    configured: status.configured,
    connected: status.connected,
    status: status.status,
    detail: status.detail,
    account_summary: status.accountSummary as never,
    last_verified_at: status.lastVerifiedAt,
    updated_at: new Date().toISOString(),
  } as never);
}

export type ApprovalCard = {
  id: string;
  marketTitle: string | null;
  outcome: string | null;
  usMarketSlug: string | null;
  sourceSide: string;
  sourcePrice: number | null;
  candidateShares: number;
  candidateNotional: number;
  previewSide: string | null;
  previewPrice: number | null;
  previewQuantity: number | null;
  previewEstimatedCost: number | null;
  availableBalance: number | null;
  balanceCurrency: string | null;
  compatibility: string;
  compatibilityReason: string | null;
  status: string;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
};

export type PmusPanelData = {
  connection: PmusConnectionStatus;
  pending: ApprovalCard[];
  recent: ApprovalCard[];
  counts: { pending: number; approved: number; rejected: number; ineligible: number };
};

export async function loadPmusPanel(): Promise<PmusPanelData> {
  const [{ data: statusRow }, { data: previewRows }] = await Promise.all([
    supabaseAdmin.from("integration_status").select("*").eq("id", INTEGRATION_ID).maybeSingle(),
    supabaseAdmin
      .from("order_previews")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(60),
  ]);

  const configured = isPmusConfigured();
  const connection: PmusConnectionStatus = {
    provider: "Polymarket US",
    configured,
    connected: configured ? (statusRow?.connected ?? false) : false,
    status: configured ? (statusRow?.status ?? "unverified") : "not_configured",
    detail: configured
      ? (statusRow?.detail ?? null)
      : "Add POLYMARKET_KEY_ID and POLYMARKET_SECRET_KEY to enable authenticated reads.",
    lastVerifiedAt: statusRow?.last_verified_at ?? null,
    accountSummary: (statusRow?.account_summary as PmusAccountSummary | null) ?? null,
  };

  const cards: ApprovalCard[] = (previewRows ?? []).map((r) => ({
    id: r.id,
    marketTitle: r.market_title,
    outcome: r.outcome,
    usMarketSlug: r.us_market_slug,
    sourceSide: r.source_side,
    sourcePrice: r.source_price === null ? null : Number(r.source_price),
    candidateShares: Number(r.candidate_shares),
    candidateNotional: Number(r.candidate_notional),
    previewSide: r.preview_side,
    previewPrice: r.preview_price === null ? null : Number(r.preview_price),
    previewQuantity: r.preview_quantity === null ? null : Number(r.preview_quantity),
    previewEstimatedCost:
      r.preview_estimated_cost === null ? null : Number(r.preview_estimated_cost),
    availableBalance: r.available_balance === null ? null : Number(r.available_balance),
    balanceCurrency: r.balance_currency,
    compatibility: r.compatibility,
    compatibilityReason: r.compatibility_reason,
    status: r.status,
    error: r.error,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  }));

  return {
    connection,
    pending: cards.filter((c) => c.status === PREVIEW_STATUS.pending),
    recent: cards.filter((c) => c.status !== PREVIEW_STATUS.pending).slice(0, 12),
    counts: {
      pending: cards.filter((c) => c.status === PREVIEW_STATUS.pending).length,
      approved: cards.filter((c) => c.status === PREVIEW_STATUS.readyForManual).length,
      rejected: cards.filter((c) => c.status === PREVIEW_STATUS.rejected).length,
      ineligible: cards.filter((c) => c.status === PREVIEW_STATUS.notEligible).length,
    },
  };
}