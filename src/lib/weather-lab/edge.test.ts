import { describe, expect, it } from "vitest";
import { classifyStrategy, computeEdge, decideEntry, edgeUnderScenarios, type EntryGate } from "./edge";
import { simulateAllScenarios, simulateFill, type LadderLevel } from "./execution";
import type { FeeSchedule } from "./fees";

const SCHEDULE: FeeSchedule = { feeType: "quadratic", feeMultiplier: 1 };
const LADDER: LadderLevel[] = [{ price: 0.08, size: 500 }];

const GATE: EntryGate = {
  minNetEdge: 0.05,
  maxPriceUsd: 0.9,
  minPriceUsd: 0.01,
  minConfidence: 0.3,
  maxModelDispersionF: 6,
  enabledStrategyClasses: ["CHEAP_TAIL_VALUE", "INTRADAY_OBSERVATION_EDGE"],
  requireVerifiedSettlement: true,
};

const filled = simulateFill({
  ladder: LADDER,
  contracts: 100,
  scenario: "BASE",
  schedule: SCHEDULE,
  maxPriceUsd: 1,
});

describe("computeEdge", () => {
  it("subtracts fees and slippage from the raw edge", () => {
    const e = computeEdge({
      modelProbability: 0.23,
      executablePriceUsd: 0.08,
      contracts: 100,
      schedule: SCHEDULE,
      slippageBufferUsd: 0.01,
    });
    expect(e.rawEdge).toBeCloseTo(0.15, 6);
    // fee/contract at 8c = 0.07*0.08*0.92 = 0.005152 -> 0.0052 rounded up
    expect(e.feePerContractUsd).toBeCloseTo(0.005152, 4);
    expect(e.netEdge).toBeLessThan(e.rawEdge);
    expect(e.netEdge).toBeCloseTo(0.15 - 0.01 - e.feePerContractUsd, 6);
  });

  it("can turn a positive raw edge negative once costs are applied", () => {
    const e = computeEdge({
      modelProbability: 0.09,
      executablePriceUsd: 0.08,
      contracts: 100,
      schedule: SCHEDULE,
      slippageBufferUsd: 0.01,
    });
    expect(e.rawEdge).toBeGreaterThan(0);
    expect(e.netEdge).toBeLessThan(0);
  });

  it("reports spread when both sides are supplied", () => {
    const e = computeEdge({
      modelProbability: 0.2,
      executablePriceUsd: 0.08,
      contracts: 10,
      schedule: SCHEDULE,
      slippageBufferUsd: 0,
      bestBidUsd: 0.06,
      bestAskUsd: 0.08,
    });
    expect(e.spreadUsd).toBeCloseTo(0.02, 6);
  });

  it("rejects out-of-range probability and price", () => {
    const bad = { contracts: 1, schedule: SCHEDULE, slippageBufferUsd: 0 };
    expect(() => computeEdge({ ...bad, modelProbability: 1.5, executablePriceUsd: 0.1 })).toThrow(RangeError);
    expect(() => computeEdge({ ...bad, modelProbability: 0.5, executablePriceUsd: 2 })).toThrow(RangeError);
  });

  it("rejects a negative slippage buffer", () => {
    expect(() =>
      computeEdge({ modelProbability: 0.5, executablePriceUsd: 0.1, contracts: 1, schedule: SCHEDULE, slippageBufferUsd: -0.01 }),
    ).toThrow(RangeError);
  });
});

describe("classifyStrategy", () => {
  const enabled = ["CHEAP_TAIL_VALUE", "MID_PRICE_VALUE", "HIGH_CONFIDENCE_VALUE", "INTRADAY_OBSERVATION_EDGE", "MODEL_DISAGREEMENT"] as const;

  it("prefers the intraday class when an observation floor was applied", () => {
    expect(
      classifyStrategy({ executablePriceUsd: 0.08, observationFloorApplied: true, modelDispersionF: 1, enabled }),
    ).toBe("INTRADAY_OBSERVATION_EDGE");
  });

  it("classifies cheap contracts as cheap tail", () => {
    expect(
      classifyStrategy({ executablePriceUsd: 0.08, observationFloorApplied: false, modelDispersionF: 1, enabled }),
    ).toBe("CHEAP_TAIL_VALUE");
  });

  it("classifies mid and high price bands distinctly", () => {
    expect(classifyStrategy({ executablePriceUsd: 0.4, observationFloorApplied: false, modelDispersionF: 1, enabled })).toBe("MID_PRICE_VALUE");
    expect(classifyStrategy({ executablePriceUsd: 0.7, observationFloorApplied: false, modelDispersionF: 1, enabled })).toBe("HIGH_CONFIDENCE_VALUE");
  });

  it("returns null when no matching class is enabled", () => {
    expect(
      classifyStrategy({ executablePriceUsd: 0.7, observationFloorApplied: false, modelDispersionF: 1, enabled: ["CHEAP_TAIL_VALUE"] }),
    ).toBeNull();
  });
});

describe("decideEntry", () => {
  const ok = {
    inputs: {
      modelProbability: 0.23,
      executablePriceUsd: 0.08,
      contracts: 100,
      schedule: SCHEDULE,
      slippageBufferUsd: 0.01,
    },
    gate: GATE,
    confidence: 0.6,
    modelDispersionF: 1.5,
    settlementVerified: true,
    observationFloorApplied: true,
    fill: filled,
  };

  it("enters when every condition passes", () => {
    const d = decideEntry(ok);
    expect(d.decision).toBe("ENTER");
    expect(d.reasons).toEqual([]);
    expect(d.strategyClass).toBe("INTRADAY_OBSERVATION_EDGE");
  });

  it("refuses to trade unverified settlement", () => {
    const d = decideEntry({ ...ok, settlementVerified: false });
    expect(d.decision).toBe("REJECT");
    expect(d.reasons).toContain("SETTLEMENT_UNVERIFIED");
  });

  it("refuses when the edge is below the frozen threshold", () => {
    const d = decideEntry({ ...ok, inputs: { ...ok.inputs, modelProbability: 0.1 } });
    expect(d.reasons).toContain("NET_EDGE_BELOW_THRESHOLD");
  });

  it("refuses when the signal could not have been filled", () => {
    const noFill = simulateFill({ ladder: [], contracts: 100, scenario: "BASE", schedule: SCHEDULE, maxPriceUsd: 1 });
    const d = decideEntry({ ...ok, fill: noFill });
    expect(d.reasons.some((r) => r.startsWith("NOT_FILLABLE"))).toBe(true);
  });

  it("refuses on low confidence and on excessive dispersion", () => {
    expect(decideEntry({ ...ok, confidence: 0.1 }).reasons).toContain("CONFIDENCE_BELOW_THRESHOLD");
    expect(decideEntry({ ...ok, modelDispersionF: 12 }).reasons).toContain("MODEL_DISPERSION_ABOVE_MAX");
  });

  it("refuses a price outside the frozen band", () => {
    const d = decideEntry({ ...ok, inputs: { ...ok.inputs, modelProbability: 0.99, executablePriceUsd: 0.95 } });
    expect(d.reasons).toContain("PRICE_ABOVE_MAX");
  });

  it("collects every failing reason rather than stopping at the first", () => {
    const d = decideEntry({ ...ok, settlementVerified: false, confidence: 0.01, modelDispersionF: 50 });
    expect(d.reasons.length).toBeGreaterThan(2);
  });

  it("refuses when no strategy class is enabled for the candidate", () => {
    const d = decideEntry({
      ...ok,
      observationFloorApplied: false,
      inputs: { ...ok.inputs, executablePriceUsd: 0.7, modelProbability: 0.95 },
      gate: { ...GATE, enabledStrategyClasses: ["CHEAP_TAIL_VALUE"] },
    });
    expect(d.reasons).toContain("NO_ENABLED_STRATEGY_CLASS");
  });
});

describe("edgeUnderScenarios", () => {
  it("reports a monotonically worse edge as adverse shift grows", () => {
    const fills = simulateAllScenarios({ ladder: LADDER, contracts: 100, schedule: SCHEDULE, maxPriceUsd: 1 });
    const rows = edgeUnderScenarios({ modelProbability: 0.23, fills, schedule: SCHEDULE, slippageBufferUsd: 0.01 });
    const edges = rows.map((r) => r.netEdge ?? Number.NEGATIVE_INFINITY);
    for (let i = 1; i < edges.length; i++) expect(edges[i]!).toBeLessThan(edges[i - 1]!);
  });

  it("returns a null edge for a scenario that could not fill", () => {
    const fills = simulateAllScenarios({ ladder: [], contracts: 100, schedule: SCHEDULE, maxPriceUsd: 1 });
    const rows = edgeUnderScenarios({ modelProbability: 0.23, fills, schedule: SCHEDULE, slippageBufferUsd: 0.01 });
    expect(rows.every((r) => r.netEdge === null)).toBe(true);
  });
});
