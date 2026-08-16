/**
 * SERVER-ONLY candidate research pass.
 *
 * RESEARCH / SHADOW ONLY. This module reads PUBLIC Polymarket endpoints with no
 * credentials and writes only to the candidate_* tables. It never places or
 * previews an order, never enables a follower, and never touches the reference
 * SHADOW experiment's accounting.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { parseSourceSide } from "../shadow-core";

import {
  RESEARCH_BATCH_SIZE,
  RESEARCH_BUDGET_MS,
  budgetExhausted,
  selectResearchBatch,
} from "./research-batch";

import {
  PROMOTED_STATUS,
  buildPromotedExperiment,
  guardPromotion,
  promotedExperimentName,
} from "./promotion";

import {
  capacityScore,
  computeFingerprint,
  computeMetrics,
  consistencyScore,
  copyabilityScore,
  finalCandidateScore,
  mirrorSimilarity,
  profitQuality,
  robustness,
  strengthsAndRisks,
  type CandidateFingerprint,
  type CandidatePosition,
  type CandidateTrade,
  type SlippageSample,
} from "./scoring";

const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

export const REFERENCE_HANDLE = "badatmath.";
export const REFERENCE_WALLET = "0x8fbd7cf5f806f563080864694415829f7229a959";
export const SNAPSHOT_SOURCE = "USER_OBSERVED_WEEKLY_LEADERBOARD_SNAPSHOT";

const TRADE_PAGES = 2;
const TRADE_PAGE_SIZE = 250;
const POSITION_LIMIT = 250;
const COPYABILITY_TRADE_SAMPLES = 4;
const DELAYS = [0, 30, 60, 300, 900];

/** User-observed weekly weather leaderboard snapshot (metadata only). */
export const SEED_CANDIDATES: {
  handle: string;
  wallet: string | null;
  rank: number | null;
  pnl: number | null;
}[] = [
  { handle: "gghff", wallet: null, rank: 1, pnl: 12_394 },
  { handle: "russell110320", wallet: "0x118689b24aead1d6e9507b8068d056b2ec4f051b", rank: 2, pnl: 11_345 },
  { handle: "opopv.", wallet: "0x7c63520c2ca9b336af0c205b9ccf68217bb393d4", rank: 3, pnl: 7_769 },
  { handle: "dingdingdangdang", wallet: null, rank: 4, pnl: 5_916 },
  { handle: "jjavi", wallet: null, rank: 5, pnl: 5_883 },
  { handle: "flawfence", wallet: null, rank: 7, pnl: 5_451 },
  { handle: "e46m3", wallet: null, rank: 8, pnl: 4_300 },
  { handle: REFERENCE_HANDLE, wallet: REFERENCE_WALLET, rank: 13, pnl: 3_757 },
  { handle: "HighTempTation", wallet: "0x6011655c4afb76f36dd1b08a137a1ba73466b31e", rank: 14, pnl: 3_492 },
  { handle: "neo7777", wallet: null, rank: 17, pnl: 3_007 },
  { handle: "Poligarch", wallet: null, rank: 30, pnl: 1_942 },
  { handle: "WeatherHK2", wallet: "0xdadbf9e1df1b8d7a184a0d6ab9c83b2337b61870", rank: 37, pnl: 1_660 },
  { handle: "Weather-Guru", wallet: null, rank: 40, pnl: 1_578 },
  { handle: "predictotemp", wallet: null, rank: 55, pnl: 1_258 },
];

type Json = Record<string, unknown>;

async function getJson(url: string, attempts = 2): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`${url.split("?")[0]} responded ${res.status}`);
      return (await res.json()) as unknown;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("request failed");
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ */
/* Public resolution + fetching                                        */
/* ------------------------------------------------------------------ */

/** Resolves a handle to a proxy wallet via the PUBLIC profile search. Exact, case-insensitive match only — never a guess. */
export async function resolveHandle(handle: string): Promise<string | null> {
  try {
    const json = (await getJson(
      `${GAMMA_API}/public-search?q=${encodeURIComponent(handle)}&limit_per_type=10&search_profiles=true`,
    )) as { profiles?: { name?: string; proxyWallet?: string }[] };
    const profiles = json.profiles ?? [];
    const exact = profiles.filter(
      (p) => str(p.name).trim().toLowerCase() === handle.trim().toLowerCase() && /^0x[a-f0-9]{40}$/i.test(str(p.proxyWallet)),
    );
    if (exact.length !== 1) return null;
    return str(exact[0]?.proxyWallet).toLowerCase();
  } catch {
    return null;
  }
}

export async function fetchPublicTrades(wallet: string): Promise<CandidateTrade[]> {
  const out: CandidateTrade[] = [];
  for (let page = 0; page < TRADE_PAGES; page += 1) {
    const json = await getJson(
      `${DATA_API}/trades?user=${wallet}&takerOnly=false&limit=${TRADE_PAGE_SIZE}&offset=${page * TRADE_PAGE_SIZE}`,
    );
    const rows = Array.isArray(json) ? (json as Json[]) : [];
    for (const r of rows) {
      // Fail closed: an unrecognized/missing side is never treated as a BUY.
      const side = parseSourceSide(r["side"]);
      if (side === null) continue;
      out.push({
        asset: str(r["asset"]),
        size: num(r["size"]),
        price: num(r["price"]),
        ts: num(r["timestamp"]),
        title: str(r["title"]),
        slug: str(r["slug"]),
        outcome: str(r["outcome"]),
        side,
      } as CandidateTrade);
    }
    if (rows.length < TRADE_PAGE_SIZE) break;
  }
  return out;
}

export async function fetchPublicPositions(wallet: string): Promise<CandidatePosition[]> {
  const json = await getJson(`${DATA_API}/positions?user=${wallet}&limit=${POSITION_LIMIT}`);
  const rows = Array.isArray(json) ? (json as Json[]) : [];
  return rows.map((r) => ({
    asset: str(r["asset"]),
    title: str(r["title"]),
    slug: str(r["slug"]),
    size: num(r["size"]),
    initialValue: numOrNull(r["initialValue"]),
    currentValue: numOrNull(r["currentValue"]),
    cashPnl: numOrNull(r["cashPnl"]),
    realizedPnl: numOrNull(r["realizedPnl"]),
    redeemable: r["redeemable"] === true,
    endDate: str(r["endDate"]) || null,
  }));
}

/** Bounded public price-history sampling used to estimate follower slippage. */
export async function fetchSlippageSamples(trades: readonly CandidateTrade[]): Promise<SlippageSample[]> {
  const recent = [...trades]
    .filter((t) => t.side === "BUY" && t.asset && t.price > 0)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, COPYABILITY_TRADE_SAMPLES);

  const samples: SlippageSample[] = [];
  for (const trade of recent) {
    let history: { t: number; p: number }[] = [];
    try {
      const json = (await getJson(
        `${CLOB_API}/prices-history?market=${trade.asset}&interval=1w&fidelity=1`,
      )) as { history?: { t?: number; p?: number }[] };
      history = (json.history ?? [])
        .map((h) => ({ t: num(h.t), p: num(h.p) }))
        .filter((h) => h.t > 0 && h.p > 0);
    } catch {
      history = [];
    }
    for (const delay of DELAYS) {
      const target = trade.ts + delay;
      const point = history
        .filter((h) => h.t >= target && h.t <= target + 120)
        .sort((a, b) => a.t - b.t)[0];
      samples.push({
        delaySeconds: delay,
        leaderPrice: trade.price,
        followerPrice: point ? point.p : null,
      });
    }
  }
  return samples;
}

/* ------------------------------------------------------------------ */
/* Watchlist seeding                                                   */
/* ------------------------------------------------------------------ */

export type WatchlistRow = {
  id: string;
  handle: string;
  wallet: string | null;
  wallet_resolved: boolean;
  source: string;
  status: string;
  notes: string | null;
  weekly_snapshot_rank: number | null;
  weekly_snapshot_pnl: number | null;
  promoted_experiment_id: string | null;
  added_at: string;
};

export async function seedWatchlist(): Promise<WatchlistRow[]> {
  const { data: existing, error: readError } = await supabaseAdmin
    .from("candidate_watchlist")
    .select("*");
  if (readError) throw new Error(`candidate_watchlist read failed: ${readError.message}`);
  const byHandle = new Map<string, WatchlistRow>(
    ((existing ?? []) as unknown as WatchlistRow[]).map((r) => [r.handle, r]),
  );

  for (const seed of SEED_CANDIDATES) {
    const current = byHandle.get(seed.handle);
    let wallet = seed.wallet ?? current?.wallet ?? null;
    if (!wallet) wallet = await resolveHandle(seed.handle);

    const payload = {
      handle: seed.handle,
      wallet,
      wallet_resolved: Boolean(wallet),
      source: SNAPSHOT_SOURCE,
      weekly_snapshot_rank: seed.rank,
      weekly_snapshot_pnl: seed.pnl,
      status: current?.status ?? (wallet ? "RESEARCH" : "INSUFFICIENT_DATA"),
      notes: wallet
        ? null
        : "wallet_unresolved: no single exact public profile match; address deliberately not guessed.",
      updated_at: new Date().toISOString(),
    };

    // Idempotent: handle is unique, so a repeat run updates in place.
    const { error: writeError } = current
      ? await supabaseAdmin.from("candidate_watchlist").update(payload as never).eq("id", current.id)
      : await supabaseAdmin.from("candidate_watchlist").insert(payload as never);
    if (writeError) throw new Error(`candidate_watchlist write failed: ${writeError.message}`);
  }

  const { data } = await supabaseAdmin
    .from("candidate_watchlist")
    .select("*")
    .order("weekly_snapshot_rank", { ascending: true });
  return (data ?? []) as unknown as WatchlistRow[];
}

/* ------------------------------------------------------------------ */
/* Research pass                                                       */
/* ------------------------------------------------------------------ */

export type ResearchSummary = {
  ranAt: string;
  state: "success" | "partial" | "error" | "skipped_locked";
  researched: number;
  resolvedCount: number;
  unresolvedCount: number;
  unresolved: string[];
  insufficient: string[];
  /** Public-API failures per candidate. The run continues past each one. */
  failures: { handle: string; error: string }[];
  detail: string | null;
};

/** Lightweight server-side lease so overlapping runs cannot double-write. */
const RESEARCH_LOCK_ID = "candidate_research";
const RESEARCH_LEASE_SECONDS = 300;

async function acquireResearchLease(): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("acquire_worker_lease", {
    p_id: RESEARCH_LOCK_ID,
    p_worker_id: `research-${Date.now()}`,
    p_lease_seconds: RESEARCH_LEASE_SECONDS,
  });
  if (error) return false;
  return data !== null && data !== undefined;
}

async function recordRunState(summary: ResearchSummary): Promise<void> {
  const { error } = await supabaseAdmin
    .from("worker_status")
    .update({
      state: summary.state === "skipped_locked" ? "running" : summary.state,
      last_poll_at: summary.ranAt,
      last_success_at: summary.state === "error" ? null : summary.ranAt,
      last_error: summary.detail,
      poll_failures: summary.failures.length,
      events_ingested: summary.researched,
      lease_expires_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as never)
    .eq("id", RESEARCH_LOCK_ID)
    .select("id");
  // A silently dropped run-state write would leave the lease looking held and
  // the pass looking like it never ran, so surface it instead of ignoring it.
  if (error) throw new Error(`worker_status update failed: ${error.message}`);
}

export type ResearchRunState = {
  lastRunAt: string | null;
  state: string;
  detail: string | null;
  failureCount: number;
  researchedCount: number;
  running: boolean;
};

export async function loadResearchRunState(): Promise<ResearchRunState | null> {
  const { data } = await supabaseAdmin
    .from("worker_status")
    .select("*")
    .eq("id", RESEARCH_LOCK_ID)
    .maybeSingle();
  if (!data) return null;
  const leaseUntil = data.lease_expires_at ? new Date(data.lease_expires_at).getTime() : 0;
  return {
    lastRunAt: data.last_poll_at ?? null,
    state: data.state,
    detail: data.last_error ?? null,
    failureCount: data.poll_failures,
    researchedCount: data.events_ingested,
    running: data.state === "running" && leaseUntil > Date.now(),
  };
}

async function referenceFingerprint(): Promise<CandidateFingerprint> {
  const trades = await fetchPublicTrades(REFERENCE_WALLET);
  return computeFingerprint(trades);
}

/** Recurring refresh interval for the autonomous candidate research pass. */
export const RESEARCH_REFRESH_HOURS = 6;

/**
 * Called by the scheduled ingest cycle. Runs the bounded public research pass
 * at most once every RESEARCH_REFRESH_HOURS; otherwise it is a cheap no-op.
 */
export async function refreshCandidateResearchIfDue(): Promise<{
  ran: boolean;
  detail: string | null;
}> {
  const state = await loadResearchRunState();
  const lastRun = state?.lastRunAt ? new Date(state.lastRunAt).getTime() : 0;
  const dueAt = lastRun + RESEARCH_REFRESH_HOURS * 3600_000;
  if (state?.running) return { ran: false, detail: "A research pass is already running." };
  if (lastRun > 0 && Date.now() < dueAt) {
    return { ran: false, detail: `Next refresh due ${new Date(dueAt).toISOString()}` };
  }
  const summary = await runCandidateResearch();
  return { ran: summary.state !== "skipped_locked", detail: summary.detail };
}

export async function runCandidateResearch(): Promise<ResearchSummary> {
  if (!(await acquireResearchLease())) {
    return {
      ranAt: new Date().toISOString(),
      state: "skipped_locked",
      researched: 0,
      resolvedCount: 0,
      unresolvedCount: 0,
      unresolved: [],
      insufficient: [],
      failures: [],
      detail: "Another research pass is already running.",
    };
  }

  const rows = await seedWatchlist();
  const reference = await referenceFingerprint();
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Bounded + resumable: only the oldest-computed slice is refreshed per
  // invocation, so one scheduled run finishes far inside the 300s lease and
  // repeated runs progress across the whole watchlist. Deterministic cursor:
  // candidate_metrics.computed_at (never-computed candidates first).
  const { data: computedRows } = await supabaseAdmin
    .from("candidate_metrics")
    .select("candidate_id, computed_at");
  const lastComputedAt = new Map<string, string | null>(
    ((computedRows ?? []) as { candidate_id: string; computed_at: string | null }[]).map((r) => [
      r.candidate_id,
      r.computed_at,
    ]),
  );
  const resolvedRows = rows.filter((r) => Boolean(r.wallet));
  const batch = selectResearchBatch(resolvedRows, lastComputedAt, RESEARCH_BATCH_SIZE);
  const batchIds = new Set(batch.map((r) => r.id));
  const startedAtMs = Date.now();

  const unresolved: string[] = [];
  const insufficient: string[] = [];
  const failures: { handle: string; error: string }[] = [];
  let researched = 0;
  let deferred = 0;

  for (const row of rows) {
    if (!row.wallet) {
      unresolved.push(row.handle);
      continue;
    }
    if (!batchIds.has(row.id)) {
      deferred += 1;
      continue;
    }
    if (budgetExhausted(startedAtMs, Date.now(), RESEARCH_BUDGET_MS)) {
      deferred += 1;
      continue;
    }
    // One candidate's public-API failure must never abort the bounded cohort.
    try {
    let trades: CandidateTrade[] = [];
    let positions: CandidatePosition[] = [];
    trades = await fetchPublicTrades(row.wallet);
    positions = await fetchPublicPositions(row.wallet);

    const metrics = computeMetrics({ trades, positions, nowSeconds });
    const fingerprint = computeFingerprint(trades);
    const mirror = mirrorSimilarity(fingerprint, reference);
    const profit = profitQuality(metrics);

    const slippage = await fetchSlippageSamples(trades);
    const copy = copyabilityScore(slippage);

    const consistency = consistencyScore(metrics);
    const capacity = capacityScore(metrics);
    const final = finalCandidateScore({
      mirror: mirror.score,
      profitQuality: profit.score,
      copyability: copy.score,
      consistency,
      capacity,
    });

    const stress = robustness({
      settledProfits: positions
        .filter((p) => p.redeemable || (p.currentValue ?? 0) <= 0)
        .map((p) => p.cashPnl ?? 0),
      slippageCents: [],
      tradeCount: trades.length,
    });

    const { strengths, risks } = strengthsAndRisks({ metrics, mirror, profit, copy, fingerprint });

    const { error: candidate_metricsError } = await supabaseAdmin.from("candidate_metrics").upsert(
      {
        candidate_id: row.id,
        computed_at: new Date().toISOString(),
        coverage_start: metrics.coverageStart ? new Date(metrics.coverageStart * 1000).toISOString() : null,
        coverage_end: metrics.coverageEnd ? new Date(metrics.coverageEnd * 1000).toISOString() : null,
        sample_count: metrics.sampleCount,
        completeness: metrics.completeness,
        metrics: { ...metrics.metrics, settledSampleCount: metrics.settledSampleCount, robustness: stress } as never,
      } as never,
      { onConflict: "candidate_id" },
    );

    const { error: candidate_fingerprintError } = await supabaseAdmin.from("candidate_fingerprint").upsert(
      {
        candidate_id: row.id,
        computed_at: new Date().toISOString(),
        bot_likelihood: fingerprint.botLikelihood,
        bot_label: fingerprint.botLabel,
        fingerprint: {
          ...fingerprint,
          markets: fingerprint.markets.slice(0, 50),
          entryPrices: fingerprint.entryPrices.slice(0, 200),
        } as never,
      } as never,
      { onConflict: "candidate_id" },
    );
    if (candidate_fingerprintError) throw new Error(`candidate_fingerprint write failed: ${candidate_fingerprintError.message}`);

    const { error: candidate_scoresError } = await supabaseAdmin.from("candidate_scores").upsert(
      {
        candidate_id: row.id,
        computed_at: new Date().toISOString(),
        mirror_similarity: mirror.score,
        profit_quality: profit.score,
        copyability: copy.score,
        consistency,
        capacity,
        final_score: final.score,
        score_status: final.status,
        completeness: {
          final: final.completeness,
          mirror: mirror.completeness,
          mirrorComponents: mirror.components,
          profitQuality: profit.completeness,
          profitComponents: profit.components,
          copyability: copy.completeness,
          copyabilityComponents: copy.components,
          metrics: metrics.completeness,
        } as never,
        strengths: strengths as never,
        risks: risks as never,
      } as never,
      { onConflict: "candidate_id" },
    );

    if (candidate_scoresError) throw new Error(`candidate_scores write failed: ${candidate_scoresError.message}`);

    if (metrics.sampleCount === 0) insufficient.push(row.handle);
    researched += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : "public request failed";
      failures.push({ handle: row.handle, error: message });
      await supabaseAdmin
        .from("candidate_watchlist")
        .update({ notes: `research_error: ${message}`.slice(0, 400), updated_at: new Date().toISOString() } as never)
        .eq("id", row.id);
    }
  }

  const resolvedCount = rows.filter((r) => Boolean(r.wallet)).length;
  const state: ResearchSummary["state"] =
    researched === 0 ? "error" : failures.length > 0 || unresolved.length > 0 ? "partial" : "success";
  const summary: ResearchSummary = {
    ranAt: new Date().toISOString(),
    state,
    researched,
    resolvedCount,
    unresolvedCount: rows.length - resolvedCount,
    unresolved,
    insufficient,
    failures,
    detail:
      failures.length > 0
        ? failures.map((f) => `${f.handle}: ${f.error}`).join("; ").slice(0, 400)
        : unresolved.length > 0
          ? `Unresolved handles: ${unresolved.join(", ")}`
          : deferred > 0
            ? `Bounded pass: ${researched} researched, ${deferred} deferred to the next scheduled run.`
            : null,
  };
  await recordRunState(summary);
  return summary;
}

/* ------------------------------------------------------------------ */
/* Read model                                                          */
/* ------------------------------------------------------------------ */

export type CandidateView = {
  id: string;
  handle: string;
  wallet: string | null;
  walletResolved: boolean;
  status: string;
  notes: string | null;
  source: string;
  weeklyRank: number | null;
  weeklyPnl: number | null;
  promotedExperimentId: string | null;
  coverageStart: string | null;
  coverageEnd: string | null;
  sampleCount: number;
  settledSampleCount: number | null;
  metricsCompleteness: number | null;
  pnl7d: number | null;
  pnl30d: number | null;
  pnlAllTime: number | null;
  realizedPnl: number | null;
  weatherShare: number | null;
  temperatureShare: number | null;
  medianEntryPrice: number | null;
  medianPositionUsd: number | null;
  tradesPerDay: number | null;
  cityCount: number | null;
  winRate: number | null;
  profitFactor: number | null;
  roi: number | null;
  top1Concentration: number | null;
  lastActivityTs: number | null;
  botLikelihood: number | null;
  mirrorSimilarity: number | null;
  profitQuality: number | null;
  copyability: number | null;
  consistency: number | null;
  capacity: number | null;
  finalScore: number | null;
  scoreStatus: string | null;
  scoreCompleteness: number | null;
  copyabilityCompleteness: number | null;
  strengths: string[];
  risks: string[];
};

type MetricLike = { value?: number | null } | number | null | undefined;

function mv(bag: Record<string, unknown> | null, key: string): number | null {
  if (!bag) return null;
  const raw = bag[key] as MetricLike;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const v = raw.value;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export type CandidatePanelData = {
  generatedAt: string;
  runState: ResearchRunState | null;
  referenceHandle: string;
  referenceWallet: string;
  candidates: CandidateView[];
};

export async function loadCandidatePanel(): Promise<CandidatePanelData> {
  const [{ data: rows }, { data: metricRows }, { data: fpRows }, { data: scoreRows }] = await Promise.all([
    supabaseAdmin.from("candidate_watchlist").select("*"),
    supabaseAdmin.from("candidate_metrics").select("*"),
    supabaseAdmin.from("candidate_fingerprint").select("*"),
    supabaseAdmin.from("candidate_scores").select("*"),
  ]);

  const metricsById = new Map<string, Record<string, unknown>>();
  for (const m of (metricRows ?? []) as unknown as {
    candidate_id: string;
    metrics: Record<string, unknown>;
    coverage_start: string | null;
    coverage_end: string | null;
    sample_count: number;
    completeness: number | null;
  }[]) {
    metricsById.set(m.candidate_id, m as unknown as Record<string, unknown>);
  }
  const fpById = new Map<string, { bot_likelihood: number | null }>();
  for (const f of (fpRows ?? []) as unknown as { candidate_id: string; bot_likelihood: number | null }[]) {
    fpById.set(f.candidate_id, f);
  }
  const scoreById = new Map<string, Record<string, unknown>>();
  for (const s of (scoreRows ?? []) as unknown as { candidate_id: string }[]) {
    scoreById.set(s.candidate_id, s as unknown as Record<string, unknown>);
  }

  const candidates: CandidateView[] = ((rows ?? []) as unknown as WatchlistRow[]).map((row) => {
    const metricRow = metricsById.get(row.id) ?? null;
    const bag = (metricRow?.["metrics"] as Record<string, unknown> | undefined) ?? null;
    const score = scoreById.get(row.id) ?? null;
    const completeness = (score?.["completeness"] as Record<string, unknown> | undefined) ?? null;
    const num_ = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

    return {
      id: row.id,
      handle: row.handle,
      wallet: row.wallet,
      walletResolved: row.wallet_resolved,
      status: row.status,
      notes: row.notes,
      source: row.source,
      weeklyRank: row.weekly_snapshot_rank,
      weeklyPnl: row.weekly_snapshot_pnl === null ? null : Number(row.weekly_snapshot_pnl),
      promotedExperimentId: row.promoted_experiment_id,
      coverageStart: (metricRow?.["coverage_start"] as string | null) ?? null,
      coverageEnd: (metricRow?.["coverage_end"] as string | null) ?? null,
      sampleCount: num_(metricRow?.["sample_count"]) ?? 0,
      settledSampleCount: mv(bag, "settledSampleCount"),
      metricsCompleteness: num_(metricRow?.["completeness"]),
      pnl7d: mv(bag, "pnl7d"),
      pnl30d: mv(bag, "pnl30d"),
      pnlAllTime: mv(bag, "pnlAllTime"),
      realizedPnl: mv(bag, "realizedPnl"),
      weatherShare: mv(bag, "weatherShare"),
      temperatureShare: mv(bag, "temperatureShare"),
      medianEntryPrice: mv(bag, "medianEntryPrice"),
      medianPositionUsd: mv(bag, "medianPositionUsd"),
      tradesPerDay: mv(bag, "tradesPerDay"),
      cityCount: mv(bag, "cityCount"),
      winRate: mv(bag, "winRate"),
      profitFactor: mv(bag, "profitFactor"),
      roi: mv(bag, "roi"),
      top1Concentration: mv(bag, "top1Concentration"),
      lastActivityTs: mv(bag, "lastActivityTs"),
      botLikelihood: fpById.get(row.id)?.bot_likelihood ?? null,
      mirrorSimilarity: num_(score?.["mirror_similarity"]),
      profitQuality: num_(score?.["profit_quality"]),
      copyability: num_(score?.["copyability"]),
      consistency: num_(score?.["consistency"]),
      capacity: num_(score?.["capacity"]),
      finalScore: num_(score?.["final_score"]),
      scoreStatus: (score?.["score_status"] as string | null) ?? null,
      scoreCompleteness: num_(completeness?.["final"]),
      copyabilityCompleteness: num_(completeness?.["copyability"]),
      strengths: Array.isArray(score?.["strengths"]) ? (score?.["strengths"] as string[]) : [],
      risks: Array.isArray(score?.["risks"]) ? (score?.["risks"] as string[]) : [],
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    runState: await loadResearchRunState(),
    referenceHandle: REFERENCE_HANDLE,
    referenceWallet: REFERENCE_WALLET,
    candidates,
  };
}

/* ------------------------------------------------------------------ */
/* Promotion — creates a PAUSED, isolated research experiment           */
/* ------------------------------------------------------------------ */

export type PromotionResult =
  | { ok: true; experimentId: string; experimentName: string; status: "PAUSED / RESEARCH_READY" }
  | { ok: false; error: string };

/**
 * Creates an isolated PAUSED paper experiment for a candidate. `enabled: false`
 * keeps it out of the autonomous cycle, which only ever loads the SHADOW
 * experiment by name — so candidate accounting can never mix with the
 * reference follower's cash, positions or P&L.
 */
export async function promoteCandidate(candidateId: string): Promise<PromotionResult> {
  const { data: row } = await supabaseAdmin
    .from("candidate_watchlist")
    .select("*")
    .eq("id", candidateId)
    .maybeSingle();
  const candidate = row as unknown as WatchlistRow | null;
  if (!candidate) return { ok: false, error: "Candidate not found." };
  const guard = guardPromotion({ wallet: candidate.wallet, handle: candidate.handle });
  if (!guard.ok) return { ok: false, error: guard.error };
  const wallet = candidate.wallet as string;

  const name = promotedExperimentName(candidate.handle);
  const { data: existing } = await supabaseAdmin
    .from("paper_experiments")
    .select("id")
    .eq("name", name)
    .maybeSingle();

  let experimentId = (existing as { id?: string } | null)?.id ?? null;
  if (!experimentId) {
    const { data: created, error } = await supabaseAdmin
      .from("paper_experiments")
      .insert(
        buildPromotedExperiment({
          handle: candidate.handle,
          wallet,
          nowSeconds: Math.floor(Date.now() / 1000),
        }) as never,
      )
      .select("id")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    experimentId = (created as { id?: string } | null)?.id ?? null;
  }
  if (!experimentId) return { ok: false, error: "Could not create the research experiment." };

  await supabaseAdmin
    .from("candidate_watchlist")
    .update({
      status: "PROMOTED_TO_SHADOW",
      promoted_experiment_id: experimentId,
      updated_at: new Date().toISOString(),
    } as never)
    .eq("id", candidateId);

  return { ok: true, experimentId, experimentName: name, status: PROMOTED_STATUS };
}

export async function setCandidateStatus(
  candidateId: string,
  status: "RESEARCH" | "REJECTED" | "INSUFFICIENT_DATA",
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabaseAdmin
    .from("candidate_watchlist")
    .update({ status, updated_at: new Date().toISOString() } as never)
    .eq("id", candidateId);
  return error ? { ok: false, error: error.message } : { ok: true };
}
