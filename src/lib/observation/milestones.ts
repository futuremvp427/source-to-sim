/**
 * OUT-OF-SAMPLE OBSERVATION MILESTONES — research flags only.
 *
 * These milestones are deliberately SEPARATE from the live-safety qualification
 * rules in src/lib/live-safety/core.ts. Reaching a milestone changes nothing:
 * it does not qualify a wallet, does not promote it, does not resize a bankroll
 * and does not enable execution. They exist so out-of-sample observation can be
 * tracked without retuning anything.
 */

export const OBSERVATION_MILESTONES = {
  /** Baseline out-of-sample observation window. */
  observationSettledDays: 7,
  /** Stronger evidence window. */
  strongerSettledDays: 14,
  /** Capital adequacy: cash-starved skip rate at or below this share of buy attempts. */
  capitalSkipRatePct: 20,
} as const;

export type MilestoneStatus = "reached" | "not_reached" | "unavailable";

export type Milestone = {
  key: "observation" | "stronger" | "capital" | "execution";
  label: string;
  target: string;
  observed: string;
  status: MilestoneStatus;
};

export type MilestoneInput = {
  settledDays: number;
  cashSkipRatePct: number | null;
  slippageAdjustedCumulativePnl: number | null;
};

export function buildMilestones(input: MilestoneInput): Milestone[] {
  const { settledDays, cashSkipRatePct, slippageAdjustedCumulativePnl } = input;

  const dayMilestone = (
    key: "observation" | "stronger",
    label: string,
    target: number,
  ): Milestone => ({
    key,
    label,
    target: `>= ${target} settled calendar days`,
    observed: `${settledDays} settled day${settledDays === 1 ? "" : "s"}`,
    status: settledDays >= target ? "reached" : "not_reached",
  });

  return [
    dayMilestone("observation", "Observation milestone", OBSERVATION_MILESTONES.observationSettledDays),
    dayMilestone("stronger", "Stronger milestone", OBSERVATION_MILESTONES.strongerSettledDays),
    {
      key: "capital",
      label: "Capital milestone",
      target: `V3 cash-starved skip rate <= ${OBSERVATION_MILESTONES.capitalSkipRatePct}%`,
      observed: cashSkipRatePct === null ? "Unavailable" : `${cashSkipRatePct.toFixed(1)}%`,
      status:
        cashSkipRatePct === null
          ? "unavailable"
          : cashSkipRatePct <= OBSERVATION_MILESTONES.capitalSkipRatePct
            ? "reached"
            : "not_reached",
    },
    {
      key: "execution",
      label: "Execution milestone",
      target: "Slippage-adjusted cumulative P&L stays positive",
      observed:
        slippageAdjustedCumulativePnl === null
          ? "Unavailable"
          : `${slippageAdjustedCumulativePnl >= 0 ? "+" : ""}${slippageAdjustedCumulativePnl.toFixed(2)}`,
      status:
        slippageAdjustedCumulativePnl === null
          ? "unavailable"
          : slippageAdjustedCumulativePnl > 0
            ? "reached"
            : "not_reached",
    },
  ];
}

/**
 * Estimated slippage-adjusted P&L for one settled market.
 *
 * A follower paying `slippageCents` above the leader's price buys fewer shares
 * for the same cash: shares scale by avgPrice / (avgPrice + slippage), so the
 * payout scales by the same factor while the cash outlay is unchanged. Returns
 * null when the inputs cannot support the estimate (fail-closed, never guessed).
 */
export function estimateSlippageAdjustedPnl(input: {
  shares: number;
  costBasis: number;
  payout: number;
  slippageCents: number | null;
}): number | null {
  const { shares, costBasis, payout, slippageCents } = input;
  if (slippageCents === null || !Number.isFinite(slippageCents) || slippageCents < 0) return null;
  if (!(shares > 0) || !(costBasis > 0)) return null;
  const avgPrice = costBasis / shares;
  const adjustedPrice = avgPrice + slippageCents / 100;
  if (!(adjustedPrice > 0)) return null;
  const adjustedShares = costBasis / adjustedPrice;
  const payoutPerShare = payout / shares;
  return payoutPerShare * adjustedShares - costBasis;
}
