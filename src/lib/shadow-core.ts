/**
 * Pure, dependency-free logic for the autonomous SHADOW / PAPER follower.
 * Everything here is deterministic and unit-testable. No network, no database.
 * Nothing in this file can place a real order.
 */

export type Side = "BUY" | "SELL";

export type RawTrade = Record<string, unknown>;

export type IdentityBasis = "source_id" | "tx_hash_log_index" | "tx_hash_ordinal";

export type NormalizedEvent = {
  eventKey: string;
  wallet: string;
  txHash: string | null;
  sourceNativeId: string | null;
  logIndex: string | null;
  conditionId: string | null;
  asset: string;
  marketTitle: string;
  outcome: string | null;
  slug: string | null;
  side: Side;
  shares: number;
  price: number;
  sourceTs: number;
  identityBasis: IdentityBasis;
  /** True when the source gave us no reliable identity and we fell back to an ordinal. */
  identityDegraded: boolean;
  raw: RawTrade;
};

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * FAIL-CLOSED side parsing. Only an explicit, case-insensitive "BUY" or "SELL"
 * may become an executable normalized event. A missing, empty, malformed or
 * unrecognized side used to silently default to BUY, which would have paper-
 * copied an unknown source action as a purchase; such rows are now skipped.
 */
export function parseSourceSide(v: unknown): Side | null {
  const raw = str(v).trim().toUpperCase();
  if (raw === "BUY") return "BUY";
  if (raw === "SELL") return "SELL";
  return null;
}

/**
 * Deterministic, restart-safe event identity.
 * Preference: source-native id -> tx hash + log/event index -> tx hash + economic tuple + ordinal.
 *
 * The ordinal is counted per identical economic tuple, so re-fetching the same
 * API window always produces the same keys (idempotent replay), while two
 * legitimate identical same-second fills stay distinct (#0 and #1).
 */
export function normalizeSourceEvents(raw: RawTrade[], wallet: string): NormalizedEvent[] {
  const ordinal = new Map<string, number>();
  const seen = new Set<string>();
  const out: NormalizedEvent[] = [];

  for (const r of raw) {
    const sourceNativeId = str(r["id"] ?? r["tradeId"] ?? r["eventId"] ?? "");
    const txHash = str(r["transactionHash"] ?? r["txHash"] ?? "");
    const rawLogIndex = r["logIndex"] ?? r["eventIndex"] ?? r["logIdx"];
    const logIndex =
      typeof rawLogIndex === "number" || typeof rawLogIndex === "string" ? String(rawLogIndex) : "";
    // Unknown/missing side is never copied as BUY (fail closed): skip the row.
    const side = parseSourceSide(r["side"]);
    if (side === null) continue;
    const asset = str(r["asset"]);
    const shares = num(r["size"]);
    const price = num(r["price"]);
    const sourceTs = num(r["timestamp"]);

    let eventKey: string;
    let identityBasis: IdentityBasis;
    if (sourceNativeId) {
      eventKey = `sid:${sourceNativeId}`;
      identityBasis = "source_id";
    } else if (txHash && logIndex) {
      eventKey = `tx:${txHash}:${logIndex}`;
      identityBasis = "tx_hash_log_index";
    } else {
      const tuple = `${txHash}:${asset}:${side}:${sourceTs}:${shares}:${price}`;
      const n = ordinal.get(tuple) ?? 0;
      ordinal.set(tuple, n + 1);
      eventKey = `ord:${tuple}#${n}`;
      identityBasis = "tx_hash_ordinal";
    }

    if (seen.has(eventKey)) continue;
    seen.add(eventKey);

    out.push({
      eventKey,
      wallet: wallet.toLowerCase(),
      txHash: txHash || null,
      sourceNativeId: sourceNativeId || null,
      logIndex: logIndex || null,
      conditionId: str(r["conditionId"]) || null,
      asset,
      marketTitle: str(r["title"]) || "Unknown market",
      outcome: str(r["outcome"]) || null,
      slug: str(r["slug"]) || null,
      side,
      shares,
      price,
      sourceTs,
      identityBasis,
      identityDegraded: identityBasis === "tx_hash_ordinal",
      raw: r,
    });
  }

  // Chronological: the follower must process events in source order.
  return out.sort((a, b) => a.sourceTs - b.sourceTs || a.eventKey.localeCompare(b.eventKey));
}

/* ------------------------------------------------------------------ */
/* Source position replay + reconciliation                             */
/* ------------------------------------------------------------------ */

export type ReplayEvent = { asset: string; side: Side; shares: number };

/** Rebuild source share counts from persisted events (never negative). */
export function replaySourcePositions(events: ReplayEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    const cur = out.get(e.asset) ?? 0;
    const next = e.side === "BUY" ? cur + e.shares : cur - e.shares;
    out.set(e.asset, Math.max(0, roundShares(next)));
  }
  return out;
}

export const RECONCILE_TOLERANCE = 1e-6;

export type ReconciliationResult = {
  ok: boolean;
  mismatches: Array<{ asset: string; compact: number; replayed: number }>;
};

/** Compare compact source state against a full replay of persisted events. */
export function reconcileSourceState(
  compact: Map<string, number>,
  replayed: Map<string, number>,
): ReconciliationResult {
  const assets = new Set([...compact.keys(), ...replayed.keys()]);
  const mismatches: ReconciliationResult["mismatches"] = [];
  for (const asset of assets) {
    const c = compact.get(asset) ?? 0;
    const r = replayed.get(asset) ?? 0;
    if (Math.abs(c - r) > RECONCILE_TOLERANCE) mismatches.push({ asset, compact: c, replayed: r });
  }
  return { ok: mismatches.length === 0, mismatches };
}

/* ------------------------------------------------------------------ */
/* Follower decisions (PAPER ONLY)                                     */
/* ------------------------------------------------------------------ */

export type FollowerDecision =
  | { action: "BUY"; shares: number; notional: number; price: number; reason: string }
  | { action: "SELL"; shares: number; notional: number; price: number; reason: string }
  | { action: "SKIP"; shares: 0; notional: 0; price: number; reason: string };

export function roundShares(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
export function roundUsd(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function validPrice(price: number): boolean {
  return Number.isFinite(price) && price > 0 && price <= 1;
}

/* ------------------------------------------------------------------ */
/* Dynamic BUY sizing (PAPER ONLY)                                     */
/* ------------------------------------------------------------------ */

/** Persisted so we know exactly when the sizing strategy changed. */
export const SIZING_RULE_VERSION = "dynamic-v1";
export const SIZING_RULE_LABEL =
  "min($5, 1% of paper cash), floor $1, 10% starting-bankroll reserve";

export const SIZING_MAX_USD = 5;
export const SIZING_CASH_FRACTION = 0.01;
export const SIZING_MIN_USD = 1;
export const SIZING_RESERVE_FRACTION = 0.1;

export type CashBreakdown = {
  availableCash: number;
  reservedCash: number;
  spendableCash: number;
};

function roundCents(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Reserve is 10% of the STARTING bankroll, so it never drifts with P&L. */
export function cashBreakdown(input: { startingCash: number; cash: number }): CashBreakdown {
  const reservedCash = roundCents(Math.max(0, input.startingCash) * SIZING_RESERVE_FRACTION);
  return {
    availableCash: roundUsd(input.cash),
    reservedCash,
    spendableCash: roundCents(Math.max(0, input.cash - reservedCash)),
  };
}

export type BuySize =
  | { ok: true; amount: number; spendableCash: number; reservedCash: number }
  | { ok: false; reason: string; spendableCash: number; reservedCash: number };

/**
 * target_buy_usd = min($5, 1% of available paper cash), floored at $1,
 * and never allowed to breach the 10% starting-bankroll reserve.
 */
export function computeBuySize(input: { startingCash: number; cash: number }): BuySize {
  const { availableCash, reservedCash, spendableCash } = cashBreakdown(input);
  if (spendableCash + 1e-9 < SIZING_MIN_USD) {
    return {
      ok: false,
      reason: `INSUFFICIENT_CASH_RESERVE (spendable ${spendableCash} < ${SIZING_MIN_USD}, reserve ${reservedCash})`,
      spendableCash,
      reservedCash,
    };
  }
  const target = Math.min(SIZING_MAX_USD, Math.max(0, availableCash) * SIZING_CASH_FRACTION);
  const floored = Math.max(SIZING_MIN_USD, target);
  const amount = roundCents(Math.min(floored, spendableCash));
  return { ok: true, amount, spendableCash, reservedCash };
}

/** BUY sized dynamically from current paper cash, at the source fill price. */
export function decideDynamicBuy(input: {
  price: number;
  startingCash: number;
  cash: number;
}): FollowerDecision {
  const { price } = input;
  if (!validPrice(price)) {
    return { action: "SKIP", shares: 0, notional: 0, price, reason: "Invalid source price" };
  }
  const size = computeBuySize({ startingCash: input.startingCash, cash: input.cash });
  if (!size.ok) {
    return { action: "SKIP", shares: 0, notional: 0, price, reason: size.reason };
  }
  return {
    action: "BUY",
    shares: roundShares(size.amount / price),
    notional: roundUsd(size.amount),
    price,
    reason: `Dynamic sizing ${SIZING_RULE_VERSION}: $${size.amount} (${SIZING_RULE_LABEL})`,
  };
}

/* ------------------------------------------------------------------ */
/* Compound book-capital sizing (PAPER ONLY) — SHADOW V4 COMPOUND PILOT */
/* ------------------------------------------------------------------ */

/**
 * Second sizing rule, dispatched explicitly by an experiment's sizing_rule
 * column (see decideBuyForSizingRule). Unlike dynamic-v1, the sizing base is
 * cumulative realized book capital rather than raw cash, so it compounds:
 * realized gains raise future BUY targets, realized losses lower them.
 */
export const COMPOUND_V2_PILOT_SIZING_RULE = "compound-v2-pilot";
export const COMPOUND_V2_PILOT_LABEL =
  "4% of book capital, 12% per-market cap, 90% deployment cap, $1 floor, no $5 ceiling";
export const COMPOUND_ENTRY_FRACTION = 0.04;
export const COMPOUND_MARKET_CAP_FRACTION = 0.12;
export const COMPOUND_PORTFOLIO_DEPLOYMENT_CAP_FRACTION = 0.9;

/** book_capital = starting_cash + cumulative realized P&L. Never unrealized mark-to-market. */
export function computeBookCapital(input: { startingCash: number; realizedPnl: number }): number {
  return roundUsd(input.startingCash + input.realizedPnl);
}

export type CompoundBuyInput = {
  price: number;
  /** starting_cash + cumulative realized P&L. Never unrealized mark-to-market equity. */
  bookCapital: number;
  /** Actual spendable simulated cash right now. */
  cash: number;
  /** Sum of open cost basis already held in this fill's market (by condition_id). */
  marketCostBasis: number;
  /** Sum of open cost basis across the whole experiment. */
  portfolioCostBasis: number;
};

/**
 * target = 4% of book capital.
 * actual = min(target, remaining per-market capacity, remaining portfolio
 * capacity, actual spendable cash). Never negative, never leverage: every
 * candidate is clamped to >= 0 before the min, so a cap that is already
 * breached (e.g. book capital shrank after a loss) contributes 0 headroom —
 * it blocks further BUYs into that market/portfolio without ever forcing a
 * SELL of the existing, now-over-cap position.
 */
export function decideCompoundBuy(input: CompoundBuyInput): FollowerDecision {
  const { price, marketCostBasis, portfolioCostBasis } = input;
  if (!validPrice(price)) {
    return { action: "SKIP", shares: 0, notional: 0, price, reason: "Invalid source price" };
  }
  const bookCapital = Math.max(0, input.bookCapital);
  const cash = Math.max(0, input.cash);
  const candidates: Array<{ amount: number; reason: string }> = [
    { amount: bookCapital * COMPOUND_ENTRY_FRACTION, reason: "TARGET_BELOW_MIN" },
    { amount: Math.max(0, bookCapital * COMPOUND_MARKET_CAP_FRACTION - marketCostBasis), reason: "PER_MARKET_CAP_REACHED" },
    {
      amount: Math.max(0, bookCapital * COMPOUND_PORTFOLIO_DEPLOYMENT_CAP_FRACTION - portfolioCostBasis),
      reason: "PORTFOLIO_DEPLOYMENT_CAP_REACHED",
    },
    { amount: cash, reason: "INSUFFICIENT_CASH" },
  ];
  const binding = candidates.reduce((min, c) => (c.amount < min.amount ? c : min));
  const amount = roundCents(Math.max(0, binding.amount));
  if (amount + 1e-9 < SIZING_MIN_USD) {
    return {
      action: "SKIP",
      shares: 0,
      notional: 0,
      price,
      reason: `SKIP_${binding.reason} (capacity $${amount} < $${SIZING_MIN_USD})`,
    };
  }
  return {
    action: "BUY",
    shares: roundShares(amount / price),
    notional: roundUsd(amount),
    price,
    reason: `${COMPOUND_V2_PILOT_SIZING_RULE}: $${amount} (${COMPOUND_V2_PILOT_LABEL})`,
  };
}

export type SizingRuleBuyInput = {
  sizingRule: string;
  price: number;
  startingCash: number;
  cash: number;
  bookCapital: number;
  marketCostBasis: number;
  portfolioCostBasis: number;
};

/**
 * Explicit dispatch by sizing_rule. Every experiment's BUY sizing must go
 * through this function so behavior is chosen by data (sizing_rule), never by
 * which code path happens to run. A sizing_rule this dispatcher does not
 * recognize fails CLOSED (SKIP) rather than silently defaulting to any
 * specific formula — a bad or future sizing_rule value must never spend
 * simulated cash under the wrong rule.
 */
export function decideBuyForSizingRule(input: SizingRuleBuyInput): FollowerDecision {
  const { sizingRule, price, startingCash, cash, bookCapital, marketCostBasis, portfolioCostBasis } = input;
  if (sizingRule === "dynamic-v1") {
    return decideDynamicBuy({ price, startingCash, cash });
  }
  if (sizingRule === COMPOUND_V2_PILOT_SIZING_RULE) {
    return decideCompoundBuy({ price, bookCapital, cash, marketCostBasis, portfolioCostBasis });
  }
  return {
    action: "SKIP",
    shares: 0,
    notional: 0,
    price,
    reason: `UNKNOWN_SIZING_RULE: ${sizingRule}`,
  };
}

/** Deterministic fail-closed reason when a compound-rule BUY has no verified market grouping. */
export const COMPOUND_SIZING_MISSING_CONDITION_ID_REASON =
  "compound sizing unavailable: missing condition_id";

export type OpenCostBasisRow = { asset: string; costBasis: number };

/**
 * Groups open cost basis by market (condition_id) rather than by asset, so
 * compound sizing's 12% per-market cap applies across EVERY outcome-token
 * asset of the same Polymarket market (Yes/No are separate assets, one
 * market). An asset absent from assetToConditionId falls back to being its
 * own bucket here — that is only safe because the caller (shadow.server.ts)
 * fails the BUY closed for any CURRENT fill whose own market grouping is
 * unverified; this function only aggregates the exposure already on the
 * books, which must be counted somewhere regardless.
 */
export type MarketKeyResolution = { verified: true; marketKey: string } | { verified: false };

/**
 * Resolves the market grouping key a compound-rule BUY must use for its cap
 * checks. Fails closed (verified: false) — never silently falls back to
 * treating the asset as its own single-asset market — when neither this
 * event's own condition_id nor a condition_id cached from an earlier fill of
 * the same asset is available. A caller must SKIP the BUY when unverified;
 * it must never spend simulated cash under an unverified market grouping.
 */
export function resolveCompoundMarketKey(input: {
  conditionId: string | null;
  cachedConditionId: string | null;
}): MarketKeyResolution {
  const key = input.conditionId ?? input.cachedConditionId;
  return key === null ? { verified: false } : { verified: true, marketKey: key };
}

export function aggregateCostBasisByMarket(
  positions: OpenCostBasisRow[],
  assetToConditionId: ReadonlyMap<string, string>,
): { marketCostBasisByKey: Map<string, number>; portfolioCostBasisTotal: number } {
  const marketCostBasisByKey = new Map<string, number>();
  let portfolioCostBasisTotal = 0;
  for (const p of positions) {
    const key = assetToConditionId.get(p.asset) ?? p.asset;
    marketCostBasisByKey.set(key, roundUsd((marketCostBasisByKey.get(key) ?? 0) + p.costBasis));
    portfolioCostBasisTotal = roundUsd(portfolioCostBasisTotal + p.costBasis);
  }
  return { marketCostBasisByKey, portfolioCostBasisTotal };
}

/** BUY: spend the configured simulated amount at the source fill price. */
export function decideBuy(input: {
  price: number;
  buyAmount: number;
  availableCash: number;
}): FollowerDecision {
  const { price, buyAmount, availableCash } = input;
  if (!validPrice(price)) {
    return { action: "SKIP", shares: 0, notional: 0, price, reason: "Invalid source price" };
  }
  if (!(buyAmount > 0)) {
    return { action: "SKIP", shares: 0, notional: 0, price, reason: "Paper buy amount is zero" };
  }
  if (availableCash + 1e-9 < buyAmount) {
    return {
      action: "SKIP",
      shares: 0,
      notional: 0,
      price,
      reason: `Insufficient simulated cash (need ${buyAmount}, have ${roundUsd(availableCash)})`,
    };
  }
  return {
    action: "BUY",
    shares: roundShares(buyAmount / price),
    notional: roundUsd(buyAmount),
    price,
    reason: "Fixed simulated notional at source fill price",
  };
}

/**
 * SELL: proportional to what the SOURCE sold, never the whole paper position by default.
 * Source held 100 and sold 25 (25%) => paper holding 40 sells ~10.
 * Missing/inconsistent source state => SKIP with a reason (never guess).
 */
export function decideProportionalSell(input: {
  price: number;
  sourceSharesBefore: number | null;
  sourceSoldShares: number;
  paperShares: number;
}): FollowerDecision {
  const { price, sourceSharesBefore, sourceSoldShares, paperShares } = input;
  if (!validPrice(price)) {
    return { action: "SKIP", shares: 0, notional: 0, price, reason: "Invalid source price" };
  }
  if (sourceSharesBefore === null || !Number.isFinite(sourceSharesBefore)) {
    return {
      action: "SKIP",
      shares: 0,
      notional: 0,
      price,
      reason: "No source position state for this asset — proportional SELL skipped",
    };
  }
  if (sourceSharesBefore <= 0) {
    return {
      action: "SKIP",
      shares: 0,
      notional: 0,
      price,
      reason: "Inconsistent source state (source held 0 before this SELL) — skipped",
    };
  }
  if (!(sourceSoldShares > 0)) {
    return { action: "SKIP", shares: 0, notional: 0, price, reason: "Source sold zero shares" };
  }
  if (!(paperShares > 0)) {
    return {
      action: "SKIP",
      shares: 0,
      notional: 0,
      price,
      reason: "No simulated shares held for this asset",
    };
  }
  const fraction = Math.min(1, sourceSoldShares / sourceSharesBefore);
  const shares = roundShares(Math.min(paperShares, paperShares * fraction));
  if (!(shares > 0)) {
    return {
      action: "SKIP",
      shares: 0,
      notional: 0,
      price,
      reason: "Proportional size rounded to zero shares",
    };
  }
  return {
    action: "SELL",
    shares,
    notional: roundUsd(shares * price),
    price,
    reason: `Proportional: source sold ${(fraction * 100).toFixed(2)}% of its position`,
  };
}

/* ------------------------------------------------------------------ */
/* Paper accounting                                                    */
/* ------------------------------------------------------------------ */

export type PaperPositionState = {
  shares: number;
  costBasis: number;
  avgPrice: number;
  realizedPnl: number;
};

export const EMPTY_POSITION: PaperPositionState = {
  shares: 0,
  costBasis: 0,
  avgPrice: 0,
  realizedPnl: 0,
};

/**
 * A paper_positions row may only be written for an asset that either already had a
 * row, or was genuinely traded (BUY/SELL) in this batch. SKIP-only assets that were
 * never funded must never be persisted — that produced phantom "closed" positions.
 */
export function shouldPersistPaperPosition(input: {
  hadExistingRow: boolean;
  tradedThisBatch: boolean;
}): boolean {
  return input.hadExistingRow || input.tradedThisBatch;
}

/** Historical phantom row signature: closed with no cost basis and no realized P&L. */
export function isPhantomClosedPosition(row: {
  costBasis: number;
  realizedPnl: number;
}): boolean {
  return row.costBasis === 0 && row.realizedPnl === 0;
}

/* ------------------------------------------------------------------ */
/* Settlement finality                                                 */
/* ------------------------------------------------------------------ */

/**
 * Once a paper position reaches one of these, it is a closed historical
 * record: a later source event must never BUY, SELL, or otherwise mutate it.
 * Ordinary "closed" (flat from paper trading, not settlement) is NOT terminal
 * — that position may legitimately be reopened by a later source BUY.
 */
const TERMINAL_SETTLEMENT_STATUSES: ReadonlySet<string> = new Set(["settled_won", "settled_lost"]);

export function isTerminalSettlementStatus(status: string | null | undefined): boolean {
  return status != null && TERMINAL_SETTLEMENT_STATUSES.has(status);
}

/** Reason recorded on the paper_trades row for a late source event against an already-settled position. */
export const SETTLED_POSITION_SKIP_REASON =
  "Paper position already settled — late source event ignored";

/* ------------------------------------------------------------------ */
/* Atomic commit payload for process_source_event_atomic               */
/* ------------------------------------------------------------------ */

export type EventCommitInput = {
  sourceEventId: string;
  backfilled: boolean;
  sourceState: {
    wallet: string;
    asset: string;
    marketTitle: string | null;
    outcome: string | null;
    shares: number;
    lastEventKey: string;
    lastEventTs: number | null;
  };
  /** Null for pre-go-live history: source state advances, nothing is paper-copied. */
  trade: Record<string, unknown> | null;
  paperPosition: {
    asset: string;
    marketTitle: string | null;
    outcome: string | null;
    shares: number;
    costBasis: number;
    avgPrice: number;
    realizedPnl: number;
    lastActivityTs: number | null;
  } | null;
  experiment: { cash: number; realizedPnl: number } | null;
  audit: Record<string, unknown> | null;
};

/**
 * Builds the single jsonb document committed by process_source_event_atomic.
 * Every mutation for one source event travels together, so the database either
 * applies all of them or none of them.
 */
export function buildEventCommit(input: EventCommitInput): Record<string, unknown> {
  return {
    source_event_id: input.sourceEventId,
    backfilled: input.backfilled,
    source_state: {
      wallet: input.sourceState.wallet,
      asset: input.sourceState.asset,
      market_title: input.sourceState.marketTitle,
      outcome: input.sourceState.outcome,
      shares: input.sourceState.shares,
      last_event_key: input.sourceState.lastEventKey,
      last_event_ts: input.sourceState.lastEventTs,
    },
    trade: input.trade,
    paper_position: input.paperPosition
      ? {
          asset: input.paperPosition.asset,
          market_title: input.paperPosition.marketTitle,
          outcome: input.paperPosition.outcome,
          shares: input.paperPosition.shares,
          cost_basis: input.paperPosition.costBasis,
          avg_price: input.paperPosition.avgPrice,
          realized_pnl: input.paperPosition.realizedPnl,
          settlement_status: input.paperPosition.shares > 0 ? "open" : "closed",
          last_activity_ts: input.paperPosition.lastActivityTs,
        }
      : null,
    experiment: input.experiment
      ? { cash: input.experiment.cash, realized_pnl: input.experiment.realizedPnl }
      : null,
    audit: input.audit,
  };
}

export function applyBuy(
  position: PaperPositionState,
  cash: number,
  shares: number,
  notional: number,
): { position: PaperPositionState; cash: number } {
  const nextShares = roundShares(position.shares + shares);
  const nextBasis = roundUsd(position.costBasis + notional);
  return {
    position: {
      shares: nextShares,
      costBasis: nextBasis,
      avgPrice: nextShares > 0 ? nextBasis / nextShares : 0,
      realizedPnl: position.realizedPnl,
    },
    cash: roundUsd(cash - notional),
  };
}

export function applySell(
  position: PaperPositionState,
  cash: number,
  shares: number,
  price: number,
): { position: PaperPositionState; cash: number; realized: number; proceeds: number } {
  const sold = Math.min(position.shares, shares);
  const basisPortion = position.shares > 0 ? (position.costBasis * sold) / position.shares : 0;
  const proceeds = roundUsd(sold * price);
  const realized = roundUsd(proceeds - basisPortion);
  const nextShares = roundShares(position.shares - sold);
  const nextBasis = roundUsd(Math.max(0, position.costBasis - basisPortion));
  return {
    position: {
      shares: nextShares,
      costBasis: nextShares > 0 ? nextBasis : 0,
      avgPrice: nextShares > 0 ? nextBasis / nextShares : 0,
      realizedPnl: roundUsd(position.realizedPnl + realized),
    },
    cash: roundUsd(cash + proceeds),
    realized,
    proceeds,
  };
}

/* ------------------------------------------------------------------ */
/* Marks                                                               */
/* ------------------------------------------------------------------ */

/** A mark older than this is not trusted; open P&L becomes Unavailable (null). */
/**
 * Freshness requirement for a trustworthy mark: 120 seconds.
 *
 * A mark older than this is discarded (never reused, never replaced by the
 * entry price, zero, or a guess), so equity reads Unavailable instead of
 * pretending. 120s is supported by measured production runtime: a concurrent
 * book refresh returns ~32 books in ~350ms, so the largest open book of 200
 * positions completes in ~2-3s — two orders of magnitude inside the window.
 * The limiting factor is scheduler cadence per experiment, not the refresh
 * itself, so the honest response to a missed pass is Unavailable equity.
 */
export const MARK_MAX_AGE_MS = 120_000;

export type MarkInput = {
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  markTs: number | null;
  nowMs: number;
};

export type ResolvedMark = {
  mark: number | null;
  source: string | null;
  fresh: boolean;
};

/** Only produce a mark when the source is verifiable AND fresh. Never fabricate. */
export function resolveMark(input: MarkInput): ResolvedMark {
  const { bestBid, bestAsk, midpoint, markTs, nowMs } = input;
  if (markTs === null || !Number.isFinite(markTs)) return { mark: null, source: null, fresh: false };
  const age = nowMs - markTs;
  const fresh = age >= 0 && age < MARK_MAX_AGE_MS;
  if (!fresh) return { mark: null, source: null, fresh: false };
  if (bestBid !== null && bestAsk !== null && bestBid > 0 && bestAsk > 0) {
    return { mark: (bestBid + bestAsk) / 2, source: "clob_book_mid", fresh: true };
  }
  if (midpoint !== null && midpoint > 0) return { mark: midpoint, source: "clob_midpoint", fresh: true };
  /**
   * One-sided book with bids only: the best bid is a live, executable exit
   * price for a long paper position, so marking there is conservative and real
   * (never an entry price, a guess or a stale quote). An ask-only book has no
   * exit liquidity at all, so it stays Unavailable rather than being marked.
   */
  if (bestBid !== null && bestBid > 0 && (bestAsk === null || !(bestAsk > 0))) {
    return { mark: bestBid, source: "clob_best_bid", fresh: true };
  }
  return { mark: null, source: null, fresh: false };
}

/** Open P&L is null ("Unavailable") whenever there is no reliable fresh mark. */
export function openPnl(shares: number, costBasis: number, mark: number | null): number | null {
  if (mark === null) return null;
  return roundUsd(shares * mark - costBasis);
}
