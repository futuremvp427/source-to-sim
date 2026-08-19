/**
 * Phase 0B, Part 5: what does MERGE/SPLIT/REDEEM evidence (captured for the
 * V2/V3 cohort as of the Phase 0A remediation) say about wallet behavior?
 *
 * Pure function over already-computed WalletBehaviorMetrics (see
 * wallet-behavior.ts). Does NOT convert any activity into a paper
 * accounting exit -- this module only produces a read-only interpretive
 * report on four specific hypotheses named in the Phase 0B brief.
 */

import type { WalletBehaviorMetrics } from "./wallet-behavior";

export type ActivityHypothesis =
  | "MARKET_MAKING"
  | "COMPLETING_COMPLEMENTARY_POSITIONS"
  | "HOLDING_TO_SETTLEMENT"
  | "MERGE_REDEEM_AS_EXIT_MECHANISM";

export type ActivitySupportVerdict = "SUPPORTS" | "WEAKENS" | "INSUFFICIENT_EVIDENCE";

export type ActivityHypothesisResult = {
  hypothesis: ActivityHypothesis;
  verdict: ActivitySupportVerdict;
  evidence: string[];
};

const MIN_ACTIVITY_EVENTS_FOR_EVIDENCE = 5;

export function evaluateNonTradeActivityHypotheses(
  metrics: WalletBehaviorMetrics,
): ActivityHypothesisResult[] {
  const { merge, split, redeem } = metrics.activityCounts;
  const totalActivity = merge + split + redeem;
  const bothOutcomesPct = metrics.pctMarketsBothOutcomesTraded ?? 0;
  const fastPairFraction = metrics.fractionOpposingPairsWithin5Min ?? 0;

  const results: ActivityHypothesisResult[] = [];

  // --- MARKET_MAKING: merge/split-heavy activity combined with fast, broad two-sided trading. ---
  if (totalActivity < MIN_ACTIVITY_EVENTS_FOR_EVIDENCE) {
    results.push({
      hypothesis: "MARKET_MAKING",
      verdict: "INSUFFICIENT_EVIDENCE",
      evidence: [
        `Only ${totalActivity} MERGE/SPLIT/REDEEM events observed -- too few to support or weaken this hypothesis.`,
      ],
    });
  } else if (bothOutcomesPct > 0.6 && fastPairFraction > 0.5 && (merge > 0 || split > 0)) {
    results.push({
      hypothesis: "MARKET_MAKING",
      verdict: "SUPPORTS",
      evidence: [
        `${merge} MERGE + ${split} SPLIT events alongside both-outcomes trading in ` +
          `${(bothOutcomesPct * 100).toFixed(0)}% of markets and ${(fastPairFraction * 100).toFixed(0)}% ` +
          "fast opposing-side pairs -- consistent with continuously flattening two-sided inventory.",
      ],
    });
  } else {
    results.push({
      hypothesis: "MARKET_MAKING",
      verdict: "WEAKENS",
      evidence: [
        `${totalActivity} MERGE/SPLIT/REDEEM events present, but two-sided trading is not both broad (` +
          `${(bothOutcomesPct * 100).toFixed(0)}% of markets) and fast (${(fastPairFraction * 100).toFixed(0)}% ` +
          "of opposing pairs within 5 min) at once -- the activity looks more incidental than structural.",
      ],
    });
  }

  // --- COMPLETING_COMPLEMENTARY_POSITIONS: merge/split follows acquiring both legs. ---
  if (totalActivity < MIN_ACTIVITY_EVENTS_FOR_EVIDENCE) {
    results.push({
      hypothesis: "COMPLETING_COMPLEMENTARY_POSITIONS",
      verdict: "INSUFFICIENT_EVIDENCE",
      evidence: [
        `Only ${totalActivity} MERGE/SPLIT/REDEEM events observed -- too few to evaluate.`,
      ],
    });
  } else if ((merge > 0 || split > 0) && bothOutcomesPct > 0.4) {
    results.push({
      hypothesis: "COMPLETING_COMPLEMENTARY_POSITIONS",
      verdict: "SUPPORTS",
      evidence: [
        `${merge + split} MERGE/SPLIT events co-occur with both-outcomes trading in ` +
          `${(bothOutcomesPct * 100).toFixed(0)}% of markets -- consistent with acquiring the complementary ` +
          "leg and then completing (merging) or creating (splitting) the pair, rather than holding a naked position.",
      ],
    });
  } else if (bothOutcomesPct > 0.4 && merge === 0 && split === 0) {
    results.push({
      hypothesis: "COMPLETING_COMPLEMENTARY_POSITIONS",
      verdict: "WEAKENS",
      evidence: [
        `Both outcomes are traded in ${(bothOutcomesPct * 100).toFixed(0)}% of markets, but zero MERGE/SPLIT ` +
          "events were observed -- the wallet appears to hold both legs rather than ever completing/redeeming the pair.",
      ],
    });
  } else {
    results.push({
      hypothesis: "COMPLETING_COMPLEMENTARY_POSITIONS",
      verdict: "INSUFFICIENT_EVIDENCE",
      evidence: [
        "Neither both-outcomes trading nor MERGE/SPLIT activity is prominent enough to evaluate this hypothesis.",
      ],
    });
  }

  // --- HOLDING_TO_SETTLEMENT: net-open positions rarely reduced within the window. ---
  if (metrics.fractionPositionsHeldOpenThroughWindow === null) {
    results.push({
      hypothesis: "HOLDING_TO_SETTLEMENT",
      verdict: "INSUFFICIENT_EVIDENCE",
      evidence: [
        "No net-opened positions were observed in the window (every position was fully offset by a SELL).",
      ],
    });
  } else if (metrics.fractionPositionsHeldOpenThroughWindow > 0.6) {
    results.push({
      hypothesis: "HOLDING_TO_SETTLEMENT",
      verdict: "SUPPORTS",
      evidence: [
        `${(metrics.fractionPositionsHeldOpenThroughWindow * 100).toFixed(0)}% of net-opened positions were ` +
          "never reduced by a SELL, MERGE, or REDEEM within the observed window -- consistent with riding the position to settlement.",
      ],
    });
  } else {
    results.push({
      hypothesis: "HOLDING_TO_SETTLEMENT",
      verdict: "WEAKENS",
      evidence: [
        `Only ${(metrics.fractionPositionsHeldOpenThroughWindow * 100).toFixed(0)}% of net-opened positions were ` +
          "held open through the window -- most positions were actively reduced, not ridden to settlement.",
      ],
    });
  }

  // --- MERGE_REDEEM_AS_EXIT_MECHANISM: merge/redeem volume relative to SELL volume. ---
  const mergeRedeemCount = merge + redeem;
  if (mergeRedeemCount === 0 && metrics.sellCount === 0) {
    results.push({
      hypothesis: "MERGE_REDEEM_AS_EXIT_MECHANISM",
      verdict: "INSUFFICIENT_EVIDENCE",
      evidence: [
        "No SELL trades and no MERGE/REDEEM activity observed -- no exit behavior of any kind to evaluate.",
      ],
    });
  } else {
    const ratio = mergeRedeemCount / Math.max(metrics.sellCount, 1);
    if (ratio >= 1) {
      results.push({
        hypothesis: "MERGE_REDEEM_AS_EXIT_MECHANISM",
        verdict: "SUPPORTS",
        evidence: [
          `${mergeRedeemCount} MERGE+REDEEM events vs. only ${metrics.sellCount} SELL trades ` +
            `(ratio ${ratio.toFixed(2)}) -- the wallet exits positions via merge/redeem at least as often as via a literal SELL order. ` +
            "This directly supports the Phase 0A hypothesis that 'zero/few SELL events' for merge-heavy wallets reflects a real exit " +
            "mechanism our pipeline previously could not see, not necessarily an absence of exits.",
        ],
      });
    } else {
      results.push({
        hypothesis: "MERGE_REDEEM_AS_EXIT_MECHANISM",
        verdict: mergeRedeemCount > 0 ? "WEAKENS" : "WEAKENS",
        evidence: [
          `${mergeRedeemCount} MERGE+REDEEM events vs. ${metrics.sellCount} SELL trades (ratio ${ratio.toFixed(2)}) -- ` +
            "SELL remains the dominant exit path for this wallet; merge/redeem is a secondary or negligible mechanism.",
        ],
      });
    }
  }

  return results;
}
