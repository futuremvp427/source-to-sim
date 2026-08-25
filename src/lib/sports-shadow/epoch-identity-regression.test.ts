import { describe, expect, it } from "vitest";

import { computeConfigHash, currentEpochVersions, type ExperimentEpoch } from "./epoch";
import { ensureCurrentEpoch, type EpochRepository } from "./epoch.server";
import { KALSHI_FEE_MODEL_VERSION, PMUS_FEE_MODEL_VERSION } from "./fees";

const WALLETS = ["0xa", "0xb"];
const GO_LIVE_A = Date.parse("2026-08-24T16:35:00Z");
const GO_LIVE_B = Date.parse("2026-08-24T17:20:00Z");

function createHistoryRepo(initial: ExperimentEpoch): EpochRepository & {
  history: ExperimentEpoch[];
  currentId: () => string | null;
} {
  const history = [initial];
  let currentId = initial.id;
  let seq = 1;

  const materialize = (
    epoch: Omit<ExperimentEpoch, "id" | "createdAtIso" | "stageEnteredAtIso" | "soakStartedAtIso" | "calibrationStartedAtIso" | "oosStartedAtIso" | "stage" | "frozenAtIso">,
  ): ExperimentEpoch => ({
    ...epoch,
    id: `epoch-${++seq}`,
    createdAtIso: new Date().toISOString(),
    stage: "PRE_SOAK",
    stageEnteredAtIso: new Date().toISOString(),
    soakStartedAtIso: null,
    calibrationStartedAtIso: null,
    oosStartedAtIso: null,
    frozenAtIso: null,
  });

  return {
    history,
    currentId: () => currentId,
    async getCurrentEpoch() {
      return history.find((epoch) => epoch.id === currentId) ?? null;
    },
    async createEpoch(epoch) {
      const created: ExperimentEpoch = {
        ...epoch,
        id: `detached-${++seq}`,
        createdAtIso: new Date().toISOString(),
        stageEnteredAtIso: new Date().toISOString(),
        soakStartedAtIso: null,
        calibrationStartedAtIso: null,
        oosStartedAtIso: null,
      };
      history.push(created);
      return created;
    },
    async resolveCurrentEpoch(epoch) {
      const current = history.find((existing) => existing.id === currentId) ?? null;
      if (
        current &&
        current.configHash === epoch.configHash &&
        current.gitSha === epoch.gitSha &&
        current.goLiveAtIso === epoch.goLiveAtIso &&
        JSON.stringify(current.walletCohort) === JSON.stringify(epoch.walletCohort) &&
        JSON.stringify(current.versions) === JSON.stringify(epoch.versions)
      ) {
        return current;
      }
      const created = materialize(epoch);
      history.push(created);
      currentId = created.id;
      return created;
    },
    async startNewEpoch(epoch) {
      const created = materialize(epoch);
      history.push(created);
      currentId = created.id;
      return created;
    },
    async transitionStage() {},
    async freezeEpoch() {},
  };
}

async function existingEpoch(gitSha: string, goLiveAtMs: number): Promise<ExperimentEpoch> {
  const versions = currentEpochVersions(PMUS_FEE_MODEL_VERSION, KALSHI_FEE_MODEL_VERSION);
  return {
    id: "epoch-1",
    createdAtIso: "2026-08-24T16:00:00.000Z",
    goLiveAtIso: new Date(goLiveAtMs).toISOString(),
    walletCohort: WALLETS,
    gitSha,
    configHash: await computeConfigHash(WALLETS, versions),
    versions,
    stage: "OPERATIONAL_SOAK",
    stageEnteredAtIso: "2026-08-24T16:00:01.000Z",
    soakStartedAtIso: "2026-08-24T16:00:02.000Z",
    calibrationStartedAtIso: null,
    oosStartedAtIso: null,
    frozenAtIso: null,
  };
}

describe("Sports Shadow experiment epoch runtime identity", () => {
  it("reuses the current epoch only when SHA and go-live still match", async () => {
    const first = await existingEpoch("sha-a", GO_LIVE_A);
    const repo = createHistoryRepo(first);

    const result = await ensureCurrentEpoch(WALLETS, GO_LIVE_A, "sha-a", repo);

    expect(result.id).toBe(first.id);
    expect(repo.history).toHaveLength(1);
    expect(repo.currentId()).toBe(first.id);
  });

  it("starts a new current epoch when the deployed git SHA changes and preserves the prior epoch", async () => {
    const first = await existingEpoch("sha-a", GO_LIVE_A);
    const repo = createHistoryRepo(first);

    const result = await ensureCurrentEpoch(WALLETS, GO_LIVE_A, "sha-b", repo);

    expect(result.id).not.toBe(first.id);
    expect(result.gitSha).toBe("sha-b");
    expect(result.goLiveAtIso).toBe(first.goLiveAtIso);
    expect(repo.currentId()).toBe(result.id);
    expect(repo.history.map((epoch) => epoch.id)).toContain(first.id);
    expect(repo.history).toHaveLength(2);
  });

  it("starts a new current epoch when the prospective go-live boundary changes", async () => {
    const first = await existingEpoch("sha-a", GO_LIVE_A);
    const repo = createHistoryRepo(first);

    const result = await ensureCurrentEpoch(WALLETS, GO_LIVE_B, "sha-a", repo);

    expect(result.id).not.toBe(first.id);
    expect(result.goLiveAtIso).toBe(new Date(GO_LIVE_B).toISOString());
    expect(first.goLiveAtIso).toBe(new Date(GO_LIVE_A).toISOString());
    expect(repo.history).toHaveLength(2);
  });
});
