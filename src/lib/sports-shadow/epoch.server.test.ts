import { describe, expect, it } from "vitest";

import { ensureCurrentEpoch } from "./epoch.server";
import { currentEpochVersions } from "./epoch";
import { KALSHI_FEE_MODEL_VERSION, PMUS_FEE_MODEL_VERSION } from "./fees";
import type { EpochRepository } from "./epoch.server";
import type { ExperimentEpoch } from "./epoch";

function makeFakeRepo(initial: ExperimentEpoch | null = null): EpochRepository & { epochs: ExperimentEpoch[] } {
  const epochs: ExperimentEpoch[] = initial ? [initial] : [];
  let seq = 0;
  return {
    epochs,
    async getCurrentEpoch() {
      return epochs.find((e) => e.stage !== "FAILED") ?? null;
    },
    async createEpoch(epoch) {
      seq += 1;
      const created: ExperimentEpoch = { ...epoch, id: `epoch-${seq}`, createdAtIso: new Date().toISOString() };
      epochs.push(created);
      return created;
    },
    async startNewEpoch(epoch) {
      seq += 1;
      // Simulate the real repo's flip-then-insert.
      for (const e of epochs) (e as { stage: string }).stage = e.stage; // no-op, is_current not modeled here
      epochs.length = 0;
      const created: ExperimentEpoch = { ...epoch, id: `epoch-${seq}`, createdAtIso: new Date().toISOString(), stage: "PRE_SOAK", frozenAtIso: null };
      epochs.push(created);
      return created;
    },
    async transitionStage(epochId, stage) {
      const e = epochs.find((x) => x.id === epochId);
      if (e) (e as { stage: string }).stage = stage;
    },
    async freezeEpoch(epochId) {
      const e = epochs.find((x) => x.id === epochId);
      if (e) (e as { frozenAtIso: string | null }).frozenAtIso = new Date().toISOString();
    },
  };
}

const GO_LIVE_MS = 1_700_000_000_000;

describe("FINAL BUILD Part 17: ensureCurrentEpoch", () => {
  it("creates a brand-new epoch when none exists yet", async () => {
    const repo = makeFakeRepo(null);
    const epoch = await ensureCurrentEpoch(["0xa", "0xb"], GO_LIVE_MS, "sha123", repo);
    expect(epoch.id).toBe("epoch-1");
    expect(epoch.walletCohort).toEqual(["0xa", "0xb"]);
    expect(epoch.gitSha).toBe("sha123");
    expect(repo.epochs).toHaveLength(1);
  });

  it("reuses the existing current epoch when versions and config hash match exactly -- no new epoch, no write", async () => {
    const versions = currentEpochVersions(PMUS_FEE_MODEL_VERSION, KALSHI_FEE_MODEL_VERSION);
    const first = await makeFakeRepo(null).createEpoch({
      goLiveAtIso: new Date(GO_LIVE_MS).toISOString(),
      walletCohort: ["0xa"],
      gitSha: "sha1",
      configHash: "will-be-overwritten",
      versions,
      stage: "PRE_SOAK",
      frozenAtIso: null,
    });
    // Compute the REAL expected hash so the fake's stored epoch matches what
    // ensureCurrentEpoch will independently recompute.
    const { computeConfigHash } = await import("./epoch");
    const realHash = await computeConfigHash(["0xa"], versions);
    const repo = makeFakeRepo({ ...first, configHash: realHash });

    const result = await ensureCurrentEpoch(["0xa"], GO_LIVE_MS, "sha1", repo);
    expect(result.id).toBe(first.id); // same epoch reused, not a new one
    expect(repo.epochs).toHaveLength(1);
  });

  it("starts a NEW epoch when the wallet cohort has changed (config hash drift)", async () => {
    const versions = currentEpochVersions(PMUS_FEE_MODEL_VERSION, KALSHI_FEE_MODEL_VERSION);
    const { computeConfigHash } = await import("./epoch");
    const oldHash = await computeConfigHash(["0xold"], versions);
    const existing: ExperimentEpoch = {
      id: "epoch-old",
      createdAtIso: new Date().toISOString(),
      goLiveAtIso: new Date(GO_LIVE_MS).toISOString(),
      walletCohort: ["0xold"],
      gitSha: "sha-old",
      configHash: oldHash,
      versions,
      stage: "CALIBRATION",
      frozenAtIso: null,
    };
    const repo = makeFakeRepo(existing);
    const result = await ensureCurrentEpoch(["0xnew"], GO_LIVE_MS, "sha-new", repo);
    expect(result.id).not.toBe("epoch-old");
    expect(result.walletCohort).toEqual(["0xnew"]);
  });

  it("starts a NEW epoch when a version constant has drifted from the existing epoch's recorded versions", async () => {
    const versions = currentEpochVersions(PMUS_FEE_MODEL_VERSION, KALSHI_FEE_MODEL_VERSION);
    const staleVersions = { ...versions, routerVersion: "router_v0_stale" };
    const { computeConfigHash } = await import("./epoch");
    const staleHash = await computeConfigHash(["0xa"], staleVersions);
    const existing: ExperimentEpoch = {
      id: "epoch-stale",
      createdAtIso: new Date().toISOString(),
      goLiveAtIso: new Date(GO_LIVE_MS).toISOString(),
      walletCohort: ["0xa"],
      gitSha: "sha-old",
      configHash: staleHash,
      versions: staleVersions,
      stage: "CALIBRATION",
      frozenAtIso: null,
    };
    const repo = makeFakeRepo(existing);
    const result = await ensureCurrentEpoch(["0xa"], GO_LIVE_MS, "sha-new", repo);
    expect(result.id).not.toBe("epoch-stale");
    expect(result.versions.routerVersion).not.toBe("router_v0_stale");
  });
});
