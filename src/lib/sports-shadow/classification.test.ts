import { describe, expect, it } from "vitest";

import { classifyCalibration, classifyOos, evaluateLivePilotGate, type LivePilotGateInput } from "./classification";

describe("classifyCalibration", () => {
  it("NO_EVIDENCE when nothing has settled yet", () => {
    expect(classifyCalibration({ independentSettledCount: 0, expectancyPerIndependentEpisodeUsd: 0, bootstrapProbabilityPositive: 0 })).toBe("NO_EVIDENCE");
  });

  it("INSUFFICIENT_DATA below the 100-independent-settled gate, regardless of how good it looks", () => {
    expect(classifyCalibration({ independentSettledCount: 99, expectancyPerIndependentEpisodeUsd: 1000, bootstrapProbabilityPositive: 0.99 })).toBe("INSUFFICIENT_DATA");
  });

  it("never returns PROVEN_PROFITABLE-like certainty -- CANDIDATE_FOR_OOS is the ceiling at gate + strong evidence", () => {
    const result = classifyCalibration({ independentSettledCount: 100, expectancyPerIndependentEpisodeUsd: 5, bootstrapProbabilityPositive: 0.9 });
    expect(result).toBe("CANDIDATE_FOR_OOS");
  });

  it("INTERESTING at gate with weak confidence even if expectancy is positive", () => {
    expect(classifyCalibration({ independentSettledCount: 150, expectancyPerIndependentEpisodeUsd: 1, bootstrapProbabilityPositive: 0.5 })).toBe("INTERESTING");
  });

  it("INTERESTING at gate with negative expectancy -- calibration never KILLs, only OOS does", () => {
    expect(classifyCalibration({ independentSettledCount: 150, expectancyPerIndependentEpisodeUsd: -5, bootstrapProbabilityPositive: 0.95 })).toBe("INTERESTING");
  });
});

function gateInput(overrides: Partial<LivePilotGateInput> = {}): LivePilotGateInput {
  return {
    oosSampleAndDurationMet: true,
    oosExpectancyPerIndependentEpisodeUsd: 5,
    oneCentStressExpectancyPerIndependentEpisodeUsd: 4,
    twoCentStressExpectancyPerIndependentEpisodeUsd: 3,
    topFiveWinsRemovedExpectancyPerIndependentEpisodeUsd: 2,
    maxDrawdownUsd: 10,
    capitalDeployedUsd: 1000,
    matchRateAtDeclaredTier: 0.9,
    integrityAuditPassed: true,
    epochContaminationDetected: false,
    unresolvedMatchingIssues: false,
    operationalHealthAcceptable: true,
    bootstrapProbabilityPositive: 0.95,
    ...overrides,
  };
}

describe("evaluateLivePilotGate", () => {
  it("ready with no blocked reasons when every criterion passes", () => {
    const result = evaluateLivePilotGate(gateInput());
    expect(result.ready).toBe(true);
    expect(result.blockedReasons).toHaveLength(0);
  });

  it("reports every failing reason at once, not just the first", () => {
    const result = evaluateLivePilotGate(gateInput({ integrityAuditPassed: false, unresolvedMatchingIssues: true, oosExpectancyPerIndependentEpisodeUsd: -1 }));
    expect(result.ready).toBe(false);
    expect(result.blockedReasons.length).toBeGreaterThanOrEqual(3);
  });

  it("blocks on drawdown exceeding the acceptable fraction of capital deployed", () => {
    const result = evaluateLivePilotGate(gateInput({ maxDrawdownUsd: 600, capitalDeployedUsd: 1000 }));
    expect(result.ready).toBe(false);
    expect(result.blockedReasons.some((r) => r.includes("drawdown"))).toBe(true);
  });

  it("blocks on insufficient liquidity (match rate) at the declared tier", () => {
    const result = evaluateLivePilotGate(gateInput({ matchRateAtDeclaredTier: 0.3 }));
    expect(result.blockedReasons.some((r) => r.includes("liquidity"))).toBe(true);
  });

  it("blocks on statistical confidence below threshold even when everything else passes", () => {
    const result = evaluateLivePilotGate(gateInput({ bootstrapProbabilityPositive: 0.6 }));
    expect(result.ready).toBe(false);
    expect(result.blockedReasons.some((r) => r.includes("confidence"))).toBe(true);
  });
});

describe("classifyOos", () => {
  it("CONTINUE_RESEARCH while the OOS sample/duration gate has not been reached", () => {
    expect(classifyOos(gateInput({ oosSampleAndDurationMet: false, oosExpectancyPerIndependentEpisodeUsd: -100 }))).toBe("CONTINUE_RESEARCH");
  });

  it("NEW_EPOCH_REQUIRED takes priority over everything else once contamination is detected", () => {
    expect(classifyOos(gateInput({ epochContaminationDetected: true }))).toBe("NEW_EPOCH_REQUIRED");
  });

  it("LIVE_PILOT_REVIEW_READY only when every gate criterion passes", () => {
    expect(classifyOos(gateInput())).toBe("LIVE_PILOT_REVIEW_READY");
  });

  it("KILL when the gate is reached, not contaminated, and net expectancy is non-positive", () => {
    expect(classifyOos(gateInput({ oosExpectancyPerIndependentEpisodeUsd: -1, oneCentStressExpectancyPerIndependentEpisodeUsd: -2 }))).toBe("KILL");
  });

  it("CONTINUE_RESEARCH when positive but the strict gate is not fully met (e.g. confidence too low)", () => {
    expect(classifyOos(gateInput({ bootstrapProbabilityPositive: 0.6 }))).toBe("CONTINUE_RESEARCH");
  });

  it("cannot reach LIVE_PILOT_REVIEW_READY prematurely: even a very strong-looking result before the sample gate stays CONTINUE_RESEARCH, never jumps straight to ready", () => {
    const result = classifyOos(gateInput({ oosSampleAndDurationMet: false, oosExpectancyPerIndependentEpisodeUsd: 1000, bootstrapProbabilityPositive: 1 }));
    expect(result).toBe("CONTINUE_RESEARCH");
  });
});
