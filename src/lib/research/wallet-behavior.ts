/**
 * Phase 0B, Part 1: wallet behavior classification.
 *
 * Pure, DB-free analysis over a wallet's already-ingested source_events (+
 * general_activity, where available) for one wallet. No network access, no
 * database access -- this module only computes metrics and a classification
 * from rows the caller supplies (see wallet-behavior.server.ts for the DB
 * fetch wrapper, which is not unit-testable in this environment).
 *
 * IMPORTANT (explicit per Phase 0B instructions): trading both outcome
 * tokens of a market is NOT, by itself, evidence of market-making. Every
 * classification below requires multiple corroborating signals, and low
 * sample size fails closed to UNKNOWN rather than forcing a label.
 */

export type TradeSide = "BUY" | "SELL";

export type SourceEventRow = {
  conditionId: string | null;
  /** Fallback grouping key when conditionId is null (should be rare). */
  marketTitle: string;
  asset: string;
  outcome: string | null; // "YES" | "NO" | null
  side: TradeSide;
  price: number; // 0..1
  shares: number;
  sourceTs: number; // unix seconds
};

export type NonTradeActivityRow = {
  conditionId: string | null;
  asset: string | null;
  activityType: string; // MERGE | SPLIT | REDEEM | REWARD | CONVERSION | ...
  sourceTs: number;
};

export type WalletBehaviorMetrics = {
  windowDays: number;
  eventCount: number;
  tradesPerDay: number;
  distinctMarkets: number;
  distinctMarketsPerDay: number;
  notional: { mean: number; median: number; p10: number; p25: number; p75: number; p90: number };
  buyCount: number;
  sellCount: number;
  buySellRatio: number | null; // buyCount / sellCount, null if sellCount === 0
  activityCounts: { merge: number; split: number; redeem: number; other: number };
  /** Fraction of distinct markets where both YES and NO were traded at least once. */
  pctMarketsBothOutcomesTraded: number | null;
  /** Among markets with both outcomes traded, median seconds between the first trade of one outcome and the next trade of the opposing outcome. */
  medianSecondsBetweenOpposingTrades: number | null;
  /** Among markets with both outcomes traded, fraction of opposing-outcome pairs that occur within 5 minutes of each other. */
  fractionOpposingPairsWithin5Min: number | null;
  /** Herfindahl-Hirschman index (0..1) of notional concentration across distinct markets. 1 = all notional in one market. */
  positionConcentrationHhi: number;
  avgEntryPrice: { buy: number | null; sell: number | null };
  tradeSize: { mean: number; median: number; p10: number; p90: number };
  /** Fraction of trades below smallFillUsd that occur within 5 minutes of another trade on the same asset. */
  repeatedSmallFillFraction: number;
  /** Among markets with a net-opened position (more BUY than SELL+MERGE-implied-exit shares), fraction never reduced within the observed window. */
  fractionPositionsHeldOpenThroughWindow: number | null;
};

export type Classification =
  "DIRECTIONAL" | "MARKET_MAKER_LIKE" | "ARBITRAGE_LIKE" | "MIXED" | "UNKNOWN";

export type Confidence = "low" | "medium" | "high";

export type ClassificationResult = {
  classification: Classification;
  confidence: Confidence;
  evidenceFor: string[];
  evidenceAgainst: string[];
  /** Raw per-hypothesis scores, for transparency/debugging. */
  scores: Record<Exclude<Classification, "UNKNOWN" | "MIXED">, number>;
};

const SMALL_FILL_USD = 10;
const OPPOSING_PAIR_FAST_SECONDS = 5 * 60;
const MIN_TRADES_FOR_CLASSIFICATION = 20;
const MIN_DISTINCT_MARKETS_FOR_CLASSIFICATION = 5;

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0]!;
  const idx = (sortedValues.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo]!;
  const frac = idx - lo;
  return sortedValues[lo]! * (1 - frac) + sortedValues[hi]! * frac;
}

function median(sortedValues: number[]): number {
  return percentile(sortedValues, 0.5);
}

function marketKey(row: SourceEventRow): string {
  return row.conditionId ?? `title:${row.marketTitle}`;
}

/** Pure. No DB/network access. */
export function computeWalletBehaviorMetrics(
  events: SourceEventRow[],
  activity: NonTradeActivityRow[] = [],
): WalletBehaviorMetrics {
  const sortedByTs = [...events].sort((a, b) => a.sourceTs - b.sourceTs);
  const eventCount = sortedByTs.length;
  const firstTs = sortedByTs[0]?.sourceTs ?? 0;
  const lastTs = sortedByTs[sortedByTs.length - 1]?.sourceTs ?? 0;
  const windowDays = eventCount > 0 ? Math.max(1, (lastTs - firstTs) / 86_400) : 0;

  const notionals = sortedByTs.map((e) => e.price * e.shares).sort((a, b) => a - b);
  const buys = sortedByTs.filter((e) => e.side === "BUY");
  const sells = sortedByTs.filter((e) => e.side === "SELL");

  const byMarket = new Map<string, SourceEventRow[]>();
  for (const e of sortedByTs) {
    const key = marketKey(e);
    const list = byMarket.get(key) ?? [];
    list.push(e);
    byMarket.set(key, list);
  }
  const distinctMarkets = byMarket.size;

  // Both-outcomes-traded + opposing-pair timing, per market.
  let marketsWithBothOutcomes = 0;
  const gapSecondsAcrossPairs: number[] = [];
  let fastPairs = 0;
  let totalPairs = 0;
  for (const rows of byMarket.values()) {
    const outcomes = new Set(rows.map((r) => r.outcome).filter((o): o is string => o !== null));
    if (outcomes.size < 2) continue;
    marketsWithBothOutcomes += 1;
    // Walk chronologically; every time the outcome changes from the previous
    // trade, record the gap as one "opposing pair".
    const chrono = [...rows].sort((a, b) => a.sourceTs - b.sourceTs);
    for (let i = 1; i < chrono.length; i += 1) {
      const prev = chrono[i - 1]!;
      const cur = chrono[i]!;
      if (prev.outcome !== null && cur.outcome !== null && prev.outcome !== cur.outcome) {
        const gap = cur.sourceTs - prev.sourceTs;
        gapSecondsAcrossPairs.push(gap);
        totalPairs += 1;
        if (gap <= OPPOSING_PAIR_FAST_SECONDS) fastPairs += 1;
      }
    }
  }
  const marketsWithOutcomeInfo = [...byMarket.values()].filter((rows) =>
    rows.some((r) => r.outcome !== null),
  ).length;

  // Position concentration (HHI over notional per market).
  const notionalByMarket = new Map<string, number>();
  let totalNotional = 0;
  for (const e of sortedByTs) {
    const key = marketKey(e);
    const n = e.price * e.shares;
    notionalByMarket.set(key, (notionalByMarket.get(key) ?? 0) + n);
    totalNotional += n;
  }
  const hhi =
    totalNotional > 0
      ? [...notionalByMarket.values()].reduce((sum, n) => sum + (n / totalNotional) ** 2, 0)
      : 0;

  // Repeated small-fill behavior: small trades clustered in time on the same asset.
  const byAsset = new Map<string, SourceEventRow[]>();
  for (const e of sortedByTs) {
    const list = byAsset.get(e.asset) ?? [];
    list.push(e);
    byAsset.set(e.asset, list);
  }
  let smallFillCount = 0;
  let repeatedSmallFillCount = 0;
  for (const rows of byAsset.values()) {
    const chrono = [...rows].sort((a, b) => a.sourceTs - b.sourceTs);
    for (let i = 0; i < chrono.length; i += 1) {
      const row = chrono[i]!;
      if (row.price * row.shares >= SMALL_FILL_USD) continue;
      smallFillCount += 1;
      const near = chrono.some(
        (other, j) =>
          j !== i && Math.abs(other.sourceTs - row.sourceTs) <= OPPOSING_PAIR_FAST_SECONDS,
      );
      if (near) repeatedSmallFillCount += 1;
    }
  }

  // Held-open-through-window: net BUY shares minus SELL shares minus
  // MERGE/REDEEM shares (best-effort; general_activity does not always carry
  // shares) remains positive at the end of the observed window.
  const activityByAsset = new Map<string, NonTradeActivityRow[]>();
  for (const a of activity) {
    if (!a.asset) continue;
    const list = activityByAsset.get(a.asset) ?? [];
    list.push(a);
    activityByAsset.set(a.asset, list);
  }
  let positionsWithNetOpen = 0;
  let positionsHeldOpen = 0;
  for (const [asset, rows] of byAsset) {
    const netShares = rows.reduce((sum, r) => sum + (r.side === "BUY" ? r.shares : -r.shares), 0);
    if (netShares <= 0) continue;
    positionsWithNetOpen += 1;
    const closingActivity = (activityByAsset.get(asset) ?? []).some(
      (a) => a.activityType === "MERGE" || a.activityType === "REDEEM",
    );
    if (!closingActivity) positionsHeldOpen += 1;
  }

  const activityCounts = { merge: 0, split: 0, redeem: 0, other: 0 };
  for (const a of activity) {
    if (a.activityType === "MERGE") activityCounts.merge += 1;
    else if (a.activityType === "SPLIT") activityCounts.split += 1;
    else if (a.activityType === "REDEEM") activityCounts.redeem += 1;
    else activityCounts.other += 1;
  }

  const gapsSorted = [...gapSecondsAcrossPairs].sort((a, b) => a - b);
  const buyPrices = buys.map((b) => b.price).sort((a, b) => a - b);
  const sellPrices = sells.map((s) => s.price).sort((a, b) => a - b);
  const sizesSorted = sortedByTs.map((e) => e.shares).sort((a, b) => a - b);

  return {
    windowDays,
    eventCount,
    tradesPerDay: eventCount / windowDays,
    distinctMarkets,
    distinctMarketsPerDay: distinctMarkets / windowDays,
    notional: {
      mean: mean(notionals),
      median: median(notionals),
      p10: percentile(notionals, 0.1),
      p25: percentile(notionals, 0.25),
      p75: percentile(notionals, 0.75),
      p90: percentile(notionals, 0.9),
    },
    buyCount: buys.length,
    sellCount: sells.length,
    buySellRatio: sells.length > 0 ? buys.length / sells.length : null,
    activityCounts,
    pctMarketsBothOutcomesTraded:
      marketsWithOutcomeInfo > 0 ? marketsWithBothOutcomes / marketsWithOutcomeInfo : null,
    medianSecondsBetweenOpposingTrades: gapsSorted.length > 0 ? median(gapsSorted) : null,
    fractionOpposingPairsWithin5Min: totalPairs > 0 ? fastPairs / totalPairs : null,
    positionConcentrationHhi: hhi,
    avgEntryPrice: {
      buy: buyPrices.length > 0 ? mean(buyPrices) : null,
      sell: sellPrices.length > 0 ? mean(sellPrices) : null,
    },
    tradeSize: {
      mean: mean(sizesSorted),
      median: median(sizesSorted),
      p10: percentile(sizesSorted, 0.1),
      p90: percentile(sizesSorted, 0.9),
    },
    repeatedSmallFillFraction: smallFillCount > 0 ? repeatedSmallFillCount / smallFillCount : 0,
    fractionPositionsHeldOpenThroughWindow:
      positionsWithNetOpen > 0 ? positionsHeldOpen / positionsWithNetOpen : null,
  };
}

/**
 * Pure scoring heuristic. Requires MULTIPLE corroborating signals per
 * hypothesis -- trading both outcomes of a market alone never scores
 * MARKET_MAKER_LIKE or ARBITRAGE_LIKE on its own (see the individual
 * `evidenceFor` gates below, each of which is a conjunction, not a single
 * signal). Fails closed to UNKNOWN under low sample size.
 */
export function classifyWalletBehavior(metrics: WalletBehaviorMetrics): ClassificationResult {
  if (
    metrics.eventCount < MIN_TRADES_FOR_CLASSIFICATION ||
    metrics.distinctMarkets < MIN_DISTINCT_MARKETS_FOR_CLASSIFICATION
  ) {
    return {
      classification: "UNKNOWN",
      confidence: "low",
      evidenceFor: [],
      evidenceAgainst: [
        `Only ${metrics.eventCount} trades across ${metrics.distinctMarkets} markets -- below the ` +
          `minimum (${MIN_TRADES_FOR_CLASSIFICATION} trades, ${MIN_DISTINCT_MARKETS_FOR_CLASSIFICATION} markets) ` +
          "for a classification to be evidence-based rather than noise.",
      ],
      scores: { DIRECTIONAL: 0, MARKET_MAKER_LIKE: 0, ARBITRAGE_LIKE: 0 },
    };
  }

  const evidenceFor: string[] = [];
  const evidenceAgainst: string[] = [];
  let mmScore = 0;
  let arbScore = 0;
  let dirScore = 0;

  const bothOutcomesPct = metrics.pctMarketsBothOutcomesTraded ?? 0;
  const fastPairFraction = metrics.fractionOpposingPairsWithin5Min ?? 0;
  const medianGap = metrics.medianSecondsBetweenOpposingTrades;

  // --- MARKET_MAKER_LIKE: needs breadth (both sides) AND speed AND small/repeated fills AND diffusion. ---
  if (bothOutcomesPct > 0.6) {
    if (fastPairFraction > 0.5) {
      mmScore += 2;
      evidenceFor.push(
        `Both outcomes traded in ${(bothOutcomesPct * 100).toFixed(0)}% of markets, with ` +
          `${(fastPairFraction * 100).toFixed(0)}% of opposing-side pairs occurring within 5 minutes -- ` +
          "consistent with two-sided quoting, not merely occasional hedging.",
      );
    } else {
      evidenceAgainst.push(
        `Both outcomes traded in ${(bothOutcomesPct * 100).toFixed(0)}% of markets, but opposing trades ` +
          "are NOT clustered in time (median gap " +
          (medianGap === null ? "unavailable" : `${Math.round(medianGap / 60)} min`) +
          ") -- this alone does not indicate market-making per the Phase 0B instruction that trading " +
          "both sides is not itself evidence.",
      );
    }
    if (metrics.repeatedSmallFillFraction > 0.4) {
      mmScore += 1;
      evidenceFor.push(
        `${(metrics.repeatedSmallFillFraction * 100).toFixed(0)}% of small fills (< $${SMALL_FILL_USD}) ` +
          "cluster with another trade on the same asset within 5 minutes -- consistent with resting-order fills.",
      );
    }
    if (metrics.positionConcentrationHhi < 0.15) {
      mmScore += 1;
      evidenceFor.push(
        `Low position concentration (HHI ${metrics.positionConcentrationHhi.toFixed(3)}) across ` +
          `${metrics.distinctMarkets} markets -- capital diffused rather than concentrated in a few convictions.`,
      );
    }
  } else {
    evidenceAgainst.push(
      `Both outcomes traded in only ${(bothOutcomesPct * 100).toFixed(0)}% of markets -- ` +
        "not broad two-sided activity.",
    );
  }

  // --- ARBITRAGE_LIKE: needs near-simultaneous opposing trades AND merge/split activity. ---
  // Weighted above the generic MM combo: near-simultaneous opposing trades
  // immediately followed by MERGE/SPLIT is a more specific, mechanically
  // distinct explanation (basis capture) than plain two-sided quoting, so
  // when both signatures are present this hypothesis should win.
  if (
    fastPairFraction > 0.7 &&
    (metrics.activityCounts.merge > 0 || metrics.activityCounts.split > 0)
  ) {
    arbScore += 3;
    evidenceFor.push(
      `${(fastPairFraction * 100).toFixed(0)}% of opposing-side pairs within 5 minutes, combined with ` +
        `${metrics.activityCounts.merge} MERGE and ${metrics.activityCounts.split} SPLIT activity events -- ` +
        "consistent with acquiring both legs then completing/redeeming the pair for the basis, rather than a directional bet.",
    );
  } else if (metrics.activityCounts.merge > 0 || metrics.activityCounts.split > 0) {
    evidenceAgainst.push(
      `MERGE/SPLIT activity present (${metrics.activityCounts.merge}/${metrics.activityCounts.split}) ` +
        "but opposing-side trades are not tightly time-clustered -- weaker evidence for basis arbitrage.",
    );
  }

  // --- DIRECTIONAL: needs narrow outcome commitment AND independent (slow) re-entries AND concentration AND holding behavior. ---
  if (bothOutcomesPct < 0.3) {
    dirScore += 1;
    evidenceFor.push(
      `Both outcomes traded in only ${(bothOutcomesPct * 100).toFixed(0)}% of markets -- ` +
        "predominantly single-outcome commitment per market.",
    );
  }
  if (metrics.positionConcentrationHhi > 0.3) {
    dirScore += 1;
    evidenceFor.push(
      `Higher position concentration (HHI ${metrics.positionConcentrationHhi.toFixed(3)}) -- ` +
        "capital concentrated in fewer, larger convictions rather than diffused across many small positions.",
    );
  }
  if (
    metrics.fractionPositionsHeldOpenThroughWindow !== null &&
    metrics.fractionPositionsHeldOpenThroughWindow > 0.6
  ) {
    dirScore += 1;
    evidenceFor.push(
      `${(metrics.fractionPositionsHeldOpenThroughWindow * 100).toFixed(0)}% of net-opened positions were ` +
        "never reduced (SELL/MERGE) within the observed window -- consistent with holding a directional view to settlement.",
    );
  }
  if (metrics.repeatedSmallFillFraction < 0.15) {
    dirScore += 1;
    evidenceFor.push(
      `Only ${(metrics.repeatedSmallFillFraction * 100).toFixed(0)}% of small fills cluster with another ` +
        "trade in time -- fills look like independent decisions, not resting-order execution.",
    );
  }

  const scores = { DIRECTIONAL: dirScore, MARKET_MAKER_LIKE: mmScore, ARBITRAGE_LIKE: arbScore };
  const maxScore = Math.max(dirScore, mmScore, arbScore);
  const strongThreshold = 3;

  let classification: Classification;
  const contenders = (Object.entries(scores) as [Classification, number][]).filter(
    ([, s]) => s === maxScore && s > 0,
  );
  if (maxScore === 0) {
    classification = "UNKNOWN";
    evidenceAgainst.push("No hypothesis accumulated any corroborating evidence.");
  } else if (contenders.length > 1) {
    classification = "MIXED";
  } else if (maxScore < strongThreshold) {
    // A single weak signal is not enough to commit to a label.
    classification = "MIXED";
    evidenceAgainst.push(
      `Leading hypothesis (${contenders[0]![0]}) scored only ${maxScore}/${strongThreshold}+ -- ` +
        "too weak on its own to commit to a single classification.",
    );
  } else {
    classification = contenders[0]![0];
  }

  const confidence: Confidence =
    classification === "UNKNOWN"
      ? "low"
      : maxScore >= 4 && metrics.eventCount >= 100
        ? "high"
        : maxScore >= 3 && metrics.eventCount >= 40
          ? "medium"
          : "low";

  return { classification, confidence, evidenceFor, evidenceAgainst, scores };
}
