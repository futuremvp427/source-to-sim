/**
 * Poligarch V2 live-pilot order submission.
 *
 * DELIBERATELY UNREACHABLE. Nothing in src/routes, src/components, or any
 * other live-pilot module (config, market-mapping, risk-checks, safety-core,
 * safety.server, safety.functions, preview.server) imports this file. It
 * exists so the real order-submission code path is fully implemented and
 * tested ahead of a future human-reviewed decision to wire it in — it is not
 * meant to run.
 *
 * Every exported function checks POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED
 * FIRST, unconditionally, before any DB read, any credential load, any
 * signing, or any network call — even if the database safety state is
 * somehow fully armed.
 *
 * This module intentionally does NOT import from
 * src/lib/pmus/capabilities.server.ts. That module's ALLOWED_OPERATIONS
 * allowlist stays scoped to the three read/preview-only operations it has
 * always had (balances, positions, order preview) and is never touched by
 * this task. This module defines its own, separate, narrowly-scoped
 * allowlist for the three write operations (submit, cancel, status lookup)
 * that capabilities.server.ts deliberately does not support. Only the pure
 * signing and credential-loading utilities (`signRequest`,
 * `loadPmusCredentials`, `isPmusConfigured`) are reused from the pmus
 * module — verbatim, not reimplemented.
 */

import { signRequest } from "../pmus/signer.server";
import { loadPmusCredentials, isPmusConfigured } from "../pmus/credentials.server";
import { isAllowedPilotSource } from "./poligarch-config";
import {
  POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED,
  isSubmissionReachable,
  type PilotSafetyState,
} from "./poligarch-safety-core";

// Clean single re-export of the hard constant (imported once above for local
// use, then re-exported as the same binding) — not a duplicate import from
// two statements, and not a dummy local const standing in for it.
export { POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED };

export type SubmissionResult =
  | { ok: true; orderId: string; raw: unknown }
  | { ok: false; error: string };

export type SubmissionDeps = {
  getPilotSafetyState: () => Promise<PilotSafetyState>;
  fetchImpl: typeof fetch;
  now: () => number;
};

const PMUS_LIVE_ORDERS_HOST = "https://api.polymarket.us";

/**
 * Isolated allowlist for this module only. Deliberately NOT imported from,
 * and does NOT extend, src/lib/pmus/capabilities.server.ts's
 * ALLOWED_OPERATIONS — that allowlist remains read/preview-only and
 * untouched. Mirrors the same defensive checks as that module's
 * `isAllowedOperation` (reviewed, not imported): rejects non-uppercase
 * methods, relative/empty paths, path traversal via `//`, trailing
 * slashes, query strings, fragments, and backslashes.
 */
export function isAllowedLivePilotOperation(method: unknown, path: unknown): boolean {
  if (typeof method !== "string" || typeof path !== "string") return false;
  if (method !== method.toUpperCase()) return false;
  if (!path.startsWith("/")) return false;
  if (path.includes("?") || path.includes("#") || path.includes("//") || path.includes("\\")) {
    return false;
  }
  if (path.endsWith("/")) return false;

  if (method === "POST" && path === "/v1/orders") return true;
  if (method === "POST" && /^\/v1\/order\/[^/]+\/cancel$/.test(path)) return true;
  if (method === "GET" && /^\/v1\/order\/[^/]+$/.test(path)) return true;
  return false;
}

/**
 * Order-scoped identity + notional guard, deliberately extracted as a small
 * pure function so it is directly unit-testable in isolation. This is the
 * ONLY place in this module where the wallet/experiment allowlist and the
 * DB-configured per-order notional cap are re-checked against the specific
 * order being submitted — everything else in this module (the hard
 * POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED constant, isSubmissionReachable,
 * isAllowedLivePilotOperation) validates the *system's* state, not *this
 * order's* identity/size.
 *
 * Defense-in-depth: today the only caller of submitPoligarchLiveOrder is
 * runPreviewPipeline (poligarch-preview.server.ts), which already enforces
 * isAllowedPilotSource and per-order sizing/exposure caps before ever
 * reaching submission. But this module's own safety story should not
 * depend entirely on always being invoked correctly by something else — if
 * a future caller ever wires submission without routing through preview
 * first, this check is what stops a wrong-wallet/wrong-experiment order or
 * an over-cap notional from ever reaching the signer.
 */
export function checkPilotOrderAllowlistAndNotional(
  pilotSource: { experimentName: string; wallet: string; notionalUsd: number },
  maxOrderNotionalUsd: number,
): { ok: true } | { ok: false; error: string } {
  if (
    !isAllowedPilotSource({
      experimentName: pilotSource.experimentName,
      wallet: pilotSource.wallet,
    })
  ) {
    return {
      ok: false,
      error: `PILOT_SOURCE_NOT_ALLOWLISTED: ${pilotSource.experimentName} / ${pilotSource.wallet} is not the allowlisted Poligarch V2 experiment/wallet.`,
    };
  }
  if (!(pilotSource.notionalUsd <= maxOrderNotionalUsd)) {
    return {
      ok: false,
      error: `NOTIONAL_EXCEEDS_CAP: order notional $${pilotSource.notionalUsd} exceeds the DB-configured per-order cap $${maxOrderNotionalUsd}.`,
    };
  }
  return { ok: true };
}

async function attemptLivePilotOperation(
  method: string,
  path: string,
  body: unknown,
  deps: SubmissionDeps,
  pilotSource?: { experimentName: string; wallet: string; notionalUsd: number },
): Promise<SubmissionResult> {
  // 1. Hard constant gate. Runs before literally anything else — no DB read,
  //    no credential load, no signing, no fetch — even if every other input
  //    to this function is fully armed.
  if (!POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED) {
    return {
      ok: false,
      error: "SUBMISSION_NOT_ENABLED: POLIGARCH_LIVE_PILOT_SUBMISSION_ENABLED is false.",
    };
  }

  // 2. Database safety-state gate.
  const state = await deps.getPilotSafetyState();
  const reachability = isSubmissionReachable(state);
  if (!reachability.reachable) {
    return { ok: false, error: `SAFETY_STATE_BLOCKED: ${reachability.reasons.join("; ")}` };
  }

  // 3. Isolated allowlist gate — before signer, signature, headers, transport.
  if (!isAllowedLivePilotOperation(method, path)) {
    return { ok: false, error: `OPERATION_NOT_ALLOWLISTED: ${method} ${path}` };
  }

  // 3.5. Order-scoped identity + notional guard (submit only — cancel/status
  // act on an order that already passed this check at submit time). Defense
  // in depth: see checkPilotOrderAllowlistAndNotional's docstring above.
  if (pilotSource) {
    const guard = checkPilotOrderAllowlistAndNotional(pilotSource, state.maxOrderNotionalUsd);
    if (!guard.ok) return { ok: false, error: guard.error };
  }

  // 4. Credentials.
  if (!isPmusConfigured()) {
    return { ok: false, error: "MISSING_CREDENTIALS" };
  }
  const credentials = loadPmusCredentials();
  if (!credentials) {
    return { ok: false, error: "MISSING_CREDENTIALS" };
  }

  // 5. Signing, then transport.
  const timestamp = String(deps.now());
  const signature = await signRequest(credentials.secretKey, timestamp, method, path);

  const init: RequestInit = {
    method,
    headers: {
      "X-PM-Access-Key": credentials.keyId,
      "X-PM-Timestamp": timestamp,
      "X-PM-Signature": signature,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const response = await deps.fetchImpl(`${PMUS_LIVE_ORDERS_HOST}${path}`, init);

  if (!response.ok) {
    return { ok: false, error: `${path} responded ${response.status}` };
  }

  const raw = (await response.json()) as { id?: string };
  if (!raw || typeof raw.id !== "string") {
    return { ok: false, error: `${path} returned a response without an order id` };
  }
  return { ok: true, orderId: raw.id, raw };
}

export type PoligarchLiveOrderIntent = {
  usMarketSlug: string;
  side: "BUY" | "SELL";
  limitPrice: number;
  shares: number;
  /** Real outcome side of the copied position (YES/NO) — determines which
   * side of the market this order trades. Must NEVER be hardcoded: a
   * copied NO position submitted as a YES order is the opposite side of
   * the market. */
  outcome: "YES" | "NO";
  /**
   * Polymarket US `orderPriceMinTickSize` for this market (e.g. 0.005).
   * Optional because not every caller may have it on hand yet; defaults to
   * the coarsest plausible tick (0.01) rather than silently sending an
   * unrounded price. Once a real caller threads the market's actual tick
   * through (from `getCurrentBook`'s `tickSize` in the preview pipeline),
   * this default is never exercised.
   */
  priceTick?: number;
  /** Owning experiment/wallet — re-checked against the allowlist at
   * submission time (defense-in-depth; see checkPilotOrderAllowlistAndNotional). */
  experimentName: string;
  wallet: string;
  /** This order's own computed USD notional — re-checked against the
   * DB-configured per-order cap at submission time (defense-in-depth). */
  notionalUsd: number;
};

const DEFAULT_PRICE_TICK = 0.01;

/**
 * Rounds a limit price to the platform's actual price tick, e.g.
 * roundToPriceTick(0.517, 0.005) -> 0.515. A blind `.toFixed(2)` cannot
 * represent a 0.005 tick and can silently push the price past the slippage
 * bound already validated upstream in the preview pipeline.
 */
export function roundToPriceTick(price: number, tick: number): number {
  return Math.round(price / tick) * tick;
}

/**
 * Formats a tick-rounded price with enough decimal places to represent the
 * tick exactly (e.g. tick 0.005 needs 3 decimals, not `.toFixed(2)`'s 2).
 */
export function formatPriceForTick(price: number, tick: number): string {
  const tickDecimals = (tick.toString().split(".")[1] ?? "").length;
  const decimals = Math.max(2, tickDecimals);
  return price.toFixed(decimals);
}

/** POST /v1/orders. Gated per attemptLivePilotOperation's fail-closed order. */
export function submitPoligarchLiveOrder(
  order: PoligarchLiveOrderIntent,
  deps: SubmissionDeps,
): Promise<SubmissionResult> {
  const priceTick = order.priceTick ?? DEFAULT_PRICE_TICK;
  const roundedPrice = roundToPriceTick(order.limitPrice, priceTick);
  return attemptLivePilotOperation(
    "POST",
    "/v1/orders",
    {
      marketSlug: order.usMarketSlug,
      type: "ORDER_TYPE_LIMIT",
      price: { value: formatPriceForTick(roundedPrice, priceTick), currency: "USD" },
      quantity: order.shares,
      outcomeSide: order.outcome,
      action: order.side,
      tif: "IMMEDIATE_OR_CANCEL",
      synchronousExecution: true,
    },
    deps,
    {
      experimentName: order.experimentName,
      wallet: order.wallet,
      notionalUsd: order.notionalUsd,
    },
  );
}

/** POST /v1/order/{orderId}/cancel. Gated per attemptLivePilotOperation's fail-closed order. */
export function cancelPoligarchLiveOrder(
  orderId: string,
  deps: SubmissionDeps,
): Promise<SubmissionResult> {
  return attemptLivePilotOperation("POST", `/v1/order/${orderId}/cancel`, undefined, deps);
}

/** GET /v1/order/{orderId}. Gated per attemptLivePilotOperation's fail-closed order. */
export function getPoligarchLiveOrderStatus(
  orderId: string,
  deps: SubmissionDeps,
): Promise<SubmissionResult> {
  return attemptLivePilotOperation("GET", `/v1/order/${orderId}`, undefined, deps);
}
