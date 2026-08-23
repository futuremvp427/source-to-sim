import { describe, expect, it } from "vitest";

import {
  CALIBRATION_MIN_DURATION_MS,
  CALIBRATION_MIN_INDEPENDENT_EPISODES,
  evaluateStageTransition,
  OOS_MIN_DURATION_MS,
  OOS_MIN_INDEPENDENT_EPISODES,
  SOAK_DURATION_MS,
  type StageEpochState,
} from "./stage";

const NOW = 1_700_000_000_000;

function epoch(overrides: Partial<StageEpochState> = {}): StageEpochState {
  return { stage: "PRE_SOAK", soakStartedAtMs: null, calibrationStartedAtMs: null, oosStartedAtMs: null, ...overrides };
}

describe("FINAL BUILD Parts 18-21: evaluateStageTransition", () => {
  it("PRE_SOAK transitions immediately to OPERATIONAL_SOAK", () => {
    const t = evaluateStageTransition({ epoch: epoch(), nowMs: NOW, independentSettledSinceCalibrationStart: 0, independentSettledSinceOosStart: 0, soakHealthPassed: true });
    expect(t.nextStage).toBe("OPERATIONAL_SOAK");
  });

  it("OPERATIONAL_SOAK stays in place before 72 hours elapse", () => {
    const t = evaluateStageTransition({
      epoch: epoch({ stage: "OPERATIONAL_SOAK", soakStartedAtMs: NOW - SOAK_DURATION_MS + 1000 }),
      nowMs: NOW,
      independentSettledSinceCalibrationStart: 0,
      independentSettledSinceOosStart: 0,
      soakHealthPassed: true,
    });
    expect(t.nextStage).toBeNull();
  });

  it("OPERATIONAL_SOAK transitions to CALIBRATION once 72h elapsed AND health gate passed", () => {
    const t = evaluateStageTransition({
      epoch: epoch({ stage: "OPERATIONAL_SOAK", soakStartedAtMs: NOW - SOAK_DURATION_MS - 1 }),
      nowMs: NOW,
      independentSettledSinceCalibrationStart: 0,
      independentSettledSinceOosStart: 0,
      soakHealthPassed: true,
    });
    expect(t.nextStage).toBe("CALIBRATION");
  });

  it("OPERATIONAL_SOAK transitions to FAILED (never silently to CALIBRATION) when 72h elapsed but the health gate did NOT pass", () => {
    const t = evaluateStageTransition({
      epoch: epoch({ stage: "OPERATIONAL_SOAK", soakStartedAtMs: NOW - SOAK_DURATION_MS - 1 }),
      nowMs: NOW,
      independentSettledSinceCalibrationStart: 0,
      independentSettledSinceOosStart: 0,
      soakHealthPassed: false,
    });
    expect(t.nextStage).toBe("FAILED");
  });

  it("CALIBRATION requires BOTH >=14 days AND >=100 independent settled episodes -- duration alone is not enough", () => {
    const t = evaluateStageTransition({
      epoch: epoch({ stage: "CALIBRATION", calibrationStartedAtMs: NOW - CALIBRATION_MIN_DURATION_MS - 1 }),
      nowMs: NOW,
      independentSettledSinceCalibrationStart: 99,
      independentSettledSinceOosStart: 0,
      soakHealthPassed: true,
    });
    expect(t.nextStage).toBeNull();
  });

  it("CALIBRATION requires BOTH -- count alone is not enough either", () => {
    const t = evaluateStageTransition({
      epoch: epoch({ stage: "CALIBRATION", calibrationStartedAtMs: NOW - 1000 }),
      nowMs: NOW,
      independentSettledSinceCalibrationStart: CALIBRATION_MIN_INDEPENDENT_EPISODES,
      independentSettledSinceOosStart: 0,
      soakHealthPassed: true,
    });
    expect(t.nextStage).toBeNull();
  });

  it("CALIBRATION transitions to OUT_OF_SAMPLE once both minimums are met", () => {
    const t = evaluateStageTransition({
      epoch: epoch({ stage: "CALIBRATION", calibrationStartedAtMs: NOW - CALIBRATION_MIN_DURATION_MS - 1 }),
      nowMs: NOW,
      independentSettledSinceCalibrationStart: CALIBRATION_MIN_INDEPENDENT_EPISODES,
      independentSettledSinceOosStart: 0,
      soakHealthPassed: true,
    });
    expect(t.nextStage).toBe("OUT_OF_SAMPLE");
  });

  it("OUT_OF_SAMPLE requires its OWN independent counter (since calibration start), not calibration's cumulative one", () => {
    const t = evaluateStageTransition({
      epoch: epoch({ stage: "OUT_OF_SAMPLE", oosStartedAtMs: NOW - OOS_MIN_DURATION_MS - 1 }),
      nowMs: NOW,
      independentSettledSinceCalibrationStart: 9999, // irrelevant to OOS's own gate
      independentSettledSinceOosStart: OOS_MIN_INDEPENDENT_EPISODES - 1,
      soakHealthPassed: true,
    });
    expect(t.nextStage).toBeNull();
  });

  it("OUT_OF_SAMPLE transitions to LIVE_PILOT_REVIEW_READY once its own minimums are met AND the real classification says so", () => {
    const t = evaluateStageTransition({
      epoch: epoch({ stage: "OUT_OF_SAMPLE", oosStartedAtMs: NOW - OOS_MIN_DURATION_MS - 1 }),
      nowMs: NOW,
      independentSettledSinceCalibrationStart: 0,
      independentSettledSinceOosStart: OOS_MIN_INDEPENDENT_EPISODES,
      soakHealthPassed: true,
      oosClassification: "LIVE_PILOT_REVIEW_READY",
    });
    expect(t.nextStage).toBe("LIVE_PILOT_REVIEW_READY");
  });

  it("OUT_OF_SAMPLE minimums met but classification KILL transitions to FAILED, never silently to LIVE_PILOT_REVIEW_READY", () => {
    const t = evaluateStageTransition({
      epoch: epoch({ stage: "OUT_OF_SAMPLE", oosStartedAtMs: NOW - OOS_MIN_DURATION_MS - 1 }),
      nowMs: NOW,
      independentSettledSinceCalibrationStart: 0,
      independentSettledSinceOosStart: OOS_MIN_INDEPENDENT_EPISODES,
      soakHealthPassed: true,
      oosClassification: "KILL",
    });
    expect(t.nextStage).toBe("FAILED");
  });

  it("OUT_OF_SAMPLE minimums met but reaching the floor alone (no classification, or CONTINUE_RESEARCH) is NEVER sufficient to reach LIVE_PILOT_REVIEW_READY -- the mission's own explicit rule", () => {
    const base = {
      epoch: epoch({ stage: "OUT_OF_SAMPLE" as const, oosStartedAtMs: NOW - OOS_MIN_DURATION_MS - 1 }),
      nowMs: NOW,
      independentSettledSinceCalibrationStart: 0,
      independentSettledSinceOosStart: OOS_MIN_INDEPENDENT_EPISODES,
      soakHealthPassed: true,
    };
    expect(evaluateStageTransition({ ...base }).nextStage).toBeNull();
    expect(evaluateStageTransition({ ...base, oosClassification: null }).nextStage).toBeNull();
    expect(evaluateStageTransition({ ...base, oosClassification: "CONTINUE_RESEARCH" }).nextStage).toBeNull();
    expect(evaluateStageTransition({ ...base, oosClassification: "NEW_EPOCH_REQUIRED" }).nextStage).toBeNull();
  });

  it("terminal stages (LIVE_PILOT_REVIEW_READY, FAILED, PAUSED) never auto-transition -- requires explicit human action", () => {
    for (const stage of ["LIVE_PILOT_REVIEW_READY", "FAILED", "PAUSED"] as const) {
      const t = evaluateStageTransition({
        epoch: epoch({ stage }),
        nowMs: NOW,
        independentSettledSinceCalibrationStart: 999,
        independentSettledSinceOosStart: 999,
        soakHealthPassed: true,
      });
      expect(t.nextStage).toBeNull();
    }
  });

  it("restart-safety: identical durable inputs always produce the identical transition, regardless of process lifetime", () => {
    const input = {
      epoch: epoch({ stage: "CALIBRATION", calibrationStartedAtMs: NOW - CALIBRATION_MIN_DURATION_MS - 1 }),
      nowMs: NOW,
      independentSettledSinceCalibrationStart: CALIBRATION_MIN_INDEPENDENT_EPISODES,
      independentSettledSinceOosStart: 0,
      soakHealthPassed: true,
    };
    const t1 = evaluateStageTransition(input);
    const t2 = evaluateStageTransition(input);
    expect(t1).toEqual(t2);
  });
});

describe("CODEX P1-1 (round 2): sourceCoverageGapDetected blocks every progression past OPERATIONAL_SOAK", () => {
  it("blocks OPERATIONAL_SOAK -> CALIBRATION even when 72h elapsed and the health gate otherwise passed", () => {
    const t = evaluateStageTransition({
      epoch: epoch({ stage: "OPERATIONAL_SOAK", soakStartedAtMs: NOW - SOAK_DURATION_MS - 1 }),
      nowMs: NOW,
      independentSettledSinceCalibrationStart: 0,
      independentSettledSinceOosStart: 0,
      soakHealthPassed: true,
      sourceCoverageGapDetected: true,
    });
    expect(t.nextStage).toBeNull();
    expect(t.reason).toMatch(/source-coverage gap/);
  });

  it("blocks CALIBRATION -> OUT_OF_SAMPLE even when duration/count minimums are met", () => {
    const t = evaluateStageTransition({
      epoch: epoch({ stage: "CALIBRATION", calibrationStartedAtMs: NOW - CALIBRATION_MIN_DURATION_MS - 1 }),
      nowMs: NOW,
      independentSettledSinceCalibrationStart: CALIBRATION_MIN_INDEPENDENT_EPISODES,
      independentSettledSinceOosStart: 0,
      soakHealthPassed: true,
      sourceCoverageGapDetected: true,
    });
    expect(t.nextStage).toBeNull();
    expect(t.reason).toMatch(/source-coverage gap/);
  });

  it("blocks OUT_OF_SAMPLE -> LIVE_PILOT_REVIEW_READY even when classification says promote", () => {
    const t = evaluateStageTransition({
      epoch: epoch({ stage: "OUT_OF_SAMPLE", oosStartedAtMs: NOW - OOS_MIN_DURATION_MS - 1 }),
      nowMs: NOW,
      independentSettledSinceCalibrationStart: 0,
      independentSettledSinceOosStart: OOS_MIN_INDEPENDENT_EPISODES,
      soakHealthPassed: true,
      oosClassification: "LIVE_PILOT_REVIEW_READY",
      sourceCoverageGapDetected: true,
    });
    expect(t.nextStage).toBeNull();
    expect(t.reason).toMatch(/source-coverage gap/);
  });

  it("does NOT block the initial PRE_SOAK -> OPERATIONAL_SOAK activation -- that is epoch bootstrapping, not progression past soak", () => {
    const t = evaluateStageTransition({
      epoch: epoch({ stage: "PRE_SOAK" }),
      nowMs: NOW,
      independentSettledSinceCalibrationStart: 0,
      independentSettledSinceOosStart: 0,
      soakHealthPassed: true,
      sourceCoverageGapDetected: true,
    });
    expect(t.nextStage).toBe("OPERATIONAL_SOAK");
  });

  it("does not affect terminal stages", () => {
    for (const stage of ["LIVE_PILOT_REVIEW_READY", "FAILED", "PAUSED"] as const) {
      const t = evaluateStageTransition({
        epoch: epoch({ stage }),
        nowMs: NOW,
        independentSettledSinceCalibrationStart: 999,
        independentSettledSinceOosStart: 999,
        soakHealthPassed: true,
        sourceCoverageGapDetected: true,
      });
      expect(t.nextStage).toBeNull();
    }
  });

  it("omitting sourceCoverageGapDetected (undefined) behaves exactly like false -- fully backward compatible", () => {
    const withGapFalse = evaluateStageTransition({
      epoch: epoch({ stage: "OPERATIONAL_SOAK", soakStartedAtMs: NOW - SOAK_DURATION_MS - 1 }),
      nowMs: NOW,
      independentSettledSinceCalibrationStart: 0,
      independentSettledSinceOosStart: 0,
      soakHealthPassed: true,
      sourceCoverageGapDetected: false,
    });
    const omitted = evaluateStageTransition({
      epoch: epoch({ stage: "OPERATIONAL_SOAK", soakStartedAtMs: NOW - SOAK_DURATION_MS - 1 }),
      nowMs: NOW,
      independentSettledSinceCalibrationStart: 0,
      independentSettledSinceOosStart: 0,
      soakHealthPassed: true,
    });
    expect(omitted).toEqual(withGapFalse);
  });
});
