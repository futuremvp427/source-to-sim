import { describe, expect, it } from "vitest";

import {
  ACTIVATION_CONFIRM_PHRASE,
  canActivate,
  canArm,
  computeLiveAllocation,
  evaluateQualification,
  LIVE_EXECUTION_IMPLEMENTED,
  type LiveSafetyState,
} from "./core";

const base: LiveSafetyState = {
  killSwitchEngaged: false,
  activationStage: "locked",
  armedAt: null,
  activatedAt: null,
  maxLiveNotionalUsd: 5,
  maxLiveExposureUsd: 100,
};

const goodQualification = {
  id: "e1",
  name: "SHADOW V2: x",
  cohort: "V2",
  handle: "x",
  settledMarkets: 40,
  roi: 3,
  markCoveragePct: 95,
  buys: 100,
  insufficientCashSkips: 5,
};

describe("qualification", () => {
  it("qualifies only when every check passes", () => {
    expect(evaluateQualification(goodQualification).status).toBe("qualified");
  });

  it("never qualifies on unavailable evidence", () => {
    const r = evaluateQualification({ ...goodQualification, markCoveragePct: null });
    expect(r.status).toBe("insufficient_evidence");
    expect(r.blockingReasons.length).toBeGreaterThan(0);
  });

  it("fails a negative ROI", () => {
    expect(evaluateQualification({ ...goodQualification, roi: -1 }).status).toBe("not_qualified");
  });
});

describe("two-step activation", () => {
  it("blocks arming while the kill switch is engaged", () => {
    expect(canArm({ ...base, killSwitchEngaged: true }, 1).allowed).toBe(false);
  });

  it("blocks arming without a qualified experiment", () => {
    expect(canArm(base, 0).allowed).toBe(false);
  });

  it("requires arming before activation", () => {
    expect(canActivate(base, 1, ACTIVATION_CONFIRM_PHRASE).allowed).toBe(false);
  });

  it("requires the exact confirmation phrase", () => {
    const armed = { ...base, activationStage: "armed" as const };
    expect(canActivate(armed, 1, "activate").allowed).toBe(false);
    expect(canActivate(armed, 1, ACTIVATION_CONFIRM_PHRASE).allowed).toBe(true);
  });
});

describe("live allocation", () => {
  const activated: LiveSafetyState = { ...base, activationStage: "activated" };

  it("is $0 because no live execution path exists", () => {
    expect(LIVE_EXECUTION_IMPLEMENTED).toBe(false);
    const r = computeLiveAllocation({
      state: activated,
      liveEquityUsd: 50,
      exposureUsd: 10,
      marksComplete: true,
      qualifiedExperiments: 1,
    });
    expect(r.allocationUsd).toBe(0);
    expect(r.blocked).toBe(true);
  });

  it("is fail-closed on stale or incomplete marks", () => {
    const r = computeLiveAllocation({
      state: activated,
      liveEquityUsd: 50,
      exposureUsd: null,
      marksComplete: false,
      qualifiedExperiments: 1,
    });
    expect(r.allocationUsd).toBe(0);
    expect(r.reasons.some((x) => x.includes("marks are incomplete"))).toBe(true);
  });

  it("is fail-closed when the kill switch is engaged", () => {
    const r = computeLiveAllocation({
      state: { ...activated, killSwitchEngaged: true },
      liveEquityUsd: 50,
      exposureUsd: 0,
      marksComplete: true,
      qualifiedExperiments: 1,
    });
    expect(r.reasons).toContain("Kill switch engaged.");
  });
});
