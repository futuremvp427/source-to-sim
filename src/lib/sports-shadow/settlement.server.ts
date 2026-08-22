/**
 * FINAL BUILD Part 15: settlement engine — SERVER (network) layer.
 *
 * Determines FINAL exchange settlement for one venue's market, from the exchange's own
 * authoritative resolution state — never inferred from sports scores. Both venues'
 * live response shapes below were confirmed against REAL, already-resolved markets
 * (2026-08-22), not assumed from documentation alone:
 *
 * PM-US: `GET /v1/markets?slug={slug}` returns `{markets:[{status, marketSides:
 * [{long, price, ...}]}]}`. A resolved market has `status === "MARKET_STATUS_RESOLVED"`
 * and each `marketSides[i].price` is the FINAL settlement price for that side directly
 * ("1" or "0") -- no separate `outcomePrices`-to-`marketSides` index correlation needed.
 *
 * Kalshi: `GET /markets/{ticker}` returns `{market: {status, result,
 * settlement_value_dollars, settlement_ts}}`. A resolved market has
 * `status === "finalized"` and `result` is `"yes"` or `"no"`.
 *
 * Neither venue's "void"/cancelled exact string value was observed live (no such
 * market was found in this session's live sample) -- this module fails safe: any
 * result value other than the two confirmed live values is classified VOID rather than
 * guessed as a win or loss.
 */

import { PMUS_PUBLIC_BASE } from "../pmus/us-markets.server";
import { KALSHI_BASE_URL } from "./kalshi.server";
import { runtimeFetch } from "./runtime-fetch.server";

export type SettlementStatus = "PENDING" | "SETTLED_WIN" | "SETTLED_LOSS" | "SETTLED_PUSH" | "VOID" | "CANCELED";

export type SettlementCheckResult = {
  status: SettlementStatus;
  settlementValue: number | null;
  settlementTimestampMs: number | null;
  settlementSource: string;
};

const SETTLEMENT_TIMEOUT_MS = 10_000;

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SETTLEMENT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const PENDING: SettlementCheckResult = { status: "PENDING", settlementValue: null, settlementTimestampMs: null, settlementSource: "not yet resolved" };

export async function checkPmusSettlement(marketSlug: string, ourOrientation: "LONG" | "SHORT", fetchImpl: typeof fetch = runtimeFetch): Promise<SettlementCheckResult> {
  const json = (await fetchJson(`${PMUS_PUBLIC_BASE}/v1/markets?slug=${encodeURIComponent(marketSlug)}`, fetchImpl)) as {
    markets?: { status?: string; marketSides?: { long?: boolean | null; price?: string | number | null }[] }[];
  };
  const market = json.markets?.[0];
  if (!market || market.status !== "MARKET_STATUS_RESOLVED") return PENDING;

  const sides = market.marketSides ?? [];
  const ourSide = sides.find((s) => s.long === (ourOrientation === "LONG"));
  if (!ourSide) {
    return { status: "VOID", settlementValue: null, settlementTimestampMs: Date.now(), settlementSource: "PMUS market resolved but our orientation was not found among marketSides" };
  }
  const value = Number(ourSide.price);
  if (!Number.isFinite(value)) {
    return { status: "VOID", settlementValue: null, settlementTimestampMs: Date.now(), settlementSource: "PMUS market resolved but marketSides.price was not a valid number" };
  }
  const status: SettlementStatus = value >= 0.99 ? "SETTLED_WIN" : value <= 0.01 ? "SETTLED_LOSS" : "SETTLED_PUSH";
  return { status, settlementValue: value, settlementTimestampMs: Date.now(), settlementSource: "PMUS market status: MARKET_STATUS_RESOLVED" };
}

export async function checkKalshiSettlement(ticker: string, ourSide: "YES" | "NO", fetchImpl: typeof fetch = runtimeFetch): Promise<SettlementCheckResult> {
  const json = (await fetchJson(`${KALSHI_BASE_URL}/markets/${encodeURIComponent(ticker)}`, fetchImpl)) as {
    market?: { status?: string; result?: string; settlement_value_dollars?: string | number; settlement_ts?: string };
  };
  const market = json.market;
  if (!market || market.status !== "finalized") return PENDING;

  const settlementTimestampMs = market.settlement_ts ? Date.parse(market.settlement_ts) : Date.now();
  if (market.result !== "yes" && market.result !== "no") {
    return { status: "VOID", settlementValue: null, settlementTimestampMs, settlementSource: "Kalshi market status: finalized (unrecognized result value)" };
  }
  const won = market.result === ourSide.toLowerCase();
  const rawValue = Number(market.settlement_value_dollars);
  return {
    status: won ? "SETTLED_WIN" : "SETTLED_LOSS",
    settlementValue: Number.isFinite(rawValue) ? rawValue : null,
    settlementTimestampMs,
    settlementSource: "Kalshi market status: finalized",
  };
}
