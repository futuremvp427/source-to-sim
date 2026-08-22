/**
 * FINAL BUILD Part 4: control/baseline analysis — PURE math only.
 *
 * The mission names three candidate baselines and says to pick the best one honestly
 * implementable with CURRENT data, documenting why the others are not valid yet rather
 * than fabricating them:
 *
 *   (A) time-matched target-market observations WITHOUT a source signal -- NOT
 *       implemented. Sports Shadow's observation lane only ever fires FROM a detected
 *       source signal (worker.server.ts's source lane triggers observation.server.ts,
 *       see that module's own doc comment) -- there is no existing instrumentation that
 *       observes a target market's book at a comparable moment with NO signal present.
 *       Building this honestly would require a new, separate always-on sampling process
 *       (observing eligible markets on a fixed schedule regardless of source activity),
 *       which is new data collection this pass does not add.
 *
 *   (B) predeclared time-shift/randomized eligible-event sampling -- NOT implemented in
 *       this pass. It is plausible future work (the system already captures the SAME
 *       signal's price at +0/+5/+10/+30/+60 minute offsets, so an "enter at a
 *       predeclared alternate offset instead of the source's own detected moment"
 *       baseline is buildable from data already collected) -- but it needs its offset
 *       rule fixed and versioned in code BEFORE any epoch's results are inspected, to
 *       avoid the sampling rule itself being chosen with knowledge of what "looks like it
 *       would show no edge". No such frozen rule exists in this codebase yet; declaring
 *       one now, after paper-fill computation already exists and epochs may already have
 *       accumulated data under the current (unshifted) rule, risks exactly that
 *       contamination. Left as documented future work rather than implemented under
 *       time pressure with an undeclared, effectively-post-hoc rule.
 *
 *   (C) market-implied baseline expectancy -- IMPLEMENTED here. Requires zero new data
 *       collection: under the null hypothesis that PM-US/Kalshi prices are efficient
 *       (unbiased estimates of true settlement probability), the expected net P&L of
 *       buying ANY contract at its quoted price, before fees, is exactly zero -- the
 *       quoted price already prices in the probability of winning. The only genuinely
 *       expected cost under that null is the venue's own known, deterministic fee. This
 *       gives a baseline expectancy per episode of exactly `-average(fee)` with NO
 *       dependency on which side the source wallet happened to pick, and no hindsight:
 *       it uses only each episode's own already-known fee, computed identically whether
 *       the bet ultimately won or lost.
 */

import type { EpisodeOutcomeRow } from "./analytics";

export const BASELINE_VERSION = "MARKET_IMPLIED_V1";

function isSettled(row: EpisodeOutcomeRow): boolean {
  return row.settlementStatus === "SETTLED_WIN" || row.settlementStatus === "SETTLED_LOSS" || row.settlementStatus === "SETTLED_PUSH";
}

export type BaselineComparison = {
  version: string;
  method: "MARKET_IMPLIED_EXPECTANCY";
  sampleSize: number;
  /** -average(fee) over the SAME settled episode set the strategy result is computed from -- never a different, cherry-picked set. */
  baselineExpectancyPerEpisodeUsd: number;
  strategyExpectancyPerEpisodeUsd: number;
  /** strategyExpectancyPerEpisodeUsd - baselineExpectancyPerEpisodeUsd -- positive means the source-follow strategy beat the market-efficiency null by more than fees alone would predict. */
  edgeUsd: number;
};

/**
 * `rows` and `strategyExpectancyPerEpisodeUsd` should come from the SAME episode set
 * (normally analytics.ts's computeCoreMetrics.expectancyPerIndependentEpisode for the
 * declared strategy) -- the sampling rule (same episodes, same tier, same epoch window)
 * is fixed BEFORE this function ever looks at whether the result is favorable, since it
 * is simply "whatever the strategy's own already-computed episode set is".
 */
export function computeMarketImpliedBaseline(rows: readonly EpisodeOutcomeRow[], strategyExpectancyPerEpisodeUsd: number): BaselineComparison {
  const settledWithFee = rows.filter((r) => isSettled(r) && r.totalFeesUsd !== null);
  const sampleSize = settledWithFee.length;
  const averageFee = sampleSize > 0 ? settledWithFee.reduce((acc, r) => acc + (r.totalFeesUsd ?? 0), 0) / sampleSize : 0;
  const baselineExpectancyPerEpisodeUsd = sampleSize > 0 ? -averageFee : 0;
  return {
    version: BASELINE_VERSION,
    method: "MARKET_IMPLIED_EXPECTANCY",
    sampleSize,
    baselineExpectancyPerEpisodeUsd,
    strategyExpectancyPerEpisodeUsd,
    edgeUsd: strategyExpectancyPerEpisodeUsd - baselineExpectancyPerEpisodeUsd,
  };
}
