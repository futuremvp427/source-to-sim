import { describe, expect, it } from "vitest";

import { ensureCurrentEpoch } from "./epoch.server";
import { currentEpochVersions } from "./epoch";
import { isEligibleForEpisodeTrigger } from "./source-poll";
import { KALSHI_FEE_MODEL_VERSION, PMUS_FEE_MODEL_VERSION } from "./fees";
import type { EpochRepository } from "./epoch.server";
import type { ExperimentEpoch } from "./epoch";

const STAGE_TIMING_DEFAULTS = { stageEnteredAtIso: new Date().toISOString(), soakStartedAtIso: null, calibrationStartedAtIso: null, oosStartedAtIso: null };

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
      const created: ExperimentEpoch = { ...epoch, id: `epoch-${seq}`, createdAtIso: new Date().toISOString(), ...STAGE_TIMING_DEFAULTS };
      epochs.push(created);
      return created;
    },
    async startNewEpoch(epoch) {
      seq += 1;
      // Simulate the real repo's flip-then-insert.
      for (const e of epochs) (e as { stage: string }).stage = e.stage; // no-op, is_current not modeled here
      epochs.length = 0;
      const created: ExperimentEpoch = { ...epoch, id: `epoch-${seq}`, createdAtIso: new Date().toISOString(), stage: "PRE_SOAK", frozenAtIso: null, ...STAGE_TIMING_DEFAULTS };
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
      ...STAGE_TIMING_DEFAULTS,
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
      ...STAGE_TIMING_DEFAULTS,
    };
    const repo = makeFakeRepo(existing);
    const result = await ensureCurrentEpoch(["0xa"], GO_LIVE_MS, "sha-new", repo);
    expect(result.id).not.toBe("epoch-stale");
    expect(result.versions.routerVersion).not.toBe("router_v0_stale");
  });
});

/**
 * ACTIVATION-DEFECT REGRESSIONS: stale runtime metadata must not be reused forever.
 * Uses a fake repo that models is_current the way the real table does (partial unique
 * index -> exactly one current row, prior rows PRESERVED but non-current).
 */
describe("Sports Shadow epoch activation: runtime metadata identity", () => {
  type Row = ExperimentEpoch & { isCurrent: boolean };

  function makeCurrentAwareRepo(rows: Row[]): EpochRepository & { rows: Row[] } {
    let seq = 0;
    return {
      rows,
      async getCurrentEpoch() {
        return rows.find((r) => r.isCurrent) ?? null;
      },
      async createEpoch(epoch) {
        seq += 1;
        const created: Row = { ...epoch, id: `new-${seq}`, createdAtIso: new Date().toISOString(), ...STAGE_TIMING_DEFAULTS, isCurrent: false };
        rows.push(created);
        return created;
      },
      async startNewEpoch(epoch) {
        seq += 1;
        for (const r of rows) r.isCurrent = false;
        const created: Row = {
          ...epoch,
          id: `new-${seq}`,
          createdAtIso: new Date().toISOString(),
          stage: "PRE_SOAK",
          frozenAtIso: null,
          ...STAGE_TIMING_DEFAULTS,
          isCurrent: true,
        };
        rows.push(created);
        return created;
      },
      async transitionStage(epochId, stage) {
        const r = rows.find((x) => x.id === epochId);
        if (r) (r as { stage: string }).stage = stage;
      },
      async freezeEpoch(epochId) {
        const r = rows.find((x) => x.id === epochId);
        if (r) (r as { frozenAtIso: string | null }).frozenAtIso = new Date().toISOString();
      },
    };
  }

  async function makeExistingRow(wallets: string[], goLiveMs: number, gitSha: string): Promise<Row> {
    const versions = currentEpochVersions(PMUS_FEE_MODEL_VERSION, KALSHI_FEE_MODEL_VERSION);
    const { computeConfigHash } = await import("./epoch");
    return {
      id: "epoch-existing",
      createdAtIso: new Date().toISOString(),
      goLiveAtIso: new Date(goLiveMs).toISOString(),
      walletCohort: wallets,
      gitSha,
      configHash: await computeConfigHash(wallets, versions),
      versions,
      stage: "OPERATIONAL_SOAK",
      frozenAtIso: null,
      ...STAGE_TIMING_DEFAULTS,
      isCurrent: true,
    };
  }

  const WALLETS = ["0xa", "0xb"];

  it("a CHANGED git sha starts a NEW current epoch (stale-revision defect)", async () => {
    const repo = makeCurrentAwareRepo([await makeExistingRow(WALLETS, GO_LIVE_MS, "sha-old")]);
    const result = await ensureCurrentEpoch(WALLETS, GO_LIVE_MS, "sha-new", repo);
    expect(result.id).not.toBe("epoch-existing");
    expect(result.gitSha).toBe("sha-new");
    expect(repo.rows.filter((r) => r.isCurrent)).toHaveLength(1);
  });

  it("a CHANGED (later, prospective) go-live starts a NEW current epoch", async () => {
    const repo = makeCurrentAwareRepo([await makeExistingRow(WALLETS, GO_LIVE_MS, "sha-same")]);
    const newGoLive = GO_LIVE_MS + 3_600_000;
    const result = await ensureCurrentEpoch(WALLETS, newGoLive, "sha-same", repo);
    expect(result.id).not.toBe("epoch-existing");
    expect(result.goLiveAtIso).toBe(new Date(newGoLive).toISOString());
  });

  it("UNCHANGED config/sha/go-live is idempotent -- same epoch, no new row", async () => {
    const repo = makeCurrentAwareRepo([await makeExistingRow(WALLETS, GO_LIVE_MS, "sha-same")]);
    const a = await ensureCurrentEpoch(WALLETS, GO_LIVE_MS, "sha-same", repo);
    const b = await ensureCurrentEpoch(WALLETS, GO_LIVE_MS, "sha-same", repo);
    expect(a.id).toBe("epoch-existing");
    expect(b.id).toBe("epoch-existing");
    expect(repo.rows).toHaveLength(1);
  });

  it("the PRIOR epoch row is preserved and flipped to non-current, never deleted or mutated", async () => {
    const repo = makeCurrentAwareRepo([await makeExistingRow(WALLETS, GO_LIVE_MS, "sha-old")]);
    await ensureCurrentEpoch(WALLETS, GO_LIVE_MS + 60_000, "sha-new", repo);
    const prior = repo.rows.find((r) => r.id === "epoch-existing");
    expect(prior).toBeDefined();
    expect(prior?.isCurrent).toBe(false);
    expect(prior?.gitSha).toBe("sha-old");
    expect(prior?.goLiveAtIso).toBe(new Date(GO_LIVE_MS).toISOString());
    expect(prior?.stage).toBe("OPERATIONAL_SOAK");
    expect(repo.rows).toHaveLength(2);
  });

  it("the wallet cohort is carried through a metadata-only epoch rotation unchanged", async () => {
    const nine = Array.from({ length: 9 }, (_, i) => `0x${String(i).repeat(40)}`);
    const repo = makeCurrentAwareRepo([await makeExistingRow(nine, GO_LIVE_MS, "sha-old")]);
    const result = await ensureCurrentEpoch(nine, GO_LIVE_MS, "sha-new", repo);
    expect(result.walletCohort).toEqual(nine);
    expect(result.versions.classifierVersion).toBe("classifier_v2_all_sports_full_contest");
    expect(result.versions.resolverVersion).toBe("resolver_v2_generic_participants_rule_fingerprint");
  });

  it("re-arming go-live does NOT reinterpret pre-go-live fills as post-go-live activity", async () => {
    const newGoLive = GO_LIVE_MS + 3_600_000;
    const beforeTs = Math.floor((newGoLive - 1000) / 1000);
    const afterTs = Math.floor((newGoLive + 1000) / 1000);
    expect(isEligibleForEpisodeTrigger(beforeTs, newGoLive)).toBe(false);
    expect(isEligibleForEpisodeTrigger(afterTs, newGoLive)).toBe(true);
    // and a fill before the OLD boundary stays ineligible under the new boundary too
    expect(isEligibleForEpisodeTrigger(Math.floor((GO_LIVE_MS - 1000) / 1000), newGoLive)).toBe(false);
  });
});
