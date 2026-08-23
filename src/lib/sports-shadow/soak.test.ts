import { describe, expect, it } from "vitest";

import { evaluateSoakHealth, SOAK_HEALTH_THRESHOLDS, type SoakHealthInput } from "./soak";

function healthyInput(overrides: Partial<SoakHealthInput> = {}): SoakHealthInput {
  return {
    actualCycleCount: 100,
    expectedCycleCount: 100,
    totalCycleErrors: 0,
    observationBacklogTotal: 0,
    observationAttemptedTotal: 500,
    pmusDiscoveryFailedCount: 0,
    pmusDiscoveryAttemptedCycles: 100,
    kalshiDiscoveryFailedCount: 0,
    kalshiDiscoveryAttemptedCycles: 100,
    sourceStarvedCycles: 0,
    sourceLaneAcquiredCycles: 100,
    leaseLostCount: 0,
    integrityAuditFailures: 0,
    integrityAuditsRun: 3,
    settlementStuckCount: 0,
    rateLimitStormCount: 0,
    rateLimitPersistFailureCount: 0,
    walletsWithIncompleteCoverageCount: 0,
    ...overrides,
  };
}

describe("evaluateSoakHealth", () => {
  it("passes with no failed checks when every metric is healthy", () => {
    const result = evaluateSoakHealth(healthyInput());
    expect(result.passed).toBe(true);
    expect(result.failedChecks).toHaveLength(0);
  });

  it("72h elapsing is necessary but NOT sufficient: a healthy duration with a bad scheduler-completion ratio still fails", () => {
    const result = evaluateSoakHealth(healthyInput({ actualCycleCount: 10, expectedCycleCount: 100 }));
    expect(result.passed).toBe(false);
    expect(result.failedChecks.some((c) => c.includes("completion ratio"))).toBe(true);
  });

  it("fails on a sustained cycle error rate above threshold", () => {
    const result = evaluateSoakHealth(healthyInput({ totalCycleErrors: 50, actualCycleCount: 100 }));
    expect(result.passed).toBe(false);
    expect(result.failedChecks.some((c) => c.includes("error rate"))).toBe(true);
  });

  it("fails on a sustained observation backlog ratio, not a transient blip", () => {
    const result = evaluateSoakHealth(healthyInput({ observationBacklogTotal: 200, observationAttemptedTotal: 500 }));
    expect(result.passed).toBe(false);
    expect(result.failedChecks.some((c) => c.includes("backlog"))).toBe(true);
  });

  it("fails on PM-US starvation specifically, without flagging Kalshi", () => {
    const result = evaluateSoakHealth(healthyInput({ pmusDiscoveryFailedCount: 90, pmusDiscoveryAttemptedCycles: 100 }));
    expect(result.passed).toBe(false);
    expect(result.failedChecks.some((c) => c.includes("PM-US"))).toBe(true);
    expect(result.failedChecks.some((c) => c.includes("Kalshi"))).toBe(false);
  });

  it("fails on Kalshi starvation specifically", () => {
    const result = evaluateSoakHealth(healthyInput({ kalshiDiscoveryFailedCount: 90, kalshiDiscoveryAttemptedCycles: 100 }));
    expect(result.failedChecks.some((c) => c.includes("Kalshi"))).toBe(true);
  });

  it("fails on source starvation (source lane attempting zero wallets repeatedly)", () => {
    const result = evaluateSoakHealth(healthyInput({ sourceStarvedCycles: 80, sourceLaneAcquiredCycles: 100 }));
    expect(result.failedChecks.some((c) => c.includes("source starvation"))).toBe(true);
  });

  it("fails on excessive lease loss", () => {
    const result = evaluateSoakHealth(healthyInput({ leaseLostCount: 20, actualCycleCount: 100 }));
    expect(result.failedChecks.some((c) => c.includes("lease-loss"))).toBe(true);
  });

  it("fails on ANY integrity audit failure -- zero tolerance", () => {
    const result = evaluateSoakHealth(healthyInput({ integrityAuditFailures: 1 }));
    expect(result.passed).toBe(false);
    expect(result.failedChecks.some((c) => c.includes("integrity audit"))).toBe(true);
  });

  it("fails on any stuck settlement", () => {
    const result = evaluateSoakHealth(healthyInput({ settlementStuckCount: 1 }));
    expect(result.failedChecks.some((c) => c.includes("stuck"))).toBe(true);
  });

  it("fails on any recorded rate-limit storm", () => {
    const result = evaluateSoakHealth(healthyInput({ rateLimitStormCount: 1 }));
    expect(result.failedChecks.some((c) => c.includes("rate-limit storm"))).toBe(true);
  });

  it("CODEX P2-2: fails on any recorded rate-limit-cooldown persistence failure, distinct from a rate-limit storm", () => {
    const result = evaluateSoakHealth(healthyInput({ rateLimitPersistFailureCount: 1 }));
    expect(result.failedChecks.some((c) => c.includes("persistence failure"))).toBe(true);
  });

  it("CODEX P1-1 (round 2): fails while any wallet has an unresolved source-coverage gap", () => {
    const result = evaluateSoakHealth(healthyInput({ walletsWithIncompleteCoverageCount: 1 }));
    expect(result.failedChecks.some((c) => c.includes("source-coverage gap"))).toBe(true);
  });

  it("reports every failing check at once, not just the first", () => {
    const result = evaluateSoakHealth(healthyInput({ integrityAuditFailures: 1, settlementStuckCount: 1, leaseLostCount: 50, actualCycleCount: 100 }));
    expect(result.failedChecks.length).toBeGreaterThanOrEqual(3);
  });

  it("division-by-zero denominators (zero attempted/acquired cycles) never produce NaN or a spurious failure", () => {
    const result = evaluateSoakHealth(
      healthyInput({ observationAttemptedTotal: 0, observationBacklogTotal: 0, pmusDiscoveryAttemptedCycles: 0, sourceLaneAcquiredCycles: 0, expectedCycleCount: 0 }),
    );
    expect(result.passed).toBe(true);
  });

  it("exposes the exact default thresholds used, for documentation/dashboard display", () => {
    expect(SOAK_HEALTH_THRESHOLDS.minCycleCompletionRatio).toBe(0.5);
    expect(SOAK_HEALTH_THRESHOLDS.maxSettlementStuckCount).toBe(0);
  });
});
