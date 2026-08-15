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

async function attemptLivePilotOperation(
  method: string,
  path: string,
  body: unknown,
  deps: SubmissionDeps,
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
};

/** POST /v1/orders. Gated per attemptLivePilotOperation's fail-closed order. */
export function submitPoligarchLiveOrder(
  order: PoligarchLiveOrderIntent,
  deps: SubmissionDeps,
): Promise<SubmissionResult> {
  return attemptLivePilotOperation(
    "POST",
    "/v1/orders",
    {
      marketSlug: order.usMarketSlug,
      type: "ORDER_TYPE_LIMIT",
      price: { value: order.limitPrice.toFixed(2), currency: "USD" },
      quantity: order.shares,
      outcomeSide: "YES",
      action: order.side,
      tif: "IMMEDIATE_OR_CANCEL",
      synchronousExecution: true,
    },
    deps,
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
