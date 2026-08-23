import { describe, expect, it } from "vitest";

import { evaluateAndApplyStageTransition, type StageRepository } from "./stage.server";
import type { ExperimentEpoch, ExperimentEpochVersions } from "./epoch";
import { SOAK_DURATION_MS } from "./stage";

const VERSIONS: ExperimentEpochVersions = {
  classifierVersion: "c1",
  episodeVersion: "e1",
  resolverVersion: "r1",
  routerVersion: "rt1",
  pmusFeeModelVersion: "pf1",
  kalshiFeeModelVersion: "kf1",
  executionSimulatorVersion: "x1",
  settlementVersion: "s1",
};

function epoch(overrides: Partial<ExperimentEpoch> = {}): ExperimentEpoch {
  return {
    id: "epoch-1",
    createdAtIso: "2026-08-01T00:00:00Z",
    goLiveAtIso: "2026-08-01T00:00:00Z",
    walletCohort: ["0xa"],
    gitSha: "sha1",
    configHash: "hash1",
    versions: VERSIONS,
    stage: "PRE_SOAK",
    stageEnteredAtIso: "2026-08-01T00:00:00Z",
    soakStartedAtIso: null,
    calibrationStartedAtIso: null,
    oosStartedAtIso: null,
    frozenAtIso: null,
    ...overrides,
  };
}

function fakeRepo(
  current: ExperimentEpoch | null,
  independentCount = 0,
  soakHealth: { passed: boolean; failedChecks: string[] } = { passed: true, failedChecks: [] },
  oosClassification: "KILL" | "CONTINUE_RESEARCH" | "NEW_EPOCH_REQUIRED" | "LIVE_PILOT_REVIEW_READY" = "CONTINUE_RESEARCH",
  sourceCoverageGapDetected = false,
): StageRepository & {
  transitions: { epochId: string; stage: string }[];
  calibrationSnapshots: number;
  oosSnapshots: number;
  notifications: { epochId: string; kind: string }[];
} {
  const transitions: { epochId: string; stage: string }[] = [];
  const notifications: { epochId: string; kind: string }[] = [];
  const state = { calibrationSnapshots: 0, oosSnapshots: 0 };
  return {
    transitions,
    get calibrationSnapshots() {
      return state.calibrationSnapshots;
    },
    get oosSnapshots() {
      return state.oosSnapshots;
    },
    notifications,
    async getCurrentEpoch() {
      return current;
    },
    async countIndependentSettledSince() {
      return independentCount;
    },
    async computeSoakHealth() {
      return soakHealth;
    },
    async hasUnresolvedSourceCoverageGap() {
      return sourceCoverageGapDetected;
    },
    async evaluateOosClassification() {
      return oosClassification;
    },
    async persistCalibrationSnapshot() {
      state.calibrationSnapshots += 1;
    },
    async persistFinalOosSnapshot() {
      state.oosSnapshots += 1;
    },
    async notifyMilestone(epochId, kind) {
      notifications.push({ epochId, kind });
    },
    async transitionStage(epochId, stage) {
      transitions.push({ epochId, stage });
    },
  };
}

describe("FINAL BUILD Parts 18-21: evaluateAndApplyStageTransition", () => {
  it("returns null when no current epoch exists -- never fabricates a transition", async () => {
    const repo = fakeRepo(null);
    const outcome = await evaluateAndApplyStageTransition(() => Date.now(), repo);
    expect(outcome).toBeNull();
  });

  it("PRE_SOAK epoch transitions to OPERATIONAL_SOAK and persists it via transitionStage", async () => {
    const repo = fakeRepo(epoch({ stage: "PRE_SOAK" }));
    const outcome = await evaluateAndApplyStageTransition(() => Date.now(), repo);
    expect(outcome?.nextStage).toBe("OPERATIONAL_SOAK");
    expect(repo.transitions).toEqual([{ epochId: "epoch-1", stage: "OPERATIONAL_SOAK" }]);
  });

  it("OPERATIONAL_SOAK epoch not yet past 72h stays in place -- no transitionStage call", async () => {
    const now = Date.parse("2026-08-01T00:00:00Z") + 1000;
    const repo = fakeRepo(epoch({ stage: "OPERATIONAL_SOAK", soakStartedAtIso: "2026-08-01T00:00:00Z" }));
    const outcome = await evaluateAndApplyStageTransition(() => now, repo);
    expect(outcome?.nextStage).toBeNull();
    expect(repo.transitions).toHaveLength(0);
  });

  it("OPERATIONAL_SOAK epoch past 72h with a passing health gate transitions to CALIBRATION", async () => {
    const soakStart = Date.parse("2026-08-01T00:00:00Z");
    const now = soakStart + SOAK_DURATION_MS + 1000;
    const repo = fakeRepo(epoch({ stage: "OPERATIONAL_SOAK", soakStartedAtIso: new Date(soakStart).toISOString() }));
    const outcome = await evaluateAndApplyStageTransition(() => now, repo);
    expect(outcome?.nextStage).toBe("CALIBRATION");
    expect(repo.notifications).toContainEqual({ epochId: "epoch-1", kind: "sports_shadow_soak_passed" });
  });

  it("OPERATIONAL_SOAK epoch past 72h with a FAILING health gate transitions to FAILED, never silently to CALIBRATION", async () => {
    const soakStart = Date.parse("2026-08-01T00:00:00Z");
    const now = soakStart + SOAK_DURATION_MS + 1000;
    const repo = fakeRepo(epoch({ stage: "OPERATIONAL_SOAK", soakStartedAtIso: new Date(soakStart).toISOString() }), 0, { passed: false, failedChecks: ["cycle error rate too high"] });
    const outcome = await evaluateAndApplyStageTransition(() => now, repo);
    expect(outcome?.nextStage).toBe("FAILED");
    expect(outcome?.soakFailedChecks).toEqual(["cycle error rate too high"]);
    expect(repo.notifications).toContainEqual({ epochId: "epoch-1", kind: "sports_shadow_soak_failed" });
  });

  it("CALIBRATION queries independent-settled-since-calibration-start, transitions once both minimums are met, and persists+alerts the milestone snapshot exactly once", async () => {
    const calStart = Date.parse("2026-08-01T00:00:00Z");
    const now = calStart + 15 * 24 * 60 * 60 * 1000;
    const repo = fakeRepo(epoch({ stage: "CALIBRATION", calibrationStartedAtIso: new Date(calStart).toISOString() }), 100);
    const outcome = await evaluateAndApplyStageTransition(() => now, repo);
    expect(outcome?.nextStage).toBe("OUT_OF_SAMPLE");
    expect(repo.calibrationSnapshots).toBe(1);
    expect(repo.notifications).toContainEqual({ epochId: "epoch-1", kind: "sports_shadow_calibration_100" });
  });

  it("CALIBRATION with insufficient independent count stays in place even past the duration minimum", async () => {
    const calStart = Date.parse("2026-08-01T00:00:00Z");
    const now = calStart + 15 * 24 * 60 * 60 * 1000;
    const repo = fakeRepo(epoch({ stage: "CALIBRATION", calibrationStartedAtIso: new Date(calStart).toISOString() }), 50);
    const outcome = await evaluateAndApplyStageTransition(() => now, repo);
    expect(outcome?.nextStage).toBeNull();
  });

  it("FINAL BUILD Part 6: computeSoakHealth is only queried while in OPERATIONAL_SOAK -- not during CALIBRATION or terminal stages", async () => {
    let calls = 0;
    const calStart = Date.parse("2026-08-01T00:00:00Z");
    const now = calStart + 1000;
    const base = fakeRepo(epoch({ stage: "CALIBRATION", calibrationStartedAtIso: new Date(calStart).toISOString() }));
    const repo: StageRepository & { transitions: { epochId: string; stage: string }[] } = {
      ...base,
      async computeSoakHealth() {
        calls += 1;
        return { passed: true, failedChecks: [] };
      },
    };
    await evaluateAndApplyStageTransition(() => now, repo);
    expect(calls).toBe(0);
  });

  it("terminal stages never transition and never call transitionStage", async () => {
    const repo = fakeRepo(epoch({ stage: "FAILED" }));
    const outcome = await evaluateAndApplyStageTransition(() => Date.now(), repo);
    expect(outcome?.nextStage).toBeNull();
    expect(repo.transitions).toHaveLength(0);
  });

  it("CODEX P1-1 (round 2): an unresolved source-coverage gap blocks OPERATIONAL_SOAK -> CALIBRATION even though the health gate and duration both pass", async () => {
    const soakStart = Date.parse("2026-08-01T00:00:00Z");
    const now = soakStart + SOAK_DURATION_MS + 1000;
    const repo = fakeRepo(
      epoch({ stage: "OPERATIONAL_SOAK", soakStartedAtIso: new Date(soakStart).toISOString() }),
      0,
      { passed: true, failedChecks: [] },
      "CONTINUE_RESEARCH",
      true, // sourceCoverageGapDetected
    );
    const outcome = await evaluateAndApplyStageTransition(() => now, repo);
    expect(outcome?.nextStage).toBeNull();
    expect(outcome?.reason).toMatch(/source-coverage gap/);
    expect(repo.transitions).toHaveLength(0);
  });

  it("CODEX P1-1 (round 2): is queried every cycle regardless of stage, and a gap-free wallet fleet never blocks a transition that would otherwise proceed", async () => {
    const repo = fakeRepo(epoch({ stage: "PRE_SOAK" }), 0, { passed: true, failedChecks: [] }, "CONTINUE_RESEARCH", false);
    const outcome = await evaluateAndApplyStageTransition(() => Date.now(), repo);
    expect(outcome?.nextStage).toBe("OPERATIONAL_SOAK");
  });
});

describe("FINAL BUILD Part 5/8/10: OUT_OF_SAMPLE gate -- classification-gated promotion, snapshot, and milestone alerts", () => {
  const oosStart = Date.parse("2026-08-01T00:00:00Z");
  const gateMetNow = oosStart + 15 * 24 * 60 * 60 * 1000;

  it("reaching the sample/duration floor with classification LIVE_PILOT_REVIEW_READY promotes the stage, snapshots, and alerts both the OOS and live-pilot milestones", async () => {
    const repo = fakeRepo(epoch({ stage: "OUT_OF_SAMPLE", oosStartedAtIso: new Date(oosStart).toISOString() }), 200, undefined, "LIVE_PILOT_REVIEW_READY");
    const outcome = await evaluateAndApplyStageTransition(() => gateMetNow, repo);
    expect(outcome?.nextStage).toBe("LIVE_PILOT_REVIEW_READY");
    expect(repo.oosSnapshots).toBe(1);
    expect(repo.notifications).toContainEqual({ epochId: "epoch-1", kind: "sports_shadow_oos_300" });
    expect(repo.notifications).toContainEqual({ epochId: "epoch-1", kind: "sports_shadow_live_pilot_review_ready" });
  });

  it("reaching the floor with classification KILL transitions to FAILED, still snapshots, but never sends the live-pilot alert", async () => {
    const repo = fakeRepo(epoch({ stage: "OUT_OF_SAMPLE", oosStartedAtIso: new Date(oosStart).toISOString() }), 200, undefined, "KILL");
    const outcome = await evaluateAndApplyStageTransition(() => gateMetNow, repo);
    expect(outcome?.nextStage).toBe("FAILED");
    expect(repo.oosSnapshots).toBe(1);
    expect(repo.notifications.some((n) => n.kind === "sports_shadow_live_pilot_review_ready")).toBe(false);
  });

  it("reaching the floor with classification CONTINUE_RESEARCH stays in OUT_OF_SAMPLE (cannot reach LIVE_PILOT_REVIEW_READY prematurely) but still snapshots the milestone -- 300 total reached is a data fact independent of the promotion verdict", async () => {
    const repo = fakeRepo(epoch({ stage: "OUT_OF_SAMPLE", oosStartedAtIso: new Date(oosStart).toISOString() }), 200, undefined, "CONTINUE_RESEARCH");
    const outcome = await evaluateAndApplyStageTransition(() => gateMetNow, repo);
    expect(outcome?.nextStage).toBeNull();
    expect(repo.oosSnapshots).toBe(1);
    expect(repo.notifications).toContainEqual({ epochId: "epoch-1", kind: "sports_shadow_oos_300" });
  });

  it("below the sample/duration floor: classification is never evaluated (avoids a wasted full-epoch analytics run), no snapshot, no milestone alert, stays in place", async () => {
    let classificationCalls = 0;
    const base = fakeRepo(epoch({ stage: "OUT_OF_SAMPLE", oosStartedAtIso: new Date(oosStart).toISOString() }), 50);
    const repo: StageRepository = {
      ...base,
      async evaluateOosClassification() {
        classificationCalls += 1;
        return "CONTINUE_RESEARCH";
      },
    };
    const now = oosStart + 1000;
    const outcome = await evaluateAndApplyStageTransition(() => now, repo);
    expect(outcome?.nextStage).toBeNull();
    expect(base.oosSnapshots).toBe(0);
    expect(classificationCalls).toBe(0);
  });
});
