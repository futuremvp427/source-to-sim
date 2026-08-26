import { describe, expect, it } from "vitest";
import type { EntryGate } from "./edge";
import { FEE_MODEL_VERSION } from "./fees";
import {
  assertExperimentIsolation,
  assertPaperOnly,
  ExperimentConfigError,
  freezeExperiment,
  hashConfig,
  LIVE_EXECUTION_IMPLEMENTED,
  LiveExecutionForbiddenError,
  type ExperimentConfig,
} from "./experiment";

const GATE: EntryGate = {
  minNetEdge: 0.05,
  maxPriceUsd: 0.9,
  minPriceUsd: 0.01,
  minConfidence: 0.3,
  maxModelDispersionF: 6,
  enabledStrategyClasses: ["INTRADAY_OBSERVATION_EDGE"],
  requireVerifiedSettlement: true,
};

const CONFIG: ExperimentConfig = {
  strategyVersion: "weather-intraday-v1",
  enabledCities: ["NYC"],
  modelWeights: { nbm: 1, hrrr: 1 },
  gate: GATE,
  positionSizeContracts: 100,
  maxNotionalPerMarketUsd: 25,
  maxNotionalPerStationDayUsd: 75,
  maxConcurrentStationDays: 5,
  slippageBufferUsd: 0.01,
  maxQuoteAgeMs: 60_000,
  maxForecastAgeMs: 6 * 3600_000,
  feeModelVersion: FEE_MODEL_VERSION,
  admittedSettlementFingerprints: { NYC: "sfp1-abc" },
};

describe("paper-only enforcement", () => {
  it("has live execution disabled as a hard constant", () => {
    expect(LIVE_EXECUTION_IMPLEMENTED).toBe(false);
  });

  it("permits PAPER mode", () => {
    expect(() => assertPaperOnly("PAPER", "test")).not.toThrow();
  });

  it("throws for any other mode", () => {
    for (const mode of ["LIVE", "live", "REAL", "", "paper"]) {
      expect(() => assertPaperOnly(mode, "test")).toThrow(LiveExecutionForbiddenError);
    }
  });

  it("names the context in the error so the call site is identifiable", () => {
    expect(() => assertPaperOnly("LIVE", "submitOrder")).toThrow(/submitOrder/);
  });
});

describe("hashConfig", () => {
  it("is stable for identical configs", () => {
    expect(hashConfig(CONFIG)).toBe(hashConfig({ ...CONFIG }));
  });

  it("ignores key order", () => {
    const reordered = JSON.parse(JSON.stringify(CONFIG)) as ExperimentConfig;
    expect(hashConfig(reordered)).toBe(hashConfig(CONFIG));
  });

  it("changes when the minimum edge moves", () => {
    const tuned = { ...CONFIG, gate: { ...GATE, minNetEdge: 0.04 } };
    expect(hashConfig(tuned)).not.toBe(hashConfig(CONFIG));
  });

  it("changes when model weights move", () => {
    expect(hashConfig({ ...CONFIG, modelWeights: { nbm: 2, hrrr: 1 } })).not.toBe(hashConfig(CONFIG));
  });

  it("changes when position sizing moves", () => {
    expect(hashConfig({ ...CONFIG, positionSizeContracts: 50 })).not.toBe(hashConfig(CONFIG));
  });
});

describe("freezeExperiment", () => {
  it("freezes a valid config in PAPER mode", () => {
    const f = freezeExperiment({ experimentId: "exp-1", config: CONFIG });
    expect(f.mode).toBe("PAPER");
    expect(f.configHash).toBe(hashConfig(CONFIG));
    expect(f.frozenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("refuses a config that would trade unverified settlement", () => {
    const bad = { ...CONFIG, gate: { ...GATE, requireVerifiedSettlement: false as unknown as true } };
    expect(() => freezeExperiment({ experimentId: "exp-1", config: bad })).toThrow(ExperimentConfigError);
  });

  it("refuses a city with no admitted settlement fingerprint", () => {
    const bad = { ...CONFIG, enabledCities: ["NYC", "Miami"] };
    expect(() => freezeExperiment({ experimentId: "exp-1", config: bad })).toThrow(/Miami/);
  });

  it("refuses a stale fee model version so a venue fee change cannot silently reprice", () => {
    const bad = { ...CONFIG, feeModelVersion: "kalshi-quadratic-2020-01" };
    expect(() => freezeExperiment({ experimentId: "exp-1", config: bad })).toThrow(/feeModelVersion/);
  });

  it("refuses a non-positive minimum edge", () => {
    const bad = { ...CONFIG, gate: { ...GATE, minNetEdge: 0 } };
    expect(() => freezeExperiment({ experimentId: "exp-1", config: bad })).toThrow(ExperimentConfigError);
  });

  it("refuses an empty strategy-class list so a category cannot run without a rule", () => {
    const bad = { ...CONFIG, gate: { ...GATE, enabledStrategyClasses: [] } };
    expect(() => freezeExperiment({ experimentId: "exp-1", config: bad })).toThrow(ExperimentConfigError);
  });

  it("refuses an inverted price band", () => {
    const bad = { ...CONFIG, gate: { ...GATE, minPriceUsd: 0.9, maxPriceUsd: 0.1 } };
    expect(() => freezeExperiment({ experimentId: "exp-1", config: bad })).toThrow(ExperimentConfigError);
  });

  it("collects every problem in one error", () => {
    const bad = { ...CONFIG, strategyVersion: "", enabledCities: [], positionSizeContracts: 0 };
    try {
      freezeExperiment({ experimentId: "", config: bad });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as Error).message.split("\n").length).toBeGreaterThan(3);
    }
  });
});

describe("assertExperimentIsolation", () => {
  const frozen = freezeExperiment({ experimentId: "exp-1", config: CONFIG });

  it("accepts a row from the same experiment and config", () => {
    expect(() =>
      assertExperimentIsolation({ frozen, rowExperimentId: "exp-1", rowConfigHash: frozen.configHash }),
    ).not.toThrow();
  });

  it("rejects a row from another experiment", () => {
    expect(() =>
      assertExperimentIsolation({ frozen, rowExperimentId: "exp-2", rowConfigHash: frozen.configHash }),
    ).toThrow(/isolation violated/);
  });

  it("rejects a row collected under a different config hash", () => {
    expect(() =>
      assertExperimentIsolation({ frozen, rowExperimentId: "exp-1", rowConfigHash: "wlx1-stale" }),
    ).toThrow(/requires a NEW experiment/);
  });
});
