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
): StageRepository & { transitions: { epochId: string; stage: string }[] } {
  const transitions: { epochId: string; stage: string }[] = [];
  return {
    transitions,
    async getCurrentEpoch() {
      return current;
    },
    async countIndependentSettledSince() {
      return independentCount;
    },
    async computeSoakHealth() {
      return soakHealth;
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
  });

  it("OPERATIONAL_SOAK epoch past 72h with a FAILING health gate transitions to FAILED, never silently to CALIBRATION", async () => {
    const soakStart = Date.parse("2026-08-01T00:00:00Z");
    const now = soakStart + SOAK_DURATION_MS + 1000;
    const repo = fakeRepo(epoch({ stage: "OPERATIONAL_SOAK", soakStartedAtIso: new Date(soakStart).toISOString() }), 0, { passed: false, failedChecks: ["cycle error rate too high"] });
    const outcome = await evaluateAndApplyStageTransition(() => now, repo);
    expect(outcome?.nextStage).toBe("FAILED");
    expect(outcome?.soakFailedChecks).toEqual(["cycle error rate too high"]);
  });

  it("CALIBRATION queries independent-settled-since-calibration-start and transitions once both minimums are met", async () => {
    const calStart = Date.parse("2026-08-01T00:00:00Z");
    const now = calStart + 15 * 24 * 60 * 60 * 1000;
    const repo = fakeRepo(epoch({ stage: "CALIBRATION", calibrationStartedAtIso: new Date(calStart).toISOString() }), 100);
    const outcome = await evaluateAndApplyStageTransition(() => now, repo);
    expect(outcome?.nextStage).toBe("OUT_OF_SAMPLE");
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
});
