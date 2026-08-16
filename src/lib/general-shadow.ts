/**
 * GENERAL SHADOW cohort — pure, deterministic definitions and math.
 *
 * Two general-market (non-weather) wallets are observed in PAPER SIMULATION
 * only, on their own independent ledgers, alongside — and never mixed with —
 * the Weather V2 / V3 cohorts. There is no live-order path anywhere in this
 * feature: nothing here signs, previews or submits an order.
 *
 * Wallet identity is always the address. Handles are display labels only.
 */

export const GS_PREFIX = "GENERAL SHADOW: ";

/**
 * Explicit General Shadow observation go-live boundary.
 * 1786503000 = 2026-08-12T02:50:00Z. Source activity strictly before this
 * second is research history only and can never enter the paper record.
 */
export const GS_GO_LIVE_TS = 1786503000;
export const GS_GO_LIVE_ISO = "2026-08-12T02:50:00.000Z";

/**
 * Documented research bankroll. Deliberately NOT $380 (Weather V2) or $1,000
 * (Weather V3): these wallets have unknown capital needs, so they start at a
 * neutral $500 experimental bankroll under the existing dynamic-v1 sizing rule
 * (min($5, 1% of cash), $1 floor, 10% starting-bankroll reserve). Experimental
 * money only — no live capital is connected.
 */
export const GS_STARTING_CASH = 500;
export const GS_RESERVE_USD = GS_STARTING_CASH * 0.1;
export const GS_SIZING_RULE = "dynamic-v1";

export type GeneralWallet = { handle: string; wallet: string };

export const GS_COHORT: readonly GeneralWallet[] = Object.freeze([
  { handle: "RN1", wallet: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea" },
  { handle: "swisstony", wallet: "0x204f72f35326db932158cba6adff0b9a1da95e14" },
]);

export function gsExperimentName(handle: string): string {
  return `${GS_PREFIX}${handle}`;
}

export function isGeneralShadowName(name: string): boolean {
  return name.startsWith(GS_PREFIX);
}

/**
 * PAUSED (2026-08-16): both General Shadow wallets (RN1, swisstony) are
 * stalled around their 2026-08-13 checkpoints and continue generating
 * upstream 429s against data-api.polymarket.com, independent of the 10
 * V2/V3 qualification experiments (which are healthy and unaffected by this
 * flag -- see isGeneralShadowName's use in runExperimentCycle, which is the
 * ONLY place this constant is read).
 *
 * This pauses POLLING ONLY: no historical source_events/paper_trades/
 * paper_positions/settlements/checkpoint row is mutated, reset, or deleted
 * by this flag. runExperimentCycle short-circuits before acquiring a lease
 * or touching worker_checkpoints/worker_status for any experiment whose
 * name matches GS_PREFIX while this is false, so no upstream /trades or
 * /activity request is made and no accounting state changes merely from
 * being paused.
 *
 * To resume: flip this back to true. Nothing else needs to change -- this
 * is deliberately the only switch. General Shadow's own underlying stall
 * (the actual root cause of the 2026-08-13 checkpoint freeze) is NOT
 * investigated or repaired by this flag; it only stops the symptom
 * (repeated 429s) from continuing while that's out of scope.
 */
export const GENERAL_SHADOW_POLLING_ENABLED = false;

/**
 * BOUNDED SAFE-RESUME GUARD.
 *
 * Flipping GENERAL_SHADOW_POLLING_ENABLED back to true must NOT let a single
 * cycle unleash the entire RN1/swisstony backlog as one request storm (the
 * 2026-08-13 stall left a very large gap, and unbounded catch-up is what
 * produced the original 429 burst).
 *
 * General Shadow catch-up is therefore capped at this many upstream pages per
 * cycle. If the backlog is not covered inside the budget the cycle fails
 * closed: the checkpoint is NOT advanced and no events are processed, so a
 * later cycle retries from the same boundary without ever skipping history.
 * V2/V3 and candidate polling do not use this cap and are unaffected.
 */
export const GENERAL_SHADOW_CATCHUP_PAGE_BUDGET = 8;

export function gsHandleFromName(name: string): string | null {
  return isGeneralShadowName(name) ? name.slice(GS_PREFIX.length) : null;
}

/** Qualification is fixed for this cohort: evidence collection only. */
export const GS_QUALIFICATION = "MONITORING" as const;

/* ------------------------------------------------------------------ */
/* Market category classification (analysis only, never a filter)      */
/* ------------------------------------------------------------------ */

export type MarketCategory = "sports" | "politics" | "crypto" | "weather" | "other";

const SPORTS = /\b(nba|nfl|mlb|nhl|wnba|ncaa|epl|ufc|f1|soccer|football|baseball|basketball|hockey|tennis|golf|cricket|o\/u|vs\.?)\b/i;
const POLITICS = /\b(election|president|senate|congress|governor|parliament|primary|nominee|impeach|cabinet|prime minister|mayor|vote|poll)\b/i;
const CRYPTO = /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|doge|crypto|token|altcoin|stablecoin)\b/i;
const WEATHER = /\b(temperature|temp|highest temp|rain|snow|hurricane|storm|weather|degrees|celsius|fahrenheit)\b/i;

/**
 * Heuristic classification from public title + slug. Used for the category MIX
 * shown as analysis; it never filters or gates ingestion.
 */
export function classifyMarketCategory(title: string | null, slug?: string | null): MarketCategory {
  const text = `${title ?? ""} ${slug ?? ""}`;
  if (WEATHER.test(text)) return "weather";
  if (CRYPTO.test(text)) return "crypto";
  if (POLITICS.test(text)) return "politics";
  if (SPORTS.test(text)) return "sports";
  return "other";
}

/* ------------------------------------------------------------------ */
/* Non-trade public activity (SPLIT / MERGE / REDEEM)                  */
/* ------------------------------------------------------------------ */

export const NON_TRADE_TYPES = ["SPLIT", "MERGE", "REDEEM", "REWARD", "CONVERSION"] as const;
export type NonTradeType = (typeof NON_TRADE_TYPES)[number];

export type NormalizedActivity = {
  wallet: string;
  eventKey: string;
  activityType: string;
  asset: string | null;
  conditionId: string | null;
  marketTitle: string | null;
  outcome: string | null;
  slug: string | null;
  category: MarketCategory;
  shares: number | null;
  usdcSize: number | null;
  price: number | null;
  sourceTs: number;
  /**
   * MERGE / SPLIT / REDEEM economics cannot be proven from the public feed
   * alone, so they are recorded as evidence with an explicit unknown status.
   * They are NEVER converted into a paper BUY or SELL.
   */
  economicsStatus: "UNKNOWN_UNRESOLVED";
  postGoLive: boolean;
  raw: Record<string, unknown>;
};

function s(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}
function n(v: unknown): number | null {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

/**
 * Deterministic identity for non-trade activity, so re-reading the same public
 * window is idempotent: tx hash + type + asset + timestamp, with a per-tuple
 * ordinal for legitimately repeated identical rows.
 */
export function normalizeActivity(
  raw: Record<string, unknown>[],
  wallet: string,
  goLiveTs: number,
): NormalizedActivity[] {
  const ordinal = new Map<string, number>();
  const out: NormalizedActivity[] = [];
  for (const r of raw) {
    const type = s(r["type"]).toUpperCase();
    if (!type || type === "TRADE") continue;
    const tx = s(r["transactionHash"]);
    const asset = s(r["asset"]);
    const ts = n(r["timestamp"]) ?? 0;
    const tuple = `${tx}:${type}:${asset}:${ts}`;
    const k = ordinal.get(tuple) ?? 0;
    ordinal.set(tuple, k + 1);
    const title = s(r["title"]) || null;
    const slug = s(r["slug"]) || null;
    out.push({
      wallet: wallet.toLowerCase(),
      eventKey: `act:${tuple}#${k}`,
      activityType: type,
      asset: asset || null,
      conditionId: s(r["conditionId"]) || null,
      marketTitle: title,
      outcome: s(r["outcome"]) || null,
      slug,
      category: classifyMarketCategory(title, slug),
      shares: n(r["size"]),
      usdcSize: n(r["usdcSize"]),
      price: n(r["price"]),
      sourceTs: ts,
      economicsStatus: "UNKNOWN_UNRESOLVED",
      postGoLive: ts >= goLiveTs,
      raw: r,
    });
  }
  return out.sort((a, b) => a.sourceTs - b.sourceTs || a.eventKey.localeCompare(b.eventKey));
}

/* ------------------------------------------------------------------ */
/* Profitability windows                                               */
/* ------------------------------------------------------------------ */

export type PeriodKey = "1D" | "1W" | "1M" | "YTD" | "ALL";
export type ProfitStatus = "GREEN" | "FLAT" | "RED" | "INCOMPLETE" | "UNAVAILABLE";

export const PERIODS: readonly PeriodKey[] = Object.freeze(["1D", "1W", "1M", "YTD", "ALL"]);

/** Inclusive period start in ms. ALL starts at our own go-live boundary. */
export function periodStartMs(period: PeriodKey, nowMs: number, goLiveMs: number): number {
  const day = 86_400_000;
  if (period === "1D") return nowMs - day;
  if (period === "1W") return nowMs - 7 * day;
  if (period === "1M") return nowMs - 30 * day;
  if (period === "YTD") return Date.UTC(new Date(nowMs).getUTCFullYear(), 0, 1);
  return goLiveMs;
}

/**
 * $0 is FLAT, never GREEN. A period whose start predates our own observation
 * boundary is INCOMPLETE — we never imply coverage we do not have. Without any
 * observation at all the honest answer is UNAVAILABLE.
 */
export function profitStatus(input: {
  pnl: number | null;
  periodStartMs: number;
  goLiveMs: number;
  hasObservations: boolean;
}): ProfitStatus {
  if (!input.hasObservations || input.pnl === null) return "UNAVAILABLE";
  if (input.periodStartMs < input.goLiveMs) return "INCOMPLETE";
  if (input.pnl > 0) return "GREEN";
  if (input.pnl < 0) return "RED";
  return "FLAT";
}

/** Daily bucket status, same rules, always fully covered by construction. */
export function dailyStatus(pnl: number): ProfitStatus {
  if (pnl > 0) return "GREEN";
  if (pnl < 0) return "RED";
  return "FLAT";
}

export function utcDay(iso: string): string {
  return iso.slice(0, 10);
}