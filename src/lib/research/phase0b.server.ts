/**
 * SERVER-ONLY: Phase 0B orchestrator. Assembles Part 1 (wallet behavior),
 * Part 2 (public-baseline comparison), and Part 3 (incremental value) into
 * one report, for all five weather wallets.
 *
 * ****************************************************************
 * NOT EXECUTED IN THIS ENVIRONMENT -- see wallet-behavior.server.ts and
 * open-meteo-baseline.server.ts's doc comments for why (no DB credentials,
 * no outbound network access). This file is unit-tested only at the type
 * level; running it requires a session with both.
 * ****************************************************************
 *
 * Read-only throughout. Nothing here writes to any table, changes sizing,
 * changes bankrolls, or converts MERGE/SPLIT/REDEEM into an accounting exit.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { fetchAllRowsAfterId } from "../db-pagination";
import { fetchHistoricalForecast } from "./open-meteo-baseline.server";
import { convertTemperature, deriveBaselineProbability } from "./open-meteo-baseline";
import {
  compareIncrementalValue,
  type IncrementalValueResult,
  type Observation,
} from "./signal-evaluation";
import { analyzeWallet, type WalletAnalysis } from "./wallet-behavior.server";
import { parseWeatherMarket } from "./weather-market-parser";

/** The five weather wallets, by handle -> address (see v2-cohort.ts / v3-cohort.ts). */
export const WEATHER_WALLETS: Readonly<Record<string, string>> = {
  "badatmath.": "0x8fbd7cf5f806f563080864694415829f7229a959",
  Poligarch: "0xb40e89677d59665d5188541ad860450a6e2a7cc9",
  gghff: "0x044f334595a7fd42c143e11c8ec47f23c8d1d1f1",
  "Weather-Guru": "0xb6fbce093cdd139858c44148a6598d8ec028c038",
  HighTempTation: "0x6011655c4afb76f36dd1b08a137a1ba73466b31e",
};

type SettlementRow = {
  id: string;
  condition_id: string | null;
  resolution_outcome: string;
  resolution_ts: string | null;
};

/**
 * Settled markets already in OUR tape (paper_settlements), keyed by
 * condition_id, across ALL enabled V2/V3 experiments -- not a fresh
 * Polymarket pull. A market can appear once per experiment that copied it;
 * this returns the first (any) settlement seen per condition_id, since the
 * resolution itself does not depend on which experiment copied it.
 */
async function loadSettledConditionOutcomes(): Promise<
  Map<string, { outcome: "YES" | "NO"; resolutionTs: number | null }>
> {
  const { rows } = await fetchAllRowsAfterId<SettlementRow>(async (afterId, limit) => {
    let query = supabaseAdmin
      .from("paper_settlements")
      .select("id, condition_id, resolution_outcome, resolution_ts")
      .not("condition_id", "is", null);
    if (afterId !== null) query = query.gt("id", afterId);
    const { data, error } = await query.order("id", { ascending: true }).limit(limit);
    if (error) throw new Error(error.message);
    return (data ?? []) as SettlementRow[];
  });
  const map = new Map<string, { outcome: "YES" | "NO"; resolutionTs: number | null }>();
  for (const r of rows) {
    if (!r.condition_id) continue;
    const outcome = r.resolution_outcome.toUpperCase();
    if (outcome !== "YES" && outcome !== "NO") continue; // fail closed on an unrecognized outcome label
    if (map.has(r.condition_id)) continue; // first settlement seen wins; resolution is market-level, not experiment-level
    map.set(r.condition_id, {
      outcome,
      resolutionTs: r.resolution_ts ? Math.floor(Date.parse(r.resolution_ts) / 1000) : null,
    });
  }
  return map;
}

type SourceEventForBaseline = {
  id: string;
  condition_id: string | null;
  market_title: string;
  slug: string | null;
  outcome: string | null;
  side: string;
  price: number;
  source_ts: number;
};

async function loadWalletBuyEvents(wallet: string): Promise<SourceEventForBaseline[]> {
  const { rows } = await fetchAllRowsAfterId<SourceEventForBaseline>(async (afterId, limit) => {
    let query = supabaseAdmin
      .from("source_events")
      .select("id, condition_id, market_title, slug, outcome, side, price, source_ts")
      .eq("wallet", wallet.toLowerCase())
      .eq("side", "BUY");
    if (afterId !== null) query = query.gt("id", afterId);
    const { data, error } = await query.order("id", { ascending: true }).limit(limit);
    if (error) throw new Error(error.message);
    return (data ?? []) as SourceEventForBaseline[];
  });
  return rows;
}

export type EligibleTradeRecord = {
  wallet: string;
  handle: string;
  conditionId: string;
  city: string;
  date: string;
  sourceTs: number;
  outcomeBought: "YES" | "NO";
  entryPrice: number;
  /** Implied P(YES) from the wallet's own entry price (see module doc for orientation). */
  walletImpliedProbYes: number;
  baselineProbYes: number;
  realizedYes: boolean;
  /** wallet's implied P(YES) minus the public baseline's P(YES) at the same timestamp. */
  baselineRelativeEdge: number;
};

export type Part2Result = {
  eligibleTrades: EligibleTradeRecord[];
  excludedCounts: {
    noSettlement: number;
    unparsedMarket: number;
    forecastUnavailableOrIneligible: number;
    unrecognizedOutcome: number;
  };
};

/**
 * Part 2: for one wallet, join its BUY events against our own settled
 * markets, parse city/date/threshold, fetch a no-lookahead baseline, and
 * compute the wallet's implied edge relative to that baseline.
 */
export async function buildPart2ForWallet(handle: string, wallet: string): Promise<Part2Result> {
  const [events, settlements] = await Promise.all([
    loadWalletBuyEvents(wallet),
    loadSettledConditionOutcomes(),
  ]);
  const eligibleTrades: EligibleTradeRecord[] = [];
  const excludedCounts = {
    noSettlement: 0,
    unparsedMarket: 0,
    forecastUnavailableOrIneligible: 0,
    unrecognizedOutcome: 0,
  };

  for (const event of events) {
    if (!event.condition_id) {
      excludedCounts.noSettlement += 1;
      continue;
    }
    const settlement = settlements.get(event.condition_id);
    if (!settlement) {
      excludedCounts.noSettlement += 1;
      continue;
    }
    const outcomeBought = (event.outcome ?? "").toUpperCase();
    if (outcomeBought !== "YES" && outcomeBought !== "NO") {
      excludedCounts.unrecognizedOutcome += 1;
      continue;
    }

    const referenceYear = new Date(event.source_ts * 1000).getUTCFullYear();
    const parsed = parseWeatherMarket({
      question: event.market_title,
      slug: event.slug,
      referenceYear,
    });
    if (!parsed) {
      excludedCounts.unparsedMarket += 1;
      continue;
    }

    const forecast = await fetchHistoricalForecast({
      lat: parsed.lat,
      lon: parsed.lon,
      targetDate: parsed.date,
      tradeSourceTs: event.source_ts,
    });
    if (!forecast.ok) {
      excludedCounts.forecastUnavailableOrIneligible += 1;
      continue;
    }

    const memberValueInThresholdUnit = convertTemperature(
      forecast.sample.temperatureMaxC,
      "C",
      parsed.threshold.unit,
    );
    const baselineProbYes = deriveBaselineProbability(
      [memberValueInThresholdUnit],
      parsed.threshold,
    );
    if (baselineProbYes === null) {
      excludedCounts.forecastUnavailableOrIneligible += 1;
      continue;
    }

    const entryPrice = Number(event.price);
    const walletImpliedProbYes = outcomeBought === "YES" ? entryPrice : 1 - entryPrice;

    eligibleTrades.push({
      wallet: wallet.toLowerCase(),
      handle,
      conditionId: event.condition_id,
      city: parsed.city,
      date: parsed.date,
      sourceTs: event.source_ts,
      outcomeBought,
      entryPrice,
      walletImpliedProbYes,
      baselineProbYes,
      realizedYes: settlement.outcome === "YES",
      baselineRelativeEdge: walletImpliedProbYes - baselineProbYes,
    });
  }

  return { eligibleTrades, excludedCounts };
}

/**
 * Part 3: builds the A (baseline alone) / B (wallet alone) / C (combined,
 * simple average as a documented placeholder blend -- NOT a fitted model;
 * refitting this once real data exists is a natural follow-up, not done
 * here) comparison, clustered by city-day per the Phase 0B instruction
 * that repeated same-city-day trades are not independent observations.
 */
export function buildPart3(trades: readonly EligibleTradeRecord[]): IncrementalValueResult {
  const baseline: Observation[] = [];
  const wallet: Observation[] = [];
  const combined: Observation[] = [];
  for (const t of trades) {
    const clusterKey = `${t.city}:${t.date}`;
    const y: 0 | 1 = t.realizedYes ? 1 : 0;
    baseline.push({ p: t.baselineProbYes, y, clusterKey });
    wallet.push({ p: t.walletImpliedProbYes, y, clusterKey });
    combined.push({ p: (t.baselineProbYes + t.walletImpliedProbYes) / 2, y, clusterKey });
  }
  return compareIncrementalValue(baseline, wallet, combined);
}

export type Phase0bWalletReport = {
  handle: string;
  wallet: string;
  part1: WalletAnalysis;
  part2: Part2Result;
  part3: IncrementalValueResult;
};

export async function buildPhase0bReport(): Promise<Phase0bWalletReport[]> {
  const reports: Phase0bWalletReport[] = [];
  for (const [handle, wallet] of Object.entries(WEATHER_WALLETS)) {
    const [part1, part2] = await Promise.all([
      analyzeWallet(wallet),
      buildPart2ForWallet(handle, wallet),
    ]);
    const part3 = buildPart3(part2.eligibleTrades);
    reports.push({ handle, wallet, part1, part2, part3 });
  }
  return reports;
}
