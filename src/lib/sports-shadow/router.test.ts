import { describe, expect, it } from "vitest";

import type { DepthWalkResult } from "./depth-walk";
import type { FeeResult } from "./fees";
import { routeExecution } from "./router";

function fullFill(overrides: Partial<DepthWalkResult> = {}): DepthWalkResult {
  return {
    status: "FULL",
    requestedNotionalUsd: 100,
    filledNotionalUsd: 100,
    unfilledNotionalUsd: 0,
    fillRatio: 1,
    contractsFilled: 200,
    averageExecutionPrice: 0.5,
    bestAvailablePrice: 0.49,
    worstExecutionPrice: 0.51,
    levelsConsumed: 2,
    fills: [{ price: 0.49, contracts: 100 }, { price: 0.51, contracts: 100 }],
    priceImpact: 0.01,
    priceImpactCents: 1,
    invalidReason: null,
    ...overrides,
  };
}

function validFee(feeUsd: number): FeeResult {
  return { feeUsd, valid: true, reason: null, feeModelVersion: "TEST_V1", effectiveDate: "2026-01-01" };
}

const NOW = 1_700_000_000_000;

describe("FINAL BUILD Part 12: no-hindsight router", () => {
  it("T-router-1: PM-US wins when it has strictly lower all-in cost per contract at equal fill ratio", () => {
    const decision = routeExecution(
      100,
      { available: true, depthWalk: fullFill({ contractsFilled: 200, filledNotionalUsd: 100 }), fee: validFee(1) }, // 101/200 = 0.505/contract
      { available: true, depthWalk: fullFill({ contractsFilled: 200, filledNotionalUsd: 100 }), fee: validFee(2) }, // 102/200 = 0.51/contract
      NOW,
    );
    expect(decision.chosenVenue).toBe("PMUS");
    expect(decision.pmus.disqualifiedReason).toBeNull();
    expect(decision.kalshi.disqualifiedReason).toBeNull(); // still qualifies -- counterfactual preserved even though not chosen
    expect(decision.rejectReason).toBeNull();
  });

  it("T-router-2: Kalshi wins when it has strictly lower all-in cost per contract at equal fill ratio", () => {
    const decision = routeExecution(
      100,
      { available: true, depthWalk: fullFill(), fee: validFee(5) },
      { available: true, depthWalk: fullFill(), fee: validFee(1) },
      NOW,
    );
    expect(decision.chosenVenue).toBe("KALSHI");
  });

  it("T-router-3: higher fillRatio wins even if the fuller fill has a slightly worse per-contract cost -- capacity beats marginal price", () => {
    const decision = routeExecution(
      100,
      { available: true, depthWalk: fullFill({ status: "FULL", fillRatio: 1, filledNotionalUsd: 100, contractsFilled: 190 }), fee: validFee(3) },
      { available: true, depthWalk: fullFill({ status: "PARTIAL", fillRatio: 0.4, filledNotionalUsd: 40, contractsFilled: 100 }), fee: validFee(0.5) },
      NOW,
    );
    expect(decision.chosenVenue).toBe("PMUS"); // fillRatio 1 > 0.4, regardless of Kalshi's cheaper per-contract cost
  });

  it("T-router-4: only PM-US available -- Kalshi selected only if it independently qualifies, never chosen by elimination alone if it also fails", () => {
    const decision = routeExecution(
      100,
      { available: true, depthWalk: fullFill(), fee: validFee(1) },
      { available: false, depthWalk: null, fee: null },
      NOW,
    );
    expect(decision.chosenVenue).toBe("PMUS");
    expect(decision.kalshi.disqualifiedReason).toMatch(/unavailable/);
    expect(decision.rejectReason).toBeNull();
  });

  it("T-router-5: only Kalshi available", () => {
    const decision = routeExecution(
      100,
      { available: false, depthWalk: null, fee: null },
      { available: true, depthWalk: fullFill(), fee: validFee(1) },
      NOW,
    );
    expect(decision.chosenVenue).toBe("KALSHI");
  });

  it("T-router-6: neither venue available -> REJECT, with both disqualification reasons preserved", () => {
    const decision = routeExecution(100, { available: false, depthWalk: null, fee: null }, { available: false, depthWalk: null, fee: null }, NOW);
    expect(decision.chosenVenue).toBeNull();
    expect(decision.rejectReason).not.toBeNull();
    expect(decision.pmus.disqualifiedReason).not.toBeNull();
    expect(decision.kalshi.disqualifiedReason).not.toBeNull();
  });

  it("T-router-7: a NONE depth-walk result disqualifies a venue even if it is 'available'", () => {
    const decision = routeExecution(
      100,
      { available: true, depthWalk: fullFill({ status: "NONE", fillRatio: 0, filledNotionalUsd: 0, contractsFilled: 0, averageExecutionPrice: null }), fee: null },
      { available: true, depthWalk: fullFill(), fee: validFee(1) },
      NOW,
    );
    expect(decision.chosenVenue).toBe("KALSHI");
    expect(decision.pmus.disqualifiedReason).toMatch(/NONE/);
  });

  it("T-router-8: an INVALID depth-walk result disqualifies a venue -- malformed evidence is never routable", () => {
    const decision = routeExecution(
      100,
      { available: true, depthWalk: fullFill({ status: "INVALID", invalidReason: "bad level" }), fee: null },
      { available: true, depthWalk: fullFill(), fee: validFee(1) },
      NOW,
    );
    expect(decision.chosenVenue).toBe("KALSHI");
    expect(decision.pmus.disqualifiedReason).toMatch(/bad level/);
  });

  it("T-router-9: an invalid/UNVERIFIED fee disqualifies a venue even with a perfectly good depth-walk result", () => {
    const decision = routeExecution(
      100,
      { available: true, depthWalk: fullFill(), fee: { feeUsd: 0, valid: false, reason: "price out of range", feeModelVersion: "V1", effectiveDate: "2026-01-01" } },
      { available: true, depthWalk: fullFill(), fee: validFee(1) },
      NOW,
    );
    expect(decision.chosenVenue).toBe("KALSHI");
    expect(decision.pmus.disqualifiedReason).toMatch(/UNVERIFIED/);
  });

  it("T-router-10: exact tie (identical fillRatio and effectiveCostPerContract) deterministically prefers PMUS, never random", () => {
    const decision1 = routeExecution(100, { available: true, depthWalk: fullFill(), fee: validFee(1) }, { available: true, depthWalk: fullFill(), fee: validFee(1) }, NOW);
    const decision2 = routeExecution(100, { available: true, depthWalk: fullFill(), fee: validFee(1) }, { available: true, depthWalk: fullFill(), fee: validFee(1) }, NOW);
    expect(decision1.chosenVenue).toBe("PMUS");
    expect(decision2.chosenVenue).toBe("PMUS"); // repeated call, identical inputs -> identical decision (no randomness)
  });

  it("counterfactuals: both venues' full candidate data is always present in the decision, regardless of which was chosen or rejected", () => {
    const decision = routeExecution(100, { available: true, depthWalk: fullFill(), fee: validFee(1) }, { available: true, depthWalk: fullFill(), fee: validFee(5) }, NOW);
    expect(decision.pmus.allInCostUsd).not.toBeNull();
    expect(decision.kalshi.allInCostUsd).not.toBeNull(); // present even though PMUS was chosen
  });

  it("routingTimestampMs is exactly the caller-supplied nowMs -- no internal clock access, no hindsight from a later timestamp", () => {
    const decision = routeExecution(100, { available: true, depthWalk: fullFill(), fee: validFee(1) }, { available: true, depthWalk: fullFill(), fee: validFee(1) }, NOW);
    expect(decision.routingTimestampMs).toBe(NOW);
  });
});
