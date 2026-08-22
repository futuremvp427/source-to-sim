import { describe, expect, it } from "vitest";

import { canFreeze, computeConfigHash, currentEpochVersions, requiresNewEpoch, type ExperimentEpochVersions } from "./epoch";

describe("FINAL BUILD Part 17: experiment epoch versioning", () => {
  it("computeConfigHash is deterministic for the same inputs", async () => {
    const versions = currentEpochVersions("PMUS_FEE_V1", "KALSHI_FEE_V1");
    const a = await computeConfigHash(["0xwallet1", "0xwallet2"], versions);
    const b = await computeConfigHash(["0xwallet1", "0xwallet2"], versions);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("wallet cohort order does not change the hash -- the SAME cohort listed differently is the SAME config", async () => {
    const versions = currentEpochVersions("PMUS_FEE_V1", "KALSHI_FEE_V1");
    const a = await computeConfigHash(["0xaaa", "0xbbb"], versions);
    const b = await computeConfigHash(["0xbbb", "0xaaa"], versions);
    expect(a).toBe(b);
  });

  it("wallet cohort casing does not change the hash", async () => {
    const versions = currentEpochVersions("PMUS_FEE_V1", "KALSHI_FEE_V1");
    const a = await computeConfigHash(["0xAAA"], versions);
    const b = await computeConfigHash(["0xaaa"], versions);
    expect(a).toBe(b);
  });

  it("a different wallet cohort produces a different hash", async () => {
    const versions = currentEpochVersions("PMUS_FEE_V1", "KALSHI_FEE_V1");
    const a = await computeConfigHash(["0xaaa"], versions);
    const b = await computeConfigHash(["0xbbb"], versions);
    expect(a).not.toBe(b);
  });

  it("a different fee model version produces a different hash -- fee-rule changes must force a new epoch", async () => {
    const v1 = currentEpochVersions("PMUS_FEE_V1", "KALSHI_FEE_V1");
    const v2 = currentEpochVersions("PMUS_FEE_V2", "KALSHI_FEE_V1");
    const a = await computeConfigHash(["0xaaa"], v1);
    const b = await computeConfigHash(["0xaaa"], v2);
    expect(a).not.toBe(b);
  });

  it("requiresNewEpoch is false when every version string matches", () => {
    const versions = currentEpochVersions("PMUS_FEE_V1", "KALSHI_FEE_V1");
    expect(requiresNewEpoch(versions, { ...versions })).toBe(false);
  });

  it("requiresNewEpoch is true when ANY single version string differs", () => {
    const versions = currentEpochVersions("PMUS_FEE_V1", "KALSHI_FEE_V1");
    const changed: ExperimentEpochVersions = { ...versions, routerVersion: "router_v2" };
    expect(requiresNewEpoch(versions, changed)).toBe(true);
  });

  it("canFreeze allows freezing from OPERATIONAL_SOAK or CALIBRATION, never twice", () => {
    expect(canFreeze({ stage: "OPERATIONAL_SOAK", frozenAtIso: null })).toBe(true);
    expect(canFreeze({ stage: "CALIBRATION", frozenAtIso: null })).toBe(true);
    expect(canFreeze({ stage: "OUT_OF_SAMPLE", frozenAtIso: null })).toBe(false);
    expect(canFreeze({ stage: "CALIBRATION", frozenAtIso: "2026-08-01T00:00:00Z" })).toBe(false);
  });
});
