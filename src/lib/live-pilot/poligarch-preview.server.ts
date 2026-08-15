/**
 * Preview-only orchestration pipeline for the Poligarch V2 live pilot.
 *
 * Wires together, in strict fail-closed order: the hard allowlist (Task 1),
 * the per-signal safety-state gate (Task 7's `PilotSafetyState`), exact-match
 * market mapping (Task 5), and every risk check (Task 6) into a single
 * PASS/FAIL preview result.
 *
 * This module NEVER calls anything resembling order submission. There is no
 * order-submission code anywhere in this codebase yet — Task 7's
 * `POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED` is a hard-coded `false` with no
 * runtime path to flip it — and this file must stay that way; it must keep
 * producing PASS/FAIL previews only.
 *
 * On PASS, or on a downstream reject reached only after an intent already
 * exists (order sizing rejected, or a risk check failed), the pipeline
 * persists an idempotent intent row through the Task 3 RPCs
 * (`create_or_get_live_pilot_intent_atomic` /
 * `update_live_pilot_intent_status_atomic`), called via `supabaseAdmin.rpc`
 * the same way `shadow.server.ts` calls `process_source_event_atomic`.
 * Rejects that never reach a sized order (allowlist miss, safety-state gate
 * closed, market-mapping SKIP, stale signal) never create an intent row —
 * there's no experiment-scoped tradeable candidate yet to be idempotent
 * about, and a speculative row for every rejected signal would just be
 * noise on a table meant to track real order intents.
 *
 * Wiring note for callers: `getCurrentBook` (live PMUS book + market specs)
 * and `getPilotLedgerSnapshot` (today's realized P&L, open exposure,
 * consecutive failures, open positions) have no prior-task implementation to
 * reuse and are left as required injected dependencies rather than guessed
 * at here — see the task-9 report for why. `mapMarket` should be wired to
 * `mapPoligarchSourceEvent` from `./poligarch-market-mapping.server`,
 * `getPilotSafetyState` to `loadPoligarchPilotSafety` from
 * `./poligarch-safety.server`, and `createOrGetIntent`/`updateIntentStatus`
 * to `createOrGetLivePilotIntent`/`updateLivePilotIntentStatus` below.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { isAllowedPilotSource, POLIGARCH_LIVE_PILOT_ID } from "./poligarch-config";
import {
  mapPoligarchSourceEvent,
  type PoligarchSourceEvent,
} from "./poligarch-market-mapping.server";
import {
  computeLivePilotOrderSize,
  checkSignalAge,
  checkSlippage,
  checkExposureCaps,
  checkDailyLoss,
  checkConsecutiveFailures,
  checkOpenPositions,
  type RiskCheck,
} from "./poligarch-risk-checks";
import type { PilotSafetyState } from "./poligarch-safety-core";

export type RawSourceEvent = PoligarchSourceEvent & {
  id: string;
  experimentId: string;
  experimentName: string;
  wallet: string;
};

export type LivePilotPreviewResult = {
  overall: "PASS" | "FAIL";
  failReason: string | null;
  sourceEvent: RawSourceEvent;
  usMarketSlug: string | null;
  signalAgeSeconds: number | null;
  slippageCheck: RiskCheck | null;
  sizing: { notionalUsd: number; shares: number } | null;
  checks: RiskCheck[];
  intentId: string | null;
};

export type PreviewDeps = {
  mapMarket: typeof mapPoligarchSourceEvent;
  getCurrentBook: (usMarketSlug: string) => Promise<{
    bestBid: number;
    bestAsk: number;
    minimumTradeQty: number;
    tickSize: number;
  }>;
  getPilotSafetyState: () => Promise<PilotSafetyState>;
  getPilotLedgerSnapshot: () => Promise<{
    remainingBankrollUsd: number;
    currentOpenExposureUsd: number;
    todayRealizedPnlUsd: number;
    consecutiveFailedOrders: number;
    openLivePositions: number;
  }>;
  createOrGetIntent: (
    event: RawSourceEvent,
  ) => Promise<{ intentId: string; created: boolean; status: string }>;
  updateIntentStatus: (
    intentId: string,
    status: string,
    fields: Record<string, unknown>,
  ) => Promise<unknown>;
  nowSeconds: () => number;
};

function fail(
  event: RawSourceEvent,
  reason: string,
  partial: Partial<LivePilotPreviewResult> = {},
): LivePilotPreviewResult {
  return {
    overall: "FAIL",
    failReason: reason,
    sourceEvent: event,
    usMarketSlug: null,
    signalAgeSeconds: null,
    slippageCheck: null,
    sizing: null,
    checks: [],
    intentId: null,
    ...partial,
  };
}

/**
 * Never submits an order. Only ever produces a PASS/FAIL preview and, once
 * an intent row exists (sizing rejected, a risk check failed, or full PASS),
 * persists its outcome via the Task 3 RPCs.
 */
export async function previewPoligarchLiveOrder(
  event: RawSourceEvent,
  deps: PreviewDeps,
): Promise<LivePilotPreviewResult> {
  if (!isAllowedPilotSource({ experimentName: event.experimentName, wallet: event.wallet })) {
    return fail(event, "Source experiment/wallet is not on the Poligarch V2 pilot allowlist.");
  }

  const safetyState = await deps.getPilotSafetyState();
  // Task 7's `canEnterPreview` answers a different question than the one
  // this pipeline needs: it gates the one-time ARM transition from "locked"
  // into "preview" (see `enterPreviewStage` in poligarch-safety.server.ts),
  // returning allowed:true only while the pilot is *still* "locked". It is
  // not a "may a preview run happen right now" check, so it isn't reusable
  // here — this pipeline instead needs the opposite condition: the pilot
  // must have ALREADY been armed into "preview" or "live_pilot", with the
  // kill switch off. Fail closed on anything else.
  const previewAllowed =
    !safetyState.killSwitchEngaged &&
    (safetyState.activationStage === "preview" || safetyState.activationStage === "live_pilot");
  if (!previewAllowed) {
    return fail(
      event,
      safetyState.killSwitchEngaged
        ? "Kill switch is engaged."
        : `Activation stage is ${safetyState.activationStage} (locked).`,
    );
  }

  const mapping = await deps.mapMarket(event);
  if (mapping.status === "SKIP") {
    return fail(event, mapping.skipReason ?? "LIVE_MARKET_MAPPING_UNVERIFIED");
  }

  const nowSeconds = deps.nowSeconds();
  const ageCheck = checkSignalAge({ sourceTsSeconds: event.sourceTs, nowSeconds });
  if (!ageCheck.pass) {
    return fail(event, "Signal is stale.", {
      usMarketSlug: mapping.usMarketSlug,
      signalAgeSeconds: nowSeconds - event.sourceTs,
    });
  }

  const book = await deps.getCurrentBook(mapping.usMarketSlug as string);
  const currentPrice = event.side === "BUY" ? book.bestAsk : book.bestBid;
  const slippageCheck = checkSlippage({ sourcePrice: event.price, currentPrice });

  const ledger = await deps.getPilotLedgerSnapshot();
  // Fixed-fraction-of-pilot-bankroll sizing signal: mirrors shadow-core.ts's
  // computeBuySize convention (1% of own cash, $1 floor), re-based onto the
  // pilot's own remaining bankroll rather than the paper-trading bankroll.
  const proportionalNotionalUsd = Math.max(1, ledger.remainingBankrollUsd * 0.01);
  const sizing = computeLivePilotOrderSize({
    proportionalNotionalUsd,
    remainingBankrollUsd: ledger.remainingBankrollUsd,
    remainingExposureUsd: Math.max(
      0,
      safetyState.maxTotalExposureUsd - ledger.currentOpenExposureUsd,
    ),
    price: currentPrice,
    minimumTradeQty: book.minimumTradeQty,
    tickSize: book.tickSize,
  });

  const intent = await deps.createOrGetIntent(event);

  if (!sizing.ok) {
    await deps.updateIntentStatus(intent.intentId, "SKIPPED", { fail_reason: sizing.reason });
    return fail(event, sizing.reason, {
      usMarketSlug: mapping.usMarketSlug,
      signalAgeSeconds: nowSeconds - event.sourceTs,
      slippageCheck,
      intentId: intent.intentId,
    });
  }

  const checks: RiskCheck[] = [
    slippageCheck,
    checkExposureCaps({
      currentOpenExposureUsd: ledger.currentOpenExposureUsd,
      newOrderNotionalUsd: sizing.notionalUsd,
    }),
    checkDailyLoss({ todayRealizedPnlUsd: ledger.todayRealizedPnlUsd }),
    checkConsecutiveFailures({ consecutiveFailedOrders: ledger.consecutiveFailedOrders }),
    checkOpenPositions({ openLivePositions: ledger.openLivePositions }),
  ];

  const failedCheck = checks.find((c) => !c.pass);
  if (failedCheck) {
    await deps.updateIntentStatus(intent.intentId, "SKIPPED", { fail_reason: failedCheck.label });
    return fail(event, failedCheck.label, {
      usMarketSlug: mapping.usMarketSlug,
      signalAgeSeconds: nowSeconds - event.sourceTs,
      slippageCheck,
      sizing: { notionalUsd: sizing.notionalUsd, shares: sizing.shares },
      checks,
      intentId: intent.intentId,
    });
  }

  await deps.updateIntentStatus(intent.intentId, "PREVIEWED", {
    us_market_slug: mapping.usMarketSlug,
    requested_shares: sizing.shares,
    requested_notional_usd: sizing.notionalUsd,
    live_price_snapshot: book,
    safety_checks: checks,
  });

  return {
    overall: "PASS",
    failReason: null,
    sourceEvent: event,
    usMarketSlug: mapping.usMarketSlug,
    signalAgeSeconds: nowSeconds - event.sourceTs,
    slippageCheck,
    sizing: { notionalUsd: sizing.notionalUsd, shares: sizing.shares },
    checks,
    intentId: intent.intentId,
  };
}

/* ------------------------- Task 3 RPC wrappers ------------------------- */

/**
 * Thin wrapper over `create_or_get_live_pilot_intent_atomic` — the only way
 * a Poligarch V2 live-pilot intent row is ever created. Idempotent: replays
 * of the same (experiment, source event) pair return the existing row
 * instead of inserting a second one (see
 * supabase/migrations/20260815121000_poligarch_live_pilot_intent_rpc.sql).
 *
 * These RPCs are hand-written and not yet reflected in the generated
 * Supabase types file's RPC-name union, so both the function name and its
 * args need the same `as never` cast `shadow.server.ts` already uses for
 * `get_pending_experiment_source_events` in the same situation.
 */
export async function createOrGetLivePilotIntent(
  event: RawSourceEvent,
): Promise<{ intentId: string; created: boolean; status: string }> {
  const { data, error } = await supabaseAdmin.rpc(
    "create_or_get_live_pilot_intent_atomic" as never,
    {
      p_pilot_id: POLIGARCH_LIVE_PILOT_ID,
      p_source_experiment_id: event.experimentId,
      p_source_event_id: event.id,
      p_payload: {
        source_event_key: event.id,
        source_wallet: event.wallet,
        source_condition_id: event.conditionId,
        source_asset: event.asset,
        source_side: event.side,
        source_price: event.price,
        source_ts: event.sourceTs,
      },
    } as never,
  );
  if (error) throw new Error(error.message);
  const row = data as unknown as { intent_id: string; created: boolean; status: string };
  return { intentId: row.intent_id, created: row.created, status: row.status };
}

/**
 * Thin wrapper over `update_live_pilot_intent_status_atomic` — the only way
 * a Poligarch V2 live-pilot intent's status ever advances. Every call
 * appends to the row's audit trail rather than overwriting it.
 */
export async function updateLivePilotIntentStatus(
  intentId: string,
  status: string,
  fields: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await supabaseAdmin.rpc(
    "update_live_pilot_intent_status_atomic" as never,
    {
      p_intent_id: intentId,
      p_new_status: status,
      p_fields: fields,
    } as never,
  );
  if (error) throw new Error(error.message);
  return data;
}
