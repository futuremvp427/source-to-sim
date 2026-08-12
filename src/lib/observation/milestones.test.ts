import { describe, expect, it } from "vitest";

import { buildMilestones, estimateSlippageAdjustedPnl } from "./milestones";

const base = { settledDays: 3, cashSkipRatePct: 24.3, slippageAdjustedCumulativePnl: 325.89 };

describe("observation milestones", () => {
  it("flags the 7-day and 14-day windows as not reached at 3 settled days", () => {
    const m = buildMilestones(base);
    expect(m.find((x) => x.key === "observation")?.status).toBe("not_reached");
    expect(m.find((x) => x.key === "stronger")?.status).toBe("not_reached");
  });

  it("reaches the observation milestone at 7 settled days but not the stronger one", () => {
    const m = buildMilestones({ ...base, settledDays: 7 });
    expect(m.find((x) => x.key === "observation")?.status).toBe("reached");
    expect(m.find((x) => x.key === "stronger")?.status).toBe("not_reached");
  });

  it("reaches the capital milestone only at or below a 20% skip rate", () => {
    expect(buildMilestones({ ...base, cashSkipRatePct: 20 }).find((x) => x.key === "capital")?.status).toBe("reached");
    expect(buildMilestones({ ...base, cashSkipRatePct: 20.1 }).find((x) => x.key === "capital")?.status).toBe("not_reached");
  });

  it("reports unavailable rather than guessing when inputs are missing", () => {
    const m = buildMilestones({ settledDays: 3, cashSkipRatePct: null, slippageAdjustedCumulativePnl: null });
    expect(m.find((x) => x.key === "capital")?.status).toBe("unavailable");
    expect(m.find((x) => x.key === "execution")?.status).toBe("unavailable");
  });

  it("fails the execution milestone when the slippage-adjusted total is not positive", () => {
    const m = buildMilestones({ ...base, slippageAdjustedCumulativePnl: -1.5 });
    expect(m.find((x) => x.key === "execution")?.status).toBe("not_reached");
  });
});

describe("estimateSlippageAdjustedPnl", () => {
  it("shrinks a winning payout by the share loss from paying up", () => {
    // 10 shares at $0.50 = $5 cost, winner pays $10. At 3c slippage the follower
    // buys 5/0.53 = 9.4340 shares, so payout is 9.4340 * $1 = $9.43.
    const v = estimateSlippageAdjustedPnl({ shares: 10, costBasis: 5, payout: 10, slippageCents: 3 });
    expect(v).toBeCloseTo(4.4340, 3);
  });

  it("leaves a total loss unchanged", () => {
    expect(estimateSlippageAdjustedPnl({ shares: 10, costBasis: 5, payout: 0, slippageCents: 3 })).toBe(-5);
  });

  it("returns null when slippage is unknown", () => {
    expect(estimateSlippageAdjustedPnl({ shares: 10, costBasis: 5, payout: 10, slippageCents: null })).toBeNull();
  });
});
