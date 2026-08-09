/**
 * Settlement / resolution automation for the SHADOW paper book.
 *
 * Only a VERIFIED public resolution may close a paper position. CLOB winner
 * flags are primary evidence; when a closed CLOB market omits a usable winner
 * flag, a fail-closed official Gamma fallback may verify an exact terminal 1/0
 * outcome mapped to the same CLOB token IDs. Settlement accounting is applied
 * by one PostgreSQL RPC transaction.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { fetchAllRows } from "./db-pagination";
import {
  decideResolution,
  decideResolutionWithGammaFallback,
  selectSettlementBatch,
  SETTLEMENT_BATCH_SIZE,
  type GammaResolutionEvidence,
  type PublicMarketResolution,
} from "./settlement-core";
import { raiseAlert } from "./shadow.server";

const CLOB_API = "https://clob.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";
const MAX_POSITIONS_PER_PASS = SETTLEMENT_BATCH_SIZE;
const RESOLUTION_TIMEOUT_MS = 10_000;
const MAX_LOOKUP_ATTEMPTS = 3;

/** Safe, non-sensitive failure classification for a public resolution lookup. */
export type LookupFailure = {
  type: "HTTP" | "TIMEOUT" | "NETWORK_ERROR" | "INVALID_JSON" | "INVALID_RESPONSE_SHAPE";
  status?: number;
  attempts: number;
  elapsedMs: number;
  /** Short, truncated, non-sensitive summary — public market data only. */
  summary: string;
};

export function failureLabel(f: Pick<LookupFailure, "type" | "status">): string {
  return f.type === "HTTP" ? `HTTP_${f.status ?? 0}` : f.type;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function backoffMs(attempt: number): number {
  const base = attempt === 1 ? 250 : 750;
  return base + Math.random() * base;
}

function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5_000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), 5_000);
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type SettlementPassResult = {
  settled: number;
  unresolved: number;
  failed: number;
  batchIndex: number;
  batchCount: number;
  failuresByType: Record<string, number>;
  details: { asset: string; marketTitle: string | null; status: string }[];
};

type LookupResult =
  | { ok: true; market: PublicMarketResolution; attempts: number }
  | { ok: false; failure: LookupFailure };

async function attemptLookup(
  conditionId: string,
): Promise<
  | { ok: true; market: PublicMarketResolution }
  | { ok: false; type: LookupFailure["type"]; status?: number; summary: string; retryAfter?: number | null }
> {
  let res: Response;
  try {
    res = await fetch(`${CLOB_API}/markets/${conditionId}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(RESOLUTION_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const timeout = name === "TimeoutError" || name === "AbortError";
    return {
      ok: false,
      type: timeout ? "TIMEOUT" : "NETWORK_ERROR",
      summary: timeout ? `no response within ${RESOLUTION_TIMEOUT_MS}ms` : `fetch failed (${name || "unknown"})`,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      type: "HTTP",
      status: res.status,
      summary: `public CLOB responded ${res.status}`,
      retryAfter: retryAfterMs(res.headers.get("retry-after")),
    };
  }

  let body: { closed?: boolean; tokens?: { token_id?: string; outcome?: string; winner?: boolean }[] };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, type: "INVALID_JSON", status: res.status, summary: "response body was not JSON" };
  }

  if (typeof body.closed !== "boolean" || !Array.isArray(body.tokens)) {
    return {
      ok: false,
      type: "INVALID_RESPONSE_SHAPE",
      status: res.status,
      summary: `missing closed/tokens (closed=${typeof body.closed}, tokens=${Array.isArray(body.tokens)})`,
    };
  }

  return {
    ok: true,
    market: {
      closed: body.closed,
      tokens: body.tokens.map((t) => ({
        tokenId: String(t.token_id ?? ""),
        outcome: t.outcome ?? null,
        winner: t.winner === true,
      })),
    },
  };
}

/** Public CLOB resolution lookup with bounded transient retries. */
async function fetchMarketResolution(conditionId: string): Promise<LookupResult> {
  const startedAt = Date.now();
  let last: Awaited<ReturnType<typeof attemptLookup>> | null = null;
  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= MAX_LOOKUP_ATTEMPTS; attempt += 1) {
    const outcome = await attemptLookup(conditionId);
    attemptsUsed = attempt;
    if (outcome.ok) return { ok: true, market: outcome.market, attempts: attempt };
    last = outcome;

    const retryable =
      outcome.type === "TIMEOUT" ||
      outcome.type === "NETWORK_ERROR" ||
      (outcome.type === "HTTP" && RETRYABLE_STATUS.has(outcome.status ?? 0));
    if (!retryable || attempt === MAX_LOOKUP_ATTEMPTS) break;
    await sleep(outcome.retryAfter ?? backoffMs(attempt));
  }

  const failure = last as Exclude<Awaited<ReturnType<typeof attemptLookup>>, { ok: true }>;
  return {
    ok: false,
    failure: {
      type: failure.type,
      ...(failure.status === undefined ? {} : { status: failure.status }),
      attempts: attemptsUsed,
      elapsedMs: Date.now() - startedAt,
      summary: failure.summary.slice(0, 200),
    },
  };
}

function parseStringArray(value: unknown): string[] | null {
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((v) => typeof v === "string") ? parsed : null;
  } catch {
    return null;
  }
}

function parseNumberArray(value: unknown): number[] | null {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : null;
  if (!Array.isArray(raw)) return null;
  const numbers = raw.map((v) => Number(v));
  return numbers.every((v) => Number.isFinite(v)) ? numbers : null;
}

/**
 * Official Gamma fallback for a CLOB market that is closed but has no usable
 * winner flag. It is evidence-only: failure/ambiguity simply leaves the paper
 * position OPEN.
 */
async function fetchGammaResolution(conditionId: string): Promise<GammaResolutionEvidence | null> {
  let res: Response;
  try {
    const params = new URLSearchParams({ condition_ids: conditionId, closed: "true", limit: "2" });
    res = await fetch(`${GAMMA_API}/markets?${params}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(RESOLUTION_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (!Array.isArray(body)) return null;

  const exact = body.filter((row): row is Record<string, unknown> => {
    if (!row || typeof row !== "object") return false;
    return String((row as Record<string, unknown>)["conditionId"] ?? "").toLowerCase() === conditionId.toLowerCase();
  });
  if (exact.length !== 1) return null;

  const market = exact[0]!;
  const outcomes = parseStringArray(market["outcomes"]);
  const outcomePrices = parseNumberArray(market["outcomePrices"]);
  const clobTokenIds = parseStringArray(market["clobTokenIds"]);
  if (!outcomes || !outcomePrices || !clobTokenIds) return null;

  return {
    closed: market["closed"] === true,
    conditionId,
    outcomes,
    outcomePrices,
    clobTokenIds,
  };
}

type SettlementRpcRow = {
  applied: boolean;
  payout: number | string;
  realized_pnl: number | string;
};

type RpcResult = { data: unknown; error: { message: string } | null };

async function applyVerifiedSettlementRpc(args: Record<string, unknown>): Promise<RpcResult> {
  const client = supabaseAdmin as unknown as {
    rpc: (name: string, params: Record<string, unknown>) => Promise<RpcResult>;
  };
  return client.rpc("apply_verified_paper_settlement", args);
}

export async function runSettlementPass(
  experimentId: string,
  cycleIndex: number = Math.floor(Date.now() / 60_000),
): Promise<SettlementPassResult> {
  const result: SettlementPassResult = {
    settled: 0,
    unresolved: 0,
    failed: 0,
    batchIndex: 0,
    batchCount: 0,
    failuresByType: {},
    details: [],
  };

  const openBook = await fetchAllRows(async (from, to) => {
    const { data, error } = await supabaseAdmin
      .from("paper_positions")
      .select("asset, market_title, outcome, shares, cost_basis, realized_pnl")
      .eq("experiment_id", experimentId)
      .eq("settlement_status", "open")
      .gt("shares", 0)
      .order("asset", { ascending: true })
      .range(from, to);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

  const batch = selectSettlementBatch(openBook.rows.length, cycleIndex, MAX_POSITIONS_PER_PASS);
  result.batchIndex = batch.batchIndex;
  result.batchCount = batch.batchCount;
  if (batch.size <= 0) return result;

  const positions = openBook.rows.slice(batch.offset, batch.offset + batch.size);
  if (positions.length === 0) return result;

  const assets = positions.map((p) => p.asset);
  const { data: eventRows, error: eventsError } = await supabaseAdmin
    .from("source_events")
    .select("asset, condition_id")
    .in("asset", assets);
  if (eventsError) throw new Error(eventsError.message);
  const conditionByAsset = new Map<string, string>();
  for (const row of eventRows ?? []) {
    if (row.condition_id && !conditionByAsset.has(row.asset)) conditionByAsset.set(row.asset, row.condition_id);
  }

  for (const position of positions) {
    const conditionId = conditionByAsset.get(position.asset);
    if (!conditionId) {
      result.unresolved += 1;
      result.details.push({ asset: position.asset, marketTitle: position.market_title, status: "No condition id on record — left OPEN" });
      continue;
    }

    let lookup: LookupResult;
    try {
      lookup = await fetchMarketResolution(conditionId);
    } catch (err) {
      lookup = {
        ok: false,
        failure: {
          type: "NETWORK_ERROR",
          attempts: 1,
          elapsedMs: 0,
          summary: (err instanceof Error ? err.message : "unknown lookup error").slice(0, 200),
        },
      };
    }
    if (!lookup.ok) {
      const label = failureLabel(lookup.failure);
      result.failed += 1;
      result.failuresByType[label] = (result.failuresByType[label] ?? 0) + 1;
      result.details.push({
        asset: position.asset,
        marketTitle: position.market_title,
        status: `Public resolution lookup failed — left OPEN (${label}, ${lookup.failure.attempts} attempt(s), ${lookup.failure.elapsedMs}ms: ${lookup.failure.summary})`,
      });
      continue;
    }

    const market = lookup.market;
    let decision = decideResolution(position.asset, market);
    let gammaEvidence: GammaResolutionEvidence | null = null;
    let resolutionSource = "polymarket_public_clob_market";

    if (!decision.verified && market.closed && decision.reason.startsWith("Unconfirmed resolution")) {
      gammaEvidence = await fetchGammaResolution(conditionId);
      decision = decideResolutionWithGammaFallback(position.asset, market, gammaEvidence);
      if (decision.verified) resolutionSource = "polymarket_public_clob_plus_gamma_terminal_prices";
    }

    if (!decision.verified) {
      result.unresolved += 1;
      result.details.push({ asset: position.asset, marketTitle: position.market_title, status: decision.reason });
      continue;
    }

    const resolutionTs = new Date().toISOString();
    const { data: rpcData, error: rpcError } = await applyVerifiedSettlementRpc({
      p_experiment_id: experimentId,
      p_asset: position.asset,
      p_condition_id: conditionId,
      p_resolution_outcome: decision.won ? "WON" : "LOST",
      p_resolution_source: resolutionSource,
      p_resolution_ts: resolutionTs,
      p_payout_per_share: decision.payoutPerShare,
      p_evidence: {
        condition_id: conditionId,
        clob: { closed: market.closed, tokens: market.tokens },
        gamma: gammaEvidence,
      },
    });

    if (rpcError) {
      result.failed += 1;
      result.details.push({ asset: position.asset, marketTitle: position.market_title, status: `Atomic settlement failed — left OPEN (${rpcError.message})` });
      continue;
    }

    const rpcRow = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as SettlementRpcRow | null;
    if (!rpcRow?.applied) {
      result.unresolved += 1;
      result.details.push({ asset: position.asset, marketTitle: position.market_title, status: "Already settled or position no longer open" });
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

  if (result.failed > 0) {
    const bucket = new Date().toISOString().slice(0, 13);
    const breakdown = Object.entries(result.failuresByType)
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => `${label}: ${count}`)
      .join(", ");
    await raiseAlert(
      "warn",
      "settlement_lookups_failed",
      `Settlement pass had ${result.failed} failed public resolution lookup(s) (batch ${batch.batchIndex + 1}/${batch.batchCount}) — ${breakdown}.`,
      { experiment_id: experimentId as never, failed: result.failed as never, failures_by_type: result.failuresByType as never },
      `settlement_lookups_failed:${experimentId}:${bucket}`,
    );
  }

  return result;
}
