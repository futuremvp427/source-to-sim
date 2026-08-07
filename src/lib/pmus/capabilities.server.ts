/**
 * Authenticated Polymarket US capabilities.
 *
 * Only three operations exist, and each has its own function. There is NO
 * generic authenticated request function callable with an arbitrary method or
 * path. Anything outside the allowlist is rejected BEFORE signer invocation,
 * signature generation, auth-header construction, and HTTP transport.
 */

import { loadPmusCredentials, pmusSecretLiterals, type PmusCredentials } from "./credentials.server";
import { REJECTED_OPERATION_MESSAGE, safeErrorMessage } from "./redact";
import { signRequest } from "./signer.server";

export const PMUS_BASE_URL = "https://api.polymarket.us";

/** The complete set of permitted authenticated operations. */
export const ALLOWED_OPERATIONS = Object.freeze({
  balances: { method: "GET", path: "/v1/account/balances" },
  positions: { method: "GET", path: "/v1/portfolio/positions" },
  orderPreview: { method: "POST", path: "/v1/order/preview" },
} as const);

export type OperationName = keyof typeof ALLOWED_OPERATIONS;

const ALLOWLIST = new Set(
  Object.values(ALLOWED_OPERATIONS).map((op) => `${op.method} ${op.path}`),
);

export class RejectedOperationError extends Error {
  constructor() {
    // Constant message. Never echoes caller-controlled path/URL/query.
    super(REJECTED_OPERATION_MESSAGE);
    this.name = "RejectedOperationError";
  }
}

/**
 * Allowlist gate. Runs first, before any signing or transport.
 * Rejects trailing slashes, query strings, absolute URLs, and unknown paths.
 */
export function isAllowedOperation(method: unknown, path: unknown): boolean {
  if (typeof method !== "string" || typeof path !== "string") return false;
  if (method !== method.toUpperCase()) return false;
  if (!path.startsWith("/")) return false;
  if (path.includes("?") || path.includes("#") || path.includes("//") || path.includes("\\")) {
    return false;
  }
  return ALLOWLIST.has(`${method} ${path}`);
}

export type Transport = (url: string, init: RequestInit) => Promise<Response>;
export type Signer = (
  secretKey: string,
  timestamp: string,
  method: string,
  path: string,
) => Promise<string>;

export type PmusDeps = {
  credentials?: PmusCredentials | null;
  transport?: Transport;
  signer?: Signer;
  now?: () => number;
};

export type PmusResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number | null; error: string };

type InternalRequest = {
  method: string;
  path: string;
  body?: unknown;
};

/**
 * Internal transport. Not exported as part of the module's public surface —
 * only the three capability functions and the test hook can reach it, and it
 * still enforces the allowlist itself as defence in depth.
 */
async function attemptOperation<T>(
  request: InternalRequest,
  deps: PmusDeps = {},
): Promise<PmusResult<T>> {
  // 1. Allowlist gate — before signer, signature, headers, transport.
  if (!isAllowedOperation(request.method, request.path)) {
    return { ok: false, status: null, error: REJECTED_OPERATION_MESSAGE };
  }

  const credentials = deps.credentials ?? loadPmusCredentials();
  const secrets = pmusSecretLiterals(credentials);
  if (!credentials) {
    return { ok: false, status: null, error: "Polymarket US credentials are not configured." };
  }

  const sign = deps.signer ?? signRequest;
  const transport = deps.transport ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? (() => Date.now());

  try {
    // 2. Signature, 3. auth headers, 4. transport — only for allowlisted ops.
    const timestamp = String(now());
    const signature = await sign(credentials.secretKey, timestamp, request.method, request.path);
    const headers: Record<string, string> = {
      "X-PM-Access-Key": credentials.keyId,
      "X-PM-Timestamp": timestamp,
      "X-PM-Signature": signature,
      "Content-Type": "application/json",
    };

    const init: RequestInit = { method: request.method, headers };
    if (request.body !== undefined) init.body = JSON.stringify(request.body);

    const response = await transport(`${PMUS_BASE_URL}${request.path}`, init);
    const text = await response.text();

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: safeErrorMessage(
          `Polymarket US request failed (HTTP ${response.status}): ${text}`,
          secrets,
        ),
      };
    }

    try {
      return { ok: true, data: JSON.parse(text) as T };
    } catch {
      return {
        ok: false,
        status: response.status,
        error: safeErrorMessage(`Polymarket US returned a non-JSON body: ${text}`, secrets),
      };
    }
  } catch (err) {
    return { ok: false, status: null, error: safeErrorMessage(err, secrets) };
  }
}

/* ---------------------------- Capabilities ---------------------------- */

export type PmusBalance = {
  currency?: string;
  currentBalance?: number;
  buyingPower?: number;
  assetNotional?: number;
  openOrders?: number;
  unsettledFunds?: number;
};

export type PmusBalancesResponse = { balances?: PmusBalance[] };

/** GET /v1/account/balances */
export function getBalances(deps: PmusDeps = {}): Promise<PmusResult<PmusBalancesResponse>> {
  const op = ALLOWED_OPERATIONS.balances;
  return attemptOperation<PmusBalancesResponse>({ method: op.method, path: op.path }, deps);
}

export type PmusPositionsResponse = { positions?: unknown[] };

/** GET /v1/portfolio/positions */
export function getPositions(deps: PmusDeps = {}): Promise<PmusResult<PmusPositionsResponse>> {
  const op = ALLOWED_OPERATIONS.positions;
  return attemptOperation<PmusPositionsResponse>({ method: op.method, path: op.path }, deps);
}

export type PmusAmount = { value?: string; currency?: string };

export type PmusPreviewOrderInput = {
  marketSlug: string;
  outcomeSide: "OUTCOME_SIDE_YES" | "OUTCOME_SIDE_NO";
  action: "ORDER_ACTION_BUY" | "ORDER_ACTION_SELL";
  quantity: number;
  limitPrice: number;
};

export type PmusPreviewOrderResponse = {
  order?: {
    id?: string;
    marketSlug?: string;
    quantity?: number;
    price?: PmusAmount;
    avgPx?: PmusAmount;
    cashOrderQty?: PmusAmount;
    state?: string;
    action?: string;
    outcomeSide?: string;
  };
};

/**
 * POST /v1/order/preview — validation/pricing only. This never creates,
 * submits, modifies, cancels, or closes anything.
 */
export function previewOrder(
  input: PmusPreviewOrderInput,
  deps: PmusDeps = {},
): Promise<PmusResult<PmusPreviewOrderResponse>> {
  const op = ALLOWED_OPERATIONS.orderPreview;
  const body = {
    request: {
      marketSlug: input.marketSlug,
      type: "ORDER_TYPE_LIMIT",
      price: { value: input.limitPrice.toFixed(3), currency: "USD" },
      quantity: input.quantity,
      tif: "TIME_IN_FORCE_GOOD_TILL_CANCEL",
      outcomeSide: input.outcomeSide,
      action: input.action,
      manualOrderIndicator: "MANUAL_ORDER_INDICATOR_AUTOMATIC",
    },
  };
  return attemptOperation<PmusPreviewOrderResponse>(
    { method: op.method, path: op.path, body },
    deps,
  );
}

/**
 * Test-only hook. Lets the regression suite prove that non-allowlisted
 * operations never reach the signer or the transport. Not used by app code.
 */
export const __testOnly = { attemptOperation };