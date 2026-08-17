/**
 * SERVER-ONLY General Shadow layer.
 *
 * Read-only against public Polymarket endpoints, plus writes to our own
 * general_activity evidence table. It deliberately imports NOTHING from the
 * PMUS signing / order-preview modules: there is no live-order path here.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { fetchAllRows, fetchAllRowsAfterId } from "./db-pagination";
import {
  GS_GO_LIVE_ISO,
  GS_GO_LIVE_TS,
  GS_PREFIX,
  GS_QUALIFICATION,
  GS_RESERVE_USD,
  GS_SIZING_RULE,
  GS_STARTING_CASH,
  PERIODS,
  classifyMarketCategory,
  dailyStatus,
  gsHandleFromName,
  normalizeActivity,
  periodStartMs,
  profitStatus,
  utcDay,
  type MarketCategory,
  type PeriodKey,
  type ProfitStatus,
} from "./general-shadow";
import { MARK_MAX_AGE_MS, roundUsd } from "./shadow-core";
import { parseRetryAfterMs, recordHostRateLimit, reserveRequestSlot } from "./http-rate-limit.server";

const DATA_API = "https://data-api.polymarket.com";
const ACTIVITY_PAGE = 250;
/** Bounded work per cycle: two pages is comfortably ahead of a one-minute poll. */
const ACTIVITY_PAGES = 2;
/** Public feeds enforce a historical offset ceiling; stop paging, keep what we have. */
const MAX_OFFSET = 10_000;

type Json = Record<string, unknown>;

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/* ------------------------------------------------------------------ */
/* Non-trade activity ingestion (SPLIT / MERGE / REDEEM)               */
/* ------------------------------------------------------------------ */

/**
 * Callers of ingestGeneralActivity are already gated on the shared
 * data-api.polymarket.com cooldown (checked once, before any network work,
 * in runExperimentCycle -- General Shadow experiments go through that same
 * gate), so this normally only ever fires while the host is believed
 * healthy. If it turns out NOT to be -- this request is the one that
 * discovers a fresh 429 -- it records the same shared cooldown so /trades
 * callers back off too, instead of General Shadow silently absorbing 429s
 * on its own and leaving the shared budget unaware of them. No in-process
 * retry here either, matching shadow.server.ts's getJson: one 429 fails
 * this page immediately rather than amplifying it.
 *
 * Also claims the same atomic pacing reservation /trades uses (see
 * reserveRequestSlot's doc comment) immediately before firing, since this
 * hits the same host and is exactly the kind of independent caller that
 * could otherwise race a concurrent /trades request past the cycle-start
 * cooldown check. Fails CLOSED: a reservation failure throws here (no
 * fetch attempted) and is caught by ingestGeneralActivity's existing
 * per-page catch below, which marks the page truncated -- the same
 * fail-closed outcome an actual 429 already produces, requiring no new
 * error handling.
 */
async function getActivityPage(wallet: string, offset: number): Promise<Json[]> {
  const url = `${DATA_API}/activity?user=${wallet}&limit=${ACTIVITY_PAGE}&offset=${offset}`;
  const waitMs = await reserveRequestSlot(new URL(url).host);
  if (waitMs > 0) await sleep(waitMs);
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    if (res.status === 429) {
      await recordHostRateLimit(
        new URL(url).host,
        parseRetryAfterMs(res.headers.get("retry-after")),
      );
    }
    throw new Error(`activity feed responded ${res.status}`);
  }
  const json = (await res.json()) as unknown;
  if (Array.isArray(json)) return json as Json[];
  return [];
}

/**
 * Records SPLIT / MERGE / REDEEM / other non-trade activity as evidence.
 * These are never converted into paper BUY or SELL trades and never touch the
 * paper ledger; their economics stay UNKNOWN_UNRESOLVED.
 *
 * A page that fails (or an offset ceiling) never discards pages already
 * fetched: whatever was collected is persisted.
 */
export async function ingestGeneralActivity(
  wallet: string,
): Promise<{ fetched: number; nonTrade: number; inserted: number; pages: number; truncated: boolean }> {
  const address = wallet.toLowerCase();
  const raw: Json[] = [];
  let pages = 0;
  let truncated = false;
  for (let p = 0; p < ACTIVITY_PAGES; p += 1) {
    const offset = p * ACTIVITY_PAGE;
    if (offset >= MAX_OFFSET) {
      truncated = true;
      break;
    }
    try {
      const page = await getActivityPage(address, offset);
      pages += 1;
      raw.push(...page);
      if (page.length < ACTIVITY_PAGE) break;
    } catch {
      truncated = true;
      break;
    }
  }

  const normalized = normalizeActivity(raw, address, GS_GO_LIVE_TS);
  if (normalized.length === 0) {
    return { fetched: raw.length, nonTrade: 0, inserted: 0, pages, truncated };
  }

  const rows = normalized.map((a) => ({
    wallet: a.wallet,
    event_key: a.eventKey,
    activity_type: a.activityType,
    asset: a.asset,
    condition_id: a.conditionId,
    market_title: a.marketTitle,
    outcome: a.outcome,
    slug: a.slug,
    category: a.category,
    shares: a.shares,
    usdc_size: a.usdcSize,
    price: a.price,
    source_ts: a.sourceTs,
    economics_status: a.economicsStatus,
    post_go_live: a.postGoLive,
    raw: a.raw as never,
  }));
  const { data, error } = await supabaseAdmin
    .from("general_activity")
    .upsert(rows as never, { onConflict: "wallet,event_key", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(error.message);
  return {
    fetched: raw.length,
    nonTrade: normalized.length,
    inserted: data?.length ?? 0,
    pages,
    truncated,
  };
}

/* ------------------------------------------------------------------ */
/* Read model                                                          */
/* ------------------------------------------------------------------ */

export type GeneralDailyRow = {
  date: string;
  realizedPnl: number;
  settlements: number;
  status: ProfitStatus;
  cumulativePnl: number;
};

export type GeneralWalletView = {
  handle: string;
  wallet: string;
  experimentId: string;
  qualification: typeof GS_QUALIFICATION;
  startingCash: number;
  reserveUsd: number;
  sizingRule: string;
  cash: number;
  goLiveTs: number;
  goLiveIso: string;
  daysObserved: number;
  sourceEvents: { total: number; postGoLive: number; preGoLiveHistoryOnly: number };
  activity: { byType: Record<string, number>; unresolvedEconomics: number };
  paper: {
    buys: number;
    sells: number;
    skips: number;
    cashStarvedSkips: number;
    cashStarvedSkipRate: number | null;
    skipReasons: { reason: string; count: number }[];
  };
  positions: {
    open: number;
    openCostBasis: number;
    marked: number;
    markCoveragePct: number | null;
    conditionExposure: number;
  };
  pnl: {
    realized: number;
    unrealized: number | null;
    total: number | null;
    equity: number | null;
    maxDrawdown: number | null;
  };
  settlements: number;
  daily: GeneralDailyRow[];
  periods: { period: PeriodKey; pnl: number | null; status: ProfitStatus }[];
  categories: { category: MarketCategory; events: number }[];
  copyability: {
    observations: number;
    observed: number;
    completenessPct: number | null;
    fillabilityPct: number | null;
    medianSlippageCents: number | null;
    slippageByDelay: { delay: string; medianCents: number | null; samples: number }[];
  };
  latency: { detectionSeconds: number | null; decisionSeconds: number | null; samples: number };
  worker: { state: string; lastSuccessAt: string | null; lastError: string | null; ageSeconds: number | null };
};

export type GeneralShadowData = {
  fetchedAt: string;
  goLiveTs: number;
  goLiveIso: string;
  liveExecutionImplemented: false;
  wallets: GeneralWalletView[];
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const v = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round(v * 100) / 100;
}

async function loadWallet(experiment: {
  id: string;
  name: string;
  wallet_address: string;
  starting_cash: number;
  cash: number;
  realized_pnl: number;
  follow_from_ts: number | null;
}): Promise<GeneralWalletView> {
  const wallet = experiment.wallet_address.toLowerCase();
  const handle = gsHandleFromName(experiment.name) ?? experiment.name;
  const goLiveTs = experiment.follow_from_ts ?? GS_GO_LIVE_TS;
  const goLiveMs = goLiveTs * 1000;
  const nowMs = Date.now();

  type TradeRow = { action: string; reason: string | null; realized_pnl: number; created_at: string };
  type SettlementRow = { realized_pnl: number; settled_at: string };
  type ActivityRow = { activity_type: string };
  type ObsRow = { status: string; sample_delay: string; slippage_cents: number | null; fillable: boolean | null };
  type CatRow = { market_title: string | null; slug: string | null };

  const [
    totalEvents,
    postEvents,
    positionsRes,
    tradesPaged,
    settlementsPaged,
    activityPaged,
    obsPaged,
    auditRes,
    workerRes,
    catPaged,
  ] = await Promise.all([
    supabaseAdmin.from("source_events").select("id", { count: "exact", head: true }).eq("wallet", wallet),
    supabaseAdmin
      .from("source_events")
      .select("id", { count: "exact", head: true })
      .eq("wallet", wallet)
      .gte("source_ts", goLiveTs),
    supabaseAdmin
      .from("paper_positions")
      .select("asset, shares, cost_basis, mark, mark_ts, settlement_status")
      .eq("experiment_id", experiment.id)
      .gt("shares", 0),
    // Full history: every paper trade decision feeds buy/sell/skip counts and
    // daily realized results, so a bounded window would silently understate
    // both once an experiment passed ~5000 trades.
    fetchAllRows<TradeRow>(async (from, to) => {
      const { data, error } = await supabaseAdmin
        .from("paper_trades")
        .select("action, reason, realized_pnl, created_at")
        .eq("experiment_id", experiment.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to);
      if (error) throw new Error(error.message);
      return data ?? [];
    }),
    fetchAllRows<SettlementRow>(async (from, to) => {
      const { data, error } = await supabaseAdmin
        .from("paper_settlements")
        .select("realized_pnl, settled_at")
        .eq("experiment_id", experiment.id)
        .order("settled_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to);
      if (error) throw new Error(error.message);
      return data ?? [];
    }),
    fetchAllRows<ActivityRow>(async (from, to) => {
      const { data, error } = await supabaseAdmin
        .from("general_activity")
        .select("activity_type")
        .eq("wallet", wallet)
        .order("id", { ascending: true })
        .range(from, to);
      if (error) throw new Error(error.message);
      return data ?? [];
    }),
    // Keyset (not OFFSET) paging: these aggregates are order-insensitive, and
    // deep OFFSET pages of this history exceed the role statement_timeout.
    fetchAllRowsAfterId<ObsRow & { id: string }>(async (afterId, limit) => {
      let query = supabaseAdmin
        .from("copyability_observations")
        .select("id, status, sample_delay, slippage_cents, fillable")
        .eq("experiment_id", experiment.id);
      if (afterId !== null) query = query.gt("id", afterId);
      const { data, error } = await query.order("id", { ascending: true }).limit(limit);
      if (error) throw new Error(error.message);
      return data ?? [];
    }),
    // Intentionally bounded: the latest-1000-sample latency window, not a
    // full-history read. Widening this would change what it measures.
    supabaseAdmin
      .from("pipeline_audit")
      .select("detection_latency_seconds, decision_latency_seconds")
      .eq("experiment_id", experiment.id)
      .order("created_at", { ascending: false })
      .limit(1000),
    supabaseAdmin
      .from("worker_status")
      .select("state, last_success_at, last_error")
      .eq("id", `ingest:${experiment.id}`)
      .maybeSingle(),
    fetchAllRows<CatRow>(async (from, to) => {
      const { data, error } = await supabaseAdmin
        .from("source_events")
        .select("market_title, slug")
        .eq("wallet", wallet)
        .gte("source_ts", goLiveTs)
        .order("source_ts", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to);
      if (error) throw new Error(error.message);
      return data ?? [];
    }),
  ]);
  const tradesRes = { data: tradesPaged.rows };
  const settlementsRes = { data: settlementsPaged.rows };
  const activityRes = { data: activityPaged.rows };
  const obsRes = { data: obsPaged.rows };
  const catRes = { data: catPaged.rows };

  /* ---- positions / marks ---- */
  const positions = positionsRes.data ?? [];
  let openCostBasis = 0;
  let marked = 0;
  let markedValue = 0;
  for (const p of positions) {
    openCostBasis = roundUsd(openCostBasis + Number(p.cost_basis));
    const ts = p.mark_ts ? Date.parse(p.mark_ts) : NaN;
    const fresh = Number.isFinite(ts) && nowMs - ts < MARK_MAX_AGE_MS && p.mark !== null;
    if (fresh) {
      marked += 1;
      markedValue = roundUsd(markedValue + Number(p.shares) * Number(p.mark));
    }
  }
  const fullyMarked = positions.length > 0 && marked === positions.length;
  const unrealized = fullyMarked ? roundUsd(markedValue - openCostBasis) : positions.length === 0 ? 0 : null;
  const realized = roundUsd(Number(experiment.realized_pnl));
  const total = unrealized === null ? null : roundUsd(realized + unrealized);
  const equity =
    unrealized === null ? null : roundUsd(Number(experiment.cash) + openCostBasis + unrealized);

  /* ---- paper decisions ---- */
  const trades = tradesRes.data ?? [];
  let buys = 0;
  let sells = 0;
  let skips = 0;
  let cashStarved = 0;
  const reasonCounts = new Map<string, number>();
  for (const t of trades) {
    // action="SETTLEMENT" is lifecycle audit evidence only (realized_pnl
    // always 0, see apply_verified_paper_settlement) — never a trading
    // decision, so it must not fall into the SKIP bucket below.
    if (t.action === "BUY") buys += 1;
    else if (t.action === "SELL") sells += 1;
    else if (t.action === "SKIP") {
      skips += 1;
      const reason = (t.reason ?? "unknown").split("(")[0]!.trim();
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      if ((t.reason ?? "").includes("INSUFFICIENT_CASH_RESERVE")) cashStarved += 1;
    }
  }
  const decisions = buys + sells + skips;

  /* ---- daily realized results ---- */
  const settlements = settlementsRes.data ?? [];
  const dayMap = new Map<string, { pnl: number; settlements: number }>();
  const bump = (iso: string | null, pnl: number, isSettlement: boolean) => {
    if (!iso) return;
    const day = utcDay(iso);
    const cur = dayMap.get(day) ?? { pnl: 0, settlements: 0 };
    cur.pnl = roundUsd(cur.pnl + pnl);
    if (isSettlement) cur.settlements += 1;
    dayMap.set(day, cur);
  };
  for (const t of trades) {
    if (t.action === "SELL") bump(t.created_at, Number(t.realized_pnl), false);
  }
  for (const s of settlements) bump(s.settled_at, Number(s.realized_pnl), true);

  const daily: GeneralDailyRow[] = [];
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const date of [...dayMap.keys()].sort()) {
    const row = dayMap.get(date)!;
    cumulative = roundUsd(cumulative + row.pnl);
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, roundUsd(peak - cumulative));
    daily.push({
      date,
      realizedPnl: row.pnl,
      settlements: row.settlements,
      status: dailyStatus(row.pnl),
      cumulativePnl: cumulative,
    });
  }

  /* ---- period windows (realized, observed-only) ---- */
  const realizedAt: { ms: number; pnl: number }[] = [];
  for (const t of trades) {
    if (t.action === "SELL" && t.created_at) realizedAt.push({ ms: Date.parse(t.created_at), pnl: Number(t.realized_pnl) });
  }
  for (const s of settlements) {
    if (s.settled_at) realizedAt.push({ ms: Date.parse(s.settled_at), pnl: Number(s.realized_pnl) });
  }
  const hasObservations = (postEvents.count ?? 0) > 0;
  const periods = PERIODS.map((period) => {
    const startMs = periodStartMs(period, nowMs, goLiveMs);
    const from = Math.max(startMs, goLiveMs);
    const pnl = hasObservations
      ? roundUsd(realizedAt.filter((r) => r.ms >= from).reduce((acc, r) => acc + r.pnl, 0))
      : null;
    return {
      period,
      pnl,
      status: profitStatus({ pnl, periodStartMs: startMs, goLiveMs, hasObservations }),
    };
  });

  /* ---- categories (analysis only) ---- */
  const categoryCounts = new Map<MarketCategory, number>();
  for (const e of catRes.data ?? []) {
    const c = classifyMarketCategory(e.market_title, e.slug);
    categoryCounts.set(c, (categoryCounts.get(c) ?? 0) + 1);
  }

  /* ---- activity types ---- */
  const byType: Record<string, number> = {};
  for (const a of activityRes.data ?? []) byType[a.activity_type] = (byType[a.activity_type] ?? 0) + 1;

  /* ---- copyability ---- */
  const obs = obsRes.data ?? [];
  const observed = obs.filter((o) => o.status === "observed").length;
  const fillables = obs.filter((o) => o.fillable !== null);
  const slipAll = obs
    .map((o) => (o.slippage_cents === null ? null : Number(o.slippage_cents)))
    .filter((v): v is number => v !== null);
  const delays = ["immediate", "30s", "60s"] as const;
  const slippageByDelay = delays.map((delay) => {
    const samples = obs
      .filter((o) => o.sample_delay === delay && o.slippage_cents !== null)
      .map((o) => Number(o.slippage_cents));
    return { delay, medianCents: median(samples), samples: samples.length };
  });

  /* ---- latency ---- */
  const audits = auditRes.data ?? [];
  const detection = audits
    .map((a) => (a.detection_latency_seconds === null ? null : Number(a.detection_latency_seconds)))
    .filter((v): v is number => v !== null);
  const decision = audits
    .map((a) => (a.decision_latency_seconds === null ? null : Number(a.decision_latency_seconds)))
    .filter((v): v is number => v !== null);

  const lastSuccess = workerRes.data?.last_success_at ?? null;
  const preGoLive = Math.max(0, (totalEvents.count ?? 0) - (postEvents.count ?? 0));

  return {
    handle,
    wallet,
    experimentId: experiment.id,
    qualification: GS_QUALIFICATION,
    startingCash: Number(experiment.starting_cash) || GS_STARTING_CASH,
    reserveUsd: GS_RESERVE_USD,
    sizingRule: GS_SIZING_RULE,
    cash: roundUsd(Number(experiment.cash)),
    goLiveTs,
    goLiveIso: new Date(goLiveMs).toISOString(),
    daysObserved: Math.max(0, Math.floor((nowMs - goLiveMs) / 86_400_000)),
    sourceEvents: {
      total: totalEvents.count ?? 0,
      postGoLive: postEvents.count ?? 0,
      preGoLiveHistoryOnly: preGoLive,
    },
    activity: { byType, unresolvedEconomics: (activityRes.data ?? []).length },
    paper: {
      buys,
      sells,
      skips,
      cashStarvedSkips: cashStarved,
      cashStarvedSkipRate: decisions > 0 ? Math.round((cashStarved / decisions) * 1000) / 10 : null,
      skipReasons: [...reasonCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
    },
    positions: {
      open: positions.length,
      openCostBasis,
      marked,
      markCoveragePct:
        positions.length > 0 ? Math.round((marked / positions.length) * 1000) / 10 : null,
      conditionExposure: new Set(positions.map((p) => p.asset)).size,
    },
    pnl: {
      realized,
      unrealized,
      total,
      equity,
      maxDrawdown: daily.length > 0 ? maxDrawdown : null,
    },
    settlements: settlements.length,
    daily: daily.slice(-30),
    periods,
    categories: [...categoryCounts.entries()]
      .map(([category, events]) => ({ category, events }))
      .sort((a, b) => b.events - a.events),
    copyability: {
      observations: obs.length,
      observed,
      completenessPct: obs.length > 0 ? Math.round((observed / obs.length) * 1000) / 10 : null,
      fillabilityPct:
        fillables.length > 0
          ? Math.round((fillables.filter((o) => o.fillable === true).length / fillables.length) * 1000) / 10
          : null,
      medianSlippageCents: median(slipAll),
      slippageByDelay,
    },
    latency: {
      detectionSeconds: median(detection),
      decisionSeconds: median(decision),
      samples: audits.length,
    },
    worker: {
      state: workerRes.data?.state ?? "unknown",
      lastSuccessAt: lastSuccess,
      lastError: workerRes.data?.last_error ?? null,
      ageSeconds: lastSuccess ? Math.round((nowMs - Date.parse(lastSuccess)) / 1000) : null,
    },
  };
}

/** Independent per-wallet General Shadow read model. Fully derived, read-only. */
export async function loadGeneralShadow(): Promise<GeneralShadowData> {
  const { data, error } = await supabaseAdmin
    .from("paper_experiments")
    .select("id, name, wallet_address, starting_cash, cash, realized_pnl, follow_from_ts")
    .like("name", `${GS_PREFIX}%`)
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  const wallets = await Promise.all((data ?? []).map((row) => loadWallet(row as never)));
  return {
    fetchedAt: new Date().toISOString(),
    goLiveTs: GS_GO_LIVE_TS,
    goLiveIso: GS_GO_LIVE_ISO,
    liveExecutionImplemented: false,
    wallets,
  };
}