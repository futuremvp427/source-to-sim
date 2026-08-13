import { describe, expect, it } from "vitest";

import {
  SLIPPAGE_METHODOLOGY_VERSION,
  buildPriorDaySlippageBasis,
  priorUtcDayCutoff,
} from "./slippage-asof";

describe("prior-day slippage basis", () => {
  it("uses a strict 00:00 UTC cutoff for the settlement day", () => {
    expect(priorUtcDayCutoff("2026-01-02")).toBe("2026-01-02T00:00:00.000Z");
  });

  it("does not let observations from the settlement day or later rewrite history", () => {
    const prior = [
      { observedAt: "2026-01-01T10:00:00.000Z", slippageCents: 1 },
      { observedAt: "2026-01-01T11:00:00.000Z", slippageCents: 3 },
    ];

    const beforeLaterSamples = buildPriorDaySlippageBasis("2026-01-02", prior);
    expect(beforeLaterSamples.medianCents).toBe(2);
    expect(beforeLaterSamples.sampleCount).toBe(2);

    const afterLaterSamples = buildPriorDaySlippageBasis("2026-01-02", [
      ...prior,
      { observedAt: "2026-01-02T12:00:00.000Z", slippageCents: 100 },
      { observedAt: "2026-01-03T12:00:00.000Z", slippageCents: 200 },
    ]);

    expect(afterLaterSamples).toEqual(beforeLaterSamples);
    expect(afterLaterSamples.methodologyVersion).toBe(SLIPPAGE_METHODOLOGY_VERSION);
  });

  it("allows later observations to inform a genuinely later settlement day", () => {
    const samples = [
      { observedAt: "2026-01-01T10:00:00.000Z", slippageCents: 1 },
      { observedAt: "2026-01-01T11:00:00.000Z", slippageCents: 3 },
      { observedAt: "2026-01-02T12:00:00.000Z", slippageCents: 100 },
      { observedAt: "2026-01-03T12:00:00.000Z", slippageCents: 200 },
    ];

    const basis = buildPriorDaySlippageBasis("2026-01-04", samples);
    expect(basis.medianCents).toBe(51.5);
    expect(basis.sampleCount).toBe(4);
  });

  it("uses only the most recent 2,000 eligible samples", () => {
    const samples = Array.from({ length: 2005 }, (_, index) => ({
      observedAt: new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString(),
      slippageCents: index,
    }));
    const basis = buildPriorDaySlippageBasis("2026-01-01", samples);
    expect(basis.sampleCount).toBe(2000);
    expect(basis.medianCents).toBe(1004.5);
  });

  it("fails closed when no pre-cutoff slippage observations exist", () => {
    const basis = buildPriorDaySlippageBasis("2026-01-02", [
      { observedAt: "2026-01-02T00:00:00.000Z", slippageCents: 2 },
      { observedAt: "2026-01-02T01:00:00.000Z", slippageCents: 4 },
    ]);
    expect(basis.medianCents).toBeNull();
    expect(basis.sampleCount).toBe(0);
  });
});
