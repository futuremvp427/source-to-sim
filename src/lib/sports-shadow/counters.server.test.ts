import { describe, expect, it } from "vitest";

import { nextMilestoneFor, type EpochCounters } from "./counters.server";

function counters(overrides: Partial<EpochCounters> = {}): EpochCounters {
  return {
    rawEpisodeCount: 0,
    independentEpisodeCount: 0,
    settledIndependentCount: 0,
    settledCount: 0,
    rejectedCount: 0,
    calibrationIndependentSettledCount: 0,
    oosIndependentSettledCount: 0,
    ...overrides,
  };
}

describe("FINAL BUILD Part 7: nextMilestoneFor", () => {
  it("targets 100 independent settled first", () => {
    expect(nextMilestoneFor(counters({ settledIndependentCount: 0 }))).toBe("100_INDEPENDENT_SETTLED");
    expect(nextMilestoneFor(counters({ settledIndependentCount: 99 }))).toBe("100_INDEPENDENT_SETTLED");
  });

  it("targets 300 total once 100 is reached but 300 is not", () => {
    expect(nextMilestoneFor(counters({ settledIndependentCount: 100 }))).toBe("300_INDEPENDENT_SETTLED");
    expect(nextMilestoneFor(counters({ settledIndependentCount: 299 }))).toBe("300_INDEPENDENT_SETTLED");
  });

  it("returns null once 300 is reached -- no further milestone target", () => {
    expect(nextMilestoneFor(counters({ settledIndependentCount: 300 }))).toBeNull();
    expect(nextMilestoneFor(counters({ settledIndependentCount: 5000 }))).toBeNull();
  });
});
