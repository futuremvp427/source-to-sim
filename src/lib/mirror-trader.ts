/**
 * Pure, client-safe domain logic for Mirror Trader MVP.
 * Read-only monitoring + deterministic PAPER copy simulation. No order placement.
 */

export const TARGET_WALLET = "0x8fbd7cf5f806f563080864694415829f7229a959";

export type TradeSide = "BUY" | "SELL";

/** Normalized source trade (shape adapted from Polymarket public data-api). */
export type SourceTrade = {
  /** Stable dedup identity. */
  id: string;
  /** How identity was derived — surfaced in Data Health. */
  idBasis: "source_id" | "tx_hash_log_index" | "tx_hash_ordinal";
  side: TradeSide;
  asset: string;
  conditionId: string;
  title: string;
  outcome: string;
  size: number;
  price: number;
  /** Unix seconds. */
  timestamp: number;
  transactionHash: string;
  icon?: string | undefined;
  slug?: string | undefined;
};

export type SourcePosition = {
  asset: string;
  conditionId: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  currentValue: number;
  realizedPnl: number;
  cashPnl: number;
  percentPnl: number;
  redeemable: boolean;
  endDate?: string | undefined;
};

export type DataMode = "LIVE" | "DEMO";

export type MirrorSnapshot = {
  mode: DataMode;
  /** ISO timestamp of when the server fetched. */
  fetchedAt: string;
  wallet: string;
  trades: SourceTrade[];
  positions: SourcePosition[];
  /** Populated when live fetch failed and demo fallback is active. */
  fallbackReason: string | null;
  sources: string[];
  warnings: string[];
};

/* ------------------------------------------------------------------ */
/* Dedup / identity                                                    */
/* ------------------------------------------------------------------ */

type RawTradeLike = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Normalize + assign stable identity to raw trades.
 * Preference: source id -> txHash + log/event index -> txHash + stable local ordinal.
 * Identical same-second trades are NEVER collapsed: the ordinal keeps them distinct.
 */
export function normalizeTrades(raw: RawTradeLike[]): SourceTrade[] {
  const ordinalCounter = new Map<string, number>();
  const seen = new Set<string>();
  const out: SourceTrade[] = [];

  for (const r of raw) {
    const sourceId = str(r["id"] ?? r["tradeId"] ?? r["eventId"] ?? "");
    const tx = str(r["transactionHash"] ?? r["txHash"] ?? "");
    const logIndex = r["logIndex"] ?? r["eventIndex"] ?? r["logIdx"];
    const side: TradeSide = str(r["side"]).toUpperCase() === "SELL" ? "SELL" : "BUY";
    const asset = str(r["asset"]);
    const timestamp = num(r["timestamp"]);

    let id: string;
    let idBasis: SourceTrade["idBasis"];
    if (sourceId) {
      id = `sid:${sourceId}`;
      idBasis = "source_id";
    } else if (tx && (typeof logIndex === "number" || typeof logIndex === "string")) {
      id = `tx:${tx}:${logIndex}`;
      idBasis = "tx_hash_log_index";
    } else {
      // Insufficient source identity: preserve every trade with a stable ordinal
      // keyed on the full economic tuple so repeat renders stay deterministic.
      const base = `${tx}:${asset}:${side}:${timestamp}:${num(r["size"])}:${num(r["price"])}`;
      const n = ordinalCounter.get(base) ?? 0;
      ordinalCounter.set(base, n + 1);
      id = `tx:${base}#${n}`;
      idBasis = "tx_hash_ordinal";
    }

    if (seen.has(id)) continue;
    seen.add(id);

    out.push({
      id,
      idBasis,
      side,
      asset,
      conditionId: str(r["conditionId"]),
      title: str(r["title"]) || "Unknown market",
      outcome: str(r["outcome"]),
      size: num(r["size"]),
      price: num(r["price"]),
      timestamp,
      transactionHash: tx,
      icon: str(r["icon"]) || undefined,
      slug: str(r["slug"]) || undefined,
    });
  }

  return out.sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
}

export function normalizePositions(raw: RawTradeLike[]): SourcePosition[] {
  return raw.map((r) => ({
    asset: str(r["asset"]),
    conditionId: str(r["conditionId"]),
    title: str(r["title"]) || "Unknown market",
    outcome: str(r["outcome"]),
    size: num(r["size"]),
    avgPrice: num(r["avgPrice"]),
    curPrice: num(r["curPrice"]),
    currentValue: num(r["currentValue"]),
    realizedPnl: num(r["realizedPnl"]),
    cashPnl: num(r["cashPnl"]),
    percentPnl: num(r["percentPnl"]),
    redeemable: Boolean(r["redeemable"]),
    endDate: str(r["endDate"]) || undefined,
  }));
}

/* ------------------------------------------------------------------ */
/* Paper copy simulation (DERIVED — never a real order)                */
/* ------------------------------------------------------------------ */

export type PaperAction = {
  id: string;
  sourceTradeId: string;
  side: TradeSide;
  asset: string;
  title: string;
  outcome: string;
  /** Price taken from the source fill (no slippage modelling in MVP). */
  price: number;
  /** Simulated notional in USD. */
  notional: number;
  /** Simulated share count. */
  shares: number;
  timestamp: number;
  note: string;
};

/**
 * Deterministic derivation: every source trade maps 1:1 to one paper action.
 * BUY  -> spend `paperAmount` at the source fill price.
 * SELL -> close up to the simulated open paper shares for that asset.
 */
export function derivePaperActions(trades: SourceTrade[], paperAmount: number): PaperAction[] {
  const chronological = [...trades].sort(
    (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
  );
  const openShares = new Map<string, number>();
  const actions: PaperAction[] = [];

  for (const t of chronological) {
    const price = t.price > 0 ? t.price : 0;
    if (t.side === "BUY") {
      const shares = price > 0 ? paperAmount / price : 0;
      openShares.set(t.asset, (openShares.get(t.asset) ?? 0) + shares);
      actions.push({
        id: `paper:${t.id}`,
        sourceTradeId: t.id,
        side: "BUY",
        asset: t.asset,
        title: t.title,
        outcome: t.outcome,
        price,
        notional: price > 0 ? paperAmount : 0,
        shares,
        timestamp: t.timestamp,
        note: price > 0 ? "Fixed paper notional" : "Skipped: no usable source price",
      });
    } else {
      const held = openShares.get(t.asset) ?? 0;
      const shares = held;
      openShares.set(t.asset, 0);
      actions.push({
        id: `paper:${t.id}`,
        sourceTradeId: t.id,
        side: "SELL",
        asset: t.asset,
        title: t.title,
        outcome: t.outcome,
        price,
        notional: shares * price,
        shares,
        timestamp: t.timestamp,
        note: shares > 0 ? "Closes simulated paper position" : "No simulated shares held",
      });
    }
  }

  return actions.sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
}

export type PaperPosition = {
  asset: string;
  title: string;
  outcome: string;
  shares: number;
  costBasis: number;
  avgPrice: number;
  /** null means "Unavailable" — no reliable fresh mark. */
  mark: number | null;
  openPnl: number | null;
  lastActivity: number;
};

export type SettledPaperRow = {
  asset: string;
  title: string;
  outcome: string;
  shares: number;
  costBasis: number;
  proceeds: number;
  realized: number;
  closedAt: number;
};

/** Freshness window for treating a source mark as usable (ms). */
export const MARK_FRESHNESS_MS = 120_000;

export function buildPaperBook(
  actions: PaperAction[],
  positions: SourcePosition[],
  fetchedAt: string,
  mode: DataMode,
): { open: PaperPosition[]; settled: SettledPaperRow[] } {
  const chronological = [...actions].sort(
    (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
  );
  const markAge = Date.now() - new Date(fetchedAt).getTime();
  const markFresh = mode === "LIVE" && markAge >= 0 && markAge < MARK_FRESHNESS_MS;
  const marks = new Map<string, number>();
  for (const p of positions) if (p.curPrice > 0) marks.set(p.asset, p.curPrice);

  const book = new Map<string, PaperPosition>();
  const settled: SettledPaperRow[] = [];

  for (const a of chronological) {
    if (a.side === "BUY") {
      if (a.shares <= 0) continue;
      const cur = book.get(a.asset);
      const shares = (cur?.shares ?? 0) + a.shares;
      const costBasis = (cur?.costBasis ?? 0) + a.notional;
      book.set(a.asset, {
        asset: a.asset,
        title: a.title,
        outcome: a.outcome,
        shares,
        costBasis,
        avgPrice: shares > 0 ? costBasis / shares : 0,
        mark: null,
        openPnl: null,
        lastActivity: a.timestamp,
      });
    } else {
      const cur = book.get(a.asset);
      if (!cur || cur.shares <= 0) continue;
      settled.push({
        asset: a.asset,
        title: a.title,
        outcome: a.outcome,
        shares: cur.shares,
        costBasis: cur.costBasis,
        proceeds: cur.shares * a.price,
        realized: cur.shares * a.price - cur.costBasis,
        closedAt: a.timestamp,
      });
      book.delete(a.asset);
    }
  }

  const open = [...book.values()].map((p) => {
    const mark = markFresh ? (marks.get(p.asset) ?? null) : null;
    return {
      ...p,
      mark,
      openPnl: mark === null ? null : p.shares * mark - p.costBasis,
    };
  });

  open.sort((a, b) => b.lastActivity - a.lastActivity);
  settled.sort((a, b) => b.closedAt - a.closedAt);
  return { open, settled };
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

export function formatUsd(v: number): string {
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatShares(v: number): string {
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function filterTrades(
  trades: SourceTrade[],
  search: string,
  side: "ALL" | TradeSide,
): SourceTrade[] {
  const q = search.trim().toLowerCase();
  return trades.filter(
    (t) => (side === "ALL" || t.side === side) && (!q || t.title.toLowerCase().includes(q)),
  );
}